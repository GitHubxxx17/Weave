# Weave Agent Tool Loop：从模型工具调用到安全执行

## 这一步解决什么问题

此前的 Agent Runner 只能完成一轮文本模型请求：

```text
用户消息 -> 模型 -> 最终文本
```

真实 coding agent 需要让模型先请求工具，Runtime 执行工具，再把结果交回模型：

```text
用户消息
  -> 模型请求工具
  -> ToolPipeline 校验、审批并执行
  -> 工具结果进入下一轮上下文
  -> 模型生成最终回答
```

这条链路就是 Agent Tool Loop。它不是“模型直接执行函数”，而是 Runtime 编排模型轮次，ToolPipeline 统一承担工具安全边界，Session Event Store 保存可恢复的事实。

## 三个核心边界

### Agent Runner：负责编排

Agent Runner 负责：

- 从 Session Projection 恢复消息；
- 构造 LLM 请求；
- 将 `tool-call-start` 和 `tool-call-delta` 组装成完整 Tool Call；
- 维护模型步骤上限；
- 按顺序调用 ToolPipeline；
- 把工具结果转换成下一轮的 `role: tool` 消息；
- 持久化 Turn、Step、Message 和工具事件；
- 向当前消费者发送 transient runtime event。

Runner 不负责解析工具参数、审批、超时、结果截断或直接调用工具函数。

### ToolPipeline：负责执行边界

ToolPipeline 是所有工具的统一入口。它负责：

- 根据工具名查找注册项；
- 解析 JSON 参数；
- 使用工具自己的 Zod Schema 校验参数；
- 等待 Approval；
- 传递取消信号；
- 处理超时；
- 序列化并限制工具结果；
- 归一化错误。

这样 Workspace 文件工具、未来 Shell 工具和插件工具都遵循同一条安全链路。

### Session：负责保存事实

Session 保存的是可重放的 durable facts，而不是每个实时增量：

- assistant 的 Tool Call 消息；
- `tool-call.created`；
- `tool-result.created`；
- `role: tool` 消息；
- model/tool Step 的开始和完成；
- Turn 的最终状态。

`text-delta`、`tool-executing` 等只属于当前连接的 transient event，不逐条写入 Event Store。

## 一次完整执行

第一轮模型返回：

```text
tool-call-start(call-1, echo)
tool-call-delta({"value":"x"})
finish(tool-call)
```

Runner 将其组装为：

```ts
{
  id: 'call-1',
  name: 'echo',
  arguments: '{"value":"x"}',
}
```

之后按以下顺序追加事实：

```text
assistant message(toolCalls)
step.completed(model)
step.started(tool)
tool-call.created
tool-result.created
message.created(role=tool)
step.completed(tool)
step.started(model)
```

第二轮 LLM 请求会同时收到：

```ts
[
  { role: 'user', ... },
  {
    role: 'assistant',
    content: [],
    toolCalls: [{ id: 'call-1', name: 'echo', arguments: '{"value":"x"}' }],
  },
  {
    role: 'tool',
    toolCallId: 'call-1',
    content: [{ type: 'text', text: 'x' }],
  },
]
```

模型最终返回 `finish(stop)` 后，Runner 才会完成最后一个 model Step 和 Turn。

## 为什么必须保留两种工具结果

`tool-result.created` 和 `message.created(role=tool)` 看起来重复，但职责不同：

| 数据                         | 主要用途                           |
| ---------------------------- | ---------------------------------- |
| `tool-result.created`        | 时间线、工具状态、错误码、截断标志 |
| `message.created(role=tool)` | 恢复下一轮 LLM 上下文              |

如果只有工具事件，Projection 可以展示工具执行，但下一轮模型无法按标准消息协议看到结果；如果只有 tool message，前端又无法稳定展示工具状态和错误分类。

## 失败和安全策略

### 工具失败

ToolPipeline 抛出 `ToolExecutionError` 时：

1. 写入失败的 `tool-result.created`；
2. 将当前 tool Step 标记为 `failed`；
3. 将 Turn 标记为 `failed`；
4. 重新抛出原始 Pipeline 错误；
5. 第一版不把失败结果重新交给模型自动恢复。

这样用户能看到失败事实，调用方也能根据稳定错误码决定重试或提示。

### 工具调用配置错误

`toolRegistry` 和 `toolPipeline` 必须同时提供。只提供一个通常说明 Runtime 装配不完整，因此创建 Runner 时直接拒绝。两者都没有时，Runner 仍然可以作为无工具 Agent 使用。

### 步数上限

默认 `maxSteps = 8`，只计算模型步骤，不把每个工具调用单独算作模型步骤。达到上限后抛出 `agent-step-limit`，避免模型和工具之间出现无限循环。

### 不做并行

同一轮多个 Tool Call 先按模型返回顺序串行执行。这样更容易保证：

- 事件顺序稳定；
- 审批状态可理解；
- 工具之间的副作用顺序明确；
- 测试和故障恢复简单。

并行执行需要额外设计依赖关系、资源锁和结果排序，留到后续阶段。

## 前后端边界

当前 Runner 是 Runtime API，还没有 Agent HTTP `/run` 和 Agent SSE。未来 Server 只负责：

1. 校验 HTTP 输入；
2. 创建或获取 Runtime Agent Runner；
3. 将 `AgentRuntimeEvent` 转换为 SSE；
4. 处理连接关闭和错误响应。

Server 不应重新实现模型循环，也不应直接调用 Tool Registry 中的 `execute`。Studio 前端只消费事件和 Session Projection，不接触 Node 文件 API。

## 面试表达

可以这样回答：

> 我把 Agent Tool Loop 拆成三个边界。Agent Runner 负责模型轮次和状态编排，ToolPipeline 负责所有工具的参数校验、审批、取消、超时和结果限制，Session Event Store 负责 append-only 的可恢复事实。模型返回的工具调用先通过流事件组装成完整 Tool Call，再交给 Pipeline 执行。成功结果同时保存为工具结果事件和 `role: tool` 消息，前者服务于时间线和审计，后者服务于下一轮模型上下文。工具失败时持久化失败状态并保留原始错误，第一版不自动把失败结果重新喂给模型，从而让错误边界更清晰。

## 自测问题

1. 为什么 Runner 不能直接调用 `ToolDefinition.execute`？
2. 为什么工具结果需要同时保存事件和 `role: tool` 消息？
3. `maxSteps` 为什么只统计模型步骤？
4. 为什么第一版多个 Tool Call 采用串行执行？
5. transient runtime event 和 durable Session event 有什么区别？
6. 工具失败时为什么要先持久化失败结果再重新抛错？
7. HTTP/SSE 层为什么不能自己实现 Agent Loop？

## 当前验证

本阶段重点测试：

- 单个 Tool Call 继续下一轮模型；
- 多个 Tool Call 按顺序执行；
- ToolPipeline 失败后的失败结果和失败 Turn；
- `maxSteps`；
- 重复 Tool Call start；
- 无工具配置时保持 `agent-tool-call-unsupported`；
- 原有无工具 Agent、取消、迭代器停止和终态持久化行为。

代码验证命令：

```bash
pnpm exec vitest run packages/runtime/test/agent-runner.test.ts --config vitest.config.ts
pnpm check
```
