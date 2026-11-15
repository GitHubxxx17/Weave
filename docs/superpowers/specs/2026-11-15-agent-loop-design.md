# Weave Agent Loop 最小执行边界设计

**日期：** 2026-11-15

**状态：** 已实施

**目标阶段：** Weave Studio 的 Headless Agent 基础

## 1. 背景

Weave 已经具备三项可以组合的基础能力：

- `@weave/protocol` 提供 `Message`、`LlmRequest` 和 `StreamEvent`；
- `@weave/llm` 提供 Provider 无关的 `LlmClient.stream()`；
- `@weave/session` 提供 append-only `SessionEventStore` 和
  `projectSession()`。

目前缺少的是 Agent 行为边界：如何从 Session 事件恢复上下文，调用模型，
把流式输出转换为可观察结果，并在完成、失败或取消时记录 durable facts。

本轮已经实现一个最小、无工具的 Agent Loop。它证明一条完整的 headless
执行链路，而不是一次实现 Agent 平台的所有能力。

## 2. 目标

完成后，调用方可以通过一个 Runtime 层的 Agent Runner 执行：

```text
用户消息
  -> Session Event
  -> Turn
  -> Model Step
  -> LLM Stream
  -> Assistant Message
  -> Session Event
```

具体要求：

1. 从现有 Session 事件恢复 Message 上下文；
2. 追加本轮用户消息；
3. 创建一个 Turn 和一个 `model` Step；
4. 通过 `LlmClient.stream()` 调用模型；
5. 实时转发文本和 reasoning 增量；
6. 聚合完整助手消息并持久化；
7. 在完成、失败或取消时持久化对应的 Step/Turn 状态；
8. 不依赖 HTTP、Hono、React、SQLite 具体 API 或 Provider SDK；
9. 通过 In-Memory LLM 和 Session Store 完成确定性测试。

同一个 `AgentRunner` 实例会按 `sessionId` 串行执行 Agent Run，覆盖
Session 读取、初始化事件追加、模型上下文构造、模型流和终态追加。这样同一
Session 的并发调用不会重复 `session.created`，也不会把一个请求的消息混入
另一个请求。当前 `SessionEventStore` 没有 CAS 或 lease 接口，因此不同
Runner 实例或不同进程之间不提供并发协调；跨实例协调属于后续 Session
并发切片，不在本轮扩展公共 API。

## 3. 非目标

本轮明确不实现：

- Tool Registry；
- Tool Pipeline；
- 工具参数解析和执行；
- Workspace、Sandbox 和 Approval；
- 多轮工具调用；
- Agent 配置文件或 Plugin Manifest；
- HTTP `/run` 或 SSE API；
- 前端页面；
- Crew、Subagent 和并行 Agent；
- 自动压缩上下文、Token Budget 和 Context Engineering；
- 重试、fallback 和 provider routing。

虽然 `StreamEvent` 已经支持工具调用增量，但本轮遇到
`tool-call-start` 或 `tool-call-delta` 时，Agent Runner 将以稳定的
“tool calls are not supported”错误结束本轮，并将 Step/Turn 标记为失败。
不能把工具调用静默丢弃，否则会产生模型已经请求工具但 Session 没有记录失败
的错误状态。

## 4. 方案选择

### 4.1 在 Server 路由中实现 Agent Loop

不选择。这样会让 HTTP Handler 负责 Session 读取、模型调用、事件持久化和
错误处理，后续 CLI、桌面端和测试无法复用同一套 Agent 行为。

### 4.2 让 Session 包实现 Agent Loop

不选择。Session 包只负责 durable facts 和 Projection，不应该知道
`LlmClient`、Provider 流或 Agent 业务顺序，否则持久化层会反向依赖运行时行为。

### 4.3 选择：在 Runtime 中实现独立 Agent Runner

选择在 `@weave/runtime` 增加 `createAgentRunner()`。Runner 依赖两个稳定抽象：

```ts
interface AgentRunnerOptions {
  readonly llm: LlmClient;
  readonly sessionStore: SessionEventStore;
}
```

