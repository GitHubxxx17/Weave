# Studio 控制面 ＋ 权限/审批后端 设计（道 1）

状态：草案（动代码前供评审）。基线 main `983dae7`（含 #40 编程工具、#41 审批卡展开 + mock `/tool` 指令）。

## 背景与范围

#40 补齐了默认 Agent 的编程工具（找文件、分页读取、`edit_file`、`run_command`、步数上限、`AGENTS.md`+环境注入），#41 让审批卡能展开 diff/命令全文。但这些能力在 Studio 的**控制面**还没接上，而且权限模型只有二档（`workspace` / `read-only`），和 Codex / Kiro 的多档差距大。

本道范围（四块，按主题拆小提交，一个分支 `feat/studio-control-surface`）：

1. 模型强度选择（`reasoningEffort`）
2. 权限模型四档重做（含 YOLO）
3. `permissionMode` 真正发送生效
4. 审批带 `sessionId` ＋ Studio 按会话过滤

**非目标**（避免和已完成/后续波次重叠）：审批卡内容渲染（#41 已做）、运行中消息排队 / 图片输入（波 2）、MCP / Skill / 指令 / 插件内核（波 3）、上下文 L2/L3（波 4）。

## 1. 模型强度（reasoningEffort）

现状：契约从上到下已全通——`packages/protocol/src/llm.ts` 有 `LlmRequest.reasoningEffort`，`packages/llm/src/openai-compatible.ts` 已发成 `reasoning_effort`，`apps/server/src/agent-api.ts` 请求 schema 接受 `reasoningEffort`，`packages/runtime/src/agent-runner.ts` 已透传进 `LlmRequest`。**唯一缺口：Studio 无选择器、也没把它放进请求。**

设计（已实现）：

- 模型与强度合并为一个菜单（仿 Kiro）：输入框一个药丸显示「模型 · 强度」，点开后上半是模型列表、下半是强度滑块（更快↔更聪明）。
- 强度档位 **低 / 中 / 高**（`low`/`medium`/`high`），初始默认 **中**，每次 run 都发送 `reasoningEffort`；不支持该参数的 Provider 多会忽略未知字段。
- `apps/studio/src/features/agent/agent-stream.ts` 的 `AgentRunRequestInput` 增加可选 `reasoningEffort`。

契约变更：无（后端已就位）。纯 Studio 改动。

## 2. 权限模型四档（含 YOLO）

现状 `packages/runtime/src/tool-types.ts`：`toolPermissionModeSchema = z.enum(['workspace','read-only'])`。`workspace` 暴露全部工具、写/命令走审批；`read-only` 只暴露只读工具。审批只针对非 `readOnly` 工具，只读工具（找文件、读文件）本就自由。

改为四档：

| 档位（UI） | enum | 行为 |
|---|---|---|
| 常规（默认） | `ask` | 读自由；写 / 编辑 / 命令每次审批（= 旧 `workspace`） |
| 信任 | `trust` | 本会话内：常规写/编辑/命令自动放行，仅**高风险**操作审批（需风险分级器） |
| 完全访问 / YOLO | `yolo` | 全程不审批 |

已定（2026-11-19）：**三档**，去掉「只读」。移除旧 `read-only` 枚举值与"按档隐藏写工具"的逻辑——三档都暴露全部工具，差异只在审批行为。YOLO 做，设置页加红色风险警示。

**风险分级器**（新文件 `packages/runtime/src/approval-risk.ts`，仅 `trust` 档用）`classifyApprovalRisk(operation, input) → 'auto' | 'ask'`（已实现）：

- `shell.run_command`：命中危险模式 → `ask`，否则 `auto`。危险模式：`rm`/`rmdir`/`mkfs`/`dd`、`sudo`、`git push`/`reset`/`clean`、`chmod`/`chown`、`kill`/`pkill`、`curl`/`wget`/`nc`/`ssh`/`scp`、`npm`/`pnpm`/`yarn publish`、`shutdown`/`reboot`。
- `workspace.write_file` / `workspace.edit_file`：`auto`（写入已受 `workspace-access` 工作区边界约束）。
- 未知 operation：默认 `ask`（保守）。
- `approvalRequiredForMode(mode, operation, input)`：`ask`→恒真；`trust`→按分级器；`yolo`→恒假。

