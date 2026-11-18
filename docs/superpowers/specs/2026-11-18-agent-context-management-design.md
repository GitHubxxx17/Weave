# Agent 上下文管理设计（确定性保真压缩 + 召回 + 可视化）

## 1. 背景

Runner 每个模型步都发送**完整投影历史**（`projectSession().messages` 全量），
长会话必然超出模型上下文窗口；工具结果虽在 Pipeline 截断到 32KB，长会话里累加仍
会撑爆；超长时厂商多返回 400，被归为 `invalid-request`，界面看不出真因。

参考 DeepSeek Harness 的压缩插件（compaction-basic / dsh-compactor 三层 /
compaction-instant 确定性编译 / billion-context 的 compress 工具 / graph-memory 召回）
与 Kiro/Codex 的上下文窗口可视化，本期做**确定性、不丢关键信息**的上下文管理。

## 2. 第一原则：不丢关键信息

Weave 是 append-only 事件日志 + 投影。**压缩只作用于"这一次发给模型的视图"，不改
事件日志**——所有原文永久保留在 session 事件里。因此关键信息在系统层面永不丢失，
风险只收窄为"模型这次请求暂时看不到"，且可随时**召回**原文。

信息分三档：

| 档 | 内容 | 处理 |
|-|-|-|
| **A 永不压缩** | 用户消息（意图）、失败与错误（工具失败、报错码、未完成任务）、最近若干轮原文 | 原样保留 |
| **B 骨架化保留** | 旧工具调用（工具名+目标路径+成败）、旧工具结果（指代：`read_file README.md → 2.4KB ✓`）、旧助手回复（留结论/首尾）、关键标识符（路径、决策、数字） | 留要点、省正文 |
| **C 可省略** | 完整文件内容、冗长输出中段 | 省略，留 B 档指代 |

## 3. 非目标（本期不做）

- LLM 摘要压缩（用模型总结旧历史）——后续 PR-C（`context.compacted` 事件 + 溢出重试
  + 可选辅助模型）。本期全部为**确定性**处理，无模型调用。

## 4. 契约与实现（按包）

### 4.1 `@weave/runtime`：token 估算（新 `context/token-estimate.ts`）

纯函数，无依赖，近似且偏保守：

- `estimateTokens(text: string): number`：CJK/全角字符≈1，其它≈0.25，向上取整。
- `estimateMessageTokens(message: Message): number`：各内容块 + 角色框架开销（≈4）
  + 工具调用 arguments。
- `estimateToolsTokens(tools): number`：工具定义 JSON 的估算。

### 4.2 `@weave/runtime`：保真压缩构建器（新 `context/build-context.ts`）

```ts
interface ContextBudget {
  readonly windowTokens: number;      // 模型上下文窗口
  readonly reserveOutputTokens: number; // 预留输出（maxTokens 或默认 4096）
  readonly marginRatio: number;       // 安全余量（默认 0.05）
}
interface ContextCategoryBreakdown {
  readonly system: number; readonly tools: number;
  readonly userMessages: number; readonly assistantText: number;
  readonly assistantReasoning: number; readonly toolCalls: number;
  readonly toolResults: number; readonly skeleton: number; // 骨架化占用
}
interface ContextBreakdown {
  readonly windowTokens: number;
  readonly sentTokens: number;        // 本次实际发送估算
  readonly ratio: number;             // sentTokens / windowTokens
  readonly trimmed: boolean;          // 是否发生压缩/骨架化
  readonly categories: ContextCategoryBreakdown;
}
interface BuildContextResult {
  readonly messages: readonly Message[];   // 实际发送（已保真压缩）
  readonly breakdown: ContextBreakdown;
  readonly overflow: boolean;              // 固定成本或单条即超预算
}
function buildModelContext(input: {
  readonly system: readonly Message[];
  readonly history: readonly Message[];          // 投影消息（最旧在前）
  readonly tools: readonly ToolDefinition[] | undefined;
  readonly budget: ContextBudget;
  readonly maxToolResultTokens: number;          // 单条结果上限（头尾截断阈值）
}): BuildContextResult;
```

> 实现说明：当前轮边界不靠显式 `turnId` 传递，而是取 `history` 中**最后一条 user
> 消息及其后**的消息（一轮以 user 消息开头，二者等价），省去把 turnId 串进调用方的
> 复杂度。`maxToolResultTokens` 默认 8000（约等于 Pipeline 32KB ASCII 上限的 token 数），
> 使正常结果不被压缩器二次截断，仅超大结果头尾截断。

**算法**
1. 预算 `available = windowTokens*(1-margin) - reserveOutputTokens - est(system) - est(tools)`。
2. **A 档固定保留**：当前轮消息（`turnId === currentTurnId` 及其后，即本轮 user +
   本轮已产生的 assistant/tool）；历史中的 user 消息；失败的 tool 结果（含错误）。
3. 历史**从新到旧按轮/组**纳入原文，预算足够就原样放；**assistant(toolCalls) 与其
   tool 结果成组纳入或成组骨架化**，不产生悬空配对。
4. 预算不足以放某组原文时，对该组做 **B 档骨架化**：
   - 工具调用 → `name + 目标路径(若有) + 成/败`；
   - 工具结果 → 指代行（工具名、路径、字节数、成/败）；失败结果保留错误文本（A 档）；
   - 助手正文 → 保留首尾各若干字符 + `…`；助手 reasoning 历史本就不回传（PR #34）。
   骨架化结果作为一条合成 `system`/`user` 提示块注入（标注"[已压缩的更早上下文]"）。
5. 纳入原文的工具结果若超 `maxToolResultTokens`，头尾截断 + `…省略 N 字节…`（durable 不变）。
6. 统计 `breakdown`，设 `overflow`（当 available ≤ 0 或当前轮固定成本已超）。

