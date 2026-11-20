# Plugin Generation Switching Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Deliver Stage 4.3: one stable Runner that switches isolated plugin generations between ordered Session turns.

**Architecture:** `@weave/plugin-host` supplies a generic generation controller and Session queue. Server assembles generation resources and publishes only complete candidates; Runtime pins Provider client and metadata together for each turn. Shared stores, approval and legacy plugin lifetimes remain owned by the Runtime/ServerHost.

**Tech Stack:** TypeScript strict ESM, Zod, Vitest, pnpm 10.13.1, Node >=24.4.0.

**Spec:** `docs/superpowers/specs/2026-11-20-plugin-host-design.md`, especially sections 8 and 8.5; ADR 0003.

## Global Constraints

- Start at latest origin/main (`00f34f8` at handoff), one topic/branch/PR, Chinese Conventional Commits, squash integration after CI.
- `plugin-host` depends on `plugin` and Zod, never Runtime or HTTP. Studio imports no `@weave/*` or Node packages.
- Durable Session facts append only; runtime queues and live generation state stay transient.
- Tests live under each unit's `test/` directory. Test behavior first and record red/green commands.
- Preserve existing tool order, shared Tool Pipeline, approval rules, prompt audit, provider settings behavior and independent Runtime usability.
- Do not add third-party dependencies. Server adds only the existing workspace `@weave/plugin-host` dependency.
- This PR does not discover disk plugins at startup, add trust persistence/routes, or modify Studio.

## Task 1: Generic generation Runner

**Files:** Create `packages/plugin-host/src/generation-runner.ts`, `packages/plugin-host/test/generation-runner.test.ts`; modify `packages/plugin-host/src/index.ts`.

**Interfaces:** Export `GenerationRequest`, `GenerationRunner`, `RunnerGeneration`, `GenerationController` and `createGenerationRunner`. The public shape is:

```ts
interface GenerationRequest {
  readonly sessionId: string;
  readonly signal?: AbortSignal | undefined;
}
interface GenerationRunner<R extends GenerationRequest, E> {
  run(request: R): AsyncIterable<E>;
}
interface RunnerGeneration<R extends GenerationRequest, E, T> {
  readonly id: number;
  readonly runner: GenerationRunner<R, E>;
  readonly resources: T;
  dispose(): void | Promise<void>;
}
interface GenerationController<R extends GenerationRequest, E, T> {
  readonly runner: GenerationRunner<R, E>;
  current(): RunnerGeneration<R, E, T>;
  replace(next: RunnerGeneration<R, E, T>, options?: { immediate?: boolean }): Promise<void>;
  blockNewRuns(error: Error): void;
  dispose(): Promise<void>;
}
```

`createGenerationRunner(initial)` returns that controller. Successful replace clears a block. Retirement errors are captured and reported by final dispose, never undo a committed replace. Generation ids are host-provided monotonic ids; replacement rejects reused ids. A rejected candidate remains caller-owned.

- [x] Write controlled async fake runners with gates for start, events and completion. Assert literal start/dispose sequences. Cases: unstarted return does nothing; first next enqueues; same-session A uses G1 and B waits; replace G2 before A ends makes B use G2; other Session runs concurrently; retirement disposes once after production ends even if consumer leaves buffered events unread.
- [x] Add cancellation cases: blocked next + return, already-aborted request, queued cancellation, exception release, concurrent next calls, repeated return/dispose, immediate cancellation of all retired old generations, shutdown with queued/live requests, blocked new runs restored by replace, failed disposal surfaced at final close.
- [x] Run `pnpm exec vitest run packages/plugin-host/test/generation-runner.test.ts`; record expected missing-export failures before implementation.
- [x] Implement one stable Runner and independent pump/buffer, per-session queue, per-generation abort/refcounts, exactly-once disposal. Never use a wrapper async generator whose return is stuck behind pending next. Await cancellation settlement before releasing a running turn. A queued aborted request must settle without waiting for an unrelated earlier turn.
- [x] Run the new tests, existing plugin-host suite, typecheck and lint using Turbo so upstream dist is current; format changed files.
- [x] Report exact commands/results and any API differences before Server integration. Do not commit; root owns the topic commit.

## Task 2: Pin Provider client and metadata at turn start

**Files:** Modify `packages/runtime/src/agent-runner.ts`, `packages/runtime/test/agent-runner.test.ts`.

