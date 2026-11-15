# Agent HTTP/SSE Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 Runtime 的 Agent Tool Loop 通过一个薄的 POST + SSE HTTP Adapter 暴露给 Studio 前端。

**Architecture:** Server 增加 `POST /agent/runs/stream`，校验请求后从 Runtime Service 获取 `AgentRunner`，使用 `ReadableStream` 将 `AgentRuntimeEvent` 编码为 SSE。请求断开、ReadableStream cancel 或 enqueue 失败时调用当前 Agent iterator 的 `return()`，复用 Runtime 已有的取消和 Session 持久化语义；本阶段不新增 Run Registry、重连协议或 durable Agent Run 状态。

**Tech Stack:** TypeScript、ESM、Hono、Zod、Vitest、pnpm、Turborepo。

**Spec:** `docs/superpowers/specs/2026-11-15-agent-http-sse-design.md`

## Global Constraints

- TypeScript、ESM、strict typing。
- 外部 HTTP 输入必须使用 Zod 校验。
- Server 只负责 HTTP/SSE 适配，Agent 行为必须继续位于 Runtime。
- 工具执行必须继续经过共享 ToolPipeline。
- 不新增 Agent durable events，不复制第二套 Run 状态机。
- 客户端断开必须调用 Agent iterator 的 `return()` 并清理监听器。
- 不暴露 `Error.cause`、堆栈、Provider 私有响应或不必要的本地绝对路径。
- 测试放在 `apps/server/test/`。
- 每个功能使用独立分支，提交信息使用中文 Conventional Commits。
- PR 合并前必须通过 CI；远程功能分支按用户要求保留。

## File Map

- Create: `apps/server/src/agent-api.ts`，负责 Agent HTTP body 校验、Runtime Service 获取、SSE 编码、流清理和错误映射。
- Modify: `apps/server/src/app.ts`，挂载 Agent 路由并导出 `AgentAppOptions`。
- Modify: `apps/server/src/runtime.ts`，导出创建 Server Agent Runner 的组合根辅助函数，复用现有 Mock LLM 与 Session Store。
- Modify: `apps/server/src/main.ts`，在 Runtime 启动后创建 Agent Runner 并注入生产 HTTP App。
- Test: `apps/server/test/agent-api.test.ts`，覆盖 HTTP 输入、SSE 事件和取消清理。
- Modify: `README.md`，增加 Agent HTTP/SSE 使用说明。
- Modify: `docs/architecture/foundation.md`，说明 Runtime 到 Server SSE 的边界。
- Create: `docs/learning/2026-11-15-agent-http-sse.md`，记录从 fetch 请求到 SSE 消费的学习内容。
- Modify: `docs/superpowers/plans/2026-11-15-agent-http-sse.md`，记录完成状态。

### Task 1: Commit design and plan

**Interfaces:**
- Produces the design and implementation plan used by later tasks.

- [ ] **Step 1: Review the HTTP/SSE design**

Confirm that the adapter uses `POST /agent/runs/stream`, direct SSE response,
runtime service injection, and request-signal cancellation.

- [ ] **Step 2: Commit the design and plan**

```bash
git add docs/superpowers/specs/2026-11-15-agent-http-sse-design.md \
  docs/superpowers/plans/2026-11-15-agent-http-sse.md
git commit -m "docs: 设计 Agent HTTP SSE 适配层"
```

### Task 2: Add the Agent HTTP contract tests

**Files:**
- Create: `apps/server/test/agent-api.test.ts`
- Modify: `apps/server/src/app.ts`
- Modify: `apps/server/src/agent-api.ts`

**Interfaces:**
- Consumes: `Runtime`, injected `AgentRunner`, `AgentRunRequest`,
  `AgentRuntimeEvent`.
- Produces: `registerAgentRoutes(app, runtime, options)` and the
  `POST /agent/runs/stream` response contract.

- [ ] **Step 1: Write the failing tests**

Use a fake runner whose `run()` returns an async iterator over:

```ts
[
  { type: 'text-delta', text: '你好' },
  { type: 'tool-call', toolCall: { id: 'call-1', name: 'echo', arguments: '{}' } },
  { type: 'tool-result', result: {
    toolCallId: 'call-1',
    name: 'echo',
    content: 'ok',
    truncated: false,
  } },
  { type: 'completed', turnId: 'turn-1' },
]
```

Assert status `200`, SSE headers, event names, JSON data, and event order.
Add tests for invalid JSON, invalid body, missing service, runner error,
reader cancellation, and iterator cleanup.

- [ ] **Step 2: Run the new tests and verify the expected failure**

```bash
pnpm exec vitest run apps/server/test/agent-api.test.ts --config vitest.config.ts
```

Expected: the new route and test helper imports do not exist yet.

- [ ] **Step 3: Implement the minimum HTTP adapter**

Define:

```ts
export interface AgentAppOptions {
  readonly agentRunner?: AgentRunner | undefined;
}

export function registerAgentRoutes(
  app: Hono,
  runtime: Runtime,
  options: AgentAppOptions,
): void;
```

Parse `context.req.text()` with `JSON.parse`, validate with a schema based on
`agentRunRequestSchema` but without `signal`, and return:

```ts
{ error: { code: 'agent-invalid-input', message: 'Agent request body is invalid' } }
```

For a valid request, call `runner.run({ ...request, signal: context.req.raw.signal })`
and expose a `ReadableStream<Uint8Array>`. Encode each runtime event as:

```text
event: ${event.type}
data: ${JSON.stringify(event)}

```

