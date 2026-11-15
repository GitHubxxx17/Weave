# Approval SSE Stream Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 Approval Broker 和 Server 控制面增加进程内实时 SSE 推送，同时保留现有 REST 查询和决策接口。

**Architecture:** `ApprovalBroker` 负责审批状态和事件订阅，Server 只把 Runtime 事件编码成 Web 标准 SSE。连接建立时发送一次快照，之后发送 created/resolved 事件；Session Event Store、Tool Pipeline 和审批状态机保持不变。

**Tech Stack:** TypeScript、ESM、Zod、Hono、Web `ReadableStream`、Vitest、pnpm、Turborepo。

**Spec:** `docs/superpowers/specs/2026-11-15-approval-sse-stream-design.md`

## Global Constraints

- TypeScript、ESM、strict typing。
- 外部输入必须使用 Zod 校验。
- Durable facts append-only；Approval SSE 事件是进程内 transient live-control state，不写入 Session Event Store。
- HTTP handlers 保持薄；审批行为继续属于 `@weave/runtime`。
- 工具必须通过共享 Tool Pipeline；本功能不增加新的工具执行路径。
- 不增加依赖，使用已有 Hono 和 Web 标准流。
- 测试放在对应 package 的 `test/` 目录。
- 跨 package 契约变化必须同步设计和架构文档。
- 每个功能使用独立分支，提交信息使用中文 Conventional Commits。
- 远程功能分支按仓库当前约定保留，使用 PR squash merge。

### Task 1: Commit the approved design

**Files:**
- Create: `docs/superpowers/specs/2026-11-15-approval-sse-stream-design.md`
- Create: `docs/superpowers/plans/2026-11-15-approval-sse-stream.md`

**Interfaces:**
- Produces the Runtime and Server event contract used by later tasks.

- [x] **Step 1: Review the design against the current foundation**

Confirm that the design keeps `ApprovalBroker` as the only state owner, uses
`ReadableStream` instead of a new dependency, and does not persist live events.

- [x] **Step 2: Commit the documents**

```bash
git add docs/superpowers/specs/2026-11-15-approval-sse-stream-design.md \
  docs/superpowers/plans/2026-11-15-approval-sse-stream.md
git commit -m "docs: 设计审批 SSE 实时推送"
```

### Task 2: Add Approval Broker subscription events

**Files:**
- Modify: `packages/runtime/src/approval-types.ts`
- Modify: `packages/runtime/src/approval-broker.ts`
- Test: `packages/runtime/test/approval-broker.test.ts`

**Interfaces:**
- Consumes: Existing `ApprovalRequest`, `ApprovalDecision`, and Broker
  transition methods.
- Produces: `ApprovalEvent`, `ApprovalListener`, and
  `ApprovalBroker.subscribe(listener): () => void`.

- [x] **Step 1: Write the failing tests**

Add focused tests with these names and expectations:

```ts
it('publishes created and resolved snapshots', async () => {
  const broker = createApprovalBroker();
  const events: ApprovalEvent[] = [];
  broker.subscribe((event) => events.push(event));

  const decision = broker.request({
    toolCallId: 'call-1',
    toolName: 'write_file',
    operation: 'workspace.write_file',
    summary: 'Write file',
    risk: 'high',
    inputSummary: { path: 'README.md' },
  });
  const pending = broker.list()[0]!;
  broker.approve(pending.approvalId, 'approved for test');

  await expect(decision).resolves.toEqual({
    status: 'approved',
    reason: 'approved for test',
  });
  expect(events.map((event) => event.type)).toEqual([
    'approval.created',
    'approval.resolved',
  ]);
  expect(events[0]?.request.status).toBe('pending');
  expect(events[1]?.request.status).toBe('approved');
});

it('stops publishing after unsubscribe and tolerates repeated unsubscribe', () => {
  const broker = createApprovalBroker();
  const events: ApprovalEvent[] = [];
  const unsubscribe = broker.subscribe((event) => events.push(event));
  unsubscribe();
  unsubscribe();

  broker.request({
    toolCallId: 'call-1',
    toolName: 'write_file',
    operation: 'workspace.write_file',
    summary: 'Write file',
    risk: 'high',
    inputSummary: {},
  });

  expect(events).toHaveLength(0);
});

it('isolates listener failures', () => {
  const broker = createApprovalBroker();
  const events: ApprovalEvent[] = [];
  broker.subscribe(() => {
    throw new Error('listener failed');
  });
  broker.subscribe((event) => events.push(event));

  broker.request({
    toolCallId: 'call-1',
    toolName: 'write_file',
    operation: 'workspace.write_file',
    summary: 'Write file',
    risk: 'high',
    inputSummary: {},
  });

  expect(events).toHaveLength(1);
  expect(events[0]?.type).toBe('approval.created');
});
```

