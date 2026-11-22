# Background executions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Keep an accepted Agent turn running without a browser and recover its exact live view after reconnect/refresh.

**Architecture:** Session stores acceptance and terminal facts. Runtime owns one producer and bounded observers. Server validates and transports; Studio restores by stable execution/turn identity.

**Tech Stack:** Existing TypeScript/ESM, Zod, Session SQLite, Hono, React, Vitest; no new dependency.

**Spec:** docs/superpowers/specs/2026-11-23-background-executions-design.md

## Global Constraints

- One feature branch/PR from latest origin/main; CI before squash merge.
- No protocol/permission/workspace bypass, no HTTP inside Runtime, no @weave imports inside Studio.
- Durable acceptance precedes production; exact request replay never produces twice; no process-restart re-execution.
- Ring 256 frames / 1 MiB; subscriber 64 frames / 1 MiB; complete snapshot 8 MiB / 4096 compacted events; list newest 100 summaries.
- Legacy endpoint is compatibility-only. Production never retries ambiguous acceptance via a second start mechanism.

### Task 1: Durable acceptance and Runtime execution ownership

**Files:** Create packages/session/src/execution-events.ts and execution projection helper; modify events.ts/index.ts/projection handling if required. Create packages/runtime/src/agent-execution-{types,service}.ts; modify agent-types.ts/agent-runner.ts/index.ts. Tests packages/session/test/execution-events.test.ts, packages/runtime/test/agent-execution-service.test.ts and Runner cancellation coverage.

**Interfaces:** Exact service/status/frame/subscription contracts in spec. Consumes AgentRunner, SessionEventStore, admit callback. Produces all exported execution schemas, AgentExecutionError, createAgentExecutionService. Runner accepts internal executionIdentity and persists current partial on interruption.

- [x] Write failing behavior tests for acceptance-before-production, lost response replay, conflicting requestId, no-subscriber progress and stable identities. Run package focused tests and record expected failures.
- [x] Implement strict JSON input/facts, canonical digest, Session gate, owned pump and durable terminal confirmation. Deep-copy input and avoid returning mutable internal snapshot/ring values.
- [x] Add failing recovery/failed-persistence/cancel tests; implement same-batch interrupted step/Turn settlement and persistence-error claim. Confirm tools do not re-execute on recovery.
- [x] Add failing race/bounds tests: atomic subscribe handoff, replay over subscriber limit -> snapshot, stale/foreign cursor, slow consumer, output cap including input. Implement bounded ring/summary and observer isolation.
- [x] Run Session and Runtime suites, lint/typecheck/build. Record test names, red/green evidence and remaining limits for independent review.

### Task 2: Server HTTP, lifecycle and shutdown

**Files:** Create apps/server/src/agent-execution-api.ts, agent-execution-guard.ts; modify app.ts/main.ts/session-service.ts/server-shutdown.ts as needed. Tests apps/server/test/agent-execution-api.test.ts, lifecycle/shutdown tests.

**Interfaces:** Inject AgentExecutionService into createApp; route paths in spec. Compose with coordinator.runner/getServerSessionStore. SessionServiceOptions receives generic withSessionIdle callback or service gate without moving lifecycle behavior to HTTP.

- [x] Add failing POST acceptance/GET recovery/explicit Stop tests against fake slow Runner + real SessionStore. Verify reader cancel does not abort execution.
- [x] Implement thin validated routes, bounded JSON/loopback/Origin/FetchSite guard and project association. Use pull-driven SSE, heartbeat and subscription-only cleanup. No Reader or HTTP signal enters execution input.
- [x] Add failing concurrent archive/delete vs launch tests; wire the shared Session gate and queue-head admission recheck, preserve existing undo startTurn/root lock.
- [x] Add failing startup/shutdown tests; recover known project Sessions before listen, close admission first, drain executions and writes before Generation/Store disposal.
- [x] Run Server focused suites, full Server typecheck/lint/tests. Test explicit error mapping (404 foreign ID; 409 busy/conflict; 503 persistence/closed; 413 body).

### Task 3: Studio recoverable client and exact Turn overlay

**Files:** Create apps/studio/src/features/agent/agent-execution-{types,client}.ts; modify agent-stream.ts/agent-types.ts/app/App.tsx and related CSS. Existing agent-stream.test explicitly tests renamed streamLegacyAgentRun; new agent-execution-client.test.ts and App recovery tests.

**Interfaces:** Production streamAgentRun keeps existing signature and adds optional onReceipt/onSnapshot/onStatus callbacks. New client provides list/get/subscribe/cancel helpers matching spec; browser types independently Zod validated.

- [x] Add failing client tests for lost POST response same-id retry, dropped SSE reconnect/resync, duplicate cursor suppression and abort-only-unsubscribe.
- [x] Implement client and optional callbacks. Keep legacy export explicit; never fallback after POST network error to a second launch path.
- [x] Add failing App tests for refresh/navigation recovery, full Turn snapshot replacement, stopped partial durable reconciliation and stale Session callbacks. Implement exact turn/user identity overlay, accepted revision clearing and stopping/reconnecting UI.
- [x] On Stop call cancel endpoint; leave subscription active until confirmed terminal or visible recovery error. On terminal read Session until durableThroughSequence, then remove exact overlay.
- [x] Run Studio focused tests plus full suite/typecheck/lint/build; preserve all prior composer/image/skills/undo behaviors.

### Task 4: Independent review, browser acceptance and PR integration

**Files:** Learning/validation report docs/learning/2026-11-23-background-executions.md; update foundation and plan progress.

- [x] Independently inspect all changed code against spec, especially terminal persistence, bounded observers, identity replacement and lifecycle races. Reproduce and repair material findings with behavior regressions.
- [x] Build real Server + Studio; run Chrome acceptance against SQLite and slow deterministic provider: refresh midway, disconnect observer, return to Session, confirm complete output exactly once; Stop midway and confirm partial history survives refresh.
- [x] Run pnpm check; record actual output/counts, not inferred status.
- [ ] Commit Chinese Conventional feature message, push explicit feature ref, create/attach focused PR with validation and limits; wait CI, squash merge and delete remote branch.
- [ ] Fetch main and create next independent message-queue branch. Continue the approved roadmap without a confirmation pause.
