# Agent Tool Loop Design

**日期：** 2026-11-15

**状态：** 已确认

**目标阶段：** Weave Runtime 的最小多步工具执行闭环

## 1. 背景

Weave 当前已经具备：

- Provider 无关的 `LlmClient`；
- 能够保存 Session、Turn、Step 和 Message 的 append-only Event Store；
- Tool Registry；
- 统一的 Tool Pipeline；
- Workspace 文件工具；
- Approval Broker 和 Approval HTTP/SSE 控制面。

但是当前 `AgentRunner` 在收到 `tool-call-start`、`tool-call-delta` 或
`finish.reason = 'tool-call'` 时会返回
`agent-tool-call-unsupported`。因此模型只能完成无工具的一轮文本回复，
还不能真正完成：

```text
用户消息
  -> 模型请求工具
  -> Tool Pipeline 执行
  -> 工具结果进入下一轮上下文
  -> 模型生成最终回复
```

本切片实现最小的顺序 Tool Loop，不实现并行工具执行、Agent HTTP
接口或 Studio UI。

## 2. 目标与非目标

### 2.1 目标

- 让 Agent Runner 接收完整的模型 Tool Call。
- 组装 `tool-call-start` 和 `tool-call-delta` 为完整 `ToolCall`。
- 将工具定义从 Runtime Registry 转换为 LLM Protocol 定义。
- 将每个完整 Tool Call 提交给共享 `ToolPipeline`。
- 将成功的工具结果转换为下一轮模型的 `tool` 消息。
- 支持多个模型轮次，默认最多 8 个模型步骤。
- 将 assistant tool call、tool call、tool result 和工具 Step 持久化。
- 在 AgentRuntimeEvent 中通知工具调用、执行和结果。
- 保留无工具 Agent 的现有完成、失败、取消和提前停止语义。
- 保留 Approval、Workspace 和 Tool Pipeline 的安全边界。

### 2.2 非目标

- 不直接调用 ToolDefinition.execute。
- 不在 Agent Runner 内复制参数校验、超时、取消、结果限制或 Approval。
- 不实现并行 Tool Call；多个调用按模型返回顺序串行执行。
- 不把每个 transient delta 单独写入 Session Event Store。
- 不实现工具失败后的模型恢复轮次；第一版工具失败会结束当前 Turn。
- 不实现 Agent `/run` HTTP API、Agent SSE 或 Studio 前端。
- 不实现跨进程 Session 锁、Crew、Subagent 或通用 Event Bus。

## 3. 方案选择

### 方案 A：Runner 直接调用 Registry 中的 execute

Runner 自己解析参数、调用工具并处理异常。代码短，但会绕过共享
ToolPipeline，导致 Approval、超时、取消和结果限制失效，不符合 Weave 的
安全边界。不采用。

### 方案 B：Runner 通过 ToolPipeline 执行

Runner 只负责模型轮次、Tool Call 组装和 Session 编排；所有工具执行仍然
进入 ToolPipeline。这个方案保持 Runtime 边界清晰，也能直接复用现有
Workspace 和 Approval 行为，因此采用方案 B。

### 方案 C：先建设通用 Agent Event Bus

把 Agent、Approval、Session 和 Plugin 的实时事件统一放进 Event Bus。
当前只有一个 Runner 消费者，提前抽象会扩大改动面，也会混淆 durable
Session Event 与 transient Runtime Event。本切片暂不采用。

## 4. Session Durable Event 契约

Session Event Store 增加两个事件：

```ts
type ToolCallCreated = {
  type: 'tool-call.created';
  payload: {
    turnId: string;
    stepId: string;
    toolCall: ToolCall;
  };
};

type ToolResultCreated = {
  type: 'tool-result.created';
  payload: {
    turnId: string;
    stepId: string;
    toolCallId: string;
    name: string;
    content: string;
    truncated: boolean;
    status: 'completed' | 'failed';
    errorCode?: string;
  };
};
```

事件顺序约束：

```text
step.started(kind=model)
  -> message.created(assistant + toolCalls)
  -> step.completed(kind=model)
  -> step.started(kind=tool)
  -> tool-call.created
  -> tool-result.created
  -> message.created(tool)
  -> step.completed(kind=tool)
  -> step.started(kind=model)
```

assistant tool call 使用已有的 `message.created`，因此下一轮
`projectSession()` 可以直接恢复 provider 所需的 assistant message。
成功工具结果同时保存为 `tool-result.created` 和 `message.created(role=tool)`：

- tool event 用于工具时间线和状态展示；
- tool message 用于下一轮模型上下文。