Also cover `reject`, `cancel`, `expire`, timeout `0`, pre-aborted input, and
the immutability of the event request snapshot.

- [x] **Step 2: Run the focused tests and verify the expected failure**

Run:

```bash
pnpm exec vitest run packages/runtime/test/approval-broker.test.ts --config vitest.config.ts
```

Expected: TypeScript/test failures because `ApprovalEvent` and `subscribe`
do not exist yet.

- [x] **Step 3: Implement the minimum subscription contract**

Add the event types and `subscribe` method. Keep listeners in a local `Set`.
Notify from the existing `request` and `transition` paths only after the
immutable request snapshot is updated. Iterate over a copied listener array
and catch each listener error independently.

- [x] **Step 4: Run Runtime tests**

Run:

```bash
pnpm exec vitest run packages/runtime/test/approval-broker.test.ts --config vitest.config.ts
```

Expected: all Approval Broker tests pass with no unhandled listener errors.

- [x] **Step 5: Commit the Runtime event contract**

```bash
git add packages/runtime/src/approval-types.ts \
  packages/runtime/src/approval-broker.ts \
  packages/runtime/test/approval-broker.test.ts
git commit -m "feat: 增加 Approval Broker 事件订阅"
```

### Task 3: Add the SSE encoding and stream route

**Files:**
- Modify: `apps/server/src/approval-api.ts`
- Modify: `apps/server/test/approval-api.test.ts`

**Interfaces:**
- Consumes: `ApprovalBroker.list()` and `ApprovalBroker.subscribe()`.
- Produces: `GET /approvals/stream` with
  `approval.snapshot`, `approval.created`, and `approval.resolved` events.

- [x] **Step 1: Write the failing HTTP tests**

Add tests that create a running Runtime with the real approval service and
assert:

```ts
const response = await app.request('/approvals/stream');
expect(response.status).toBe(200);
expect(response.headers.get('content-type')).toContain('text/event-stream');
expect(response.headers.get('cache-control')).toBe('no-cache');
```

Read the first chunk and assert it contains:

```text
event: approval.snapshot
data: {"approvals":[]}

```

Create a pending request through the Broker before connecting and assert that
the snapshot contains it. Connect before creating a second request, then read
the next chunk and assert `event: approval.created`; approve it and assert
`event: approval.resolved`.

- [x] **Step 2: Run the focused HTTP tests and verify failure**

Run:

```bash
pnpm exec vitest run apps/server/test/approval-api.test.ts --config vitest.config.ts
```

Expected: the new route returns 404 because it has not been registered.

- [x] **Step 3: Implement stream lifecycle helpers**

In `apps/server/src/approval-api.ts`, add a small local encoder helper that
produces:

```ts
`event: ${eventName}\ndata: ${JSON.stringify(payload)}\n\n`
```

Register `GET /approvals/stream`. In `ReadableStream.start()`:

