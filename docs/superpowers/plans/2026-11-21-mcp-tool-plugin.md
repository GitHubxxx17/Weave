# MCP tool plugin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把已授权 MCP 连接贡献为现有共享 Pipeline 的高风险工具，完整复用审批、失败事件和结果展示。

**Architecture:** plugin-builtins 依赖独立 mcp-client，只转换冻结目录；Server 后续拥有连接启动与 Generation 资源。合成插件以 host:mcp 注册封闭工具清单，不持有管理权或另建 Broker。

**Tech Stack:** strict ESM TypeScript、Zod4.6.7、既有 Kernel/Tool Pipeline/Runner/Vitest。

**Spec:** [Stage5设计](../specs/2026-11-21-mcp-stdio-design.md) §6。

## Global Constraints

- mcp-client 不导入 Weave；plugin-host 不导入 MCP；不新增 Runtime 专用 MCP类型。
- tool name `mcp_<serverId>_<slug10>_<sha256-original-first16>`，最多56，冲突拒绝。
- 所有工具 readOnly:false；operation mcp.call_tool、risk high；ask/trust需批，yolo与policy沿用既有语义。
- 输入 z.object({}).passthrough().superRefine 调用 connection.validateInput；非法不审批不执行。
- isError抛稳定McpToolError，持久和live均failed，模型可修正。
- 只文本/structuredContent；资源/二进制不跟随不解码；无可用非空内容失败，空content合法。
- 已知显式环境秘密替换先于截断；错误4KiB；成功沿用pipeline32000 UTF8。
- 每主题新分支、独立PR、check/CI/squash；测试test/。

## Affected contracts

`createMcpPlugin({serverId,label,cwd,connection,redactValues?}):KernelPlugin` 贡献该连接冻结工具。连接资源由 source/generation拥有，插件 dispose不擅自关闭共享连接。
`mcpToolName(serverId,originalName):string` 稳定映射；`createMcpTool(options,tool):ToolDefinition<Record<string,unknown>,string>`。`formatMcpResult(result,context):string` 安全归属输出；`McpToolError` code mcp-tool-error / mcp-unsupported-result。所有可展示文本先redact。

### Task1: safe result conversion

**Files:** src/mcp-result.ts,test/mcp-result.test.ts。

- [ ] 失败测试文本/structured/mixed unsupported/empty/error/UTF8/secret replacement；运行目标vitest red。
- [ ] 实现只接受协议已校验内容的safe转换，unsupported块只计数摘要；structured使用JSON文本，不主动资源操作；错误4KiB。文本+结构化附service/tool归属。
- [ ] 运行目标测试green、lint/typecheck。

### Task2: tools and kernel contribution

**Files:** src/mcp-tool.ts,src/mcp-plugin.ts,src/index.ts,package.json,test/mcp-tool.test.ts,test/mcp-plugin.test.ts。

- [ ] 先测试稳定映射、空slug、跨名唯一、非法id、closed contributes、注册冲突归因。
- [ ] 定义输入passthrough+refinement；审批summary仅id/原名/映射/cwd/字节/字段名；execute复用signal并转换结果。
- [ ] 真实Pipeline测试ask/trust/yolo/policydeny，第三方注解不免批；非法输入无审批无调用；不暴露参数值凭据。
- [ ] 测试kernel正确host:mcp和封闭贡献，无管理能力；连接由调用方管理。

### Task3: Runner and UI failure compatibility

**Files:** plugin-builtins/test/mcp-runner.test.ts,适用Studio现有tool display测试。

- [ ] 真实Runner+内存event store+mock model：MCP isError -> failed durable步骤/tool-result，模型见mcp-tool-error并可继续修正成功。
- [ ] 验证现有UI失败步骤呈现，approve卡toolCallId定位现有参数详情；仅有缺口才修改通用显示组件。
- [ ] 更新Foundation/spec的实际adapter contract、直接workspace依赖、锁文件；独立审查。
- [ ] root pnpm check，提交feat: 将 MCP 工具接入共享执行与审批；push/create/attachPR，CI后squash，再从main开始5.3。

### Cross-package UI contract

ApprovalPanel adds optional onInspectToolCall callback; App expands matching current-session message process and its ToolStep, scrolls/focuses existing parameters. ToolStep gains scoped DOM targeting without duplicate IDs in side panel. No new HTTP/runtime event. React changes follow vercel-react-best-practices. Tests cover matching call identity, collapsed parents, failure status and safe approval summary.