工具失败时保存 `tool-result.created(status=failed)` 和失败的 tool Step，
不创建可供模型继续消费的成功 tool message，然后将 Turn 标记为 failed。
底层异常保留在 Runtime 错误的 `cause` 中，不写入 Session。

Projection 增加：

- `SessionToolCall`；
- `SessionToolResult`；
- `SessionTurn.toolCalls`；
- `SessionTurn.toolResults`。

Projection 只恢复 durable facts，不执行工具，也不推断未持久化的实时状态。

## 5. Agent Runner 契约

`AgentRunnerOptions` 增加：

```ts
interface AgentRunnerOptions {
  llm: LlmClient;
  sessionStore: SessionEventStore;
  toolRegistry?: ToolRegistry;
  toolPipeline?: ToolPipeline;
  maxSteps?: number;
}
```

`toolRegistry` 和 `toolPipeline` 必须同时提供。只提供其中一个属于
装配错误，应在创建 Runner 时抛出稳定的配置错误；两者都没有时表示
无工具 Runner，保持当前文本 Agent 行为。

Runner 每轮构造 `LlmRequest` 时，将 Registry 中的工具转换为 Protocol
的模型定义：

```text
Runtime ToolDefinition
  -> name
  -> description
  -> parameters
  -> Protocol ToolDefinition
```

`inputSchema`、`approval` 和 `execute` 不能泄露到 LLM。

### Tool Call 组装

一轮模型流允许：

```text
text-delta*
reasoning-delta*
tool-call-start
tool-call-delta*
finish(reason=tool-call)
```

同一个调用 ID 的 delta 追加到同一个 buffer。Runner 必须拒绝：

- delta 在 start 之前出现；
- 同一 ID 使用不同工具名；
- 两个 start 使用同一 ID；
- Tool Call 缺少名称；
- `finish(tool-call)` 没有完整调用；
- finish 后仍有事件；
- 同一轮出现重复或非法终态。

### 多步循环

每个模型请求计为一个 model Step。默认 `maxSteps = 8`。

```text
while (modelSteps < maxSteps):
  stream model response
  if finish(stop):
    persist assistant text + completed model step + completed turn
    emit completed
    return
  if finish(tool-call):
    persist assistant tool-call message + completed model step
    for tool call in order:
      persist tool Step and tool-call event
      emit tool-call and tool-executing
      execute through ToolPipeline
      persist tool result + tool message + completed tool Step
      emit tool-result
    continue with projected messages
fail with agent-step-limit
```

文本和 Tool Call 可以同时出现在 assistant message 中。工具轮次产生的
assistant 文本会和 toolCalls 一起持久化，下一轮模型可以看到完整消息。

### 错误与取消

- 无 Registry/Pipeline 时收到 Tool Call，继续返回
  `agent-tool-call-unsupported`。
- Pipeline 的 `ToolExecutionError` 原样作为 Runner 的 cause，并将工具
  Step、Turn 持久化为 failed。
- 工具被 Approval 拒绝、取消或过期时，不调用工具实现，Turn 失败。
- 请求取消或消费者 `return()` 仍然写入 cancelled Step/Turn。
- maxSteps 用稳定的 `agent-step-limit` 错误结束。
- terminal append 失败继续使用现有 AggregateError 语义。

## 6. Transient AgentRuntimeEvent

增加：

```ts
type AgentRuntimeEvent =
  | { type: 'tool-call'; toolCall: ToolCall }
  | { type: 'tool-executing'; toolCall: ToolCall }
  | { type: 'tool-result'; result: ToolExecutionResult };
```

这些事件只服务于当前执行者、CLI、Server 或未来 Studio。它们不替代
Session Durable Events，也不保证断线重放。

## 7. 测试策略

### Session

- 新事件使用 Zod 校验；
- Projection 能恢复工具调用和结果；
- 错误/缺失引用被拒绝；
- 输入事件不被修改。

### Runtime

- 无工具文本流程保持通过；
- 单轮 Tool Call 能继续第二轮模型；
- 工具定义传给 LLM，但执行实现不泄露；
- 多个 Tool Call 按顺序提交 Pipeline；
- Tool Call delta 组装和非法顺序校验；
- Tool Pipeline 成功结果进入 tool message；
- Pipeline 错误持久化失败 Tool Step/Turn；
- 无 Pipeline 时保留 unsupported 错误；
- maxSteps、取消和 iterator.return() 正确结束。

不使用真实文件系统或真实网络 Provider；使用内存 Store、假的
LlmClient 和真实 ToolPipeline。

## 8. 后续扩展

后续可以在这个边界上增加工具失败恢复、并行 Tool Call、Agent HTTP/SSE、
Token/成本统计和 Studio Projection，但不能绕过当前 Pipeline 或把
transient event 直接当成 durable log。
