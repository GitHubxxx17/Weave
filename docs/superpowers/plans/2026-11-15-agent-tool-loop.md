# Agent Tool Loop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans (inline execution is acceptable for this task). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 Agent Runner 支持顺序多步 Tool Call，并通过共享 ToolPipeline 执行工具、持久化工具过程和继续下一轮模型请求。

**Architecture:** Session 增加 `tool-call.created` 和 `tool-result.created` durable events；Runtime Runner 负责组装模型 Tool Call、组织 model/tool Steps 和多轮上下文；工具执行始终委托给 `ToolPipeline`，Approval、Workspace、取消、超时和结果限制保持在 Pipeline 内。

**Tech Stack:** TypeScript、ESM、Zod、Vitest、pnpm、Turborepo。

**Spec:** `docs/superpowers/specs/2026-11-15-agent-tool-loop-design.md`

## Global Constraints

- TypeScript、ESM、strict typing。
- 外部输入必须使用 Zod 校验。
- Durable facts append-only；transient AgentRuntimeEvent 不逐条持久化。
- Tool 必须通过共享 ToolPipeline 执行，Runner 不得调用 `execute()`。
- 无工具 Runner 的现有行为必须保持。
- 测试放在对应 package 的 `test/` 目录。
- 跨 package 契约变化必须先同步设计文档。
- 每个功能使用独立分支，提交信息使用中文 Conventional Commits。
- 远程功能分支保留，使用 PR squash merge。

### Task 1: Commit design and implementation plan

**Files:**
- Create: `docs/superpowers/specs/2026-11-15-agent-tool-loop-design.md`
- Create: `docs/superpowers/plans/2026-11-15-agent-tool-loop.md`

- [x] **Step 1: Review the design**

Confirm that the design keeps Runtime as the behavior owner, Session as the
durable fact owner, and ToolPipeline as the only execution boundary.

- [x] **Step 2: Commit the design**

```bash
git add docs/superpowers/specs/2026-11-15-agent-tool-loop-design.md \
  docs/superpowers/plans/2026-11-15-agent-tool-loop.md
git commit -m "docs: 设计 Agent Tool Loop"
```

### Task 2: Extend Session tool events and projection

**Files:**
- Modify: `packages/session/src/events.ts`
- Modify: `packages/session/src/projection.ts`
- Modify: `packages/session/src/index.ts`
- Test: `packages/session/test/schemas.test.ts`
- Test: `packages/session/test/projection.test.ts`

**Interfaces:**
- Consumes: Protocol `ToolCall` and existing Session messages.
- Produces: `tool-call.created`, `tool-result.created`,
  `SessionToolCall`, `SessionToolResult`, and projected Turn collections.

- [ ] **Step 1: Write failing schema and projection tests**

Test that a valid tool call/result event parses, an invalid reference fails,
and a complete sequence projects:

```ts
const events = [
  event(1, 'session.created', {}),
  event(2, 'turn.started', { turnId: 'turn-1' }),
  event(3, 'step.started', { turnId: 'turn-1', stepId: 'model-1', kind: 'model' }),
  event(4, 'message.created', {
    messageId: 'assistant-1',
    message: {
      role: 'assistant',
      content: [],
      toolCalls: [{ id: 'call-1', name: 'echo', arguments: '{"value":"x"}' }],
    },
  }),
  event(5, 'step.completed', {
    turnId: 'turn-1',
    stepId: 'model-1',
    status: 'completed',
  }),
  event(6, 'step.started', { turnId: 'turn-1', stepId: 'tool-1', kind: 'tool' }),
  event(7, 'tool-call.created', {
    turnId: 'turn-1',
    stepId: 'tool-1',
    toolCall: { id: 'call-1', name: 'echo', arguments: '{"value":"x"}' },
  }),
  event(8, 'tool-result.created', {
    turnId: 'turn-1',
    stepId: 'tool-1',
    toolCallId: 'call-1',
    name: 'echo',
    content: 'x',
    truncated: false,
    status: 'completed',
  }),
  event(9, 'message.created', {
    messageId: 'tool-message-1',
    message: {
      role: 'tool',
      toolCallId: 'call-1',
      content: [{ type: 'text', text: 'x' }],
    },
  }),
  event(10, 'step.completed', {
    turnId: 'turn-1',
    stepId: 'tool-1',
    status: 'completed',
  }),
];

expect(projectSession(events).turns[0]).toMatchObject({
  toolCalls: [{ toolCall: { id: 'call-1' } }],
  toolResults: [{ toolCallId: 'call-1', content: 'x' }],
});
```

- [ ] **Step 2: Run the focused tests and verify failure**

```bash
pnpm exec vitest run packages/session/test/schemas.test.ts packages/session/test/projection.test.ts --config vitest.config.ts
```

Expected: TypeScript or assertion failures because the new event types do not
exist yet.

- [ ] **Step 3: Implement schemas and projection**

Add Zod payload schemas, persisted event variants, projection collections, and
reference/order checks. Keep tool messages as ordinary protocol messages so
the next LLM request can be rebuilt from `projectSession().messages`.

- [ ] **Step 4: Run Session tests**

```bash
pnpm exec vitest run packages/session/test/schemas.test.ts packages/session/test/projection.test.ts --config vitest.config.ts
```

