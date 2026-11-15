# Approval Service Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 `@weave/runtime` 增加内存型 Tool Approval Broker，并让 Tool Pipeline 在执行声明了 Approval 的工具前等待批准。

**Architecture:** Approval 是 Runtime 内的 transient live-control state，不写入 Session Event Store。`ApprovalBroker` 管理 pending 请求和终态快照；`ToolPipeline` 在参数校验后、工具 `execute` 前创建审批请求，批准后才执行，拒绝、取消和过期都不会触发工具副作用。`write_file` 通过工具声明标记为高风险审批工具。

**Tech Stack:** TypeScript、ESM、Node.js `randomUUID`、Zod、Vitest、pnpm workspace、Turborepo。

**Spec:** `docs/superpowers/specs/2026-11-15-approval-service-design.md`

## Global Constraints

- Approval 状态只保存在单个 Runtime 进程的内存中。
- `pending` 只能转换为 `approved`、`rejected`、`cancelled` 或 `expired`。
- 终态不能再次转换；未知 Approval ID 返回稳定错误。
- 工具批准前不能调用工具 `execute`。
- `AbortSignal` 取消 pending Approval 时，工具不能执行。
- `timeoutMs` 必须是有限、非负数；`0` 表示立即过期。
- `write_file` 的审批摘要只能包含相对路径、UTF-8 字节数和覆盖标志，不包含完整文件内容。
- 没有审批声明的工具保持现有行为。
- 声明需要 Approval 的工具在 Pipeline 未配置 Broker 时必须失败，不能静默放行。
- 不增加运行时依赖，不实现 HTTP/SSE、Studio UI、Session durable approval events 或多进程恢复。
- 测试放在 `packages/runtime/test/`。
- 每个行为先写失败测试，再实现最小代码。

---

### Task 1: Approval Contracts and In-Memory Broker

**Files:**

- Create: `packages/runtime/src/approval-types.ts`
- Create: `packages/runtime/src/approval-broker.ts`
- Create: `packages/runtime/test/approval-broker.test.ts`
- Modify: `packages/runtime/src/index.ts`

**Interfaces:**

```ts
export type ApprovalStatus =
  | 'pending'
  | 'approved'
  | 'rejected'
  | 'cancelled'
  | 'expired';

export type ApprovalRisk = 'low' | 'medium' | 'high';

export interface ApprovalRequest {
  readonly approvalId: string;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly operation: string;
  readonly summary: string;
  readonly risk: ApprovalRisk;
  readonly inputSummary: unknown;
  readonly status: ApprovalStatus;
  readonly createdAt: string;
  readonly resolvedAt?: string | undefined;
  readonly expiresAt?: string | undefined;
  readonly decisionReason?: string | undefined;
}

export interface CreateApprovalRequestInput {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly operation: string;
  readonly summary: string;
  readonly risk: ApprovalRisk;
  readonly inputSummary: unknown;
  readonly signal?: AbortSignal | undefined;
  readonly timeoutMs?: number | undefined;
}

export type ApprovalDecision =
  | { readonly status: 'approved'; readonly reason?: string | undefined }
  | { readonly status: 'rejected'; readonly reason?: string | undefined }
  | { readonly status: 'cancelled'; readonly reason?: string | undefined }
  | { readonly status: 'expired'; readonly reason?: string | undefined };

export type ApprovalErrorCode =
  | 'approval-invalid-input'
  | 'approval-not-found'
  | 'approval-already-resolved'
  | 'approval-cancelled'
  | 'approval-expired';

export interface ApprovalBroker {
  request(input: CreateApprovalRequestInput): Promise<ApprovalDecision>;
  get(approvalId: string): ApprovalRequest | undefined;
  list(): readonly ApprovalRequest[];
  approve(approvalId: string, reason?: string): ApprovalRequest;
  reject(approvalId: string, reason?: string): ApprovalRequest;
  cancel(approvalId: string, reason?: string): ApprovalRequest;
  expire(approvalId: string, reason?: string): ApprovalRequest;
}

export function createApprovalBroker(): ApprovalBroker;
```

