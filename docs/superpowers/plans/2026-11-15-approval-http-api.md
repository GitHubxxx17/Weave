# Approval HTTP API Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 `apps/server` 增加薄 REST Approval 控制面，让客户端可以查询并处理 Runtime 内存型 Approval Request。

**Architecture:** Server Runtime 装配一个实例级 `ApprovalBroker`，HTTP 层通过注入的 `RuntimeService<ApprovalBroker>` 获取它。Hono 路由只负责 Zod 输入校验、调用 Broker 和稳定错误响应，不复制审批状态机，也不直接执行工具。第一版只实现 REST，不实现 SSE、认证、持久化和工具执行 HTTP API。

**Tech Stack:** TypeScript、ESM、Hono、Zod、Vitest、`@weave/runtime`、`@weave/server`。

**Spec:** `docs/superpowers/specs/2026-11-15-approval-http-api-design.md`

## Global Constraints

- TypeScript、ESM、strict typing。
- 所有外部 JSON 输入必须先通过 Zod 校验。
- Approval 状态唯一保存在 Runtime 注入的 `ApprovalBroker` 中，Server 不保存第二份状态。
- 工具执行仍然只能经过 `ToolPipeline`，HTTP 不调用工具 `execute`。
- HTTP handler 保持薄，Approval 状态迁移属于 Runtime Broker。
- 不增加依赖，继续使用现有 Hono 和 Zod。
- 测试放在 `apps/server/test/`。
- `GET /health` 既有行为不能回归。
- 受保护服务缺失或 Runtime 尚未运行时，Approval API 必须 fail closed，返回 `503`。
- HTTP 错误响应不能暴露 `Error.cause`。
- 每个功能分支只解决本主题，提交信息使用中文 Conventional Commits。

---

### Task 1: 装配 Approval Broker Runtime Service

**Files:**

- Modify: `apps/server/src/runtime.ts`
- Modify: `apps/server/test/health.test.ts`

**Interfaces:**

```ts
import { createApprovalBroker, type ApprovalBroker, type RuntimeService } from '@weave/runtime';

export const approvalBrokerService: RuntimeService<ApprovalBroker>;
```

`createServerRuntime()` 必须注册 `mockLlmService`、`approvalBrokerService`
和 `sessionEventStoreService`。每次调用 `createServerRuntime()` 都必须创建
独立 Broker，不能使用模块级 Broker 实例。

- [x] **Step 1: Write the failing service-isolation test**

在 `apps/server/test/health.test.ts` 增加：

```ts
it('creates an isolated Approval Broker for each server Runtime', async () => {
  const first = createServerRuntime();
  const second = createServerRuntime();
  await first.start();
  await second.start();

  const firstBroker = first.get(approvalBrokerService);
  const secondBroker = second.get(approvalBrokerService);
  const pending = firstBroker.request({
    toolCallId: 'call-1',
    toolName: 'write_file',
    operation: 'workspace.write_file',
    summary: '写入测试文件',
    risk: 'high',
    inputSummary: { path: 'test.txt', bytes: 1, overwrite: false },
  });

  expect(firstBroker).not.toBe(secondBroker);
  expect(firstBroker.list()).toHaveLength(1);
  expect(secondBroker.list()).toHaveLength(0);

  firstBroker.cancel(firstBroker.list()[0]!.approvalId);
  await expect(pending).rejects.toMatchObject({ code: 'approval-cancelled' });
  await first.stop();
  await second.stop();
});
```

- [x] **Step 2: Run the focused test and verify it fails**

Run:

```bash
pnpm exec vitest run apps/server/test/health.test.ts --config vitest.config.ts
```

Expected failure: `approvalBrokerService` is not exported and the service is not
registered in `createServerRuntime()`.

- [x] **Step 3: Add the Runtime service**

Modify `apps/server/src/runtime.ts`:

```ts
export const approvalBrokerService: RuntimeService<ApprovalBroker> = {
  key: Symbol('weave.server.approval-broker'),
  create: () => createApprovalBroker(),
};
```

Register it in declaration order:

```ts
return createRuntime({
  services: [mockLlmService, approvalBrokerService, sessionEventStoreService],
});
```

- [x] **Step 4: Run service tests and existing server tests**

Run:

```bash
pnpm exec vitest run apps/server/test/health.test.ts --config vitest.config.ts
```

Expected: all server tests pass and every server Runtime receives a distinct
Broker instance.

- [x] **Step 5: Commit the service wiring**

