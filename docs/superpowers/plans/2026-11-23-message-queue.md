# Durable message queue implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Accept, inspect, reorder and cancel immutable queued messages while Runtime executes them independently of browsers.

**Architecture:** Extend AgentExecutionService, not AgentRunner or a new RunManager, as the only FIFO scheduler. Session owns append-only queue facts; Server owns transport; Studio owns admission feedback and detachable observers.

**Tech Stack:** TypeScript ESM, Zod, existing Session stores, Hono, React, Vitest and Playwright. No new dependency.

**Spec:** `docs/superpowers/specs/2026-11-23-message-queue-design.md`

## Global constraints

- Work only on feat/message-queue from origin/main fc7c33ad; one feature/PR, CI then squash.
- Strict external validation, append-only durable facts, no Studio @weave/Node imports, tools use shared Pipeline.
- Waiting limits 10/Session and 100 globally, active excluded; queued inputs do not retain live output state.
- Stop targets current only; cancelled/failed settlement advances FIFO, persistence uncertainty blocks.
- Server restart interrupts every unfinished entry without re-execution; browser refresh preserves execution.
- First acceptance freezes sampling defaults after logical request replay lookup; no Generation/credentials pin.
- Independent agents may implement disjoint package surfaces against the exact spec; root integrates and reviews. No concurrent git mutations or agent commits.

### Task 1: Session facts and Runtime FIFO

**Files:** packages/session/src/{events,execution-events,index}.ts; packages/runtime/src/{agent-execution-types,agent-execution-service,index}.ts; matching package test/ execution and lifecycle suites.

**Interfaces:** Extend existing launch/get/list/subscribe/cancel/recover/drain; produce queue, subscribeQueue, reorderQueue and cancelQueued plus exact exported schemas/types and optional resolveInput callback from spec. Consume SessionEventStore and stable AgentRunner only.

- [x] Add a controlled real-store test that launches first/second, asserts second queued and runner invocation count one, releases first then asserts second starts without subscriber.

```ts
const first = await service.launch(sessionId, request('one'));
const second = await service.launch(sessionId, request('two'));
expect(second.status).toBe('queued');
expect((await service.queue(sessionId)).queued.map(x => x.executionId)).toEqual([second.executionId]);
expect(started).toEqual([first.executionId]);
```

- [x] Run focused execution tests to observe the missing queue behavior before implementation.
- [x] Add backward-compatible accepted dispatch/runInput, claimed/reordered/queue-cancel facts and projections; serialize mutation/claim, reserve global capacity, persist before launching and implement bounded metadata subscription.
- [x] Add regressions for exact permutation CAS and replay, cancel/claim race, full queue and cross-Session capacity race, immutable/default replay, Stop/failure advance, persistence blocks, old logs, shutdown/restart no Runner calls.
- [x] Run Session/Runtime focused tests plus typecheck/lint; document report and exact schema names for root. Root stages commits after integration.

### Task 2: Server queue transport and frozen defaults

**Files:** apps/server/src/{agent-execution-api,agent-execution-guard,main}.ts; new focused transport/default helper if needed; apps/server/test/{agent-execution-api,agent-execution-lifecycle,execution-http-fixture,agent-turn-order,main,shutdown}.test.ts and existing compositions.

**Interfaces:** Consume Task 1 service schemas. Produce GET queue, GET queue/events, POST queue/reorder and POST execution/cancel-queued; existing POST executions now queues.

- [x] Add route tests for GET empty queue and two launches yielding active+queued; run to observe 404/busy failure.

```ts
const response = await app.request(`/sessions/${sessionId}/executions/queue`);
expect(response.status).toBe(200);
expect(await response.json()).toMatchObject({sessionId, revision: 0, queued: []});
```

- [x] Register static queue routes before executionId, reuse bounded JSON/security/association checks, map new conflicts to 409, use bounded pull-based SSE with cleanup and heartbeat.
- [x] Compose resolveInput using current public provider descriptor, respecting explicit/disabled defaults and freezing only temperature/maxTokens/useProviderDefaults:false. Preserve logical replay lookup in Runtime before callback.
- [x] Test strict bounds/unknown fields/foreign Session, reorder/cancel race and replay, disconnect progress, lifecycle busy with queued work, frozen settings, shutdown order, legacy bypass rejected.
- [x] Update existing second-admission busy expectations to real FIFO assertions, then focused checks.

### Task 3: Studio queue and continuous execution

**Files:** apps/studio/src/features/agent/agent-execution-{types,client,view}.ts, focused queue hook/component/styles, apps/studio/src/app/App.tsx, corresponding apps/studio/test/ suites.

**Interfaces:** Independent Zod mirrors of Task 1; use Task 2 HTTP only. Split launch receipt from observe, preserve explicit legacy-only fixtures and no production fallback.

- [x] Test running composer remains editable, second submission receives queued receipt and clears only captured draft revision, queue metadata renders, no premature conversation row. Observe failure before implementation.
- [x] Implement independent pending admission and per-execution observation/reconciliation, queue replacement observer, exact-turn handoff and Stop identity.
- [x] Add queue controls/count/preview/model/counts, lazy full-input copy with explicit handling of existing draft; row controls use stable requestId and expectedRevision, conflict refresh never active Stop.
- [x] Test queue-before-receipt, lost response identical retry, A-B-A draft ownership, previous terminal watermark with next live overlay, refresh/navigation, stale control, capacity preserves draft, Stop preserves next, copy leaves original.
- [x] Run focused client/App/hook/component tests and Studio lint/typecheck/build; report changed files and limitations.

### Task 4: Integration, review and browser acceptance

**Files:** docs/learning/2026-11-23-message-queue.md; architecture/spec/plan corrections; focused integration regressions in touched packages.

- [x] Review spec coverage and actual diff, use independent reviewer for concurrency/lifecycle/bounds and Studio identity/draft handling.
- [x] Start production Studio, Server SQLite and deterministic slow provider; enqueue uniquely labelled items, reorder/remove exact IDs, refresh, verify order and one durable pair per started input; Stop current then next runs, copy preserves original.
- [x] Fix any reproduced defect with a failing regression first; preserve background/undo/context/performance fixture contracts.
- [ ] Inspect staged diff, commit Chinese Conventional message, push exact feature ref, create/attach PR with validation limits. Final `pnpm check` passed (241 test files / 4,390 tests), and `pnpm marketplace:check` passed.
- [ ] Monitor required CI, repair actual failures, squash after green with exact head, delete remote branch, fetch main; start @file independently from newest main.