- [x] **Step 1: Write failing Broker tests**

Add real behavior tests for:

```ts
it('creates a pending request and resolves after approval', async () => {
  const broker = createApprovalBroker();
  const decisionPromise = broker.request({
    toolCallId: 'call-1',
    toolName: 'write_file',
    operation: 'workspace.write_file',
    summary: '写入 Workspace 文件 src/app.ts',
    risk: 'high',
    inputSummary: { path: 'src/app.ts', bytes: 12, overwrite: false },
  });

  const pending = broker.list()[0];
  expect(pending).toMatchObject({ status: 'pending', toolCallId: 'call-1' });
  broker.approve(pending.approvalId, '用户确认');
  await expect(decisionPromise).resolves.toEqual({
    status: 'approved',
    reason: '用户确认',
  });
});
```

Also cover rejected decisions, cancellation, expiry, unknown IDs, duplicate
decisions, pre-aborted signals, `timeoutMs: 0`, and immutable snapshots.

- [x] **Step 2: Run the focused test and verify the expected failure**

Run:

```bash
pnpm exec vitest run packages/runtime/test/approval-broker.test.ts --config vitest.config.ts
```

Expected: FAIL because the Approval exports do not exist.

- [x] **Step 3: Implement schemas, error and Broker**

Use Zod to validate non-empty IDs and strings, the risk enum, `inputSummary`
as unknown, and finite non-negative timeout values. Use `randomUUID()` for
Approval IDs and ISO timestamps for `createdAt`, `resolvedAt`, and
`expiresAt`.

Store each request in a `Map`. Keep a private resolver/rejecter and cleanup
function per pending request. Every resolution must update the snapshot before
settling the Promise, remove abort listeners, and clear timers.

Map decisions as follows:

```text
approve -> approved, resolve Promise
reject  -> rejected, resolve Promise
cancel  -> cancelled, reject ApprovalError(approval-cancelled)
expire  -> expired, reject ApprovalError(approval-expired)
```

Throw `ApprovalError('approval-not-found')` for unknown IDs and
`ApprovalError('approval-already-resolved')` for any decision after a terminal
state. A pre-aborted signal rejects before inserting a pending request.

- [x] **Step 4: Run Broker tests**

Run the focused Vitest command again. All Broker tests must pass before
changing Tool Pipeline behavior.

- [x] **Step 5: Export and commit the contract**

Export the schemas, types, `ApprovalError`, `ApprovalBroker`, and
`createApprovalBroker` from `packages/runtime/src/index.ts`, then commit:

```bash
git add packages/runtime/src/approval-types.ts packages/runtime/src/approval-broker.ts packages/runtime/src/index.ts packages/runtime/test/approval-broker.test.ts
git commit -m "feat: 增加工具审批服务"
```

### Task 2: ToolDefinition and ToolPipeline Approval Gate

**Files:**

- Modify: `packages/runtime/src/tool-types.ts`
- Modify: `packages/runtime/src/tool-pipeline.ts`
- Modify: `packages/runtime/src/index.ts`
- Modify: `packages/runtime/test/tool-pipeline.test.ts`

**Interfaces:**

```ts
export interface ToolApprovalRequirement<TInput = unknown> {
  readonly operation: string;
  readonly risk: ApprovalRisk;
  readonly summarize: (input: TInput) => {
    readonly summary: string;
    readonly inputSummary: unknown;
  };
}

export interface ToolDefinition<TInput = unknown, TOutput = unknown> {
  // existing fields...
  readonly approval?: ToolApprovalRequirement<TInput> | undefined;
}

export interface ToolPipelineOptions {
  readonly registry: ToolRegistry;
  readonly approvalBroker?: ApprovalBroker | undefined;
  readonly timeoutMs?: number | undefined;
  readonly maxResultBytes?: number | undefined;
}
```

Add these `ToolExecutionErrorCode` members:

