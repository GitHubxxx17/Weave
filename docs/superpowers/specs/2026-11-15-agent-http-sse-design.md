# Agent HTTP/SSE Adapter Design

**日期：** 2026-11-15

**状态：** 已确认

**目标阶段：** 为 Runtime Agent Tool Loop 增加最小 HTTP/SSE 适配层

## 1. 背景

Weave Runtime 已经可以在内存中完成一轮 Agent Tool Loop：

```text
用户消息
  -> LlmClient
  -> Tool Call
  -> ToolPipeline
  -> Tool Result
  -> 下一轮 LLM
  -> AgentRuntimeEvent
```

但是当前 `AgentRunner` 只能被 Node、CLI 或测试代码直接调用，Server 还没有
Agent 执行入口。因此 Studio 前端无法通过 HTTP 观察文本增量、工具执行状态、
完成、失败和取消。

本阶段只增加薄 HTTP/SSE Adapter，不重新实现 Agent Loop，也不把 transient
Runtime Event 复制成第二套 durable 状态。

## 2. 目标与非目标

### 2.1 目标

- 增加一个可以从浏览器调用的 Agent SSE HTTP endpoint；
- 使用现有 `AgentRunRequest` 作为 Runtime 输入契约；
- 在 HTTP 边界使用 Zod 校验 JSON body；
- 将 `AgentRuntimeEvent` 编码为标准 SSE；
- 保持文本、reasoning、Tool Call、工具执行、工具结果和 completed 的顺序；
- 将 Runtime 的失败转换为不泄露 `Error.cause` 的 SSE error event；
- 客户端断开时中止当前 Agent Run；
- 让测试可以注入假的 Agent Runner，不依赖真实 Provider 或 TCP 端口；
- 保持 Server 只做适配，Agent 行为继续位于 Runtime。

### 2.2 非目标

- 不实现 Agent Run 列表、查询、删除或重连接口；
- 不实现独立 `GET /agent/runs/:runId/stream`；
- 不实现 Last-Event-ID、断线重放或跨进程事件广播；
- 不新增 Agent durable events；
- 不让 Server 直接访问 Tool Registry 或 `ToolDefinition.execute`；
- 不实现 Studio 前端；
- 不改变 Agent Runner 的 Session、ToolPipeline、取消和错误语义。

## 3. 方案选择

### 方案 A：POST 创建 Run，GET 独立订阅

POST 返回 `runId`，GET 使用 `runId` 建立 SSE，另外增加取消接口。

优点是更接近长期任务系统，也便于多个客户端订阅。缺点是需要新的
transient Run Registry、订阅生命周期、连接重连语义和取消路由。当前
Session Event Store 尚无 Run 状态恢复能力，容易在第一版引入第二套状态机。

### 方案 B：POST 直接返回 SSE

客户端用 `fetch` 提交 JSON，Server 直接返回 `text/event-stream`。请求
断开时通过 `Request.signal` 取消 Agent Runner。

这个方案与当前 `AgentRunner.run(): AsyncIterable<AgentRuntimeEvent>` 最匹配，
不需要 Run Registry，也不需要复制 transient 状态。浏览器可以使用
`fetch()` 读取 `ReadableStream`，后续如果需要长期任务和重连，再独立设计
Run Registry 和恢复协议。

**本阶段采用方案 B。**

### 方案 C：Server 直接调用 Runtime 内部实现

Server 在路由中自行读取模型流、调用工具和写 Session。

这种方案短期代码少，但会绕过 Runtime 的 Agent Runner、ToolPipeline 和
Session 约束，破坏当前分层。不采用。

## 4. HTTP 契约

### 4.1 Endpoint

```text
POST /agent/runs/stream
Content-Type: application/json
Accept: text/event-stream
```

请求 body：

```ts
type AgentRunHttpRequest = {
  sessionId: string;
  userMessage: UserMessage;
  provider: string;
  model: string;
  temperature?: number;
  maxTokens?: number;
  reasoningEffort?: string;
};
```

HTTP schema 与 Runtime `agentRunRequestSchema` 保持同一字段集合，但不接受
`signal`，因为 signal 由 Server 从请求生命周期注入：

```ts
const request = {
  ...parsedBody,
  signal: context.req.raw.signal,
};
```

### 4.2 非流式错误

以下错误发生在创建 SSE Response 之前，使用 JSON 返回：

