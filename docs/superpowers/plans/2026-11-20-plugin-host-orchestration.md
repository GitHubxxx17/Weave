# Local Plugin Host Orchestration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Deliver Stage 4.4a generic discovery, trust mutation, failure isolation and reload orchestration.

**Architecture:** Inject the existing generation controller/publication port and a Server-owned assembler. Keep one stable Runner, serialize administration, and separate desired disk/trust state from current active generation metadata.

**Tech Stack:** TypeScript strict ESM, Zod, Vitest, existing pnpm/Node workspace. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-11-20-plugin-host-design.md` §8.6; ADR 0003; foundation architecture.

## Global Constraints

- Base: latest origin/main after PR #73 (`a40f89d`), branch feat/plugin-host-orchestration, one PR, squash after CI.
- plugin-host depends only on plugin and existing Zod; no Runtime, HTTP, Agent or Server imports.
- Tests under package test/. Behavior tests precede implementation and record red/green evidence.
- Do not add SQLite/routes/Studio in this slice. Root owns commit/push/integration, authorized by the ongoing workflow.
- Public signatures and invariants are exact in design §8.6. Setup default deadline 10,000ms, positive finite. No cleanup/import deadline.

## File ownership

- `generation-runner.ts` and its test: independent active-run cancellation.
- Private `plugin-lifecycle.ts` and its test: attempt-owned setup deadline/cleanup.
- `host-types.ts`, `host.ts`, `host-reload.ts`/focused helpers if needed, errors/index and host tests: host coordinator and public contract.
- Existing design/foundation and this plan: root maintains architecture and progress.

### Task 1: Independent generation cancellation

**Files:** Modify packages/plugin-host/src/generation-runner.ts and test/generation-runner.test.ts.
**Interface:** Add `abortActiveRuns(reason?: unknown): void` to GenerationController. Cancel running Run objects across current/retired generations; current generation stays reusable. Existing replace/block/dispose API unchanged.

- [x] Write gate-based tests for active current and multiple retired generations, exact reason, once-only cleanup, queue admission and recovery. A subsequent new run must not inherit a permanently aborted generation signal.
- [x] Run focused tests RED on missing abortActiveRuns before implementation.
- [x] Implement reason-aware Run cancellation and active-only iteration; do not change Session/pump semantics.
- [x] Run focused suite GREEN plus package typecheck/lint. Report evidence; do not commit.
- [x] Independent spec/quality review and fix covering tests.

### Task 2: Attempt-owned lifecycle

**Files:** Create packages/plugin-host/src/plugin-lifecycle.ts and test/plugin-lifecycle.test.ts.
**Interface:** `createPluginLifecycle(plugin: KernelPlugin, setupTimeoutMs: number): PluginLifecycle`; PluginLifecycle has readonly plugin: KernelPlugin, dispose(): Promise<void>, normalize(error: unknown): unknown, and readonly cleanupErrors: readonly unknown[]. Keep private (not index export).

- [x] Use real createPluginKernel in tests: setup throw/timeout rolls registration back, dispose once, forwarded signal aborts, pending original setup does not block timeout completion, late registrations rejected, late rejection observed.
- [x] Test successful kernel cleanup, never-registered module cleanup, failing dispose retained separately without replacing setup failure; capture RED.
- [x] Implement wrapper deadline inside setup, private timeout marker, combined signal, guarded env (preserve overloads and this), memoized disposeOnce and cleanup diagnostics. Normalize own timeout through kernel cause chain only.
- [x] Run lifecycle suite GREEN, typecheck/lint and report. Do not edit host/controller/index.
- [x] Independent spec/quality review and covering fixes.

### Task 3: Public PluginHost coordinator

**Files:** Create host-types.ts, host.ts and focused host helpers, host*.test.ts/test support; modify errors.ts and index.ts.
**Interfaces:** Export §8.6 exact public names. Consume Task 1 abortActiveRuns and Task 2 lifecycle API. Inject port and assembler; return exact existing Runner identity.

- [x] Tests first for baseline/untrusted discovery, exact-digest trust, no-execution mismatch, enabling validation, missing trusted disable/revoke, immutable cached snapshots and duplicate row identity. Capture RED missing host export.
- [x] Implement Zod external-input/config validation, cached discovery/fold snapshots and active metadata keyed by actual published id. Mutations update trust cache immediately after durable append before any later await.
- [x] Test/implement one serial admin queue, adjacent queued reload coalescing, one trailing pass during active reload, mutation barriers, append failure and close during assembly. Keep snapshots detached from later state changes.
- [x] Test/implement fresh factories on every attempt, load/setup/local attributed publish failures, shrinking retries <=N+1, host/unowned failures retaining baseline/current, setup timeout normalization and cleanup aggregation.
- [x] Test/implement load digest mismatch whole-root rediscovery with finite original-eligible budget, accurate changed/invalid/missing rows and failure identity by id+digest.
- [x] Test/implement disable/revoke append-before-block-and-abort, blocked rebuild failures, external event folding, recovery publication, actual pointer during slow retirement; failed eligible plugins always retry and unchanged requires clean attempted set.
- [x] Run host/lifecycle/controller suites GREEN, then package suite/typecheck/lint. Report exact red/green commands and changes. Root integrates exports and any interface mismatch; no commit.
- [x] Independent spec/quality review and covering fixes.

### Task 4: Verify and integrate

- [x] Self-review plan/spec coverage, finite retries, ownership, no duplicate controller and cross-package boundaries. Whole-branch independent review; fix findings with tests and scoped re-review.
- [x] Run pnpm check and git diff --check, inspect exact task-only diff/index.
- [ ] Chinese Conventional Commit, explicit same-name branch push, open/attach PR with validation evidence; wait CI, squash merge and delete remote branch.
- [ ] Continue Stage 4.4b from latest origin/main on new branch; retain handoff notes for Server/Studio.

Final validation: `pnpm check` passed on 2026-11-21, 1,529 tests (248 plugin-host). Independent task and whole-branch review approved. Only integration steps remain.