```text
tool-approval-required
tool-approval-rejected
tool-approval-cancelled
tool-approval-expired
```

- [x] **Step 1: Add failing Pipeline approval tests**

Add tests for:

```ts
it('does not execute a protected tool before approval', async () => {
  let executions = 0;
  const broker = createApprovalBroker();
  const registry = createToolRegistry();
  registry.register({
    name: 'protected',
    description: 'Protected test tool',
    parameters: { type: 'object' },
    inputSchema: z.object({ value: z.string() }),
    approval: {
      operation: 'test.protected',
      risk: 'high',
      summarize: ({ value }) => ({
        summary: `执行受保护操作 ${value}`,
        inputSummary: { value },
      }),
    },
    execute: () => {
      executions += 1;
      return 'done';
    },
  });

  const pipeline = createToolPipeline({ registry, approvalBroker: broker });
  const execution = pipeline.execute({
    toolCallId: 'call-1',
    name: 'protected',
    arguments: JSON.stringify({ value: 'x' }),
  });

  await Promise.resolve();
  expect(executions).toBe(0);
  broker.approve(broker.list()[0].approvalId);
  await expect(execution).resolves.toMatchObject({ content: 'done' });
});
```

Also test rejection, cancellation, expiration, missing Broker,
non-approval tools, input summaries, and request-level timeout propagation.

- [x] **Step 2: Run Pipeline tests and verify the expected failure**

Run:

```bash
pnpm exec vitest run packages/runtime/test/tool-pipeline.test.ts --config vitest.config.ts
```

Expected: FAIL because `ToolApprovalRequirement`, `approvalBroker`, and the
approval error mappings do not exist.

- [x] **Step 3: Add the approval contract to ToolDefinition**

Import `ApprovalBroker` and `ApprovalRisk` as types. Extend
`toolDefinitionSchema` with a runtime check that an optional `approval` value
has non-empty `operation`, a valid `risk`, and a function `summarize`.
Existing unprotected tools must remain valid.

- [x] **Step 4: Add the Pipeline approval gate**

After JSON and input validation but before invoking `execute`:

1. If no `tool.approval` exists, continue unchanged.
2. If `tool.approval` exists and no Broker is configured, throw
   `ToolExecutionError('tool-approval-required', ...)`.
3. Call `summarize(input)` and pass its output to `approvalBroker.request()`.
4. Pass `request.signal` through the combined Pipeline signal.
5. Pass the effective Pipeline timeout to the Approval request when defined.
6. Await the decision before invoking the tool.
7. For `approved`, continue.
8. For `rejected`, throw `tool-approval-rejected`.
9. Convert `ApprovalError('approval-cancelled')` to
   `tool-approval-cancelled`.
10. Convert `ApprovalError('approval-expired')` to
    `tool-approval-expired`.

The existing timeout and final `finally` cleanup must still run. Approval
errors must preserve their original error as `cause`.

- [x] **Step 5: Run Pipeline tests**

Run the focused Pipeline test command and the existing Runtime tool tests.
Confirm protected tools execute once only after approval and never execute
after rejection, cancellation, expiration, or missing Broker.

- [x] **Step 6: Commit the Pipeline integration**

已完成实现和验证，提交信息为：

```text
feat: 接入工具审批执行门禁
```

### Task 3: Require Approval for `write_file`

**Files:**

- Modify: `packages/runtime/src/workspace-file-tools.ts`
- Modify: `packages/runtime/test/workspace-file-tools.test.ts`

**Interfaces:**

`writeFileTool.approval` must be:

```ts
{
  operation: 'workspace.write_file',
  risk: 'high',
  summarize: (input) => ({
    summary: `写入 Workspace 文件 ${input.path}`,
    inputSummary: {
      path: input.path,
      bytes: Buffer.byteLength(input.content, 'utf8'),
      overwrite: input.overwrite === true,
    },
  }),
}
```

- [x] **Step 1: Add failing `write_file` Approval tests**

Update the file tool test helper to create and pass an `ApprovalBroker`.
Add an `approvePending()` test helper that starts the Pipeline request,
waits until a pending request is visible, approves it, and returns the
execution Promise.

