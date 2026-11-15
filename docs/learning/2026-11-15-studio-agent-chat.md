# Weave Studio Agent Chat 学习说明

这篇文档面向前后端基础较好、但第一次做 Agent 产品的开发者。目标不是
介绍 React 或 SSE 的全部细节，而是解释一个最小 Agent 产品如何把
Runtime、HTTP、浏览器流和 UI 状态连接起来。

本阶段的链路是：

```text
Browser Studio
  -> fetch POST /agent/runs/stream
  -> Server HTTP/SSE adapter
  -> Runtime AgentRunner
  -> LlmClient / ToolPipeline / SessionEventStore
```

Studio 是第一个可以用浏览器观察 Agent 的工作台，但它不是 Runtime 的
替代品，也还不是完整的 Weave 产品。

## 1. 为什么 Studio 不导入 Runtime

`apps/studio` 是浏览器应用，`packages/runtime` 是 Node 侧的 Agent 领域
运行时。两者的职责不同：

```text
Studio
  负责输入、展示、取消和本地临时 UI 状态

Server
  负责 HTTP 输入校验、SSE 编码和请求生命周期适配

Runtime
  负责模型调用、工具执行、Session 恢复和生命周期持久化
```

如果 Studio 直接导入 Runtime，会产生几个问题：

1. 浏览器会被迫理解 Node、文件系统、Session Store 或 Provider 的依赖；
2. UI 可能绕过 Server 和 Tool Pipeline，形成另一套 Agent Loop；
3. Runtime 的内部实现会变成前端的耦合协议，后续替换运行时成本很高；
4. 浏览器无法安全地直接获得 Workspace、工具执行和密钥相关能力。

因此 Studio 只依赖公开的 HTTP/SSE 契约。它知道请求字段和
`AgentRuntimeEvent` 的可展示形状，但不知道 Runtime 如何调用模型、如何
执行工具，也不直接写 Session。

这是一个典型的边界设计：

```text
浏览器边界: HTTP request / SSE response
领域边界:   AgentRunRequest / AgentRuntimeEvent
基础设施边界: LlmClient / SessionEventStore / ToolPipeline
```

这样做也便于测试。前端可以 mock `fetch` 或 `streamAgentRun()`，Runtime
可以直接测试 Agent Loop，Server 可以测试 HTTP adapter，三层不需要启动
同一个进程才能验证各自的行为。

## 2. 为什么使用 fetch + ReadableStream

当前接口是：

```text
POST /agent/runs/stream
Content-Type: application/json
Accept: text/event-stream
```

`EventSource` 适合订阅一个 GET SSE 地址，但它不适合当前的 Agent Turn：

- Agent 请求需要 JSON body；
- body 中包含 Session、用户消息、Provider 和模型；
- 原生 `EventSource` 不提供发送 POST body 的接口；
- `EventSource` 的自动重连语义不适合当前还没有 Run Registry 的短生命周期请求。

`fetch()` 可以同时满足两个需求：

1. 用 `POST` 和 JSON body 提交一次 Agent 请求；
2. 从 `Response.body` 获取 `ReadableStream<Uint8Array>`，边接收边渲染。

Studio 的 `agent-stream.ts` 负责传输层工作，React 的 `App.tsx` 只接收
已经校验过的事件：

```text
fetch
  -> Response.body.getReader()
  -> TextDecoder
  -> SSE frame parser
  -> Zod event validation
  -> AgentRuntimeEvent
  -> React state update
```

`fetch()` 不会自动解析 SSE。浏览器只负责给出字节流，SSE 事件边界、JSON
解析、事件类型校验和终止语义都需要应用层实现。

## 3. UTF-8 chunk 和 SSE frame 不是一回事

这是流式开发中最容易混淆的两个边界。

### 3.1 UTF-8 chunk boundary

网络层给出的 `Uint8Array` chunk 只是一次读取得到的字节片段。它可能在
任意字节位置截断，例如一个中文字符的 UTF-8 编码可能被拆到两个 chunk：

```text
chunk 1: ... E4
chunk 2: B8 AD ...
```

如果直接把每个 chunk 转成字符串，可能得到替换字符。Studio 使用：

```ts
const decoder = new TextDecoder();
buffer += decoder.decode(value, { stream: true });
```

