# Weave Approval HTTP API 设计

**日期：** 2026-11-15

**状态：** 已确认，进入实施

**目标阶段：** Server 薄控制面与 Runtime Approval Broker 的 HTTP 适配

## 1. 目标

本轮为 `apps/server` 增加最小可用的 Approval HTTP API，让前端或其他本地
客户端可以发现和处理 Runtime 内正在等待的 Approval Request。

本轮完成后应满足：

1. Server Runtime 装配一个实例级 `ApprovalBroker`；
2. HTTP 可以列出所有 Approval Request；
3. HTTP 可以查询单个 Approval Request；
4. HTTP 可以批准、拒绝和取消 pending Approval；
5. 所有外部 JSON 输入都经过 Zod 校验；
6. HTTP 错误使用稳定的 `code` 和明确的状态码；
7. Hono handler 只负责适配 HTTP，不复制 Approval 状态机；
8. 工具仍然只能通过 `ToolPipeline` 执行；
9. 不实现 SSE、身份认证、角色权限、Session durable approval events
   和跨进程 Approval Store。

## 2. 为什么先做 REST 控制面

当前 `ApprovalBroker` 已经提供了状态查询和终态决策方法，但还没有事件订阅
能力。直接增加 SSE 会同时引入 Broker 订阅、连接生命周期、广播、断线重连
和流式测试。

因此本轮先通过 REST 固定 Server 与 Runtime 的控制面边界：

```text
HTTP Client
  -> Hono Approval Routes
    -> Runtime.get(approvalBrokerService)
      -> ApprovalBroker
        -> waiting ToolPipeline
```

前端可以先使用轮询验证完整的审批流程。下一条独立分支再增加
`ApprovalBroker.subscribe()` 和 SSE 适配。

## 3. Runtime Service 装配

`apps/server/src/runtime.ts` 新增并导出：

```ts
export const approvalBrokerService: RuntimeService<ApprovalBroker>;
```

服务创建时返回一个新的 `createApprovalBroker()` 实例：

```ts
export const approvalBrokerService: RuntimeService<ApprovalBroker> = {
  key: Symbol('weave.server.approval-broker'),
  create: () => createApprovalBroker(),
};
```

`createServerRuntime()` 将它与 Mock LLM 和 Session Event Store 一起注册。
这样每个 Server Runtime 都有自己的 Broker，测试之间不会共享审批状态。

`createApp()` 接收可选的 `approvalBrokerService` 定义，而不是直接接收 Broker
实例。请求处理时通过 `runtime.get()` 读取服务，保持 Runtime 生命周期和
Server 控制面一致。

如果 `createApp()` 没有传入 Approval Service，健康检查仍然正常工作，但
Approval API 返回 `503` 和 `approval-service-unavailable`，不能创建一个
隐式的全局 Broker。

## 4. HTTP API

### 4.1 列出审批请求

```text
GET /approvals
```

成功响应：

```json
{
  "approvals": [
    {
      "approvalId": "approval-id",
      "toolCallId": "call-1",
      "toolName": "write_file",
      "operation": "workspace.write_file",
      "summary": "写入 Workspace 文件 src/app.ts",
      "risk": "high",
      "inputSummary": {
        "path": "src/app.ts",
        "bytes": 128,
        "overwrite": false
      },
      "status": "pending",
      "createdAt": "2026-11-15T10:00:00.000Z"
    }
  ]
}
```

状态码：`200`。

列表保持 Broker 的创建顺序。终态快照也会返回，因为当前 Broker 保留终态
用于查询和后续审计适配。

### 4.2 查询单个审批

```text
GET /approvals/:approvalId
```

成功时返回一个 `ApprovalRequest` 对象，状态码为 `200`。

如果 ID 不存在：

```json
{
  "error": {
    "code": "approval-not-found",
    "message": "Approval request was not found"
  }
}
```

状态码：`404`。

### 4.3 批准

```text
POST /approvals/:approvalId/approve
```

请求体可选：

```json
{
  "reason": "用户确认"
}
```

请求体省略时等价于空对象。`reason` 必须是非空字符串，最大长度为 1000。
成功时返回更新后的 `ApprovalRequest`，状态码为 `200`。

### 4.4 拒绝

```text
POST /approvals/:approvalId/reject
```

请求体和批准相同。成功时 Approval 进入 `rejected`，返回最新快照，状态码为
`200`。

### 4.5 取消

```text
POST /approvals/:approvalId/cancel
```

请求体和批准相同。成功时 Approval 进入 `cancelled`，等待中的 Pipeline
Promise 会收到 `ApprovalError('approval-cancelled')`，HTTP 返回最新快照，
状态码为 `200`。

## 5. 输入与错误边界

HTTP 层使用 Zod 校验：

- `:approvalId` 必须是非空字符串；
- JSON body 必须是对象；
- 只允许 `reason` 字段；
- `reason` 必须是 1 到 1000 个字符；
- 空 body 视为 `{}`，方便前端执行无理由决策。

HTTP 不返回 `Error.cause`，避免把 Node、文件系统或内部实现细节泄漏给
客户端。错误响应统一为：

```ts
interface ApprovalHttpErrorResponse {
  readonly error: {
    readonly code: string;
    readonly message: string;
  };
}
```

状态码映射：

| Runtime 错误码 | HTTP 状态码 |
|---|---:|
| `approval-invalid-input` | 400 |
| `approval-not-found` | 404 |
| `approval-already-resolved` | 409 |
| `approval-cancelled` | 409 |
| `approval-expired` | 409 |
| `approval-service-unavailable` | 503 |
| JSON 或 Zod 校验失败 | 400 |

如果 Runtime 尚未启动，`runtime.get()` 的服务不可用错误也映射为
`approval-service-unavailable` 和 `503`。

## 6. Handler 与 Runtime 的职责

Server Handler 只做以下事情：

1. 匹配路由；
2. 读取参数和请求体；
3. 用 Zod 校验输入；
4. 从 Runtime 获取 `ApprovalBroker`；
5. 调用 Broker 的一个公开方法；
6. 序列化成功快照或稳定错误。

Server 不做以下事情：

- 不判断工具是否需要 Approval；
- 不直接调用工具的 `execute`；
- 不修改 Session Event Store；
- 不实现 Approval 状态迁移；
- 不保存第二份审批状态；
- 不依赖具体 Workspace 或文件工具。

## 7. 测试策略

Server 测试应覆盖：

- `GET /health` 既有行为不回归；
- `GET /approvals` 返回创建顺序和终态快照；
- `GET /approvals/:approvalId` 返回成功和 404；
- approve、reject、cancel 返回最新快照；
- approve、reject、cancel 可以让 Broker 中等待的 Promise 完成；
- 未知 ID 返回 404；
- 重复决策返回 409；
- 非法 JSON、未知字段、空 reason、超长 reason 返回 400；
- 未装配 Approval Service 或 Runtime 未启动返回 503；
- HTTP 层不返回 `cause`；
- `createServerRuntime()` 为每个 Runtime 创建独立 Broker。

## 8. 明确不实现

本轮不实现：

- Approval SSE；
- Broker 事件订阅；
- 用户登录、身份认证和角色权限；
- CSRF、跨域策略和远程多租户安全；
- Session durable approval events；
- 多进程共享和进程重启恢复；
- Studio 审批页面；
- 工具执行和 Agent Loop 的 HTTP 化。

这些能力应在 REST 控制面稳定后，按独立功能分支继续增加。
