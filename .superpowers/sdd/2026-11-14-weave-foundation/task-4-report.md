# Task 4 Report: 实现 LLM 公共接口、错误分类和 Mock Provider

## Status

DONE

## What Was Implemented

- Added the provider-independent `LlmClient` interface with `AbortSignal` and
  optional timeout options.
- Added public LLM-related type exports for `LlmRequest`, `StreamEvent`,
  `LlmError`, `LlmErrorCode`, and stream options.
- Added `createMockLlmClient`:
  - Replays the readonly event script in order.
  - Does not synthesize a `finish` event.
  - Validates each request with `llmRequestSchema` before emitting events.
  - Throws a Web-standard `AbortError` when cancellation is observed.
  - Supports cancellable optional per-event delay.
  - Does not access network, environment variables, or files.
- Added `createLlmError` with stable retryability defaults:
  - Non-retryable: `authentication`, `invalid-request`,
    `context-overflow`, `cancelled`, `provider`, and `protocol`.
  - Retryable: `rate-limit`, `timeout`, and `network`.
  - An explicit `retryable` value always wins.
  - Diagnostic messages remove control characters and redact common bearer,
    API key, and `sk-` token forms.
- Updated the package entrypoint exports.
- Updated `pnpm-lock.yaml` to record the existing workspace dependency link.

## TDD Evidence

### RED

Added `packages/llm/test/contract.test.ts` before implementing the new
production modules and ran:

```bash
pnpm --filter @weave/llm test -- contract
```

The expected failure was:

```text
packages/llm/test/contract.test.ts (14 tests | 14 failed)
TypeError: createMockLlmClient is not a function
TypeError: createLlmError is not a function
```

The existing SSE and protocol tests still passed. The failure was caused by
the requested exports and implementations not existing yet.

An initial post-implementation run also failed to resolve `@weave/protocol`
because this worktree had no linked `node_modules`. Running
`pnpm install --no-frozen-lockfile` linked the existing workspace dependency
and updated the lockfile. `pnpm install --frozen-lockfile` was intentionally
not used because the pre-existing lockfile did not contain the already-declared
`@weave/llm` workspace dependency.

### GREEN

Focused contract verification:

```bash
pnpm --filter @weave/llm test -- contract
```

Result:

```text
Test Files  3 passed (3)
Tests       29 passed (29)
```

The command includes the new 14 contract tests, the 9 existing SSE parser
tests, and the 6 protocol schema tests.

## Files Changed

- `packages/llm/src/types.ts`
- `packages/llm/src/client.ts`
- `packages/llm/src/errors.ts`
- `packages/llm/src/mock-client.ts`
- `packages/llm/src/index.ts`
- `packages/llm/test/contract.test.ts`
- `pnpm-lock.yaml`
- `.superpowers/sdd/2026-11-14-weave-foundation/task-4-report.md`

The pre-existing untracked `docs/` directory was not modified or staged.

## Verification

Commands and results:

```bash
pnpm --filter @weave/llm test -- contract
# 3 test files passed, 29 tests passed

pnpm --filter @weave/llm typecheck
# passed

pnpm --filter @weave/llm build
# passed

pnpm --filter @weave/llm lint
# passed

pnpm format:check
# All matched files use Prettier code style!

pnpm check
# format:check, lint, typecheck, test, and build all passed

git diff --check
# passed with no whitespace errors
```

`pnpm check` reports the existing Turbo warning that
`@weave/llm#test` has no configured output files. It is non-failing and comes
from the repository's existing Turbo configuration; no unrelated configuration
was changed.

## Self-Review

- `client.ts` only imports protocol types and the local stream option type. It
  does not import Hono, Node-specific APIs, or provider SDK types.
- The Mock provider validates requests before entering its event loop and checks
  cancellation before and after each delay.
- Delay timers remove their abort listener on both completion and cancellation.
- The event script is replayed exactly as supplied, including incomplete scripts.
- The error retryability table is exhaustive over the protocol's current error
  codes, with conservative defaults for `provider` and `protocol`.
- The public package entrypoint exports only the requested provider-independent
  interfaces, factories, protocol types, and existing SSE parser API.
- No dependency was added; the lockfile change only records the existing
  workspace package link.

## Concerns

- `timeoutMs` is part of the provider-independent `LlmClient` options contract,
  but this task does not define timeout behavior for Mock Provider. It is
  intentionally accepted by the interface and left for provider-specific
  implementations such as Task 5.
- Turbo still warns that package tests produce no configured output artifact.
  This is an existing repository-level configuration concern and does not
  affect test correctness.

## Commit

Created local commit:

```text
feat: 增加模型客户端与 Mock Provider
```
