# Task 7: 装配最小 Hono Server 和 `/health`

## Status

DONE

## What Was Implemented

- Added `@weave/server` as an ESM TypeScript workspace application.
- Added `createServerRuntime()` in `apps/server/src/runtime.ts`.
- Registered one server-owned Mock LLM service backed by
  `@weave/llm`'s `createMockLlmClient`.
- Added `createApp(runtime)` in `apps/server/src/app.ts` with only `GET /health`.
- Returned `200` with `{ "status": "ok", "runtime": "running" }` for a running
  Runtime and `503` with `{ "status": "unavailable", "runtime": "created" }`
  before startup.
- Validated the health response through a fixed Zod schema.
- Added `apps/server/src/main.ts`, which validates the configured port with
  Zod, defaults to port `4317`, binds `127.0.0.1`, starts Runtime before
  serving, and stops both the HTTP server and Runtime on `SIGINT`/`SIGTERM`.
- Kept `serve()` isolated to `main.ts`; tests use Hono in-memory requests and
  do not bind a real port.
- Added Hono, `@hono/node-server`, and `@types/node` dependencies. Hono is
  required for the control-plane app, `@hono/node-server` is required for the
  Node entrypoint, and Node types are required for strict TypeScript checking
  of `process`.

## TDD Evidence

### RED

Added `apps/server/test/health.test.ts` before adding the server source files.
The first focused run was:

```bash
pnpm --filter @weave/server test
```

The initial run could not resolve the newly declared workspace package because
the app had not been installed yet:

```text
Error: Cannot find package '@weave/runtime'
```

After installing the workspace dependencies, the same command reached the
intended feature failure:

```text
FAIL apps/server/test/health.test.ts
Error: Cannot find module '../src/app.js'
```

This was expected because `createApp` and the server source directory did not
yet exist. The existing package tests were still green: 57 tests passed.

### GREEN

After implementing the server:

```bash
pnpm --filter @weave/server test
```

Result:

```text
Test Files  6 passed (6)
Tests       59 passed (59)
```

The package test script runs the workspace test set from the repository root,
including the two new `/health` tests.

## Verification

```bash
pnpm --filter @weave/server test
pnpm --filter @weave/server typecheck
pnpm --filter @weave/server build
pnpm --filter @weave/server lint
```

All commands passed. The focused package test run reported 59/59 passing.

Repository checks:

```bash
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

All commands passed. The repository test run reported 59/59 tests passing in
each package invocation. Turbo emitted its existing non-failing warning that
test tasks have no configured output files; no Turbo configuration was changed.

Boundary checks:

```bash
rg -n "(Agent Loop|runAgent|RunManager|serve\\(|fetch\\(|createMockLlmClient|process\\.env|API_KEY|secret|tools|database|fs|http)" apps/server/src apps/server/test || true
```

The only matches were the intended Mock LLM factory, `serve()` in `main.ts`,
and `process.env.PORT` in the Node entrypoint. No Agent Loop, tool execution,
database, or filesystem logic was added.

## Files Changed

- `apps/server/package.json`
- `apps/server/tsconfig.json`
- `apps/server/src/runtime.ts`
- `apps/server/src/app.ts`
- `apps/server/src/main.ts`
- `apps/server/test/health.test.ts`
- `pnpm-lock.yaml`
- `.superpowers/sdd/2026-11-14-weave-foundation/task-7-report.md`

The pre-existing untracked `docs/` directory was not modified or staged.

## Self-Review

- `createApp` accepts an already-created Runtime and contains only the health
  route.
- The route does not access Runtime services, call the model, execute tools,
  write files, or access a database.
- The route exposes only the fixed public health payload and never includes
  service instances, config, errors, or secrets.
- Runtime is per-factory; no module-level singleton was introduced.
- The Mock LLM service key is private to the server package.
- Port input is validated before starting Runtime or binding the server.
- The Node entrypoint is the only file that imports `@hono/node-server`.
- No real network port is used by tests.

## Concerns

- The registry does not contain the initially considered
  `@hono/node-server@4.11.4`; the dependency was set to the available
  `@hono/node-server@2.1.8`, compatible with Hono `4.13.18`.
- The worktree is detached at the foundation task revision, so the requested
  local commit will be created on detached HEAD. No push will be performed.