On stream errors, send:

```ts
event: error
data: {"error":{"code": stableCode, "message": stableMessage}}
```

Do not serialize `Error.cause`.

- [ ] **Step 4: Run the focused tests**

```bash
pnpm exec vitest run apps/server/test/agent-api.test.ts --config vitest.config.ts
```

Expected: all Agent HTTP/SSE tests pass.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/agent-api.ts apps/server/src/app.ts apps/server/test/agent-api.test.ts
git commit -m "feat: 增加 Agent HTTP SSE 适配层"
```

### Task 3: Wire the default Runtime composition

**Files:**
- Modify: `apps/server/src/runtime.ts`
- Modify: `apps/server/src/main.ts`
- Modify: `apps/server/src/app.ts`
- Modify: `apps/server/test/health.test.ts`

**Interfaces:**
- Consumes: existing Mock LLM and Session Event Store services.
- Produces: exported `createServerAgentRunner(runtime)` and a production
  `createApp` configuration that receives the created runner.

- [ ] **Step 1: Add a failing service-availability test**

Create a running server Runtime, call `createApp(runtime)` without Agent options,
and assert:

```ts
expect(response.status).toBe(503);
expect(await response.json()).toEqual({
  error: {
    code: 'agent-service-unavailable',
    message: 'Agent service is not available',
  },
});
```

- [ ] **Step 2: Implement the default service**

Add:

```ts
export function createServerAgentRunner(runtime: Runtime): AgentRunner {
  return createAgentRunner({
    llm: runtime.get(mockLlmService),
    sessionStore: runtime.get(sessionEventStoreService),
  });
}
```

Change `mockLlmService` from `RuntimeService<unknown>` to
`RuntimeService<LlmClient>` so the composition root can pass its value to
`createAgentRunner()` without unsafe casts. Call
`createServerAgentRunner(runtime)` only after `runtime.start()`, and pass the
returned runner through `createApp(runtime, { approvalBrokerService, agentRunner })`.
Do not add a second Runtime service or change service creation order.

Wire `createApp(runtime, { approvalBrokerService, agentRunnerService })` in
`main.ts`.

- [ ] **Step 3: Run Server tests and typecheck**

```bash
pnpm exec vitest run apps/server/test --config vitest.config.ts
pnpm --filter @weave/server typecheck
```

- [ ] **Step 4: Commit**

```bash
git add apps/server/src/runtime.ts apps/server/src/main.ts apps/server/src/app.ts \
  apps/server/test/health.test.ts
git commit -m "feat: 接入 Server Agent Runner 服务"
```

### Task 4: Synchronize repository documentation

**Files:**
- Modify: `README.md`
- Modify: `docs/architecture/foundation.md`
- Create: `docs/learning/2026-11-15-agent-http-sse.md`

- [ ] **Step 1: Write the learning document**

Explain the difference between HTTP validation, Runtime execution, transient
SSE events, and durable Session events. Include a browser `fetch` example that
reads SSE frames and a section explaining why this phase does not use
`EventSource` or Run IDs.

- [ ] **Step 2: Update README and architecture**

Document:

- `POST /agent/runs/stream`;
- SSE event encoding;
- error behavior before and after headers are sent;
- client disconnect cancellation;
- the current non-goals around replay and Run Registry.

- [ ] **Step 3: Format and run focused verification**

```bash
pnpm exec prettier --write README.md docs/architecture/foundation.md \
  docs/learning/2026-11-15-agent-http-sse.md
pnpm format:check
git diff --check
```

- [ ] **Step 4: Commit**

```bash
git add README.md docs/architecture/foundation.md docs/learning/2026-11-15-agent-http-sse.md
git commit -m "docs: 补充 Agent HTTP SSE 学习说明"
```

### Task 5: Write Feishu learning material and publish

**Files:**
- Modify: `docs/superpowers/plans/2026-11-15-agent-http-sse.md`

- [ ] **Step 1: Update the plan checkboxes**

Mark completed implementation and verification steps, but leave publish
unchecked until the PR is actually merged.

- [ ] **Step 2: Create Feishu document**

After reading `/Users/mi/.codex/skills/feishu/reference/extended-markdown.md`,
confirm the next number in folder `IaaUfCD1klneledtbUycz7bLndh`, create:

```text
14 Weave Agent HTTP SSE：从 Runtime 事件到前端实时流
```

Then append a progress section to the Feishu total plan and fetch it back to
verify the write.

- [ ] **Step 3: Commit the plan record**

```bash
git add docs/superpowers/plans/2026-11-15-agent-http-sse.md
git commit -m "docs: 完善 Agent HTTP SSE 实施记录"
```

- [ ] **Step 4: Run complete verification**

```bash
pnpm check
git diff --check
git status --short --branch
```

- [ ] **Step 5: Push and create the PR**

```bash
git push -u origin HEAD:refs/heads/feat/agent-http-sse
gh pr create \
  --repo GitHubxxx17/Weave \
  --base main \
  --head feat/agent-http-sse \
  --title "feat: 增加 Agent HTTP SSE 适配层" \
  --body "## 变更内容
- 增加 Agent HTTP SSE 入口
- 复用 Runtime Agent Tool Loop
- 支持请求断开取消
- 补充 Server 测试和学习文档

## 验证
- pnpm check

## 合并方式
请使用 squash merge 合入 main，保留远程功能分支。"
gh pr merge <PR_NUMBER> --repo GitHubxxx17/Weave --auto --squash
```
