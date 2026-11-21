# ADR 0004: MCP stdio Tools

- Status: Proposed
- Date: 2026-11-21
- Refines: ADR 0002（Typed Plugin Kernel）和 ADR 0003（Local Plugin Loading and Trust）。
- 详细设计：`docs/superpowers/specs/2026-11-21-mcp-stdio-design.md`。

## Context

Stage 4 已经为进程内本地插件建立了发现、摘要、信任和 Generation 边界。下一阶段
需要让第三方工具以本地进程的 MCP server 形式接入 Weave。第一版只覆盖 **local
stdio Tools**：Weave 启动一个用户明确配置的命令，通过 stdin/stdout 使用 MCP，读取
`tools/list`，并把 `tools/call` 接入现有 Tool Pipeline。采样、roots、elicitation、
resources、prompts、HTTP MCP、安装器、市场和操作系统沙箱都不在本 ADR 的范围内。

MCP server 是独立进程，但启动本身仍是执行任意代码的动作。配置、信任、工具声明、
审批和 Generation 生命周期必须分别有清晰的宿主边界；不能因为 MCP 使用了独立进程就
把它当作权限或沙箱。

## Decision

### 1. 包边界和适配层

新增 `@weave/mcp-client`，只依赖 MCP 官方客户端和本包需要的运行时依赖，不依赖任何
`@weave/*` 包。它负责 MCP stdio 连接、握手、分页、取消、关闭、schema/result 适配和
进程诊断，输出一个与 Weave 无关的 typed client contract。

`plugin-builtins` 负责把该 contract 适配为 `KernelPlugin`：工具描述、host-owned
映射名、Tool Pipeline 调用器和 Generation 注册都在这里完成。Server 是唯一的组合根，
负责 ESM 本地插件与 MCP 插件的统一发现/信任结果、Generation 协调和生命周期；MCP client
不认识 Runtime、HTTP、Session、Agent 或 Kernel。

MCP 工具名称、展示名称、插件 id、配置 id 和模型可见名称由宿主映射并保持稳定。远端
`name` 不能覆盖宿主命名空间，也不能作为权限、审批或能力名称直接使用；重复名称和
非法映射在构建 Generation 时拒绝。

### 2. 固定的第一版 SDK 接入