1. Resolve the Broker and return the existing 503 JSON response when absent.
2. Create a cleanup function guarded by a boolean.
3. Subscribe to Broker events.
4. Enqueue the snapshot before returning.
5. Enqueue future events inside a try/catch.
6. Attach the request abort listener with `{ once: true }`.

Use `cancel()` to call the same cleanup function. Cleanup must unsubscribe,
remove the abort listener, and close the controller only when it is not already
closed. A failed enqueue must be treated as a disconnect and must not escape
the Broker listener.

- [x] **Step 4: Run Server tests**

Run:

```bash
pnpm exec vitest run apps/server/test/approval-api.test.ts --config vitest.config.ts
```

Expected: SSE tests and all existing REST tests pass.

- [x] **Step 5: Commit the Server SSE adapter**

```bash
git add apps/server/src/approval-api.ts apps/server/test/approval-api.test.ts
git commit -m "feat: 增加审批 SSE 控制面"
```

### Task 4: Synchronize architecture and learning documentation

**Files:**
- Modify: `docs/architecture/foundation.md`
- Modify: `README.md`

**Interfaces:**
- Consumes: The implemented Runtime subscription and Server SSE contracts.
- Produces: Repository documentation that explains polling versus SSE, event
  lifecycle, and the current in-process limitation.

- [x] **Step 1: Update the architecture document**

Document that the Approval control plane now has REST and SSE adapters, that
the Broker remains the source of truth, and that live events are not durable
Session events.

- [x] **Step 2: Update the README**

Add the SSE endpoint to the local API list and explain the three event names in
one concise section. Keep detailed learning material in Feishu, not in the
README.

- [x] **Step 3: Run documentation formatting**

Run:

```bash
pnpm exec prettier --write docs/architecture/foundation.md README.md
pnpm format:check
```

- [x] **Step 4: Commit documentation**

```bash
git add docs/architecture/foundation.md README.md
git commit -m "docs: 补充审批 SSE 架构说明"
```

### Task 5: Verify the complete feature

**Files:**
- Modify: `docs/superpowers/plans/2026-11-15-approval-sse-stream.md`

- [x] **Step 1: Mark completed plan steps**

Update only the checklist markers after the corresponding commands have
actually passed. Do not mark a step complete based on code inspection alone.

- [x] **Step 2: Run focused tests**

```bash
pnpm exec vitest run packages/runtime/test/approval-broker.test.ts --config vitest.config.ts
pnpm exec vitest run apps/server/test/approval-api.test.ts --config vitest.config.ts
```

- [x] **Step 3: Run repository verification**

```bash
pnpm format:check
pnpm check
git diff --check
```

- [x] **Step 4: Inspect the final branch**

```bash
git status --short --branch
git diff origin/main...HEAD --stat
git log --oneline origin/main..HEAD
```

- [ ] **Step 5: Commit the completed plan**

```bash
git add docs/superpowers/plans/2026-11-15-approval-sse-stream.md
git commit -m "docs: 完善审批 SSE 实施记录"
```

### Task 6: Publish the feature branch

- [ ] **Step 1: Push the feature branch**

```bash
git push -u origin HEAD:refs/heads/feat/approval-sse-stream
```

- [ ] **Step 2: Create the Pull Request**

```bash
gh pr create \
  --repo GitHubxxx17/Weave \
  --base main \
  --head feat/approval-sse-stream \
  --title "feat: 增加审批 SSE 实时推送" \
  --body "## 变更内容
- 增加 Approval Broker 事件订阅
- 增加审批 SSE 流
- 保留 REST 查询和决策接口
- 补充实时推送测试和学习文档

## 验证
- pnpm check

## 合并方式
请使用 squash merge 合入 main，保留远程功能分支。"
```

- [ ] **Step 3: Enable automatic squash merge**

```bash
gh pr merge <PR_NUMBER> \
  --repo GitHubxxx17/Weave \
  --auto \
  --squash
```

Do not delete the remote feature branch.