```bash
git add apps/server/src/runtime.ts apps/server/test/health.test.ts
git commit -m "feat: 装配服务端审批 Broker"
```

### Task 2: Add Approval HTTP Contract and Routes

**Files:**

- Create: `apps/server/src/approval-api.ts`
- Modify: `apps/server/src/app.ts`
- Modify: `apps/server/src/runtime.ts`
- Modify: `apps/server/test/approval-api.test.ts`

**Interfaces:**

```ts
export interface ApprovalAppOptions {
  readonly approvalBrokerService?: RuntimeService<ApprovalBroker> | undefined;
}

export function createApp(runtime: Runtime, options?: ApprovalAppOptions): Hono;
```

Routes:

```text
GET  /approvals
GET  /approvals/:approvalId
POST /approvals/:approvalId/approve
POST /approvals/:approvalId/reject
POST /approvals/:approvalId/cancel
```

Success payloads:

```ts
GET /approvals        -> { approvals: readonly ApprovalRequest[] }
GET /approvals/:id    -> ApprovalRequest
POST decision         -> ApprovalRequest
```

Request body:

```ts
{ readonly reason?: string }
```

`reason` 只能是 1 到 1000 个字符。空请求体按 `{}` 处理。未知字段、
非法 JSON、非对象 JSON 和非法 reason 都返回 `400`。

- [x] **Step 1: Add failing route tests**

创建 `apps/server/test/approval-api.test.ts`，先写以下公共测试辅助函数：

```ts
async function createApprovalApp() {
  const runtime = createServerRuntime();
  await runtime.start();
  const broker = runtime.get(approvalBrokerService);
  return {
    app: createApp(runtime, { approvalBrokerService }),
    broker,
    stop: () => runtime.stop(),
  };
}

function createPendingApproval(broker: ApprovalBroker): {
  readonly approvalId: string;
  readonly decision: Promise<ApprovalDecision>;
} {
  const decision = broker.request({
    toolCallId: 'call-http-1',
    toolName: 'write_file',
    operation: 'workspace.write_file',
    summary: '写入 Workspace 文件 src/app.ts',
    risk: 'high',
    inputSummary: { path: 'src/app.ts', bytes: 12, overwrite: false },
  });
  const request = broker.list()[0];
  if (request === undefined) {
    throw new Error('Expected a pending Approval request');
  }
  return { approvalId: request.approvalId, decision };
}
```

然后加入这些失败测试：

```ts
it('lists pending and terminal Approval snapshots', async () => {
  const { app, broker, stop } = await createApprovalApp();
  try {
    const pending = createPendingApproval(broker);
    const response = await app.request('/approvals');

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      approvals: [expect.objectContaining({ approvalId: pending.approvalId, status: 'pending' })],
    });

    broker.approve(pending.approvalId, '预先批准');
    await expect(pending.decision).resolves.toMatchObject({ status: 'approved' });
    expect((await app.request('/approvals')).status).toBe(200);
  } finally {
    await stop();
  }
});

it('gets and approves one pending request through HTTP', async () => {
  const { app, broker, stop } = await createApprovalApp();
  try {
    const pending = createPendingApproval(broker);
    const getResponse = await app.request(`/approvals/${pending.approvalId}`);
    expect(getResponse.status).toBe(200);

    const approveResponse = await app.request(`/approvals/${pending.approvalId}/approve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reason: '用户确认' }),
    });
    expect(approveResponse.status).toBe(200);
    expect(await approveResponse.json()).toMatchObject({
      approvalId: pending.approvalId,
      status: 'approved',
      decisionReason: '用户确认',
    });
    await expect(pending.decision).resolves.toEqual({
      status: 'approved',
      reason: '用户确认',
    });
  } finally {
    await stop();
  }
});