使用官方 TypeScript SDK `@modelcontextprotocol/client@2.4.0`，固定到 release tag
[`v2.4.0`](https://github.com/modelcontextprotocol/typescript-sdk/releases/tag/v2.4.0)，
tag commit 为 `951fe5603a7ec0b2dcb6a0b95d92cd86f93ad9e5`。第一版使用：

```ts
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
```

显式设置 `versionNegotiation: { mode: 'legacy' }`。SDK 的 `auto` 模式配合官方
`StdioClientTransport` 会先用相同参数额外启动一个短命探测进程，再启动正式进程；在
没有明确兼容性需求前，不接受这个双启动副作用。现代协议协商留给后续兼容性决策。

SDK transport 使用 `shell: false` 和 argv 数组。环境只包括 SDK 系统白名单及配置明确
引用的环境变量；`env: {}` 不等于零继承，宿主禁止扩散整个 `process.env`。默认 stderr 是 inherit，
Weave 必须显式使用 pipe、持续排空并丢弃原文，仅记录字节计数；stderr 不进入持久日志。stdout
协议缓冲、单工具结果和适配后的文本/结构化结果都要有独立字节上限。

### 3. 配置、信任和启动闸门

MCP 配置与信任共同写入独立的 append-only SQLite authority 事件流，且不复用 Stage 4
ESM 插件信任事件。MCP 配置包含命令、argv、cwd 和显式环境引用；固定的高风险工具策略
以 policyVersion 参与摘要，映射由宿主确定。配置哈希用于发现配置变化和审计，
但**不复用 ESM 插件目录 SHA-256 的信任语义**。配置哈希不能证明命令实际执行的代码未变，
也不能替代用户对命令、路径和环境的确认。

任何 `spawn` 或 MCP `initialize`/handshake 之前，Server 必须折叠配置/信任事件并确认
当前配置处于允许启动的状态。未信任、配置变化、禁用、撤销、命令不可执行或声明不兼容
的条目不得启动进程。启动失败只隔离该 MCP 条目并投影安全的临时失败状态；不得让整个
Runtime 或已有 Generation 失效。

stdio 没有操作系统级 sandbox。`roots` 不在第一版能力范围内，也不能被当作强制的文件
边界；命令本身仍可使用它拥有的用户权限访问文件、网络和凭据。信任文案必须明确这一
限制。

### 4. Tool、审批和 Pipeline

第一版将所有 MCP tools 视为 `readOnly: false`，无论 MCP `ToolAnnotations` 如何声明。
这些 annotations 是不可信提示，不能降低权限或审批等级。宿主为 `mcp.call_tool`
统一生成 **high** 风险审批，并遵循既有 `ask` / `trust` / `yolo` 策略：策略只能由
受保护的 Approval/Tool Pipeline 决定，模型不能改变工具权限、信任或启用状态。

调用前由宿主使用 SDK bundled JSON Schema validator 校验 `inputSchema`；每个 schema
使用隔离的 validator 实例。具体支持的 schema 子集、大小和复杂度限制由 companion spec
定案，不在此 ADR 固定。校验失败不得发送 `tools/call`。

`isError: true` 是工具执行失败的 MCP 结果，不是协议传输失败。适配器将其转换成带稳定
`code` 的 `McpToolError`，由 Pipeline 既有的 `cause` 承载，并映射为 Agent 可恢复的 tool
failure，使模型可以看到失败并自行修正。协议错误、超时、取消、schema 错误和连接关闭
则走 Pipeline 的系统错误路径，不伪装成普通工具结果，也不对可能已产生副作用的调用
自动重试。

适配器对 content blocks、structured content、错误消息和诊断输出执行字节上限。非 text
结果（图片、音频、资源链接、embedded resource）不隐式读取、跟随、解码或渲染；必须按
明确的宿主策略保留、摘要或报告为不支持结果。

### 5. Generation 和连接生命周期

每个 Generation 为每个 MCP 配置持有独立的 stdio client/transport、工具描述和固定
工具快照。一次 Agent 回合捕获 Generation 后始终使用同一连接和同一描述；重载、信任
变化或配置变化构建新 Generation，并从下一回合生效。旧 Generation 在最后一个回合结束
后再关闭连接；关闭必须是幂等且有界的。

SDK 的 `listTools()` 默认自动聚合分页；Weave 使用 SDK 的底层 request 逐页读取，
在聚合前检查页数、工具数量、描述/schema 字节和总耗时。`list_changed` 只将当前
catalog 标记为 stale；它不能自动刷新或直接改变当前
Generation 的注册表。新快照必须经过完整校验、命名冲突检查和审批配置后，才能发布为
下一 Generation。工具调用不因 catalog 变化、断线或超时自动重试。

MCP client 复用 SDK 的 `AbortSignal`、请求 timeout 和 close 语义。stdio 取消是合作式
的：已发请求通常会发送 `notifications/cancelled`，但不能保证远端停止副作用；连接
关闭会结算 pending requests。固定 SDK public `close()` 还存在父端管道可能保活宿主的
缺口；5.1b 用版本固定的最小 pnpm 补丁释放父端管道并保证 close 通知一次，以独立
宿主退出 fixture 验证，具体范围见设计 §7.3。SDK 不保证清理进程树，因此 Server
按 Generation 处理租约并执行有界的 best-effort 关闭，不宣称 OS 权限隔离或进程树终止保证。

## Alternatives Considered

### 自己实现原始 JSON-RPC/stdio

可以减少依赖，但必须自行维护 MCP schema、版本协商、分页、取消通知、错误分类、消息
缓冲和进程关闭，容易产生协议漂移和安全遗漏。拒绝；Weave 只在 SDK 之上实现宿主
策略、快照和适配。

### 把 MCP 直接塞进 ESM plugin loader

表面上复用 Stage 4 的 loader，但会把不可信进程协议和高权限 in-process ESM 混成一个
信任/摘要模型；配置变化也会错误地继承目录代码摘要语义。拒绝；两者在 Server/Generation
组合处汇合，拥有独立事件流和风险文案。

### MCP 和 ESM 分别发布完整 Generation

两个 manager 各自使用缓存组装完整 Generation，会用陈旧的对方状态覆盖刚完成的
启停或撤销。拒绝；Server 只保留一个串行协调器，并在发布临界段复验所有来源的
authority 和 desired revision。安装、签名和市场另属 Stage 6。

### 同时引入安装和市场

可提供市场、版本和签名，但会提前引入下载、依赖解析、更新回滚和供应链信任面。拒绝于
Stage 5；第一版只运行用户已配置并明确确认的本地命令。发布、安装、签名和市场留给后续
Stage 6。

## Consequences

- MCP 工具进入已有 Tool Pipeline、Approval、Agent recoverable failure 和 Generation
  机制，不会形成第二套工具执行路径。
- `@weave/mcp-client` 可以独立测试和复用，但不会把 Server 或 Kernel 依赖向下泄漏。
- 用户需要分别确认 ESM 插件代码与 MCP 命令；两者的配置变更、信任、撤销和审计记录互不
  覆盖。
- stdio 提供进程边界和协议边界，但不是 OS sandbox。更强的权限代理、roots 强制、HTTP
  MCP、进程树治理、签名和安装器需要后续 ADR。

## Follow-Up

实施顺序和验收用例写在 [`2026-11-21-mcp-stdio-design.md`](../superpowers/specs/2026-11-21-mcp-stdio-design.md)：先保持行为不变地提取 ESM source 和 Server 统一协调器，再定义
独立 client contract 和 fixture server，随后做 `plugin-builtins` 适配、Server
authority 事件与管理接口、Studio 管理入口。
每一项从最新 `origin/main` 建独立分支和 PR；本 ADR 保持 Proposed，待设计评审和第一轮
实现验证后再 Accepted。

## References

以下官方资料均固定到已核实的 SDK `v2.4.0`，避免把 v1 和 v2 API 混用：

- [Client 源码：版本协商、Tools API、分页和输出校验](https://github.com/modelcontextprotocol/typescript-sdk/blob/v2.4.0/packages/client/src/client/client.ts)。
- [stdio transport 源码：argv、环境白名单、缓冲与关闭](https://github.com/modelcontextprotocol/typescript-sdk/blob/v2.4.0/packages/client/src/client/stdio.ts)。
- [公开 JSON Schema validator 入口](https://github.com/modelcontextprotocol/typescript-sdk/blob/v2.4.0/packages/client/src/validators/ajv.ts)与 [AJV provider 实现](https://github.com/modelcontextprotocol/typescript-sdk/blob/v2.4.0/packages/core-internal/src/validators/ajvProvider.ts)。
- [协议基础：超时、取消和连接关闭](https://github.com/modelcontextprotocol/typescript-sdk/blob/v2.4.0/packages/core-internal/src/shared/protocol.ts)。
- [v2 行为变更说明](https://github.com/modelcontextprotocol/typescript-sdk/blob/v2.4.0/skills/mcp-typescript-sdk-upgrade-to-v2/references/behavioral-changes.md)。
