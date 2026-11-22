# Studio Performance Baseline Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development or superpowers:executing-plans. Track each task with checkboxes; the user has approved this implementation scope.

**Goal:** Establish a repeatable production-browser baseline for long Studio conversations before rendering optimization.

**Architecture:** A Node-only test fixture serves existing Studio dist and synthetic JSON/SSE on a random loopback port. A self-contained Playwright browser probe measures user-visible readiness and streaming responsiveness without modifying production code.

**Tech Stack:** Existing Node 24, Zod, Vitest, Vite production build and installed Playwright CLI. No new dependency.

**Spec:** `docs/superpowers/specs/2026-11-23-studio-performance-baseline-design.md`.

## Global constraints

- Test tooling lives under `apps/server/test/performance/`; tests remain under test/.
- No changes to real data, credentials, Runtime, production rendering or user flows.
- No timing assertions in ordinary CI; retain raw observations and measurement limits.
- One independent branch; no commit, push, public publication or merge without authorization.

## Task 1: Deterministic scenario and isolated fixture

Files: create `apps/server/test/performance/scenario.mjs`, `fixture.mjs`, and `apps/server/test/studio-performance-fixture.test.ts`.

- [x] Write failing tests for count validation, exact visible history, tool pairing, isolated project/session JSON, ordered SSE completion and rejected unknown routes.
- [x] Run `pnpm exec vitest run apps/server/test/studio-performance-fixture.test.ts` and confirm failure.
- [x] Implement `createScenario(count, variant)` and `startPerformanceFixture(options)` with an idempotent async close, bounded inputs, owned sockets/timers, dist-only paths and safe errors.
- [x] Run focused tests and Server lint.

## Task 2: Browser probe and explicit command

Files: create `apps/server/test/performance/browser-probe.mjs` and `run.mjs`; modify root `package.json`.

- [x] Implement an independently serializable `probeStudio(page, options)` that measures cold/warm render, input painting, frame gaps and long tasks; assert exact final stream text.
- [x] Implement a CLI with validated count/variant/repeat/output options; invoke the browser CLI using execFile argument arrays, write its probe to a temporary file, and close owned resources in finally.
- [x] Add `studio:benchmark` to build Studio then invoke the runner; execute a small workload first and correct actual browser failures.
- [x] Execute all 100/1000/5000 workloads, retaining versioned raw JSON in ignored dist output. Discard the shared-browser exploratory matrix; use all 18 replacement samples with a fresh browser per sample and no-store assets.

## Task 3: Evidence and independent review

Files: create `docs/learning/2026-11-23-studio-performance-baseline.md`; update README benchmark instructions.

- [x] Document setup, exact command, machine/browser/build metadata, measured samples and limitations.
- [x] Run `pnpm check` and inspect exit code. Owner reported exit 0; the independent reviewer inspected `/tmp/weave-performance-check-20261123.log`, including successful format, lint, typecheck, tests and final build stages.
- [x] Obtain independent review of isolation, measurement definitions, cleanup, all raw summaries and the learning-document table; independently rerun four fixture tests, focused ESLint and delivered-file formatting checks.
- [x] Fix material findings: use fresh browsers and no-store assets, assert exact final stream content/rows, and keep the correct `approval.snapshot` subscription open. Report observations without inventing improvement claims.