Add tests that:

- `write_file` creates a pending Approval Request;
- the request summary contains path, byte count and overwrite;
- the summary does not contain `content`;
- approved writes still write successfully;
- rejected writes do not modify the file;
- reads remain unprotected;
- the external and dangling symlink tests still pass after approval.

- [x] **Step 2: Run the file tool tests and verify the expected failure**

Run:

```bash
pnpm exec vitest run packages/runtime/test/workspace-file-tools.test.ts --config vitest.config.ts
```

Expected: FAIL because `write_file` has no Approval declaration and the
existing write helper does not resolve pending requests.

- [x] **Step 3: Add the `write_file` Approval declaration**

Attach the exact requirement above to the returned `writeFile` tool. Do not
move Workspace Policy or filesystem checks into the Approval Broker.

- [x] **Step 4: Run file tool tests**

Confirm approved writes pass and all denied paths remain denied by the
Workspace File Tool after Approval.

- [x] **Step 5: Commit**

已完成实现和验证，提交信息为：

```text
feat: 为工作区写入增加审批要求
```

### Task 4: Documentation and Final Verification

**Files:**

- Modify: `README.md`
- Modify: `docs/architecture/foundation.md`
- Modify: `docs/superpowers/specs/2026-11-15-approval-service-design.md`
- Modify: `docs/superpowers/plans/2026-11-15-approval-service.md`

- [x] **Step 1: Update README and architecture guide**

Document:

- `createApprovalBroker()` usage;
- registering protected tools with a Pipeline Broker;
- pending/approved/rejected lifecycle;
- why Approval is transient and separate from Session events;
- why Approval does not replace WorkspacePolicy or Sandbox;
- why `write_file` summaries omit content.

- [x] **Step 2: Record implementation evidence**

Append actual test counts, verification commands, and current exclusions to
the Approval design document. Mark plan checkboxes only after final commands
pass.

- [x] **Step 3: Update the Feishu learning materials**

Read `/Users/mi/.codex/skills/feishu/reference/extended-markdown.md`, create
the next learning document in folder
`IaaUfCD1klneledtbUycz7bLndh`:

```text
10 Weave Approval Service：工具审批、等待与安全门禁
```

Append a progress section to:

```text
https://mi.feishu.cn/docx/KhEZdcTTSoi7fMxjpT4cxviRniT
```

Explain the state machine, Broker, Pipeline gate, cancellation, timeout,
summary redaction, and why durable approval events are deferred.

- [x] **Step 4: Run verification**

```bash
pnpm format:check
pnpm --filter @weave/runtime lint
pnpm --filter @weave/runtime typecheck
pnpm --filter @weave/runtime test
pnpm --filter @weave/runtime build
pnpm check
git diff --check
```

- [ ] **Step 5: Inspect scope and commit docs**

```bash
git status --short --branch
git diff origin/main...HEAD --stat
git log --oneline origin/main..HEAD
```

Then commit:

```bash
git add README.md docs/architecture/foundation.md docs/superpowers/specs/2026-11-15-approval-service-design.md docs/superpowers/plans/2026-11-15-approval-service.md
git commit -m "docs: 补充工具审批学习说明"
```

- [ ] **Step 6: Push and create PR**

```bash
git push -u origin HEAD:refs/heads/feat/approval-service
gh pr create \
  --repo GitHubxxx17/Weave \
  --base main \
  --head feat/approval-service \
  --title "feat: 增加工具审批服务" \
  --body "## 变更内容
- 增加 Runtime 内存型 Approval Broker
- 接入 Tool Pipeline 执行前审批
- 为 write_file 增加审批要求
- 补充测试、架构说明和学习文档

## 验证
- pnpm check

## 合并方式
请使用 squash merge 合入 main，保留远程功能分支。"
gh pr merge <PR_NUMBER> --repo GitHubxxx17/Weave --auto --squash
```

不要添加 `--delete-branch`。
