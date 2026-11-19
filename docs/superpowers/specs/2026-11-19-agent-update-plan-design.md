# Agent 计划清单设计（update_plan 工具 + 计划面板）

## 1. 背景

对标 Codex 的计划清单：模型用一个 `update_plan` 工具维护一份任务清单（待办 / 进行中 /
已完成），随工作推进不断整体替换，Studio 在右侧「计划」面板展示当前清单。Weave 目前没有
任何计划能力。

本设计复用 #38 已验证的 usage/context 管线形态：runtime 发 transient 事件 + 持久化到
step 的 `step.completed` + 投影带出到 turn + Studio 解析渲染，风险最低、与既有写法一致。

## 2. 范围与边界

- 新建为主：`packages/protocol/src/plan.ts`、`packages/runtime/src/update-plan-tool.ts`、
  `apps/studio/src/features/panel/plan-panel.tsx`。
- 共享文件只做追加：protocol `index.ts`、runtime `agent-types.ts`/`agent-runner.ts`/`index.ts`、
  session `events.ts`/`projection.ts`、server `session-service.ts`/`runtime.ts`/`agent-instructions.ts`、
  studio `agent-types.ts`/`agent-stream.ts`/`panel-data.ts`/`panel-registry.tsx`/`workspace-types.ts`、
  App.tsx 事件处理（约 10 行，严格仿 context）。
- **严禁改 App.tsx 的 composer / 输入框区域**（道1 正在改，避免冲突）。只在 `handleEvent`
  的 switch 里加一个 `plan` 分支。
- 跨包改动，契约只做向后兼容新增。

## 3. 数据模型（protocol）

```ts
export type PlanItemStatus = 'pending' | 'in_progress' | 'completed';
export interface PlanItem { readonly step: string; readonly status: PlanItemStatus; }
export interface AgentPlan {
  readonly explanation?: string;     // 可选，本次更新的一句话说明（Codex 同款）
  readonly items: readonly PlanItem[];
}
```
Zod：`planItemStatusSchema`、`planItemSchema`、`planSchema`，从 protocol `index.ts` 导出。
清单允许为空（模型可清空）；不强制「至多一个 in_progress」，由工具描述软约束。

## 4. 工具（runtime `update-plan-tool.ts`）

- `updatePlanToolName = 'update_plan'`。
- 模型可见入参（Codex 兼容）：`{ explanation?: string, plan: PlanItem[] }`。
- `createUpdatePlanTool()` 返回 `ToolDefinition`：`readOnly: true`（无文件副作用、无需审批、
  所有权限档都可用），`execute` 校验入参后返回一句确认文本（`已记录计划：N 项，其中进行中 x 项`）。
- `parsePlanFromToolCall(toolCall)`：当 `toolCall.name === updatePlanToolName` 时，用入参 schema
  解析 `toolCall.arguments` 并映射成 `AgentPlan`（`plan` 数组 → `items`）；否则返回 `undefined`。
  供 runner 从原始参数还原计划（pipeline 返回的是字符串结果，拿不到结构化入参）。

## 5. 瞬态事件（runtime `agent-types.ts`）

`AgentRuntimeEvent` 新增 `{ type: 'plan'; plan: AgentPlan }`，并在 `agentRuntimeEventSchema`
加一支（复用 protocol `planSchema`）。不带 turnId——与 usage/context 一致，由 Studio 归到当前
活动轮（`liveTurnIdFor(assistantId)`）。

## 6. runner 接入（`agent-runner.ts`）

在「工具执行成功」分支（已有 tool-result.created + message + step.completed 的 append 处）：
1. `const plan = parsePlanFromToolCall(toolCall);`
2. 在该 tool step 的 `step.completed` payload 追加 `...(plan === undefined ? {} : { plan })`，持久化。
3. `emit({ type: 'tool-result', result })` 之后，若 `plan !== undefined` 则 `emit({ type: 'plan', plan })`。

计划因此与 usage/context 一样挂在 `step.completed` 上（这里是 tool step），不新增事件类型。

## 7. 持久化与投影（session）

- `events.ts`：`stepCompletedPayloadSchema` 追加 `plan: planSchema.optional()`（覆盖新事件 +
  持久化两处，因该 schema 两边共用）。
- `projection.ts`：`SessionStep` 追加 `plan?: AgentPlan`；`step.completed` 处理器在
  `event.payload.plan !== undefined` 时写入 `step.plan`。

## 8. turn 汇总（server `session-service.ts`）

`SessionTurnSummary` 追加 `plan?: AgentPlan`。因为计划挂在 tool step（非 model step），
`turnSummaryFor` 用「该 turn 所有 steps 里最后一个带 plan 的」作为 turn 当前计划
（`turn.steps.reduceRight(...)`）。其余字段不变。

## 9. 工具注册与系统提示（server）

- `runtime.ts`：仿 recall 用一个 `WeakSet` 守卫，一次性注册 `createUpdatePlanTool()`（无依赖）。
- `agent-instructions.ts`：当 `names.has('update_plan')` 时追加一句引导——多步任务开始时用
  update_plan 列出步骤，完成一步就把它标 completed、下一步标 in_progress，保持至多一个进行中。

## 10. Studio

- `workspace-types.ts`：新增 `planItemSchema`/`planSchema`（studio 本地），`turnSummarySchema`
  追加 `plan` 可选；导出 `PlanItem`/`AgentPlan` 类型。
- `agent-types.ts`（studio features/agent）：`AgentRuntimeEvent` 与 `agentRuntimeEventSchema`
  各加一支 `plan`（复用本地 `planSchema`）。
- `agent-stream.ts`：`knownEventNames` 加 `'plan'`。
- `panel-data.ts`：新增 `latestPlan(turns)`（仿 `latestContext`），以及计划状态元数据。
- `plan-panel.tsx`：新面板，展示当前清单（状态图标 + 文案 + 进度统计 + explanation），空态提示。
- `panel-registry.tsx`：注册 `plan` 面板（默认固定，单例，非 keepAlive）。
- `App.tsx`：`handleEvent` 加 `case 'plan'`，仿 `context` 把 `event.plan` 写进活动轮的 `plan`。

## 11. 测试

- runtime：update-plan-tool（execute 文案、parsePlanFromToolCall 正/负例）；runner（update_plan
  调用后发 `plan` 事件且 `step.completed` 持久化 plan）。
- session：projection（step.plan 被带出）。
- server：session-service（turn.plan 为最新计划）；runtime 注册（工具清单含 update_plan）。
- studio：agent-stream 解析 `plan`；plan-panel 渲染清单与空态；App 的 turns 写入（可选）。

## 12. 验收

模型调用 update_plan 后，Studio「计划」面板实时显示清单，刷新后仍在（来自 turn.plan）；
`pnpm check` 全绿；不触碰 App.tsx 的 composer。
