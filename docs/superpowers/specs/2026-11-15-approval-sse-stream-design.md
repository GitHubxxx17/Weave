# Approval SSE Stream Design

**日期：** 2026-11-15

**状态：** 已确认

**目标阶段：** Weave Studio 的审批实时控制面

## 1. 背景

Weave 当前已经具备 Runtime-owned 的 `ApprovalBroker` 和 Server
Approval REST API。REST API 可以查询审批列表、读取单条审批并提交
approve、reject、cancel 决策，但前端只能通过轮询发现状态变化。

轮询会增加请求数量，并且会让审批界面的响应延迟取决于轮询间隔。本切片
增加一个进程内 SSE 适配层，让前端在保持现有 REST 决策接口的同时，实时
接收审批创建和审批终态变化。

本切片不把 SSE 变成新的审批状态机，也不把事件写入 Session Event Store。
审批状态仍然只由 Runtime 的 `ApprovalBroker` 管理，Server 只负责把
Broker 事件转换为 HTTP 流。

## 2. 目标与非目标

### 2.1 目标

- 为 `ApprovalBroker` 增加进程内订阅能力。
- 在创建审批时发布 `approval.created` 事件。
- 在审批进入 approved、rejected、cancelled 或 expired 时发布
  `approval.resolved` 事件。
- 增加 `GET /approvals/stream` SSE 接口。
- 连接建立后发送一次 `approval.snapshot`，包含当前所有审批快照。
- 客户端断开或主动取消读取时，可靠移除订阅。
- 保留现有 Approval REST API，REST 和 SSE 共享同一个 Broker。
- 订阅监听器或 SSE 写入失败时，不破坏 Broker 的状态迁移。

### 2.2 非目标

- 不把审批事件持久化到 Session Event Store。
- 不提供跨进程、跨机器或重启后的事件恢复。
- 不替换 REST 决策接口。
- 不让 Server 直接执行工具或复制 Approval 状态机。
- 不在本切片实现 Agent 执行流的 SSE；AgentRuntimeEvent 适配属于后续
  独立切片。
- 不引入新的 SSE 或事件总线依赖，使用 Web 标准 `ReadableStream`。

## 3. 方案选择

### 方案 A：Server 定时轮询 Broker

Server 为每个连接启动定时器，周期性调用 `broker.list()` 并比较差异。
实现简单，但会重复计算、引入状态去重逻辑，并且实时性受轮询间隔限制。
它还会把事件判断放进 HTTP 层，削弱 Runtime 的状态边界。

### 方案 B：Broker 订阅 + Server SSE

Broker 在状态迁移的同一处发布不可变快照，Server 将事件编码为 SSE。
Server 不需要理解审批状态迁移，只处理连接生命周期和序列化。这个方案
复用现有 REST Broker，事件语义集中，测试边界清晰，因此采用方案 B。

### 方案 C：引入通用 Event Bus

新增通用事件总线，ApprovalBroker 和未来 Session、Plugin 都发布到总线。
当前只有一个进程内事件源，通用总线会提前固定更多抽象，增加依赖和清理
复杂度。本切片暂不采用；当多个 Runtime 子系统确实需要共享事件语义时，
再单独设计 Event Bus 契约。

## 4. Runtime 契约

在 `@weave/runtime` 中增加：

```ts
export interface ApprovalEvent {
  readonly type: 'approval.created' | 'approval.resolved';
  readonly request: ApprovalRequest;
}

export type ApprovalListener = (event: ApprovalEvent) => void;
```

`ApprovalBroker` 增加：

```ts
subscribe(listener: ApprovalListener): () => void;
```

事件规则：

1. `request()` 通过输入校验并写入 Map 后发布 `approval.created`。
2. 已取消的请求不会进入 Map，因此不会发布 `approval.created`。
3. `timeoutMs: 0` 仍先发布 created，再发布 resolved expired；这样观察者
   可以看到完整的状态迁移。
4. `approve()`、`reject()`、`cancel()` 和 `expire()` 更新快照后发布
   `approval.resolved`，并且在等待 Promise resolve/reject 前完成通知。