| 场景 | HTTP 状态 | 错误码 |
| --- | ---: | --- |
| body 不是合法 JSON | 400 | `agent-invalid-input` |
| body 不符合 Agent 请求 schema | 400 | `agent-invalid-input` |
| Agent Runner Service 不可用 | 503 | `agent-service-unavailable` |

响应形状：

```json
{
  "error": {
    "code": "agent-invalid-input",
    "message": "Agent request body is invalid"
  }
}
```

### 4.3 SSE 事件

每个 Runtime Event 使用对应的 SSE event name，data 是 JSON：

```text
event: text-delta
data: {"type":"text-delta","text":"你好"}

event: tool-call
data: {"type":"tool-call","toolCall":{"id":"call-1","name":"echo","arguments":"{}"}}

event: completed
data: {"type":"completed","turnId":"turn-1"}
```

Runtime Event 的 `type` 是唯一事件名来源，不在 Server 中重新设计第二套
事件联合类型。Server 只负责编码和传输。

### 4.4 流内错误

SSE Response 建立后，模型、ToolPipeline、Session 或协议错误不能再改变
HTTP status，因此发送一次：

```text
event: error
data: {"error":{"code":"tool-execution-failed","message":"Tool \"echo\" failed"}}
```

随后关闭流。错误消息只暴露稳定 code 和面向调用方的 message，不暴露
`Error.cause`、堆栈、文件绝对路径或 Provider 私有响应。

### 4.5 Response headers

```text
Cache-Control: no-cache
Connection: keep-alive
Content-Type: text/event-stream
```

本阶段不发送心跳注释，不实现 Last-Event-ID。流中事件顺序等于 Runner
产生顺序。

## 5. Runtime 与 Server 边界

当前 Runtime Service 工厂只接收 `RuntimeContext`，没有向后创建的 Service
提供 `runtime.get()` 的依赖注入能力。因此本阶段不把 `AgentRunner` 伪装成
一个同级 Service，也不修改 Runtime 容器来提前引入依赖图。

生产组合根在 Runtime 启动后读取已经创建的 LLM 和 Session Store，再创建
一个 Agent Runner 实例，并将实例注入 HTTP App：

```ts
await runtime.start();
const agentRunner = createAgentRunner({
  llm: runtime.get(mockLlmService),
  sessionStore: runtime.get(sessionEventStoreService),
});
const app = createApp(runtime, {
  approvalBrokerService,
  agentRunner,
});
```

`createApp()` 的 options 接受 `AgentRunner` 实例。测试可以注入假的 Runner；
HTTP 路由只调用 `runner.run()`。如果没有注入 Runner，路由返回 503。路由
不在每个请求中创建新的工具状态机，也不读取或修改 Session。

未来如果 Runtime 需要完整的依赖图和长生命周期 Agent 服务，再单独设计
Service dependency declaration；本阶段不扩展 Runtime 容器。

## 6. 取消和资源清理

SSE 流创建时记录当前请求的 `AbortSignal`。请求 abort、ReadableStream
`cancel()` 或 Controller enqueue/close 失败时：

1. 标记流已清理，避免重复 close；
2. 调用当前 Agent AsyncIterator 的 `return()`；
3. 让 Agent Runner 使用既有取消语义持久化 cancelled Step/Turn；
4. 删除事件监听器；
5. 关闭输出流。

正常完成时不主动调用 `return()`，让 `for await` 自然结束。错误时发送
一次 error event，再关闭流。清理必须幂等。

## 7. 测试策略

### HTTP

- 合法请求返回 SSE headers；
- 文本和 completed 事件按顺序编码；
- Tool Call、Tool Result 和 reasoning event 原样编码；
- 非法 JSON 和非法 body 返回 400 JSON；
- Service 缺失返回 503 JSON；
- Agent Runner 抛错时发送 error SSE 且不泄露 cause；
- Reader cancel 会调用 Runner iterator.return；
- 重复 cleanup 不重复调用 return 或 close。

### Runtime 复用

HTTP 测试使用假的 `AgentRunner` 和 `RuntimeService`，验证的是 Adapter
行为而不是重复验证 Agent Tool Loop。Agent Runner 的行为由
`packages/runtime/test/agent-runner.test.ts` 继续负责。

## 8. 后续升级路径

当 Studio 需要后台长任务、刷新页面继续观察或多个客户端订阅时，再增加：

```text
AgentRunRegistry
  -> runId
  -> transient subscribers
  -> Session Projection recovery
```

这应作为独立功能设计，不能在本阶段偷偷引入。