**YOLO 安全**：全程不审批，仅限用户显式切换；默认不启用；设置页该档红色警示文案。注意仍受 `workspace-access` 的工作区路径边界约束（写工具不能越界），但 `run_command` 本就能跑任意命令，YOLO 下无审批直接执行——这一点在 UI 上明确提示。

落点：

- `packages/runtime/src/tool-types.ts`：enum 扩到四值。
- `packages/runtime/src/tool-pipeline.ts`：按档决定 `auto`/`ask`（`trust` 接 `classifyApprovalRisk`；`yolo` 一律 `auto`；`ask` 维持；`read-only` 不暴露写工具故不触发）。
- `packages/runtime/src/agent-runner.ts`：工具暴露——`read-only` 仍只暴露只读工具，其余档暴露全部。
- `packages/runtime/src/approval-risk.ts`：分级器 + 单测。
- `apps/server/src/agent-api.ts`：schema 已 `optional` 接受，随 enum 扩展即可。
- Studio：菜单四档 + 发送；设置页「运行权限」默认档。

兼容：默认 `ask`（等价旧 `workspace`），请求不带时行为不变；旧 `workspace` 值作为别名映射到 `ask`（或直接改名并同步少数引用）。

## 3. permissionMode 真正发送

现状：`apps/studio/src/app/App.tsx` 有「权限模式」菜单和 `permissionMode` 状态（现文案"工作区访问/仅查看"），但 `streamAgentRun` 调用没带它，所以点了不生效。

设计：请求带 `permissionMode`（UI 中文档位 → enum 映射）；`AgentRunRequestInput` 加可选 `permissionMode`。与第 2 块的菜单改造一起做。

## 4. 审批带 sessionId ＋ 按会话过滤

现状：`ApprovalRequest` / `CreateApprovalRequestInput` / broker / SSE / Studio schema 全链路无 `sessionId`。#39 放开运行中切换会话后，别的会话的审批卡会浮在当前会话输入框上，看不出归属。

设计：

- `packages/runtime/src/approval-types.ts`：`CreateApprovalRequestInput` 和 `ApprovalRequest` 加 `sessionId`。
- `packages/runtime/src/approval-broker.ts`：存储并在快照/事件里带出。
- `packages/runtime/src/tool-pipeline.ts` / `agent-runner.ts`：创建审批时传入当前 run 的 `sessionId`（runner 从 run 请求已知 sessionId，透传给 pipeline 的审批创建）。
- `apps/server/src/approval-api.ts`：SSE 已序列化整个 request，字段随之带出，无需额外改。
- `apps/studio/src/features/approvals/approval-api.ts`：schema 加 `sessionId`。
- `apps/studio/src/app/App.tsx`：`useApprovals` 按当前 `activeSessionId` 过滤显示。

兼容：`sessionId` 可选；旧快照无该字段则不过滤（显示全部），不影响单会话场景。

## 分期（一个分支，三个主题提交）

1. 模型强度（最小、无契约风险，先出）。
2. 权限四档 + 风险分级器 + YOLO + `permissionMode` 发送（菜单与发送一体）。
3. 审批 `sessionId` + 按会话过滤。

可合为一个 PR（多主题提交），也可拆成「模型强度」一个小 PR 先合、其余一个 PR。

## 测试

- `approval-risk.ts` 单测：各类命令 / 写 / 编辑分级。
- runner：四档的工具暴露与自动放行 / 审批路径。
- 本地演示用 #41 的 mock `/tool` 指令驱动 `write_file` / `edit_file` / `run_command`，无需真实模型即可验证各档审批行为。
- Studio：强度选择器发送、权限菜单四档映射与发送、审批按会话过滤。
- 全链路 `pnpm check`。

## 文件归属（道 1 独占，供并行参考）

- studio：`App.tsx`、`features/{approvals,agent}/*`、`app.css`、设置页。
- runtime：`tool-types.ts`、`tool-pipeline.ts`、`agent-runner.ts`、`approval-types.ts`、`approval-broker.ts`、新 `approval-risk.ts`。
- server：`agent-api.ts`、`approval-api.ts`。
- protocol：仅在把 `permissionMode` 上升为协议层时才动（当前在 runtime，倾向不动）。
