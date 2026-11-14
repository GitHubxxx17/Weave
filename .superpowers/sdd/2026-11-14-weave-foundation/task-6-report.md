# Task 6: 实现 `@weave/runtime` 生命周期和服务容器

## Status

DONE

## What Was Implemented

- Added the `@weave/runtime` package with strict TypeScript, ESM, package
  exports, test, lint, typecheck, and build scripts.
- Added the public `RuntimeStatus`, `RuntimeContext`, `RuntimeService`,
  `Runtime`, and `RuntimeOptions` contracts.
- Implemented a per-Runtime `ServiceContainer` backed by a private `Map`.
  Services are only available while the Runtime is `running`.
- Implemented the lifecycle state machine:
  `created -> starting -> running -> stopping -> stopped`.
- Starts services in declaration order and disposes created services in reverse
  order.
- Cleans up already-created services when a service factory fails and leaves
  the Runtime in `stopped`.
- Makes concurrent duplicate `start()` and `stop()` calls idempotent.
- Allows retrying after a failed startup, while rejecting `start()` after an
  explicit stop.
- Creates one `AbortController` per Runtime and aborts its signal before
  disposal during `stop()`.
- Keeps Runtime independent from Agent Loop, HTTP, filesystem, and global
  singleton behavior.

## TDD Evidence

### RED

Added `packages/runtime/test/runtime.test.ts` before adding the Runtime
implementation and ran:

```bash
pnpm exec vitest run packages/runtime/test/runtime.test.ts --root . --config vitest.config.ts
```

Relevant output:

```text
FAIL packages/runtime/test/runtime.test.ts
Error: Cannot find module '../src/index.js'
```

The failure was expected because the requested Runtime package entrypoint and
implementation did not yet exist. Vitest discovered the new test file, so the
failure was caused by the missing feature rather than a test typo.

### GREEN

After implementing the package:

```bash
pnpm exec vitest run packages/runtime/test/runtime.test.ts --root . --config vitest.config.ts
```

Result:

```text
Test Files  1 passed (1)
Tests       8 passed (8)
```

The tests cover declaration-order startup, reverse-order disposal, service
access boundaries, Runtime context propagation, abort behavior, duplicate
start/stop idempotency, failed-start cleanup, retry after failed startup,
stop-after-start rejection, and stable errors for unregistered services.

## Files Changed

- `packages/runtime/package.json`
- `packages/runtime/tsconfig.json`
- `packages/runtime/src/types.ts`
- `packages/runtime/src/service-container.ts`
- `packages/runtime/src/runtime.ts`
- `packages/runtime/src/index.ts`
- `packages/runtime/test/runtime.test.ts`
- `pnpm-lock.yaml`
- `.superpowers/sdd/2026-11-14-weave-foundation/task-6-report.md`

The pre-existing untracked `docs/` directory was not modified or staged.

## Verification

Required package commands:

```bash
pnpm --filter @weave/runtime test
```

Result: 5 test files passed, 54 tests passed. The package script runs the
Runtime tests together with the existing protocol and LLM tests.

```bash
pnpm --filter @weave/runtime typecheck
pnpm --filter @weave/runtime build
pnpm --filter @weave/runtime lint
```

All three commands passed with exit code 0 and no diagnostics.

Repository verification:

```bash
pnpm format:check
```

Passed: all matched files use Prettier code style.

```bash
pnpm check
```

Passed all root stages:

- format check passed.
- lint: 3 successful tasks.
- typecheck: 3 successful tasks.
- test: 3 successful tasks; Runtime package run passed 54 tests.
- build: 3 successful tasks.

Turbo emitted its existing non-failing warning that
`@weave/runtime#test` has no configured output files. No Turbo configuration
was changed for this task.

Dependency-boundary check:

```bash
rg -n "from ['\"].*(hono|react|@hono/node-server|node:|fs|http)" packages/runtime/src packages/runtime/test || true
```

Result: no output. Runtime does not import HTTP, browser, filesystem, or Node
HTTP APIs.

Diff hygiene:

```bash
git diff --check
```

Passed with no whitespace errors.

## Self-Review

- The service container is instantiated inside each Runtime; no module-level
  service registry or global Map is used.
- `get()` checks the Runtime lifecycle state before reading the container, so
  services are unavailable before startup and after cleanup.
- Startup records a service only after its `create()` resolves, so a failing
  factory is never disposed as if it had produced an instance.
- Cleanup iterates all successfully-created services in reverse order and
  continues after a disposal error. The first disposal error is rethrown after
  all cleanup has been attempted.
- `stop()` aborts the Runtime signal before calling service disposers, allowing
  future LLM, Agent, and Tool services to observe cancellation.
- The public entrypoint exports the requested Runtime contracts and factory
  without exposing implementation details.
- The design document already contains the Task 6 Runtime contract and package
  boundary, so no additional architecture change was required.

## Concerns

- Turbo reports a pre-existing warning because package test tasks do not
  produce configured output files. It is non-failing and unrelated to Runtime
  behavior.
- The worktree is detached at the foundation task revision, so the requested
  local commit is created on detached HEAD. No push was performed.
