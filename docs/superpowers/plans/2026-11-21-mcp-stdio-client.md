# MCP stdio client Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** 交付可独立使用、有限额、有冻结目录和可靠关闭能力的本地 stdio MCP 客户端。

**Architecture:** 新包 `@weave/mcp-client` 不依赖任何 Weave 包。SDK 负责协议与进程 transport，Weave 负责 schema 子集、固定快照、调用预算、安全错误及取消。适配器、持久信任与 Studio 后续在独立 PR 接入既有协调器。

**Tech Stack:** TypeScript strict ESM、Node >=24.4.0、官方 client 2.4.0、Zod 4.6.7、Vitest。

**Spec:** [Stage 5 设计](../specs/2026-11-21-mcp-stdio-design.md)，特别是 §3、§5、§6.1、§7.3。

## Global Constraints

- 本包无 `@weave/*` 依赖；仅 plugin-builtins/server 可以消费。
- argv 数组、shell:false、显式 legacy、capabilities:{}、禁止自动履行与自动重试。
- 初始化及完整目录 15 秒；16 页、64 工具、512 KiB；schema 64 KiB、深32/节点2048/组合分支32/组合深4。
- 输入 64 KiB/深32/节点4096；结果1 MiB；协议 buffer2 MiB；4 并发；调用120秒。
- stderr 只排空计数；不记录原文。固定错误消息不包含原异常、输入、命令或凭据。
- 关闭幂等且 <=5秒；SDK ESM/CJS 最小补丁释放父端管道，不承诺进程树沙箱。
- 测试置于 `test/`；每主题独立分支，完整 check、审查、CI 后 squash。

## Contract preflight

| 文件                      | 提供/消费契约                                                                                                                          |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `src/types.ts`            | McpToolSnapshot、McpCallResult、McpConnection、ConnectMcpOptions，独立公共类型                                                         |
| `src/errors.ts`           | McpClientError 与稳定 code/message，不保留原始 cause                                                                                   |
| `src/schema.ts`           | compileMcpSchema(schema,{input?}) 返回同步 `(unknown)=>McpValidationResult`；assertJsonValue(value,limits)；输出 provider 复用缓存函数 |
| `src/stdio-connection.ts` | connectMcp(options):Promise<McpConnection>，冻结快照、校验后调用，stale/closed 同步回调                                                |
| 根 ESLint                 | 独立叶子 mcp-client；仅 builtin/server 的允许依赖列表新增该包                                                                          |
| SDK patch                 | 仅 transport 资源关闭；不接触协商、协议、工具行为                                                                                      |

### Task 1: bounded schema and JSON validation

**Files:** `packages/mcp-client/src/{schema,limits}.ts`、`test/schema.test.ts`。

- [x] 写失败测试：`compileMcpSchema({type:'object',required:['x'],properties:{x:{type:'integer'}},additionalProperties:false},{input:true})` 拒绝缺项/字符串/额外项，保持原输入；拒绝 schema 位置 `$id` 及非法关键词形状，允许 const/default 内相同属性名。
- [x] 运行 `pnpm exec vitest run packages/mcp-client/test/schema.test.ts` 记录 red。
- [x] 实现纯 JSON/深度/节点/字节预算、schema 位置遍历、关键词形状与单 schema 独立 AjvJsonSchemaValidator 编译。未知关键词、异步函数或编译失败抛 mcp-unsupported-schema。
- [x] 扩充临界预算、组合深度、有限数/循环/原型、enum 数据、非变异与重复 `$id` 回归；运行同一命令确认 green。

### Task 2: stdio connection and immutable catalog

**Files:** `src/{types,errors,stdio-connection,index}.ts`、`test/stdio-connection.test.ts`、`test/fixtures/server.mjs`。

- [x] 仓库自有 JSON-RPC fixture 记录启动数，initialize 返回 tools capability，tools/list 分页；先写连接/快照/真实调用测试并运行确认缺少实现。
- [x] 实现显式 legacy SDK 连接、手动 request tools/list、总 deadline、重复 cursor/name 与目录预算；先编译全部 schema 再暴露深冻结工具。
- [x] 每次 callTool 传冻结 toolDefinition；校验输入后才发请求，输出 provider 返回准备期函数；错误调用不使用成功 outputSchema。
- [x] 测试4并发/busy、取消和迟到结果、EOF、无重发、list_changed 只标 stale、safe errors、stderr 排空、环境白名单和 argv 不经 shell。
- [x] 运行包测试/typecheck，核对无宿主能力处理器和无自动刷新。

### Task 3: owned pipe cleanup regression

**Files:** `patches/@modelcontextprotocol__client@2.4.0.patch`、`test/transport-close.test.ts`、`test/fixtures/`、包 README、根 package/lockfile。

- [x] 独立宿主 fixture 启动会留下继承 stdio 后代的服务；通过超时及宿主退出事件验证未修补时失败。
- [x] transport close finally 销毁自己持有的 stdin/stdout/stderr/PassThrough、清 buffer、onclose 一次；同时修补 ESM/CJS。
- [x] 同时验证正常退出/失败初始化/重复关闭；测试清理自己创建的后代。README 记录固定源码版本、补丁原因和升级删除条件。

### Task 4: integration and delivery

**Files:** 包元数据/tsconfig、根 ESLint、Foundation、ADR0004、Stage5 设计。

- [x] 固定依赖 `@modelcontextprotocol/client:2.4.0`、Zod4.6.7，更新边界与 dependency rationale，SDK 类型不暴露到 HTTP。
- [x] 独立审查 spec 符合性及实现质量，修复发现的问题并重跑相关测试。
- [x] 运行 `pnpm check`；保存日志及实际测试数。
- [ ] 提交 `feat: 增加有界 stdio MCP 客户端`，显式分支 refspec 推送，创建并附加 PR；CI 全绿后 squash，删除远程功能分支。
- [ ] 从更新后的 main 创建5.2工具适配分支，继续完成5.3管理与5.4界面，最后真实浏览器/Electron验收。
