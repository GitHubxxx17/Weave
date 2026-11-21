# Stage 5 — 本地 stdio MCP Tools 设计

状态：用户已于 2026-11-21 确认推荐方案。5.1a–5.2 已合入；5.3 Server 管理正在实现，5.4 Studio 尚未接入。本文规定完整跨包契约。
基线：`origin/main` 的 `a0b38b4`（Stage 4.5，PR #76）。
决策记录：[ADR 0004](../../adr/0004-mcp-stdio-tools.md)。
实施计划：[5.1a 统一扩展协调器](../plans/2026-11-21-extension-coordinator.md)、
[5.1b stdio 客户端](../plans/2026-11-21-mcp-stdio-client.md)。

产品对标 Codex、Kiro、DeepSeek Harness；参考来源和当前采用原则见
[Foundation 的 Product references](../../architecture/foundation.md#product-references)。
以下取舍保持 Weave 自身的回合边界、共享工具执行和显式信任规则。

## 1. 目标和首版范围

让用户在 Studio 配置、审阅并信任一个本地 MCP 服务，把它的工具加入现有
Agent 的 Tool Pipeline，并沿用下一回合生效、审批、取消和持久会话记录。

第一版包含用户级 `stdio`、Tools、固定工作目录、显式环境变量引用、管理界面、
进程生命周期和 Generation 切换。只运行用户明确确认的命令，不安装或下载服务。
HTTP/SSE transport、Resources、Prompts、Sampling、Elicitation、roots、Tasks、
OAuth、项目提供的启动配置、自动重连、文件监听和市场安装不在本阶段范围内。
配置不是 `weave-plugin.json` 的扩展，也不从仓库内的 MCP 配置文件自动导入。

`stdio` 是独立进程通信，**不是 OS 沙箱**。子进程拥有启动用户的普通文件、网络
及进程权限；`cwd`、环境变量过滤、工具审批和 WorkspacePolicy 不能限制它启动时
或后台的行为。信任发生在任何进程启动、初始化或工具发现之前。

## 2. 方案选择

| 方案                                                | 优点                                           | 代价与结论                                                             |
| --------------------------------------------------- | ---------------------------------------------- | ---------------------------------------------------------------------- |
| 独立协议客户端 + 内置工具适配器 + Server 单一协调器 | 协议、Agent 工具与管理职责清楚；保留现有包边界 | 需要先提取 ESM 来源和迁移 Server 编排；采用                            |
| 直接把 command/args 加进本地 ESM loader             | 表面改动少                                     | 启动信任与代码目录摘要语义不同，也不能解决两个发布者互相覆盖；不采用   |
| 把 plugin-host 泛化为通用多协议宿主                 | 未来协议扩展方便                               | 当前缺少第二个稳定实现，扩大公共 API；首版只提取具体 LocalPluginSource |

使用官方 `@modelcontextprotocol/client` **2.4.0**，避免自行实现 JSON-RPC。
Weave 保持 Node >=24.4.0 和现有 Zod 4.6.7，满足 SDK 的 Node >=20 / Zod ^4.2.0。
使用显式 `versionNegotiation: { mode: 'legacy' }`，首版走 initialize 协商。
不启用 `auto`：该模式搭配 stdio transport 会额外启动一次探测进程。
旧 `@modelcontextprotocol/sdk` 1.x 的入口不用于新包。

## 3. 包边界与文件归属

| 单元                               | 负责                                                          | 依赖                                          |
| ---------------------------------- | ------------------------------------------------------------- | --------------------------------------------- |
| 新包 `@weave/mcp-client`           | stdio、协议校验、工具快照、JSON Schema 校验、调用、取消和关闭 | 官方 client 2.4.0、Zod；不依赖任何 `@weave/*` |
| `plugin-builtins` 的 MCP 适配器    | 把连接和快照转为 KernelPlugin / ToolDefinition                | `mcp-client`、现有 plugin/runtime             |
| `plugin-host` 的 LocalPluginSource | 原有 ESM 发现、信任折叠、摘要复验和新实例准备                 | 仍只依赖 plugin；不引入 MCP 或 Runtime        |
| Server ExtensionCoordinator        | 所有扩展的变更队列、完整候选组装、发布和状态投影              | ESM source、MCP source、现有 ServerHost       |
| Server MCP 管理                    | 配置/信任事件、环境引用解析、HTTP 适配                        | 协调器；不直接调用工具                        |
| Studio MCP 管理                    | 配置和信任审阅、状态、启停/重载                               | 仅 HTTP；不导入 workspace 包或 Node           |

实施时更新根 ESLint：注册 mcp-client 为无内部依赖的独立叶子包，仅允许
plugin-builtins 和 server 消费。为调用的外部包声明直接依赖。Server 不把 SDK
或原始 MCP 协议类型泄露进 HTTP。现有 Runtime/Protocol 不需要为 MCP 增加专用类型。

主要新增文件按责任分开：

- `packages/mcp-client/src/{types,limits,schema,stdio-connection,index}.ts`。
- `packages/plugin-builtins/src/{mcp-plugin,mcp-tool,mcp-result}.ts`。
- `packages/plugin-host/src/{local-plugin-source,local-source-types}.ts`。
- `apps/server/src/{extension-coordinator,extension-types,mcp-source,mcp-authority-store,mcp-management-types,mcp-api,mcp-environment}.ts`。
- `apps/studio/src/features/mcp/` 下的 HTTP 客户端、目录状态、配置/信任对话框和面板。

测试放各单元的 `test/`。真实 stdio 测试使用仓库自己的 fixture，不运行下载的服务。

## 4. 配置、环境与启动信任

### 4.1 用户级配置

配置存入现有数据目录下的 SQLite 数据库，新建 `mcp_authority_events` 表。
不新增可执行配置文件，不复用 ESM 的 `plugin_trust_events`。

```ts
interface McpServerConfig {
  readonly schemaVersion: 1;
  readonly id: string; // ^[a-z0-9]+(?:-[a-z0-9]+)*$，最多 24 个 ASCII 字符
  readonly label: string; // 1..80 字符，仅展示
  readonly transport: 'stdio';
  readonly command: string; // 用户指定的绝对可执行文件路径，保存 realpath
  readonly args: readonly string[]; // 最多 64 项，每项最多 4096 UTF-8 字节
  readonly cwd: string; // 用户指定的绝对目录，保存 realpath，不随 Session 改变
  readonly env: Readonly<Record<string, { readonly fromHostEnv: string }>>;
}
```

最多配置 8 个服务；每份规范配置最多 64 KiB。command/cwd 必须存在，路径解析与
文件类型检查失败时不能信任。Windows 首版要求可直接执行的程序；不自动通过 shell
包装 `.cmd`/`.bat`。使用 argv 数组和 `shell: false`。显式选择解释器仍属于用户的
启动授权，不会获得沙箱权限。参数用于非秘密配置；凭据通过环境引用传入。

环境映射最多 32 项，变量名使用 `^[A-Za-z_][A-Za-z0-9_]*$`。目标名及引用名
均按大小写不敏感规则拒绝 `WEAVE_` 前缀；Windows 还拒绝目标名/引用名各自集合
中的大小写别名，并将规范配置的目标名及引用名统一为大写。这样传入 PATH 能按
SDK 的覆盖顺序替换默认 PATH，避免 PATH/Path 审阅与实际选值不一致。只读取显式列出的宿主变量；
不存在时启动失败。每个候选
构建只解析一次并冻结到该连接，禁止扩散 `process.env`、自动读取 `.env` 或
把 Provider 的凭据交给 MCP。首版不增加凭据保险库或环境变量明文输入框。

官方 transport 还会继承它的系统环境白名单；`env: {}` 不代表零继承。POSIX 是
HOME、LOGNAME、PATH、SHELL、TERM、USER，Windows 白名单按固定 SDK 版本定义。
界面说明该继承规则；显式传入的 env 只能来自上面的引用解析。

### 4.2 信任绑定的对象

`configDigest = SHA-256(canonicalJson({ schemaVersion, id, transport, command,
args, cwd, env, policyVersion: 1 }))`。canonicalJson 按对象键排序，保留数组顺序，
UTF-8 编码；路径已规范化。label 不参与摘要。固定限额和全部高风险审批策略由
policyVersion 表示；未来放宽权限或启动策略时提高版本并要求重新确认。

信任授权的是**这个规范启动配置及其显式环境引用**。秘密值不参与摘要或事件，
不保存它的 hash；引用变量的轮换无需重新信任。配置引用名变化会改变摘要。
可执行文件、argv 指向的脚本、动态依赖和 npm 缓存变化均不被此摘要证明；首版
不声称拥有 ESM 那样的目录代码内容信任。启动前再次 realpath/stat；路径变化或
消失则失败，但同一路径内容变化不能可靠检测。界面必须直接说明该授权含义。

保存新配置或修改参与摘要的字段后默认不受信任且停用。只有 `trust` 操作对当前
精确摘要追加信任，才启用该配置并请求构建候选；不能先启动以预览工具。信任
弹窗展示规范 command、完整 argv、cwd、环境目标与引用名、系统继承规则及普通
用户进程权限。工具数量和清单在启动后才可见，无“启动前已审阅全部工具”承诺。
新增工具在用户触发的全量管理重建后加入新代，仍逐次经过高风险审批，不另设工具
免批名单。reload 是专门入口，ESM/MCP 信任和启停操作也会触发全量重建。

### 4.3 追加事件与并发

```ts
type McpAuthorityEvent =
  | { kind: 'configured'; config: McpServerConfig; configDigest: string }
  | { kind: 'trusted'; serverId: string; configDigest: string }
  | { kind: 'enabled'; serverId: string; configDigest: string }
  | { kind: 'disabled' | 'revoked' | 'removed'; serverId: string };
```

每条记录额外带全局连续 `sequence`、ISO `occurredAt`、`scope: 'user'`、
`schemaVersion: 1`。事务读取并校验历史，比较调用者 `expectedSequence` 后追加。
configured 不沿用旧信任，label-only 修改保留相同摘要的信任和 enabled 状态；
removed 留下 tombstone，重新创建同 ID 需重新信任。revoked 清除信任，disabled
保留信任。enable 必须匹配当前受信摘要。记录没有秘密值、原始异常或 stderr。

数据库读取异常、序号回退、事件不合法都是 authority failure，不能解释为空列表。
本阶段只有一个 Server 写入者；管理变更均从协调器进入。不承诺多进程实时同步，
另一个 Weave 进程的外部变更在下一次 refresh 才会被观察到。

## 5. MCP 客户端契约

以下为新包公共契约，实际导出相同职责的具名类型；HTTP 不直接引用它们。

```ts
interface McpToolSnapshot {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
  readonly outputSchema?: Readonly<Record<string, unknown>>;
  readonly annotations?: Readonly<Record<string, unknown>>;
}
interface McpValidationResult {
  readonly valid: boolean;
  readonly issue?: string; // 固定、限长的错误说明，不包含输入值
}
interface McpConnection {
  readonly tools: readonly McpToolSnapshot[]; // 复制后深冻结
  validateInput(toolName: string, input: unknown): McpValidationResult;
  callTool(
    name: string,
    input: Readonly<Record<string, unknown>>,
    options: { readonly signal: AbortSignal },
  ): Promise<McpCallResult>;
  close(): Promise<void>; // 幂等
}
```

`McpCallResult` 是协议校验后的 content、structuredContent、isError 的类型化结果；
保留文本/二进制/资源块的种类供适配器决定处理方式，不主动访问资源。`connectMcp`
接收已授权且环境已解析的启动参数、AbortSignal，以及同步的 stale/closed 状态回调，
返回 `Promise<McpConnection>`。客户端不知道信任数据库，也不自行决定某配置可运行。

Client 选项：`capabilities: {}`、`enforceStrictCapabilities: true`、
`inputRequired: { autoFulfill: false }`、显式 legacy。不注册宿主能力的请求处理器。
`listChanged.tools.autoRefresh` 为 false；通知只将所属连接标为 stale，不改冻结目录。
`onerror/onclose` 和 stderr reader 在 connect 前注册；无 tools capability 的服务失败。

先 initialize，再手动逐页 `tools/list`：使用 SDK `request` 和公开结果 schema，
每页立刻检查总数/字节/cursor，避免 `listTools()` 自动聚合先分配巨大目录。
cursor 重复即失败，空字符串也是合法 cursor。预编译全部输入/输出 schema，
出现重复工具名或任意不支持的 schema 时，该服务整组加载失败，不静默隐藏工具。
每次 callTool 传入该代冻结的 `toolDefinition`，不能依赖 SDK 的可变目录缓存。

默认限额固定在 policyVersion 1：

| 对象                                  | 限额/行为                                                                |
| ------------------------------------- | ------------------------------------------------------------------------ |
| initialize + 全部分页 + schema 预编译 | 总计 15 秒；每次异步协议请求都受外层 signal 约束                         |
| 工具目录                              | 最多 16 页、64 个工具、512 KiB 聚合描述                                  |
| 单工具                                | 原名最多 256 UTF-8 字节；description 最多 4 KiB；每份 schema 最多 64 KiB |
| 协议缓冲和返回结果                    | transport `maxBufferSize` 2 MiB；单个已解析结果最多 1 MiB                |
| 单连接调用                            | 最多 4 个同时在途调用；超额立即返回 busy，不设隐藏执行队列               |
| 单次调用                              | 最多 120 秒，且受上层 Pipeline/Turn signal 约束；progress 不延长总时限   |
| Server 进程预算                       | 包括候选、当前与退役代最多 32 个；耗尽时新候选失败，不抢占旧回合         |
| stderr                                | 始终排空并丢弃原文，仅保留字节计数；不写终端、事件、HTTP 或日志          |

SDK buffer 限额不等于所有 JSON 分配的硬内存限制；同步 schema 编译也不受异步计时器
强制抢占。它们是资源预算和兼容性边界，不是对任意恶意本地进程的隔离保证。

## 6. Schema 校验、命名、审批和结果

### 6.1 实际校验 schema

使用 SDK 公开的 `AjvJsonSchemaValidator`，每份 input/output schema 首次编译使用
独立实例，并按本代精确 schema 内容缓存已编译函数。SDK 的 provider 先按 `$id`
查缓存，新实例仍可能命中预置 meta-schema；因此首版在所有 schema 位置拒绝 `$id`，
不能只靠实例隔离。不添加第二份 AJV 依赖。根 inputSchema 必须是 `type: 'object'`；
缺省 `$schema` 按 Draft 2020-12，仅接受该 dialect，且 `$schema` 只允许出现在根。

首版同步校验采用明确子集：type、properties、required、additionalProperties、
items、enum、const、minimum、maximum、exclusiveMinimum、exclusiveMaximum、
multipleOf、minLength、maxLength、minItems、maxItems、minProperties、maxProperties、
anyOf、oneOf、allOf、not，以及 `$schema`、title、description、default、
examples、deprecated、readOnly、writeOnly 注解。允许嵌套布尔 schema。拒绝其他
schema 关键词，包括 `$id`、所有 `$ref`/动态引用、`$async`、pattern/patternProperties、
format、uniqueItems 和 unevaluated/conditional 等扩展；不静默删除关键词。

SDK 默认 `validateSchema: false`，所以宿主不能仅依赖 compile 成功。关键词的值
必须按上述子集的 Draft 2020-12 形状校验：required 为不重复字符串数组、properties
为 schema 映射、计数/长度为非负整数、multipleOf 为正有限数、type 为合法类型或
不重复类型数组、组合子为非空 schema 数组等；类型不符同样拒绝整个服务目录。

检查沿 schema 位置递归，enum/const/default/examples 是普通数据，不把其属性名
误认成关键词。完整 schema JSON（含注解及普通数据）深度最多 32、节点最多 2048；组合分支总数最多 32、组合
嵌套最多 4 层。输入值最多 64 KiB、深度 32、节点 4096。校验不补默认值、不转型、
不删除属性；注解不改变权限。输入及 schema 必须是有限数、无循环的纯 JSON 值，
拒绝 undefined、BigInt、函数及非普通对象，防止独立调用者的输入在序列化时改变。
拒绝异步 validator，编译抛错或不支持关键词报
`mcp-unsupported-schema`。子集会拒绝部分标准兼容服务，UI 要展示原因，不能称
“支持任意 MCP schema”。后续扩展正则、引用等需要独立 Worker 校验与超时设计。

工具 `inputSchema` 使用保留全部字段的 Zod 对象校验（`z.object({}).passthrough()`）
加 refinement 调用 validateInput；字段是否允许由 JSON Schema 决定，禁止 Zod
默认剥离字段。失败产生
Zod issue，Pipeline 在审批/执行前返回 `tool-invalid-arguments`。不能使用只有
`z.unknown()` 或 `z.record` 的透传验证。mcp-client.callTool 也复验输入，保证其
独立调用者不能绕过 schema。成功结果的 outputSchema 用相同子集预编译，交给
SDK 的隔离 validator provider 校验。该 provider 返回准备阶段的缓存函数，避免每次
callTool 都重新编译；未知 schema 拒绝。isError 跳过成功输出 schema，按失败处理。

### 6.2 命名与插件归因

每个服务生成一个受宿主管理的 `KernelPlugin`，ID 为 `mcp-<serverId>`，
`host: 'mcp'`，版本/apiVersion 使用当前宿主支持的数值版本，`contributes.tools`
是这代工具的封闭清单。与现有插件 ID 冲突时拒绝新增 MCP 配置，不重命名旧插件。

工具公开名为 `mcp_<serverId>_<slug>_<hash>`；slug 是原名转为 `[a-z0-9_]` 后
的前 10 字符，空则用 `tool`；hash 为原名 UTF-8 SHA-256 的前 16 个十六进制字符。
总长最多 56，符合 `[a-zA-Z0-9_-]{1,64}`。检测摘要碰撞以及与内置/ESM 工具的
重名，失败归因到本服务，不覆盖或 fallback。映射和原名按代固定，实际 tools/call
只使用保存的原名。远程描述、标题、annotations 始终是第三方内容。

### 6.3 工具权限

所有首版 MCP 工具一律 `readOnly: false`，显式声明
`approval: { operation: 'mcp.call_tool', risk: 'high', summarize }`。
摘要包含服务 ID、工具原名和映射名、固定 cwd、参数字节数及字段名；不复制参数
值或启动凭据。审批通过 toolCallId 关联现有 ToolStep 参数详情，用户能辨别不同
目标的调用；在审批卡上提供到该现有详情的定位。审批属于现有 Broker，不引入第二套批准/拒绝状态。

遵循已有权限模式：ask 和 trust 对此操作询问，yolo 按既有语义跳过普通审批；
策略 Hook 仍能进一步 ask/deny。第三方 readOnlyHint 等注解不得赋予免批权限。
工具只经 `weave.tools` 扩展点注册，只经共享 Pipeline 调用；MCP 进程拿不到
PluginSdk、ApprovalBroker、Session writer、Provider 或管理接口代理。

### 6.4 返回内容与失败

文本和 structuredContent 转为带服务/工具归属的普通工具结果。图片、音频、
资源链接和嵌入资源不下载、不解码、不塞 base64；混合结果保留文本/结构化数据，
附省略类型及数量。完全没有受支持内容且包含这些块时返回
`mcp-unsupported-result` 失败；合法的空 content 且无不支持块允许空成功。
最终成功内容沿用 Pipeline 的 32,000 UTF-8 字节上限及截断标记。

`isError: true` 抛出带 `code: 'mcp-tool-error'` 的 `McpToolError`，其 message
只取经过限长的文本/结构化错误摘要，最多 4 KiB。现有 Pipeline 把它包装为
`tool-execution-failed`，AgentRunner.describeToolFailure 读取带 code 的直接 cause，
保留可读信息，并记录 `status: 'failed'`，模型可以继续修正参数。无需新增 Runtime
的 MCP 专用错误或协议事件。测试必须同时覆盖模型内容、持久失败状态和 UI 失败状态。

传输/初始化/校验失败使用固定错误码和安全消息，不透出原始 SDK exception、argv、
stderr 或堆栈。适配层对将暴露的内容替换本连接显式 env 的已知值，再做字节裁剪；
这只覆盖已知凭据，不能把任意服务返回内容保证为无秘密。工具输出仍是第三方数据。

## 7. 单一 Generation 协调与资源所有权

Server 的 ExtensionCoordinator 是完整候选唯一发布者。配置内置插件、ESM source
与 MCP source 的全部变更进入同一串行队列；启动不再同时创建另一个拥有 controller
的 createPluginHost。`createPluginHost` 保留为独立使用的兼容门面，Server 路由
使用协调器提供的 ServerPluginManager 窄视图，现有 `/plugins` HTTP 契约保持兼容。

### 7.1 先迁移 ESM 来源，保持行为不变

LocalPluginSource 只公开 `snapshot()`、`refresh()`、`mutate(command)`、
`prepare(stamp, { signal, excluded })`、`recheck(prepared, signal)`、`close()`。
具体 controller 类型命名为 `LocalPluginSourceController`，保留 loader 已导出的
`LocalPluginSource` 数据类型别名，避免破坏既有消费者。
stamp 含单调 revision 和 trustSequence；仅 authority 或发现身份实际变化才增加
revision，无变化 refresh/recheck 保持同一 stamp。prepare 返回全新 KernelPlugin 生命周期、
identity、归因失败、幂等 dispose。source 不保存 active generation，不发布或
销毁 controller；现有 loader 的 import 前摘要复验和 setup deadline 保留。

source 接收同步 `onAuthorityChange({ snapshot, reason, affectedIds, immediate })`
宿主回调。每次读到或成功追加信任后，先更新冻结缓存，再同步通知，之后才允许
下一次 await。协调器只对实际 authority 变化同步更新 desired revision；停用/撤销/移除或已生效
配置失去信任时 blockNewRuns，可选 abortActiveRuns。不能在 `await mutate()`
之后才 block。append 失败不能修改 authority 或取消回合。

### 7.2 完整候选和发布

每个候选带 `desiredRevision`、各 source stamp 和完整 membership。prepare 从最新
authority 取全量 enabled/trusted 来源，每代创建独立 Tool/Provider Registry、内核、
MCP 连接及进程。已分配但尚未进入内核的资源也归候选清理器，所有 disposer 幂等。
MCP 连接在 KernelPlugin 构造前准备目录；setup 只贡献已经冻结的工具。

发布前重新读全部 authority 并复验身份。所有异步工作完成后，在同一个无 await
临界段检查：宿主未关闭、revision/stamp 未变、generation ID 前进、全部实际成员
仍获授权、所有 admission latch 均满足，然后同步提交指针、membership 与该 revision
的 latch 状态。5.1a 必须增加显式同步成功/失败的提交契约：

```ts
// GenerationController；ServerHost 提供相同语义的 ServerGeneration 特化。
commit(next: RunnerGeneration<R, E, T>, options?: { immediate?: boolean }): {
  readonly retirement: Promise<void>;
};
```

commit 在返回前完成全部验证和 current 指针切换，验证失败同步 throw，不能声明为
async。原 replace/publish 的 Promise API 保留兼容并包装 commit 后等待 retirement。
Server 协调器只调用同步 commit，成功返回后立即提交 membership/latch，再 await
retirement；不能把现有 async publish 的调用返回视为提交成功。
retirement 保持既有 replace/publish 的等待语义：仅等待提交时可立即开始的退役清理；
旧代仍有 pin 时可以立即完成，该代最后一个回合结束后再自行清理。它不表示全部旧回合
已经 drain，不能让管理响应等待用户尚需操作才能结束的回合。
不能因一个旧 publish 的 retirement 完成而清掉关闭/新撤销设下的阻断。
GenerationRunner.replace 会清除 blocked，因此“先发布，再检查或补 block”不可行。

已 pin 的旧回合继续使用旧连接；下一回合 pin 新代，同 Session 顺序保持不变。
最后一个旧回合结束才关闭旧连接；立即停用/撤销取消当前及所有退役代回合。
任意来源变更可能新建所有 enabled MCP 进程，旧/新代会暂时并行。这要求服务可并发
启动；独占端口/锁的服务可能重载失败。首版不跨代共享连接来掩盖这个限制。

`tools/list_changed` 仅标记 stale，本身不触发重建；用户触发任意完整管理重建时
重新发现全部 enabled 来源。独立连接固定本地
工具/schema 快照，不能保证服务端内部实现或数据不自行变化。崩溃/EOF 使该连接
pending calls 失败，标 failed；不自动重启或重发。其他来源继续工作，恢复需用户重建。
所有回调绑定 attemptId/connectionId、configDigest 和 generation，候选及退役连接的
stale/EOF 不得覆盖当前健康连接的状态。候选准备期的 list_changed 必须带入新代的
stale 标记，不能因发布就丢弃。

### 7.3 失败隔离与关闭

单 ESM 插件或单 MCP 服务的启动/schema/setup/可归因装配失败可排除该 identity，
以全新实例重建健康集合。排除集合严格扩大，最多 N+1 次装配；身份变化的 refresh
保留现有有界预算。共享 authority 读取失败、损坏记录和不可归因装配失败，保留
旧指针与已有 admission latch，不能伪装为成功的空来源。durable revoke 后即使
装配失败，后续 ESM reload 也不得带回已撤销 MCP 或用陈旧候选解封。

调用 abort/timeout 时本地 promise 及时拒绝，发协议取消并忽略迟到结果；不等待
服务端确认，不自动重试。初始化失败也关闭 transport。协议取消不会回滚副作用。
一个调用取消不关闭仍被其他回合使用的连接。

关闭入口同步拒绝新管理操作/回合，并给候选及所有当前/退役回合发送取消；然后
等待候选资源释放和所有代 drain → 关闭 source → 最后关闭持久库。不能先等待
候选清理，才取消当前回合。SDK close 先关 stdin，最多等 2 秒，再 SIGTERM
等最多 2 秒，必要时 SIGKILL；外围以 5 秒为关闭等待上限，记录固定清理失败。
固定版本 SDK public close 未销毁全部父端管道，孙进程继承写端时可能保持 Weave
事件循环。5.1b 增加针对 2.4.0 的最小 `pnpm.patchedDependencies` 补丁：close 的
finally 中销毁它拥有的 stdin/stdout/stderr 及 stderr PassThrough、清除读取缓冲，
确保 onclose 仅通知一次并结算 pending calls；同时覆盖 ESM/CJS 分发入口。不从
Weave 访问 SDK 私有字段，不修改协商或工具协议。补丁理由和上游固定版本记录在
新包 README；升级时用回归测试判断能否删除补丁。独立宿主子进程 fixture 必须
验证服务启动继承 stdio 的后代后退出时，Weave 宿主能真正退出，不只检查 close 返回。
这只释放宿主句柄，不保证清理孙进程，也不等待最后 SIGKILL 完成，不能宣称进程树被完全回收。
retirement 清理失败不回滚已发布的新代，最终 shutdown 汇总错误。

## 8. Server HTTP 契约

路由薄适配协调器。GET 只读缓存、不启动进程；写接口全部复用 JSON-only、回环
Host、Origin 和 Sec-Fetch-Site 检查，给安全守卫增加通用的错误文案。开发代理补
`/mcp`。管理功能不注册为模型工具，也不由斜杠命令绕过信任步骤调用。

| 路由                            | 请求/结果                                                            |
| ------------------------------- | -------------------------------------------------------------------- |
| `GET /mcp`                      | authoritySequence、服务记录、当前 generation/admission、固定失败信息 |
| `POST /mcp/servers`             | `{ expectedSequence, config }`，创建停用且未信任配置                 |
| `PUT /mcp/servers/:id`          | `{ expectedSequence, config }`，ID 必须相同，按摘要决定是否失去信任  |
| `POST /mcp/servers/:id/trust`   | `{ expectedSequence, configDigest }`，精确信任并请求新代             |
| `POST /mcp/servers/:id/enable`  | `{ expectedSequence, configDigest }`，必须已受信                     |
| `POST /mcp/servers/:id/disable` | `{ expectedSequence, immediate?: boolean }`                          |
| `POST /mcp/servers/:id/revoke`  | 同 disable；清除信任                                                 |
| `POST /mcp/servers/:id/remove`  | 同 disable；保留 tombstone                                           |
| `POST /mcp/reload`              | `{ expectedSequence }`，刷新全部来源并构建完整候选                   |

GET 每条记录带 config、configDigest、trustedDigest、enabled、state、stale、
active、drainingGenerations、受限的工具清单/annotations 和 issue；没有环境变量值或日志。
active 只表示当前已发布代，drainingGenerations 是仍持有连接的旧代 ID 和配置摘要，
最多 32 条。state 为 `removed / changed / untrusted / disabled / connecting / loaded / failed`，
stale 为独立标记。优先级及含义如下：

- removed：已移除，但 current/退役代尚持有连接时仍保留安全配置和归属，全部释放后
  可从常规列表隐藏；追加历史不删除。
- changed：曾受信后改动摘要字段，当前信任已失效且停用；旧审阅配置单独作差异来源，
  不把它列为当前有效 trustedDigest。新配置或已明确 revoked 的配置为 untrusted。
- disabled：当前摘要受信但停用；当前/退役代可能仍有连接，用 active/draining 呈现。
- 对启用且受信配置，候选正在准备时 connecting；当前健康连接且摘要匹配时 loaded；
  最近准备或当前连接失败时 failed。failed 保留 issue，不因 registry 仍有工具而改回 loaded。

`/plugins` 继续列出当前代的合成 MCP 插件（host:mcp），但不把它伪装为带
local.directory/digest 的 ESM 插件。这里的 loaded 只表示内核贡献仍注册，
`/mcp` 才是连接健康状态权威；EOF 后可以同代出现 registry loaded、连接 failed。
`GET /plugins` 增加向后兼容的顶层 `generation: { id, acceptingRuns, blocked? }`，
即使关闭本地 ESM 发现也返回；`/mcp` 使用同一结构。不能依赖只有开启 ESM 时
才存在的 local.generation 来判断两个目录是否同代。

格式非法 400、不存在 404、sequence/digest/信任冲突 409、安全守卫 403/415、
持久库失败 500。成功持久化但重建部分失败返回 200，带 `applied: false` 或
失败成员和真实 generation/admission；不能把 durable decision 回滚成界面成功假象。
配置和信任成功启动失败仍保留授权及失败状态，下次 reload 可以重试进程启动。

## 9. Studio 行为

插件面板增加 MCP 分组与“添加本地 MCP 服务”，沿用共享目录刷新和 next-turn
提示。表单收集可执行路径、argv 列表、固定 cwd、环境目标/引用名；保存后进入
未信任状态。用户在独立确认弹窗审阅规范配置后才启动。取消为默认焦点，支持
键盘、焦点返回、滚动内容和窄窗口。命令/参数按纯文本渲染，不执行链接或 HTML。

载入后展示工具清单、schema、第三方注解及高风险审批规则。目录变化显示 stale
和“重新加载”；配置变化显示原授权与新配置差异。启用、停用、撤销和移除分别
表达是否保留信任。立即生效只用于停用/撤销/移除，影响所有旧回合，不能只检查
当前选中 Session。409 必须重新拉取目录并重新审阅，不自动重新提交信任。

MCP 状态从 `/mcp` 获取，当前内核插件仍来自 `/plugins`；面板将 host:mcp 的行合并
到 MCP 分组并使用 `/mcp` 的健康状态，不再重复展示一条健康的普通插件行。两者的 generation
不一致时重新拉取，不拼出自相矛盾的“已加载”状态。界面持续显示已持久化决定、
当前代和重建失败。工具调用、审批、结果使用现有对话过程展示，不造第二套流程。

## 10. 验证与交付切分

各 PR 从合并后的最新 origin/main 新建主题分支，CI 通过后 squash merge。
先完成行为不变的编排迁移，再实现协议客户端；不把全部 Stage 5 塞进一个 PR。

| 步骤            | 分支建议                     | 交付和验收                                                                                           |
| --------------- | ---------------------------- | ---------------------------------------------------------------------------------------------------- |
| 5.0 设计        | `docs/mcp-stdio-design`      | 本文、ADR 0004、Foundation/旧 ADR 的边界修正；审阅后再改实现                                         |
| 5.1a 统一编排   | `feat/extension-coordinator` | LocalPluginSource + Server 唯一 owner、同步 commit 契约；既有 ESM 行为保持；跨来源假 source 竞态测试 |
| 5.1b 协议客户端 | `feat/mcp-stdio-client`      | 新包、SDK 依赖/关闭补丁理由、边界、限额、schema 子集和真实 fixture；无 Server 管理界面               |
| 5.2 工具适配    | `feat/mcp-tool-plugin`       | 合成插件、稳定命名、真实输入校验、共享审批/结果/失败；通过现有 Runner 验证                           |
| 5.3 Server 管理 | `feat/mcp-server-management` | 追加事件、环境解析、source、HTTP、安全守卫及统一候选；启动/重启/撤销闭环                             |
| 5.4 Studio      | `feat/studio-mcp-management` | 配置/信任/差异、状态与操作；真实浏览器 + Electron stdio 生命周期验收                                 |

关键测试矩阵：

- 客户端：argv 不被 shell 展开、系统/显式环境、只启动一次、能力缺失、总超时、
  分页循环/数量/字节、重复名、schema 关键词和注解数据区分、同 `$id` 隔离、
  预置 meta-schema `$id` 拒绝、required/额外字段不剥离、输入非法不发 call、
  输出 schema 缓存、不支持结果、EOF、取消/迟到响应、不重发、后代继承管道不保活宿主。
- 适配器：ask/trust 请求审批、yolo 既有语义、策略 deny、注解不能免批、命名冲突、
  isError 对模型/事件/UI 都是失败、凭据替换、UTF-8 裁剪、仅资源结果失败。
- 协调器：ESM 与 MCP 交错变更不丢状态；durable revoke 后装配失败再 ESM reload
  不复活；append 失败不 block；fold 同步阻断；外部撤销后目录失败保持禁入；
  慢 retirement、close 竞态、有界重试、健康来源隔离、候选和旧代各关闭一次。
- 管理：事件回放/序号回退/损坏、无秘密落库/GET、CAS 和精确摘要 409、未信任
  不启动、配置变化停用、重启恢复、全部写路由守卫、不存在管理工具。
- 端到端：仓库自带 stdio fixture → 添加并信任 → 下一回合审批调用 → list_changed
  不改当前目录 → reload 后新回合变化 → 旧回合保留连接 → 撤销/立即取消 → 重启。

行为 PR 运行目标包测试及 `pnpm check`，修复后重新验证受影响部分。最后一步用
真实 Electron 主进程验证 stdio 启动/关闭与重启配置恢复；仓库尚无分发打包器，
该结果不等于安装包验证。5.0 仅文档变更执行 Prettier、链接/契约检查和 diff 检查。

### 10.1 5.1a 实施边界

`feat/extension-coordinator` 实施具体的本地 ESM source 和 Server 协调器，
独立 `createPluginHost` 保留原公共接口。Server 内部 source port 只在 Server
定义，未将 plugin-host 扩展为多协议平台。`GenerationController.commit` 与
`ServerHost.commit` 提供同步所有权移交，完整候选提交前复验全部来源；
来源聚合清理器随发布代保留，最后一个旧回合结束后再释放。

本轮测试使用两个带真实工具贡献的可控来源验证交错变更，并使用真实 ESM
目录和 Server 启停验证信任、HTTP 投影和持久库关闭顺序。它们未启动 MCP
服务；协议客户端、连接状态、MCP 配置持久化及 Studio 表单仍按 5.1b–5.4 交付。

## 11. 已知边界与后续方向

首版牺牲部分 schema 兼容性以适配现有同步 Pipeline；正则/引用/更多 dialect
需单独设计可中断的校验 Worker。stdio 服务可能在初始化时产生副作用，且跨代
重载会再次启动进程。配置摘要不是代码签名，取消不是回滚，SDK 关闭不是进程树
沙箱。需要这些保证时，应另立 OS 隔离和可验证制品的设计，不能靠权限文案承诺。

## 12. 核对资料

- [官方 SDK v2.4.0](https://github.com/modelcontextprotocol/typescript-sdk/releases/tag/v2.4.0)，tag commit `951fe5603a7ec0b2dcb6a0b95d92cd86f93ad9e5`。
- [Client 实现](https://github.com/modelcontextprotocol/typescript-sdk/blob/v2.4.0/packages/client/src/client/client.ts)。
- [stdio transport](https://github.com/modelcontextprotocol/typescript-sdk/blob/v2.4.0/packages/client/src/client/stdio.ts)。
- [SDK JSON Schema validator](https://github.com/modelcontextprotocol/typescript-sdk/blob/v2.4.0/packages/core-internal/src/validators/ajvProvider.ts)。
- [Stage 4 设计](2026-11-20-plugin-host-design.md)、[Foundation](../../architecture/foundation.md)。

以上 SDK 行为基于固定版本源码和 npm 元数据核对；设计阶段未安装 SDK 或启动第三方服务。

### 10.2 5.1b 实施边界

独立 MCP 客户端实现显式 legacy stdio、手动分页、冻结目录、受限 schema、
调用预算、取消与安全错误。官方 v2.4.0 的实际公开结果 schema 入口为
`specTypeSchemas.ListToolsResult`；不使用 v1 的导出名称。每代按精确 schema
内容缓存隔离 provider 编译函数，schema 位置拒绝 `$id`。为保留 AJV 对特殊
JSON 属性名遗漏时的语义，内部校验副本对所有数据键及对应 properties/required/
const/enum 使用一致的单射前缀；公开 schema 与发出的参数保持原样。

固定 SDK 的 ESM/CJS transport 补丁释放父端管道、共享关闭 promise 并通知关闭
一次；独立宿主测试实际观察退出。此交付尚不提供 Server 启动授权、
MCP 工具适配或 Studio 管理；后续5.2–5.4 必须经过这些边界后才允许用户启动服务。

### 10.3 5.2 工具适配实施契约

`plugin-builtins.createMcpPlugin({serverId,label,cwd,connection,redactValues?})`
接收已授权且由 source 持有的冻结连接，贡献 `mcp-<serverId>`/host:mcp 插件与
封闭工具清单。插件不负责启动或关闭连接。原名稳定映射、输入 passthrough +
JSON Schema refinement、全部高风险审批和结果转换按 §6 执行；任何展示文本先
替换本连接已知非空秘密值。用于协议/注册表匹配的 ID、映射名及原始 JSON Schema
保持精确语义；必要元数据和第三方内容不能保证任意秘密都被识别。

审批卡通过现有 toolCallId 提供“查看参数”，App 在当前 Session 找到对应
ToolStep，展开父过程和参数、滚动并聚焦。ToolStep 的定位限于对话区域，
不与工具侧栏副本产生重复 DOM ID。该通用交互只新增 Studio 组件回调，
不新增运行时事件、HTTP 字段或审批状态。失败结果复用现有通用 failed 渲染。
实施计划见[5.2 工具适配](../plans/2026-11-21-mcp-tool-plugin.md)。

Zod4.6.7 的 object passthrough 会省略自有 `__proto__` 字段。适配器外层保留
原对象引用，内部仍执行规定的 object passthrough 和 JSON Schema refinement，
但 refinement 检查原始字段，成功后返回原始完整对象；不可把剥离后的副本发送给
服务。快照同样只借 Zod 检查形状，最终冻结副本保留 schema 全部自有 JSON 字段。

### 10.4 5.3 Server 实施契约

MCP authority 使用独立 SQLite 追加表。store 的 read/mutate 返回完整冻结日志及
折叠记录，mutate 在同一事务内验证历史前缀、连续 sequence、CAS 和合法状态转换。
source 在收到成功日志的同一 continuation 内安装缓存并同步通知 observer，之后才
允许下一个 await。reviewed 保存上次审阅配置，仅当前有效信任使用 trustedDigest。
配置规范化、路径复验及环境引用解析均属于 Server；历史回放不检查当前文件存在。

统一协调器增加显式 force 重建意图；相邻 pending reload 保留最强意图，带 CAS
的 MCP reload 通过独立排队 mutation 检查，不追加伪事件。prepared item 可带
Server-only instanceId 和纯同步 isReady，发布前最后无 await 临界段检查连接存活。
retainedGenerations 返回当前及未完全释放来源的代与精确 instanceId 成员；MCP
私有账本据此投影 active/draining，旧候选或退役通知不覆盖当前连接健康。

Server 在首个 spawn 前为整组 MCP surviving set 预留共用32个 allocation 配额，
资源不足保留旧指针；onClosed 仅表示停止接纳调用，配额只在 await close 成功后归还。
清理失败保留配额和代元数据。McpClientError 增加只读 cleanupFailed 布尔值，
初始化失败保留安全 code/message，同时标记内部关闭失败，不暴露原异常或环境。

mcp-management-types 定义仅含安全配置、authoritySequence、generation/admission、
服务状态、active/draining、工具快照与固定 issue 的 HTTP DTO。mutation 返回同一
snapshot 及 result(decisionSequence/applied/unchanged/failed/error)。HTTP不读取
持久库、环境或连接。所有写接口复用管理安全守卫，CORS 支持 PUT，开发代理增加 /mcp。
main 即使关闭 ESM 也创建 MCP store/source/manager，先 drain 来源资源再关闭持久库。
实施计划见[5.3 Server 管理](../plans/2026-11-21-mcp-server-management.md)。

### 10.5 5.4 Studio 实施契约

沿用单一 App-owned PluginCatalogStore/context，增加 MCP 目录及动作；ESM/MCP
共用一个写入门。初始/刷新并行 GET 两目录，最多三轮完整比较 generation 的
id、acceptingRuns、blocked 后原子安装，失配保留上一致快照但标旧、禁管理写入。
mutation 成功结果（持久决定序号和重建结果）单独保留，即使另一目录读取失败。
旧 GET 不得覆盖新写入结果。面板激活仅 GET；用户明确重载走 /mcp/reload，
关闭 ESM 时同样有效。只有明确的 management-disabled404 兼容插件只读旧服务。

MCPConfigDialog 保存原始路径/argv/环境目标引用名给 Server 规范化；保存与
信任独立。McpReview 捕获规范 config、configDigest、authoritySequence、
reviewEpoch，展示上次 reviewedConfig 字段差异；任意409刷新并使本次审阅失效，
不替换 token 自动重投。所有 schema/annotations 按数据展示，完整保留 JSON 字段。

MCP 三类停用/撤销/移除对话框的 immediate 选择始终可用，明确影响所有当前及
退役代回合；不依赖当前界面可见的 running session 才提供或提交此选项。
复用 PluginDialog 的取消初始焦点、键盘、背景 inert、返回焦点和滚动外壳。
MCPPanel 使用 /mcp 健康，合并 host:mcp 注册表实际贡献，避免重复健康普通行；
状态、stale、active/draining 和持久结果分别展示，失败不推测为已加载。
实施计划见[5.4 Studio](../plans/2026-11-21-studio-mcp-management.md)。
