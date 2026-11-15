# Agent HTTP/SSE：从 Runtime 事件到前端实时流

这篇文档解释 Weave 如何把 Runtime 的一次 Agent 执行暴露给浏览器。
重点不是 SSE API 的语法，而是为什么 HTTP 层只做适配，为什么取消必须回到
Runtime，以及 transient 事件和 durable Session 事件为什么不能混在一起。

## 1. 先看完整请求链路

当前接口是：

```text
POST /agent/runs/stream
  -> 读取 JSON body
  -> Zod 校验 HTTP 输入
  -> 调用注入的 AgentRunner.run()
  -> Runtime 产生 AgentRuntimeEvent
  -> Server 编码成 SSE
  -> 浏览器 fetch() 读取 ReadableStream
```

Runtime 内部仍然负责真正的 Agent 行为：

```text
AgentRunner
  -> SessionEventStore 恢复上下文
  -> LlmClient.stream()
  -> ToolPipeline 执行工具
  -> SessionEventStore 写入 durable facts
  -> yield AgentRuntimeEvent
```

因此 Server 没有自己的模型循环，也没有直接调用
`ToolDefinition.execute()`。这保证 CLI、桌面端和 HTTP 使用的是同一套
Runtime 语义。

## 2. HTTP 输入为什么要单独校验

Runtime 的 `AgentRunRequest` 包含一个内部使用的 `signal`。这个 signal
不是 JSON 数据，应该由 Server 从当前 HTTP 请求注入：

```ts
const request = {
  ...validatedBody,
  signal: context.req.raw.signal,
};
```

HTTP schema 因此只接受：

```ts
{
  sessionId: string;
  userMessage: UserMessage;
  provider: string;
  model: string;
  temperature?: number;
  maxTokens?: number;
  reasoningEffort?: string;
}
```

校验失败发生在 SSE Response 建立之前，所以可以正常返回 JSON：

```json
{
  "error": {
    "code": "agent-invalid-input",
    "message": "Agent request body is invalid"
  }
}
```

这比让 Runtime 收到任意 `unknown` 更清晰：HTTP 层负责外部输入边界，
Runtime 负责自己的领域契约，两层都保留校验，避免未来被其他调用方绕过。

## 3. SSE 帧如何表达 Runtime 事件

每个 Runtime 事件都使用自己的 `type` 作为 SSE `event` 名称，完整事件
放在 `data` 中：

```text
event: text-delta
data: {"type":"text-delta","text":"你好"}

event: tool-call
data: {"type":"tool-call","toolCall":{"id":"call-1","name":"echo","arguments":"{}"}}

event: completed
data: {"type":"completed","turnId":"turn-1"}
```

SSE 的空行表示一条消息结束。客户端可以按空行切帧，再解析 `event` 和
`data`。Server 不重新定义第二套事件联合类型，而是直接复用
`AgentRuntimeEvent` 的顺序和字段。这一点很重要：如果 Server 重新设计
一套事件，CLI、桌面端和浏览器就会出现三套不一致的状态机。

当前会透传的事件包括：

| SSE event         | 用途                             |
| ----------------- | -------------------------------- |
| `text-delta`      | 增量渲染 assistant 文本          |
| `reasoning-delta` | 展示模型 reasoning 增量          |
| `tool-call`       | 告知前端已经组装出完整 Tool Call |
| `tool-executing`  | 告知工具开始执行                 |
| `tool-result`     | 告知工具返回的规范化结果         |
| `completed`       | 告知当前 Turn 已完成             |
| `error`           | 流建立后发生失败                 |

## 4. 为什么是 POST + fetch，而不是 EventSource

`EventSource` 的优点是很容易订阅一个 GET SSE 地址，但它不适合当前接口：

1. Agent 请求需要 JSON body；
2. 前端需要发送 Session、用户消息、Provider 和模型；
3. `EventSource` 不能按这个契约发送 POST body；
4. `fetch()` 既可以提交 JSON，也可以读取响应体的
   `ReadableStream`。

浏览器端最小消费示例：