`TextDecoder` 会保留尚未完整解码的多字节字符，等下一块字节到达后再输出
正确的 Unicode 字符。最后一次读取结束时，还要调用一次不带 `stream: true`
的 `decode()` 刷出 decoder 中的剩余状态。

### 3.2 SSE frame boundary

SSE 使用空行结束一条 frame：

```text
event: text-delta
data: {"type":"text-delta","text":"你好"}

```

但一次 `reader.read()` 可能包含半条 frame、一条 frame 或多条 frame。
因此不能把一次 `read()` 当成一次事件，也不能把一次 UTF-8 解码结果当成
完整 JSON。

正确顺序是：

```text
bytes -> UTF-8 text -> buffer -> SSE frame -> event/data -> JSON -> typed event
```

代码要保留未完成的 `buffer`。当找到 `\n\n` 或 `\r\n\r\n` 时，才取出完整
frame；最后一个没有空行的 frame，则在 response 结束时处理。

SSE 的多行 `data:` 也有自己的规则。多行 data 需要用换行合并后再解析
JSON，空帧和以 `:` 开头的注释行需要忽略。未知事件可以忽略，因为这为
协议向后兼容留下了空间；已知事件但字段非法，则必须转换为安全的协议错误。

## 4. Parser 如何映射到 React 状态

Parser 不应该直接修改 DOM，也不应该知道 React。它只做两件事：

1. 把不可靠的 HTTP 字节流转换成可靠的、经过 Zod 校验的事件；
2. 按网络接收顺序调用 `onEvent`。

UI 层再把事件映射到本地状态：

| Runtime event     | React state 变化             |
| ----------------- | ---------------------------- |
| `text-delta`      | 追加到当前 assistant message |
| `reasoning-delta` | 追加到 reasoning 文本        |
| `tool-call`       | 创建 `called` 的工具活动     |
| `tool-executing`  | 将对应工具改为 `executing`   |
| `tool-result`     | 保存结果并改为 `completed`   |
| `completed`       | Run 状态改为 `completed`     |
| `error`           | 保存安全错误并改为 `error`   |

提交消息时，App 会同时插入 user message 和空的 assistant message。之后
收到 `text-delta` 时使用函数式 state update 追加文本，而不是从 DOM 读取
当前内容。这能保证连续 delta 在 React 批量更新时仍然按顺序合并。

第一版状态保持在 `App` 内，因为页面只有一个工作台，暂时没有跨路由或
跨页面共享状态的需求。未来加入 Session 列表、Workspace、Approval 和
Crew 后，再根据状态所有权决定是否拆分 store，而不是一开始就引入全局状态
管理库。

## 5. runId 如何防止取消竞态

取消一个请求并不意味着它的所有异步回调已经同步消失。旧请求可能在取消
之后晚到一个事件，或者晚一点抛出 `AbortError`。如果新请求已经开始，旧
请求就可能错误地修改新请求的 assistant message 或状态。

Studio 为每次提交生成一个唯一的 `runId`：

```text
submit A -> runId A
cancel A
submit B -> runId B
```

事件、错误和 `finally` 清理都先检查：

```text
activeRunId === current callback runId
```

只有仍属于当前 Run 的回调才允许更新 React 状态。取消时先让旧
`activeRunId` 失效，再调用 `AbortController.abort()`，这样旧请求即使稍后
回调也只会被丢弃。

这个问题本质上不是 React 特有的，而是异步请求生命周期的并发问题。任何
支持“取消后立即重新发送”的实时界面，都需要请求身份、版本号或等价的
所有权判断。

## 6. AbortController 的跨层取消链路

取消是一条跨层控制链：

```text
用户点击 Cancel
  -> controller.abort()
  -> 浏览器 fetch rejected with AbortError
  -> Server request signal / response cancel
  -> AsyncIterator.return()
  -> Runtime 中止模型或工具
  -> Runtime 持久化 cancelled Turn/Step
  -> Studio 显示 Cancelled
```

Server 仍然是 HTTP 和 Runtime 之间的适配层。它不应该自己复制一套
“取消中的 Agent 状态机”，而应该把请求断开转换为 Runner iterator 的
`return()`。Runtime 才知道当前是在等待模型、执行工具，还是准备写入
Session，也才有能力决定如何保存取消终态。

前端只把 `AbortError` 视为用户取消，不把它展示成系统故障。其他错误分为：

- SSE 建立前的 HTTP 错误，例如 `400` 或 `503`；
- SSE 建立后的 `error` 事件；
- 客户端发现的协议错误。