**Consumes:** Existing LlmProviderRegistry API; no new public cross-package API is required.

**Produces:** A running turn uses one client/descriptor snapshot. Subsequent turns use current registry values. Explicit request overrides remain highest priority.

- [x] Write a regression that blocks Session store read or instruction creation, replaces Provider client/default temperature/maxTokens/window, then resumes. Assert the first turn sends with its initial client/defaults/window and next turn with the replacements.
- [x] Add a multi-model-step turn case updating/deleting Provider during the first model/tool cycle; assert later model steps keep the original context window and defaults. Use real registry, in-memory Session store, deterministic model/tool fixtures; no network.
- [x] Run targeted tests and record the old mixed-descriptor behavior as RED.
- [x] Capture descriptor together with client before the first await in execution; pass this snapshot to sampling/window helpers. Preserve options.llm fallback and request overrides.
- [x] Run Runtime tests and typecheck with upstream build, format changed files, report red/green evidence. Do not commit.

## Task 3: Server generation assembly, ownership and provider views

**Files:** Modify `apps/server/src/server-host.ts`, `agent-kernel.ts`, `runtime.ts`, `main.ts`, Provider settings/API wiring and corresponding tests. Add focused generation/provider-view modules under `apps/server/src/` if they keep ownership clear. Modify plugin-builtins/legacy adapter only if an ownership primitive cannot be implemented at Server; update its tests. Add Server workspace dependency and ESLint/lockfile entry.

**Consumes:** Task 1 controller API and Task 2 Provider pin behavior.

**Produces:** A stable Server Runner, `assembleServerGeneration`/replacement operations for later PluginHost injection, and catalogs reading current resources. Keep public createServerAgentRunner/registerServerPlugins compatibility for existing callers.

- [x] Add Server integration tests with real kernel and mock LLM: candidate-only tools/providers are invisible before publish, failure leaves current untouched, current tool/commands/plugins change atomically, removed contributions disappear from new turns, duplicate tools/providers throw attributable errors instead of skip.
- [x] Add generation/provider tests: shared settings CRUD remains visible next turn; current plugin provider collision is rejected by settings creation; plugin cannot override host ids; same provider id in G1/G2 remains available in G2 after G1 dispose. Legacy setup once, dispose only final host close while two generations replay its tools.
- [x] Run tests RED. Use a fresh Tool Registry and private plugin Provider registry per assembly. Read host/settings providers dynamically through each generation view, but resolve a selected client/descriptor once per turn. Provider listings/default selection use current combined catalog; writes stay in host source and check current plugin ids. Revalidate host-source collisions at publish after async candidate assembly.
- [x] ServerHost owns the controller and legacy resource lifetimes. Replay legacy contributions via borrowed per-generation wrappers; each kernel disposes only its own registrations. New kernelPlugins/local modules have generation ownership; never mutate a caller's plugin object. Existing direct registry use before first assembly stays supported.
- [x] Expose enough concrete assembly metadata for 4.4 without loading local plugins now. `createServerAgentRunner` returns the same facade after initial construction; reconfiguration uses explicit generation assembly. Failed candidate cleanup covers partial setup and services.
- [x] Fix shutdown order: close listener to new connections, abort/drain facade while stores remain open, finish HTTP close, then close shared Runtime/project/settings stores. Test open SSE plus pending approval and idempotent stop; no blocking fixed sleeps.
- [x] Update foundation/ADR documentation for actual implemented ownership and settings behavior. Run Server, Runtime, plugin-host and any modified plugin package tests/typechecks, then complete `pnpm check` once integration passes.
- [ ] Root reviews complete diff, creates Chinese topic commit, pushes explicit same-name ref, opens PR, attaches it and verifies CI before squash integration. Do not directly push main.

## Task 4: Whole-branch review and integration

**Files:** All changed files; review-only unless findings require fixes.

- [x] Independently review against spec section 8.5 and this plan; prioritize cross-generation queue, cancellation, provider updates and ownership.
- [x] Send actionable findings back to responsible implementer, run covering tests for fixes and scoped re-review.
- [x] Check working-tree/index ownership, formatting, package boundaries and complete `pnpm check` evidence.
- [ ] Create reviewable PR with problem/behavior/validation, wait for CI, then squash via PR workflow. Start Stage 4.4a from the new origin/main only after successful integration.