它不负责创建依赖，也不负责选择具体实现。Server、CLI、桌面端或测试从 Runtime
Service Container 获取依赖后，把它们注入 Runner。

这样可以保持：

```text
protocol -> { llm, session } -> runtime -> server
```

同时避免为了本轮功能提前引入通用服务依赖图、拓扑排序或复杂的 Runtime
Service Container 重构。

## 5. 公共 API

### 5.1 Agent Runner 输入

```ts
interface AgentRunRequest {
  readonly sessionId: string;
  readonly userMessage: UserMessage;
  readonly provider: string;
  readonly model: string;
  readonly temperature?: number;
  readonly maxTokens?: number;
  readonly reasoningEffort?: string;
  readonly signal?: AbortSignal;
}
```

`userMessage` 在进入 Runner 时必须是 `role: 'user'`。Runner 对整个请求执行
Zod 校验，不能依赖 TypeScript 类型保证外部输入合法。

`sessionId` 用于选择事件流；`provider` 和 `model` 组成本次模型请求的路由
元数据。当前没有 Provider Registry，因此具体 `LlmClient` 已经由调用方选好，
Runner 不根据 `provider` 动态查找客户端。

### 5.2 Agent Runner 输出

```ts
type AgentRuntimeEvent =
  | {
      readonly type: 'text-delta';
      readonly text: string;
    }
  | {
      readonly type: 'reasoning-delta';
      readonly text: string;
    }
  | {
      readonly type: 'completed';
      readonly turnId: string;
    };
```

Runner 使用异步可迭代对象输出临时运行事件：

```ts
for await (const event of runner.run(request)) {
  // 立即发送给 CLI、桌面端或未来的 HTTP/SSE 适配器
}
```

这些事件不是 Session durable events。调用方中途停止消费时，Runner 的错误和
清理语义仍由 Runner 自己负责；不能把“消费者没有继续读取”当作成功完成。
如果消费者提前调用 iterator 的 `return()`，Runner 将把本轮视为取消，执行
与 AbortSignal 相同的 cancelled 持久化。

`return()` 会先中止 Runner 内部的 AbortSignal，再等待正在进行的模型读取和
终态持久化完成；它返回 `{ done: true, value: undefined }`。如果终态持久化
失败，则 `return()` 抛出包含持久化错误的 `AggregateError`。如果执行已经完成
但消费者仍有排队事件，`return()` 会丢弃剩余 transient events，直接结束迭代器。

### 5.3 Agent 错误

Runner 暴露稳定错误类型：

```ts
type AgentRunErrorCode =
  | 'agent-invalid-input'
  | 'agent-stream-protocol'
  | 'agent-tool-call-unsupported';

class AgentRunError extends Error {
  readonly code: AgentRunErrorCode;
}
```

- `agent-invalid-input`：请求没有通过 Zod 校验；
- `agent-stream-protocol`：模型流缺少 finish、出现重复 finish，或 finish 后仍有事件；
- `agent-tool-call-unsupported`：模型请求执行当前尚未实现的 Tool Pipeline。

Provider 抛出的 `LlmError`、Store 抛出的 `SessionStoreError` 和 AbortError 保留
原始类型，不重复包装成 AgentRunError。

## 6. 执行流程

### 6.1 读取现有上下文

Runner 首先读取：

```ts
const storedEvents = await sessionStore.read(sessionId);
```

如果事件为空，本轮视为新 Session，先追加：

```ts
{
  type: 'session.created',
  payload: {},
}
```

如果事件不为空，则通过 `projectSession(storedEvents)` 恢复已有状态。
不允许跳过 Projection 直接从事件中手写提取 Message，因为那会复制 Session
业务规则。

### 6.2 追加用户消息和 Turn/Step

Runner 追加以下 durable events：

```text
message.created(user message)
turn.started
step.started(kind = "model")
```

`messageId`、`turnId` 和 `stepId` 由 Runner 使用 UUID 生成。Store 继续负责
eventId、sequence 和 occurredAt。