这些错误都应该使用安全的 `code` 和 `message`，不能把本地路径、堆栈或
Provider 的敏感响应原样展示给用户。

## 7. 本地 Mock 为什么放在 composition root

本地演示脚本位于 `apps/server/src/runtime.ts`，由 composition root 选择
固定的 Mock LLM：

```ts
const localDemoScript = [
  { type: 'text-delta', text: '这是 Weave 的本地 Agent 演示。' },
  { type: 'text-delta', text: ' 当前消息通过 SSE 增量传输。' },
  { type: 'finish', reason: 'stop' },
];
```

这不是在 Server 里重新实现 Agent Loop，而是在组装服务时注入一个确定性
的 `LlmClient`。Agent Runner、Tool Pipeline、Session 持久化和 SSE adapter
仍然走生产代码路径。

把 Mock 放在 composition root 有三个好处：

1. 领域逻辑不需要知道“这是演示环境”；
2. 测试和浏览器验收每次都能得到确定结果；
3. 以后接入真实 Provider 时只替换服务选择，不改 Studio 契约。

## 8. Transient 和 durable

两类事件服务不同目的：

```text
AgentRuntimeEvent
  面向实时消费者，transient

SessionEvent
  面向恢复、投影和审计，durable
```

`text-delta`、`reasoning-delta` 和 `tool-executing` 适合实时展示，不适合
逐条写入 Session。原因包括：

- delta 数量很多，会膨胀事件存储；
- 网络传输分块不是领域事实；
- SSE 断开后，部分 delta 可能已经到达浏览器、部分还没有到达；
- 把传输格式写入数据库会让持久化模型绑定到某个 UI 协议。

Session 更适合保存用户消息、完整 assistant message、Turn/Step 生命周期、
Tool Call 和 Tool Result 等可恢复事实。Runtime 负责决定哪些事实应该追加；
Studio 只展示实时事件，不直接写 durable events。

当前项目没有 Run Registry，因此刷新页面或断开后不能通过本接口重放历史
运行。要支持后台任务、多端订阅和重连，需要单独设计 run ownership、
事件 replay、`Last-Event-ID`、进程重启恢复和权限边界。

## 9. 面试表达

可以按下面的顺序回答：

1. **分层**：Runtime 负责 Agent Loop、工具和 Session，Server 负责 HTTP
   输入校验与 SSE 适配，Studio 负责浏览器交互和展示。
2. **前端边界**：Studio 不导入 Runtime，只依赖稳定的 HTTP/SSE 契约，避免
   浏览器耦合 Node 和领域内部实现。
3. **流式处理**：先用 `TextDecoder` 解决 UTF-8 字节边界，再用 buffer 解决
   SSE frame 边界，最后用 Zod 验证事件结构。
4. **状态模型**：parser 只产生 typed events，React 根据事件更新消息、
   reasoning、工具活动和 Run 状态。
5. **取消语义**：AbortController 触发 fetch 取消，Server 将断开转换为
   iterator return，Runtime 负责停止执行并持久化 cancelled 终态。
6. **持久化取舍**：实时 delta 是 transient，Session 保存 durable facts，
   当前单请求接口暂不承担重连和后台运行。
7. **演进方向**：需要刷新恢复、多端订阅或后台任务时，引入 Run Registry 和
   replay 协议，而不是把重连逻辑堆到当前页面。

## 10. 自测题

1. 为什么包含 `AbortSignal` 的 Runtime request 不能直接作为 HTTP JSON schema？
2. 为什么一次 `reader.read()` 不能等同于一条 SSE 事件？
3. UTF-8 字符边界和 SSE frame 边界分别由什么组件处理？
4. 为什么 `completed` 后 parser 应该结束消费并取消 reader？
5. 为什么取消后立即发送新请求时需要 `runId`？
6. 浏览器断开后，为什么 Server 需要调用 AsyncIterator `return()`？
7. 为什么 `text-delta` 不应逐条写入 Session Event Store？
8. 什么业务需求出现时，才值得引入 Run Registry、重连和 Last-Event-ID？
9. 为什么固定 Mock LLM 应该放在 composition root，而不是 Agent Runner 内部？
10. 如果 SSE 已经返回 `200`，Runtime 后续失败为什么只能发送 `error` 事件，
    不能再把 HTTP 状态改成 `500`？