it('maps rejected, cancelled, unknown and repeated decisions', async () => {
  const { app, broker, stop } = await createApprovalApp();
  try {
    const pending = createPendingApproval(broker);
    const rejectResponse = await app.request(`/approvals/${pending.approvalId}/reject`, {
      method: 'POST',
      body: JSON.stringify({ reason: '需要复核' }),
      headers: { 'content-type': 'application/json' },
    });
    expect(rejectResponse.status).toBe(200);
    await expect(pending.decision).resolves.toMatchObject({ status: 'rejected' });

    const repeatedResponse = await app.request(`/approvals/${pending.approvalId}/approve`, {
      method: 'POST',
    });
    expect(repeatedResponse.status).toBe(409);
    expect(await repeatedResponse.json()).toEqual({
      error: {
        code: 'approval-already-resolved',
        message: 'Approval request is already rejected',
      },
    });

    const unknownResponse = await app.request('/approvals/missing');
    expect(unknownResponse.status).toBe(404);
    expect(await unknownResponse.json()).toEqual({
      error: {
        code: 'approval-not-found',
        message: 'Approval request was not found',
      },
    });
  } finally {
    await stop();
  }
});
```

- [x] **Step 2: Add failing validation and unavailable-service tests**

继续在 `approval-api.test.ts` 加入：

```ts
it.each([
  ['', 400],
  ['{}', 400],
  ['{"reason":""}', 400],
  ['{"reason":"ok","extra":true}', 400],
  ['not-json', 400],
])('rejects invalid decision body %s with %s', async (body, expectedStatus) => {
  const { app, broker, stop } = await createApprovalApp();
  try {
    const pending = createPendingApproval(broker);
    const response = await app.request(`/approvals/${pending.approvalId}/approve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    });
    expect(response.status).toBe(expectedStatus);
    expect(await response.json()).toMatchObject({
      error: { code: 'approval-invalid-input' },
    });
    broker.cancel(pending.approvalId);
    await expect(pending.decision).rejects.toMatchObject({ code: 'approval-cancelled' });
  } finally {
    await stop();
  }
});

it('returns 503 when the Approval service is not available', async () => {
  const runtime = createRuntime();
  await runtime.start();
  const response = await createApp(runtime).request('/approvals');

  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({
    error: {
      code: 'approval-service-unavailable',
      message: 'Approval service is not available',
    },
  });
  await runtime.stop();
});
```

- [x] **Step 3: Run the focused tests and verify the expected failures**

Run:

```bash
pnpm exec vitest run apps/server/test/approval-api.test.ts --config vitest.config.ts
```

Expected failures: `approval-api.test.ts` and its route helpers do not yet
exist, and `createApp()` does not mount Approval routes.

- [x] **Step 4: Implement the HTTP contract helpers**

Create `apps/server/src/approval-api.ts` with:

```ts
const approvalIdSchema = z.string().min(1);
const decisionBodySchema = z
  .object({ reason: z.string().min(1).max(1000).optional() })
  .strict();

interface ApprovalHttpError {
  readonly error: {
    readonly code: string;
    readonly message: string;
  };
}
```

Implement these helpers:

```ts
function jsonError(
  context: Context,
  status: ContentfulStatusCode,
  code: string,
  message: string,
): Response;

function approvalStatusForError(code: ApprovalErrorCode): ContentfulStatusCode;

async function readDecisionReason(context: Context): Promise<
  { readonly success: true; readonly reason: string | undefined } |
  { readonly success: false; readonly response: Response }
>;
```

`readDecisionReason()` must read the raw body text. Empty or whitespace-only body
becomes `{}`; non-empty body is parsed with `JSON.parse`, then validated by
`decisionBodySchema`. Never pass an unvalidated body to Broker.

- [x] **Step 5: Implement thin routes**

Mount the route functions in `createApp()`:

```ts
const options = appOptions ?? {};
const approvalBrokerService = options.approvalBrokerService;

app.get('/approvals', (context) => {
  const broker = getApprovalBroker(runtime, approvalBrokerService);
  if (broker instanceof Response) {
    return broker;
  }
  return context.json({ approvals: broker.list() }, 200);
});
```

Use the same `getApprovalBroker()` helper for all routes. It must return a
`503` response when the service definition is absent or `runtime.get()` throws.
Decision handlers call exactly one Broker method after validation:

```ts
broker.approve(approvalId, reason)
broker.reject(approvalId, reason)
broker.cancel(approvalId, reason)
```

Catch `ApprovalError` and map it with:

```ts
const approvalHttpStatus: Record<ApprovalErrorCode, ContentfulStatusCode> = {
  'approval-invalid-input': 400,
  'approval-not-found': 404,
  'approval-already-resolved': 409,
  'approval-cancelled': 409,
  'approval-expired': 409,
};
```

For unexpected internal errors, return `500` with
`approval-internal-error` and a generic message. Do not include `cause`,
stack traces, or raw exception messages.

- [x] **Step 6: Export the app options and run Server tests**

Export `ApprovalAppOptions` from `apps/server/src/app.ts` or
`apps/server/src/approval-api.ts`, update `createApp()` to accept the optional
options object, and keep existing `/health` calls source-compatible.

Run:

```bash
pnpm --filter @weave/server lint
pnpm --filter @weave/server typecheck
pnpm exec vitest run apps/server/test/health.test.ts apps/server/test/approval-api.test.ts --config vitest.config.ts
```

Expected: all health and Approval API tests pass.

- [x] **Step 7: Commit the REST control plane**

```bash
git add apps/server/src/app.ts apps/server/src/approval-api.ts apps/server/src/runtime.ts apps/server/test/health.test.ts apps/server/test/approval-api.test.ts
git commit -m "feat: 增加审批 HTTP 控制面"
```

### Task 3: Documentation and Project Plan Synchronization

**Files:**

- Modify: `README.md`
- Modify: `docs/architecture/foundation.md`
- Modify: `docs/superpowers/specs/2026-11-15-approval-http-api-design.md`
- Create: `docs/superpowers/plans/2026-11-15-approval-http-api.md`

内容：

- README 补充 Approval REST API 示例和轮询说明；
- Foundation Architecture 更新 Server 控制面数据流；
- 设计文档追加真实实现结果、错误映射和当前边界；
- 计划勾选已完成步骤并记录验证数字；
- 不在代码或计划中伪造 SSE、认证或持久化能力。

- [x] **Step 1: Write the failing documentation checks**

在实现提交后检查：

```bash
rg -n "GET /approvals|approval-service-unavailable|approval-http-api" README.md docs/architecture/foundation.md docs/superpowers/specs/2026-11-15-approval-http-api-design.md
```

Expected before documentation edits: README 和 Foundation 尚未说明 REST
Approval 控制面。

- [x] **Step 2: Update the documentation**

README 至少补充：

```text
GET /approvals
GET /approvals/:approvalId
POST /approvals/:approvalId/approve
POST /approvals/:approvalId/reject
POST /approvals/:approvalId/cancel
```

明确说明 REST 当前采用轮询，SSE 是后续独立分支；HTTP 不执行工具，所有
工具行为仍由 Runtime Pipeline 控制。

- [x] **Step 3: Record implementation evidence**

在设计文档增加：

- Runtime Service 装配完成；
- REST 路由和错误映射完成；
- 请求体校验和 `cause` 脱敏完成；
- Server 测试数量；
- `pnpm check` 验证结果；
- 当前未实现 SSE、认证、持久化和多进程恢复。

- [x] **Step 4: Update plan checkboxes and run final verification**

运行：

```bash
pnpm format:check
pnpm check
git diff --check
```

确认 `apps/server` 和 Runtime 的所有测试通过后，更新计划 checkbox。

- [x] **Step 5: Commit documentation**

```bash
git add README.md docs/architecture/foundation.md docs/superpowers/specs/2026-11-15-approval-http-api-design.md docs/superpowers/plans/2026-11-15-approval-http-api.md
git commit -m "docs: 补充审批 HTTP 控制面说明"
```

### Task 4: Push, Pull Request, and Auto-Merge

**Files:** None.

- [ ] **Step 1: Inspect final Git scope**

```bash
git status --short --branch
git diff origin/main...HEAD --stat
git log --oneline origin/main..HEAD
```

工作区必须干净，当前分支必须是 `feat/approval-http-api`，所有提交都只
属于 Approval HTTP API。

- [ ] **Step 2: Push the development branch**

```bash
git push -u origin HEAD:refs/heads/feat/approval-http-api
```

验证 upstream 必须是 `origin/feat/approval-http-api`，不能指向 `main`。

- [ ] **Step 3: Create the Pull Request**

```bash
gh pr create \
  --repo GitHubxxx17/Weave \
  --base main \
  --head feat/approval-http-api \
  --title "feat: 增加审批 HTTP 控制面" \
  --body "## 变更内容
- 装配服务端 Approval Broker
- 增加审批列表、查询、批准、拒绝、取消 REST API
- 补充 Zod 输入校验和稳定 HTTP 错误映射
- 更新架构和学习说明

## 验证
- pnpm check

## 合并方式
请使用 squash merge 合入 main，保留远程功能分支。"
```

- [ ] **Step 4: Enable automatic squash merge**

```bash
gh pr merge <PR_NUMBER> \
  --repo GitHubxxx17/Weave \
  --auto \
  --squash
```

不要删除远程分支。CI 通过后确认 PR 状态为 `MERGED`，记录 squash merge
commit。