这三个事件使用一次 `append()` 批量追加。Store 已经保证批量追加要么全部成功，
要么全部失败，因此不会出现“Turn 已开始但 Model Step 没有创建”的半初始化状态。

追加后，Runner 重新读取或在内存中组合完整消息列表，生成本次
`LlmRequest.messages`。本轮只允许把已经持久化的 Session Message 发送给模型，
不把 transient delta 当成上下文。

### 6.3 调用模型并转发流

Runner 调用：

```ts
llm.stream(
  {
    provider,
    model,
    messages,
    temperature,
    maxTokens,
    reasoningEffort,
  },
  { signal },
)
```

遇到：

- `text-delta`：追加到 assistant text buffer，并立即 yield；
- `reasoning-delta`：追加到 reasoning buffer，并立即 yield；
- `finish`：标记模型流终止，等待最终持久化；
- `tool-call-start` 或 `tool-call-delta`：抛出稳定的未支持工具错误。

模型流必须且只能包含一个 `finish`，并且 `finish` 必须是最后一个事件。流结束时
没有 `finish`、出现重复 `finish`，或者 `finish` 后继续输出，都属于
`agent-stream-protocol`。`finish.reason = 'tool-call'` 即使没有显式工具增量，
也属于 `agent-tool-call-unsupported`。

`stop`、`length`、`content-filter` 和 `unknown` 作为模型正常结束原因处理。当前
Session Event Schema 没有单独保存 finish reason 和 token usage；本轮不扩展
事件模型，它们将在后续 Observability/Token Meter 垂直切片中设计。

本轮 assistant Message 只持久化文本内容。Reasoning 是模型过程信息，当前
Session Message 协议没有单独的 reasoning 字段，因此不把 reasoning 混入用户
可见文本。Reasoning 的 durable 记录方式留到后续 Token/Observability 设计。

如果模型只产生 reasoning、没有文本，Runner 不创建空的 assistant message；
但仍然完成 Step/Turn，并在运行结果中返回 `completed`。

### 6.4 完成持久化

当模型流正常结束并且存在文本内容时，追加：

```text
message.created(assistant message)
step.completed(status = "completed")
turn.completed(status = "completed")
```

完成阶段使用一次批量 `append()`。如果 assistant message 存在，它与 Step/Turn
完成事件在同一批次中写入；如果没有文本，则只批量写入两个完成事件。

最后 yield：

```ts
{
  type: 'completed',
  turnId,
}
```

Assistant message 的 `content` 当前只包含一个 `text` part。后续如果要把
reasoning、tool calls 或多模态内容持久化，应先扩展协议和 Session Event Schema，
不能在 Runner 中偷偷添加非标准字段。

## 7. 失败和取消语义

### 7.1 模型错误

当 `LlmClient.stream()` 抛出错误：

1. Runner 追加 `step.completed(status = 'failed')`；
2. Runner 追加 `turn.completed(status = 'failed', reason)`；
3. Runner 重新抛出原始 LLM 错误；
4. 不追加不完整的 assistant message；
5. 不 yield `completed`。

两个失败事件使用一次批量 `append()`。

如果失败事件本身追加失败，Runner 保留最初模型错误，并通过
`AggregateError` 暴露持久化失败，不能静默覆盖其中一个错误。

### 7.2 外部取消

调用方传入的 `AbortSignal` 传递给 LLM Client。取消时：

1. Runner 追加 `step.completed(status = 'cancelled')`；
2. Runner 追加 `turn.completed(status = 'cancelled')`；
3. 不追加不完整的 assistant message；
4. 重新抛出 AbortError；
5. 不 yield `completed`。

两个取消事件使用一次批量 `append()`。

取消判断优先于普通模型错误。这样前端点击停止后，Session 状态会明确显示
cancelled，而不是模糊的 failed。

### 7.3 持久化阶段错误

如果用户消息、Turn 或 Step 的初始化事件写入失败，模型不会被调用；Runner
直接抛出 Store 错误。因为此时还没有完整的 Turn/Step 生命周期，不能伪造失败
事件覆盖原始存储错误。