骨架化与截断均为确定性字符串变换，可脱离 Provider 单测。

### 4.3 `@weave/runtime`：召回工具 `recall`（新 `context/recall-tool.ts`）

注册进共享 ToolRegistry 的只读工具（不需审批）：

- `recall({ toolCallId?: string; path?: string })`：从 session 事件读回被压缩的**原文**
  工具结果（按 `toolCallId`；或按最近一次读该 `path` 的结果），返回完整内容（受
  Pipeline 字节上限）。让模型在需要被省略细节时自己取回。
- 实现经 `resolveRecall(sessionId)` 回调读 session 事件（Server 注入，和文件工具
  `resolveWorkspaceRoot` 同构），保持 runtime 不直接依赖具体 Store 实例。

### 4.4 `@weave/runtime`：接入 Runner + 溢出码

- 构造 `llmRequest` 前调用 `buildModelContext`，用其 `messages` 替换
  `[...systemMessages, ...messages]`。
- `breakdown` 走 **`usage` 同款管线**：
  - 发 transient 事件 `{ type: 'context', breakdown }`（`AgentRuntimeEvent` 新增一类 +
    `agentRuntimeEventSchema` 新增分支）。
  - 存入 `step.completed.payload.context`（session 事件 schema 新增可选字段，与
    `usage` 并列），投影与 `turns` 接口带出，支持刷新后查看与趋势。
- `overflow === true`，或厂商返回 `context-overflow`（llm 已分类）→ 抛
  `AgentRunError('agent-context-overflow', …)`（新增错误码），前端显示"上下文超出
  模型窗口"。本期不自动压缩重试（属 PR-C）。

### 4.5 `@weave/session`：事件与投影

- `step.completed` 的 payload 新增可选 `context: ContextBreakdown`（与 `usage` 并列，
  落库 schema 可选）。
- 投影在 `modelSteps[]` 带出 `context`；`turns` 汇总时保留每步 context（或取最后一步
  作为该轮代表）。

### 4.6 `@weave/protocol`

`ContextBreakdown` / `ContextCategoryBreakdown` 类型 + Zod schema（供 runtime、session、
server、studio 共享形状；studio 侧另有自己的只读 schema，遵循现有"前后端两份"约定）。

### 4.7 `@weave/llm` + `apps/server`

- Provider 配置新增可选 `contextWindowTokens`：`WEAVE_LLM_PROVIDERS` schema +
  `ServerLlmProviderConfig` + Provider 描述符；mock 给默认值。缺省 **128_000**（可配）。
- Server 把所选 Provider 的 `contextWindowTokens` 传给 Runner 构造 `ContextBudget`
  （经 Runner option 或按 provider 解析的回调）。
- 注册 `recall` 工具时注入读取 session 事件的实现。

### 4.8 `apps/studio`：上下文面板

- `agent-stream` 的 `knownEventNames` 新增 `context`，解析进 turn/step。
- 新增 panel kind `context`（复用标签页面板架构）："上下文"标签展示当前轮
  `sentTokens` + 占窗口 % 堆叠条 + 分类列表（系统/工具定义/用户/助手回复/工具调用/
  工具结果/骨架）+ 最近 N 轮趋势。与"用量"标签分工：用量=厂商 usage，上下文=发送构成。
- 阈值（默认 70%，可调）本期只用于"接近上限"预警高亮，不触发压缩。

## 5. 影响的跨包契约（AGENTS.md 要求）

- protocol：新增 `ContextBreakdown` 类型/schema（契约，向下游开放）。
- session：`step.completed.payload.context` 可选字段 + 投影/turns 带出。
- runtime：`AgentRuntimeEvent` 新增 `context` 事件（每个模型步发送前发一次）；
  `AgentRunError` 新增 `agent-context-overflow`；新增 `recall` 工具
  （`createRecallTool` + `createSessionRecallResolver`）与 `buildModelContext`/估算器；
  `AgentRunnerOptions` 新增 `context`（`AgentContextOptions`：默认窗口/预留/余量/单条上限）。
- llm/server：Provider 描述符 `LlmProviderDescriptor` 与注册项新增可选 `contextWindowTokens`
  （`WEAVE_LLM_PROVIDERS` 配置可填，缺省 128_000）；Runner 按 provider 从描述符读取窗口。
  Server 在 ToolRegistry 注册注入了 session 读取实现的 `recall` 工具。
- studio：agent 事件 schema 新增 `context`；workspace-types 的 turns 带 context；新面板。
- 层次依赖不变（protocol→llm→runtime→server；session 独立；studio 不引 `@weave/*`）。

## 6. 测试计划

- runtime：估算器量级（中/英/代码）；预算先扣 system+tools；最近优先纳入；成组保
  配对不产生悬空；当前轮与用户消息与失败结果永不压；超预算时旧组骨架化且保留路径/
  成败/错误；大结果头尾截断；breakdown 分类正确；overflow 判定；`recall` 按
  toolCallId/path 取回原文。
- session：step.completed 带 context 落库与投影带出。
- llm/server：provider 配置解析 contextWindowTokens；默认值。
- studio：context 事件解析；上下文面板渲染分类与占比；阈值预警。

## 7. 分期

- **PR-A（本期）**：第 4 节全部（确定性保真压缩 + 召回工具 + context 事件/持久化/
  可视化 + 溢出识别）。
- PR-B：阈值真正触发更激进的确定性压缩策略调优（如有需要）。
- PR-C：L3 LLM 摘要（`context.compacted` 事件 + 溢出压缩重试 + 可选辅助模型）。

合并后同步更新第 2 部分（上）llm 学习文档的上下文管控一节。