```ts
type AgentStreamEvent = {
  type: string;
  [key: string]: unknown;
};

async function runAgent(message: string): Promise<void> {
  const response = await fetch('/agent/runs/stream', {
    method: 'POST',
    headers: {
      accept: 'text/event-stream',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      sessionId: 'session-1',
      userMessage: {
        role: 'user',
        content: [{ type: 'text', text: message }],
      },
      provider: 'mock',
      model: 'test-model',
    }),
  });

  if (!response.ok) {
    throw new Error((await response.json()).error.message);
  }

  const reader = response.body?.getReader();
  if (reader === undefined) {
    throw new Error('Agent stream body is missing');
  }

  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });
    const frames = buffer.split('\n\n');
    buffer = frames.pop() ?? '';

    for (const frame of frames) {
      const eventName = frame.match(/^event: (.+)$/m)?.[1];
      const dataText = frame.match(/^data: (.+)$/m)?.[1];
      if (eventName === undefined || dataText === undefined) {
        continue;
      }

      const event = JSON.parse(dataText) as AgentStreamEvent;
      if (eventName === 'text-delta') {
        renderAssistantText(String(event.text ?? ''));
      } else if (eventName === 'tool-executing') {
        showToolStatus(event);
      } else if (eventName === 'completed') {
        markTurnCompleted(event);
      } else if (eventName === 'error') {
        showAgentError(event);
      }
    }
  }
}
```

真实 Studio 还应该把 SSE parser 抽成前端基础设施，并为
`eventName` 做 discriminated union 校验。示例为了突出传输过程，使用了
简化的 `string` 类型。

## 5. 请求断开为什么要调用 iterator.return()

Agent Runner 的结果是 `AsyncIterable<AgentRuntimeEvent>`。HTTP 流结束时，
可能还有一个模型请求、工具执行或 Session 写入正在等待。如果 Server
只关闭浏览器连接而不通知迭代器，Runtime 可能继续消耗模型和执行工具。

因此适配层维护三个动作：

```text
Request.signal abort
ReadableStream.cancel()
enqueue/close 失败
        -> AsyncIterator.return()
        -> Runtime 复用已有取消逻辑
        -> Session 持久化 cancelled Turn/Step
```

清理函数必须幂等，因为同一次断开可能同时触发请求 abort 和
ReadableStream cancel。适配层只负责通知 Runner，取消后的 Session 语义仍
由 Runtime 决定。

## 6. transient 事件和 durable 事件的区别

`AgentRuntimeEvent` 是实时展示用的 transient event：

- `text-delta` 可能很多条，适合逐字渲染；
- `reasoning-delta` 是模型流中的临时增量；
- `tool-executing` 只表达当前运行状态；
- SSE 断开后，客户端不能仅靠本接口重放已经错过的事件。

`SessionEvent` 是恢复和审计用的 durable fact：

- 用户消息；
- assistant 完整消息；
- `turn.started`、`turn.completed`；
- `step.started`、`step.completed`；
- Tool Call 和 Tool Result 的持久化事实。

如果把每个 SSE delta 都写入 Session，会导致事件数量膨胀，并把展示传输
格式强行绑定到持久化模型。当前 Runner 只把适合恢复和投影的事实写入
Session，Server 只传输实时事件。

## 7. 为什么本阶段不设计 runId 和重连

当前接口是一条请求对应一条实时 Agent Turn：

```text
一次 POST -> 一条 SSE -> 一个 Runner iterator
```

如果现在增加 `runId` 和独立 GET 订阅，还必须同时解决：

- Run Registry 保存什么状态；
- 多个订阅者如何管理；
- 请求断开后 Runner 是否继续；
- 页面刷新后如何恢复；
- Last-Event-ID 如何重放；
- 进程重启后哪些状态可恢复。

这些问题属于后台任务和事件恢复设计，而不是当前最小 HTTP Adapter。等
Studio 真正需要刷新页面继续观察或多端订阅时，可以单独增加
`AgentRunRegistry`，让它订阅同一个 Runner 事件源，而不是在 Server 里
复制 Agent Loop。

## 8. 面试时如何表达

可以按下面的顺序回答：

1. **分层**：Runtime 负责 Agent Loop、工具和 Session；Server 只做 HTTP
   输入校验和 SSE 传输。
2. **契约**：Runtime 输出 `AgentRuntimeEvent`，Server 直接用事件类型作为
   SSE event，避免重复定义状态机。
3. **取消**：浏览器断开会触发请求 `AbortSignal` 或流 cancel，Server 调用
   AsyncIterator `return()`，Runtime 再负责取消模型/工具并持久化终态。
4. **持久化**：实时 delta 是 transient，Session 只保存可恢复的 durable
   facts，不把传输帧当作数据库事件。
5. **演进**：当前用 POST + fetch 解决单请求实时流；需要重连、多订阅和后台
   任务时，再引入 Run Registry 和 replay 协议。

## 9. 自测题

1. 为什么 HTTP body 不能直接复用包含 `AbortSignal` 的 Runtime schema？
2. 如果 SSE Response 已经返回 `200`，Runtime 后续失败时为什么不能再改成
   `500`？
3. 为什么 `reader.cancel()` 不能只关闭浏览器流？
4. 为什么 `text-delta` 不应该逐条写入 Session Event Store？
5. 什么需求出现时，才值得引入 `runId`、Last-Event-ID 和 Run Registry？