## 8. Durable Event 与 Runtime Event 的边界

```text
LLM StreamEvent / Runtime Event       Durable Session Event
-------------------------------------------------------------
text-delta("你好")                    message.created(完整消息)
reasoning-delta("分析中")             当前不持久化
finish(reason, usage)                 step.completed + turn.completed
completed                             仅用于实时运行通知
```

`LlmClient.stream()` 产生 Provider 无关的 transient `StreamEvent`。Runner
筛选并转发其中的文本和 reasoning 作为 `AgentRuntimeEvent`，供实时 UI、CLI
和未来 SSE 使用。Session Event 是 append-only durable fact，用于重启恢复、
时间线、Projection 和审计。Runner 当前不持久化 finish reason、usage 或
reasoning；两个事件模型不能互相替代。

## 9. 测试策略

### 正常完成

- 新 Session 自动创建；
- 用户消息、Turn、Model Step 被追加；
- Mock LLM 的文本增量按顺序 yield；
- assistant message 被持久化；
- Step 和 Turn 变为 completed；
- 最后收到 completed Runtime Event。

### 继续已有 Session

- 读取已有 Message；
- 新用户消息追加到末尾；
- LLM Request 包含完整历史；
- 不重复追加 `session.created`。

### Reasoning

- reasoning delta 会被实时 yield；
- 不混入 assistant 文本；
- 当前不新增 reasoning durable event。

### 模型失败

- 不写入不完整 assistant message；
- Step 和 Turn 标记 failed；
- 原始错误被重新抛出。

### 取消

- AbortSignal 传递给 LLM；
- Step 和 Turn 标记 cancelled；
- 不发送 completed Runtime Event。

### 工具调用

- 遇到工具事件时稳定失败；
- `finish.reason = 'tool-call'` 同样稳定失败；
- 不执行任何工具；
- 不静默丢弃工具调用；
- Step 和 Turn 标记 failed。

### 流协议

- 缺少 finish 时返回 `agent-stream-protocol`；
- 重复 finish 时返回 `agent-stream-protocol`；
- finish 后继续输出时返回 `agent-stream-protocol`；
- 协议失败时不写入不完整 assistant message。

### 输入校验

- 空 Session ID 被拒绝；
- 非 user role 的消息被拒绝；
- 缺少 provider 或 model 被拒绝。

## 10. 后续演进

本轮完成后，下一阶段才适合增加 Tool Pipeline：

```text
Agent Runner
  -> Model Step
  -> tool-call
  -> Tool Pipeline
  -> Approval / Workspace boundary
  -> tool result
  -> next model step
```

工具执行不能直接写在本轮 Runner 里。它必须经过共享 Tool Pipeline，并明确
Workspace、Approval、超时、取消和安全边界。

前端实时交互也应在本轮之后实现：

```text
AgentRuntimeEvent
  -> Server Adapter
  -> SSE/WebSocket
  -> Weave Studio
```

这样 HTTP 层只是传输适配器，不会重新实现 Agent 行为。

## 11. 面试解释

### 为什么 Agent Loop 放在 Runtime？

因为 Agent Loop 是运行时行为，需要组合 LLM、Session 和未来的 Tool Pipeline，
但不应该依赖 HTTP。放在 Runtime 可以被 Server、CLI 和桌面端复用。

### 为什么流式 delta 不直接持久化？

delta 是传输过程，不是最终业务事实。逐个保存会造成事件膨胀，也会把 Provider
协议细节泄露到 Session 模型。我们只把完成后的 assistant message 作为 durable
fact 保存。

### 为什么错误还要写失败事件并重新抛出？

事件日志负责恢复和展示状态，异常负责通知当前调用方。两者解决的问题不同，
不能用事件记录替代当前调用的错误传播。

### 为什么本轮不做工具？

工具执行会引入参数校验、权限、Workspace、Approval、取消和结果持久化。如果
没有 Tool Pipeline 边界，直接在 Agent Loop 中执行工具会让安全责任落在错误的
层级。因此本轮先明确失败边界，再单独实现工具垂直切片。