Expected: focused Session tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/session/src packages/session/test
git commit -m "feat: 增加工具调用 Session 事件"
```

### Task 3: Extend Agent contracts and tool-call assembly

**Files:**
- Modify: `packages/runtime/src/agent-types.ts`
- Modify: `packages/runtime/src/index.ts`
- Modify: `packages/runtime/test/agent-runner.test.ts`

**Interfaces:**
- Consumes: Protocol `ToolCall`, Runtime `ToolPipeline`, Runtime
  `ToolExecutionResult`.
- Produces: tool runtime events, `maxSteps`, and new stable error codes.

- [ ] **Step 1: Write failing contract tests**

Add tests that expect:

```ts
expect(agentRuntimeEventSchema.parse({
  type: 'tool-call',
  toolCall: { id: 'call-1', name: 'echo', arguments: '{}' },
})).toBeDefined();
```

Also test that a runner configured with only `toolRegistry` or only
`toolPipeline` rejects its configuration.

- [ ] **Step 2: Run tests and verify failure**

```bash
pnpm exec vitest run packages/runtime/test/agent-runner.test.ts --config vitest.config.ts
```

- [ ] **Step 3: Add contract types and validation**

Add `tool-call`, `tool-executing`, and `tool-result` runtime events; add
`agent-step-limit` and `agent-tool-call-invalid`; add `maxSteps` to the
validated request/options boundary. Export the types from Runtime.

- [ ] **Step 4: Run focused tests**

```bash
pnpm exec vitest run packages/runtime/test/agent-runner.test.ts --config vitest.config.ts
```

### Task 4: Implement the multi-step Agent Tool Loop

**Files:**
- Modify: `packages/runtime/src/agent-runner.ts`
- Modify: `packages/runtime/src/agent-types.ts`
- Test: `packages/runtime/test/agent-runner.test.ts`

**Interfaces:**
- Consumes: Session projection, Tool Registry, Tool Pipeline, and LLM
  `tool-call-*` events.
- Produces: multi-round model requests, durable tool events, and transient
  tool lifecycle events.

- [ ] **Step 1: Write failing end-to-end Runner tests**

Use a fake LLM that records requests and returns:

```ts
// First request
{ type: 'tool-call-start', id: 'call-1', name: 'echo' }
{ type: 'tool-call-delta', id: 'call-1', argumentsDelta: '{"value":"x"}' }
{ type: 'finish', reason: 'tool-call' }

// Second request
{ type: 'text-delta', text: '工具结果是 x' }
{ type: 'finish', reason: 'stop' }
```

Assert that the pipeline ran once, the second request contains an assistant
tool-call message and a tool message, and the final projection contains the
tool call/result events.

- [ ] **Step 2: Verify the expected failure**

```bash
pnpm exec vitest run packages/runtime/test/agent-runner.test.ts --config vitest.config.ts
```

Expected: the current Runner returns `agent-tool-call-unsupported`.

- [ ] **Step 3: Implement minimal round execution**

Create focused local helpers for:

- mapping registered tools to protocol definitions;
- assembling tool-call deltas;
- persisting model Step completion;
- persisting tool Step/call/result/message events;
- converting successful results to protocol tool messages.

Execute tool calls sequentially through `toolPipeline.execute()`. On a
Pipeline error, persist failed tool result/Step and failed Turn, then rethrow
the original `ToolExecutionError`.

- [ ] **Step 4: Add loop safety and cancellation**

Enforce `maxSteps`, propagate the combined AbortSignal into both LLM and
Pipeline requests, and preserve iterator `return()` behavior.

- [ ] **Step 5: Run all Runtime tests**

```bash
pnpm exec vitest run packages/runtime/test --config vitest.config.ts
```

Expected: existing no-tool tests and new Tool Loop tests pass.

- [ ] **Step 6: Commit**

```bash
git add packages/runtime/src packages/runtime/test
git commit -m "feat: 增加 Agent 多步工具循环"
```

### Task 5: Synchronize repository documentation

**Files:**
- Modify: `docs/architecture/foundation.md`
- Modify: `README.md`

- [ ] **Step 1: Update architecture**

Document the Session tool events, Runner loop, Pipeline boundary, sequential
execution, and max step safety limit.

- [ ] **Step 2: Update README**

Add a concise Tool Loop section and clarify that Agent `/run` and Agent SSE
remain future HTTP adapters.

- [ ] **Step 3: Format and commit**

```bash
pnpm exec prettier --write README.md docs/architecture/foundation.md
git add README.md docs/architecture/foundation.md
git commit -m "docs: 补充 Agent Tool Loop 架构说明"
```

### Task 6: Verify, document, and publish

**Files:**
- Modify: `docs/superpowers/plans/2026-11-15-agent-tool-loop.md`

- [ ] **Step 1: Mark verified plan steps**

- [ ] **Step 2: Run focused and complete verification**

```bash
pnpm format:check
pnpm check
git diff --check
```

- [ ] **Step 3: Create Feishu learning document**

Create `13 Weave Agent Tool Loop：从模型工具调用到安全执行` in folder
`IaaUfCD1klneledtbUycz7bLndh`, then append the progress to the Feishu total
plan.

- [ ] **Step 4: Commit plan record**

```bash
git add docs/superpowers/plans/2026-11-15-agent-tool-loop.md
git commit -m "docs: 完善 Agent Tool Loop 实施记录"
```

- [ ] **Step 5: Publish**

```bash
git push -u origin HEAD:refs/heads/feat/agent-tool-loop
gh pr create \
  --repo GitHubxxx17/Weave \
  --base main \
  --head feat/agent-tool-loop \
  --title "feat: 增加 Agent 多步工具循环" \
  --body "## 变更内容
- 增加工具调用 Session 事件
- 增加 Agent 多步 Tool Loop
- 所有工具继续经过 Tool Pipeline
- 补充 Runtime、Session 和学习文档

## 验证
- pnpm check

## 合并方式
请使用 squash merge 合入 main，保留远程功能分支。"
gh pr merge <PR_NUMBER> --repo GitHubxxx17/Weave --auto --squash
```