5. 事件中的 `request` 是独立的不可变快照，监听器修改不了 Broker 内部
   状态。
6. 监听器按订阅顺序收到事件；一个监听器抛错时，其他监听器仍然继续。
7. `subscribe()` 返回幂等的 unsubscribe 函数，重复调用不会抛错。
8. 事件订阅只保证当前 Runtime 进程内的实时通知。

订阅集合使用 `Set` 管理。通知时复制集合后再遍历，避免监听器在回调中
取消订阅或新增订阅影响当前事件的分发顺序。

## 5. Server SSE 契约

新增：

```text
GET /approvals/stream
```

成功响应：

```http
HTTP/1.1 200 OK
Content-Type: text/event-stream
Cache-Control: no-cache
Connection: keep-alive
```

事件格式使用标准 SSE：

```text
event: approval.snapshot
data: {"approvals":[...]}

event: approval.created
data: {"approvalId":"...","status":"pending",...}

event: approval.resolved
data: {"approvalId":"...","status":"approved",...}
```

连接建立后，Server 先发送一个 `approval.snapshot`。快照不是状态迁移
事件，只是连接建立时的当前视图；后续 `approval.created` 和
`approval.resolved` 才表示实时变化。这样前端可以用一次连接完成初始化，
仍然可以使用已有 REST API 做单项详情和决策。

SSE handler 的职责：

- 解析 Runtime Service，找不到 Broker 时返回稳定的 503 JSON 错误。
- 创建 `ReadableStream` 和 UTF-8 编码器。
- 先写 snapshot，再订阅 Broker。
- 将 Broker 事件编码为 `event`、`data` 和空行。
- 在 request abort、stream cancel 或 enqueue 失败时取消订阅并关闭流。

为了避免连接建立窗口丢事件，handler 必须在同一个同步的
`ReadableStream.start()` 回调中先取得当前列表、建立订阅并发送 snapshot。
在单线程 JavaScript 执行模型下，Broker 不会插入另一个同步状态迁移；之后
的异步状态迁移会通过已建立的 listener 发送。

## 6. 错误与生命周期

- Broker 的订阅回调是同步通知，不能因为 listener 抛错而回滚状态迁移。
- SSE 的 `controller.enqueue()` 可能在客户端断开后抛错；Server 必须捕获
  该错误，并执行一次清理。
- 清理操作必须幂等：unsubscribe、close 和 abort 处理可以因不同路径重复
 触发，但不能产生未处理异常。
- 连接关闭后不再向已关闭的 controller 写入。
- SSE 只发送 JSON 可序列化的 `ApprovalRequest` 快照；如果未来允许复杂
  `inputSummary`，需要在协议层增加可序列化约束，而不是在 Server 随意
  截断或转换。
- 无 Broker 时，SSE 与 REST 使用相同的 `approval-service-unavailable`
  错误码。

## 7. 测试策略

### Runtime

`packages/runtime/test/approval-broker.test.ts` 覆盖：

- created 和 resolved 事件；
- 四种终态；
- unsubscribe 和重复 unsubscribe；
- 一个监听器抛错不影响其他监听器；
- 事件快照不可变；
- pre-aborted request 不发布 created；
- 零超时先 created 后 resolved expired。

### Server

`apps/server/test/approval-api.test.ts` 覆盖：

- SSE 状态码和响应头；
- snapshot 的事件名和现有审批内容；
- 新建审批收到 created；
- approve 后收到 resolved；
- `reader.cancel()` 触发流清理；
- 无 Broker 返回 503；
- 现有 REST 查询和决策接口保持可用。

测试不依赖真实网络端口，继续使用 Hono `app.request()` 和 Web 标准
`ReadableStream`。连接生命周期难以通过所有适配器一致模拟的部分，由
Runtime 的 unsubscribe 测试保证，Server 测试验证可观察的 HTTP 行为。

## 8. 后续扩展

后续 Studio 前端可以把 snapshot 作为初始状态，把 created/resolved 事件
映射到本地审批 Store。跨进程部署、重连游标、Last-Event-ID、权限过滤和
持久化审计需要新的设计，不能直接把当前进程内 SSE 契约当成分布式事件
系统。
