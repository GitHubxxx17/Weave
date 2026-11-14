# Task 5 Report: OpenAI-compatible Provider Adapter

## Status

Implemented the OpenAI-compatible `@weave/llm` provider adapter with injected
`fetch`, offline fake-fetch tests, request/response translation, cancellation,
timeouts, bounded diagnostics, and stable `LlmError` classification.

## TDD Evidence

### RED

Command:

```bash
pnpm --filter @weave/llm test -- openai-compatible
```

Result before the adapter implementation:

```text
FAIL packages/llm/test/openai-compatible.test.ts (11 tests | 11 failed)
TypeError: createOpenAiCompatibleClient is not a function
Test Files 1 failed | 3 passed (4)
Tests 11 failed | 29 passed (40)
```

The failure was expected because the tests imported the new public factory
before the adapter existed.

### GREEN

Focused command:

```bash
pnpm --filter @weave/llm test -- openai-compatible
```

Result:

```text
Test Files 4 passed (4)
Tests 40 passed (40)
```

Full package test command:

```bash
pnpm --filter @weave/llm test
```

Result:

```text
Test Files 4 passed (4)
Tests 40 passed (40)
```

Additional verification:

```bash
pnpm format:check
pnpm --filter @weave/llm lint
pnpm --filter @weave/llm typecheck
pnpm --filter @weave/llm build
```

All four commands passed. Format output reported that all files matched
Prettier style; lint, typecheck, and build produced no errors.

## Implementation

- Added `createOpenAiCompatibleClient` and
  `OpenAiCompatibleClientOptions`.
- Added private provider request structures and Zod schemas for streamed
  OpenAI-compatible chunks.
- Converts Weave messages, reasoning/text content, assistant tool calls, tool
  results, tool definitions, temperature, token limits, and reasoning effort.
- Sends `POST ${baseUrl}/chat/completions` with `Bearer` authorization,
  JSON content type, and `stream: true`.
- Uses the existing SSE parser and `TextDecoder` for arbitrary UTF-8 body
  chunks.
- Maps text, reasoning, tool-call start/delta, finish reason, and token usage
  fields to Weave `StreamEvent` values.
- Forwards an external `AbortSignal` through an internal controller and
  supports per-call timeout overriding the default timeout.
- Cleans up timeout timers and abort listeners in `finally`.
- Maps HTTP failures to `authentication`, `rate-limit`, `invalid-request`,
  `context-overflow`, or `provider`; 5xx and rate limits are retryable.
- Maps network failures, cancellation, timeout, missing bodies, malformed JSON,
  and invalid provider chunks to stable `LlmError` values.
- Reads at most 4,000 diagnostic characters and redacts the configured API key.
- Does not perform automatic retries.
- Added `zod` as a direct `@weave/llm` dependency because the adapter owns
  private provider response validation.

## Files Changed

- `packages/llm/package.json`
- `packages/llm/src/index.ts`
- `packages/llm/src/openai-compatible.ts`
- `packages/llm/test/openai-compatible.test.ts`
- `pnpm-lock.yaml`
- `.superpowers/sdd/2026-11-14-weave-foundation/task-5-report.md`

## Self-review

- Provider request and chunk types remain private to the adapter; generated
  declarations expose only the requested options and factory.
- The Weave `provider` routing field is not included in the provider request.
- Tool parameters are passed as JSON Schema and are never treated as executed
  tool data.
- Unknown provider fields are accepted without changing supported mappings.
- Tool-call state uses provider `index` when present and position otherwise.
- The adapter does not retry.
- API keys are not included in error messages or diagnostics.
- No real network or credentials are used by tests.

## Concerns

The worktree contained pre-existing untracked `docs/` content. It was not
modified or staged. No implementation concerns remain after the required
verification commands passed.

## Review Fix Report

### Findings Fixed

1. Configured API keys are redacted from all provider-derived error messages,
   including network exceptions, response-reader exceptions, HTTP status text,
   and bounded diagnostic bodies. Adapter-created errors are now sanitized
   centrally with the configured key.
2. Early async-iterator termination cancels the response body and aborts the
   internal controller before releasing the reader lock.
3. Tool-call state is buffered by provider tool-call index. Id, name, and
   argument fragments may arrive independently; buffered arguments are emitted
   only after `tool-call-start`, preserving all fragments and event ordering.
4. Usage is retained independently of choices. A usage-only final chunk is
   combined with the pending finish reason, and an unfinished stream with only
   usage receives an `unknown` finish at stream termination.
5. Error normalization trusts only errors created by this adapter via a private
   marker. Arbitrary thrown objects, including duck-typed `{ code, message }`
   objects, are rebuilt as sanitized retryable network errors.

### TDD Evidence

RED command after adding the five regression areas:

```bash
pnpm --filter @weave/llm test -- openai-compatible
```

Relevant failure evidence:

```text
Test Files 1 failed | 3 passed (4)
Tests 4 failed | 41 passed (45)
```

The failures covered missing partial tool-call preservation, missing usage
from a usage-only chunk, configured-key leakage from network errors, and
missing response-body cancellation. The arbitrary thrown-object regression was
also added and passed through the existing fetch-catch path; a second
response-reader arbitrary-object test covers the stream error path directly.

GREEN focused command:

```bash
pnpm --filter @weave/llm test -- openai-compatible
```

Result:

```text
Test Files 4 passed (4)
Tests 46 passed (46)
```

### Verification

Commands run:

```bash
pnpm --filter @weave/llm test -- openai-compatible
pnpm --filter @weave/llm test
pnpm --filter @weave/llm lint
pnpm --filter @weave/llm typecheck
pnpm --filter @weave/llm build
pnpm check
git diff --check
```

Results:

- Focused adapter run: 46/46 tests passed.
- Full `@weave/llm` run: 46/46 tests passed.
- Lint, typecheck, build, and `git diff --check` passed.
- `pnpm check` passed across format, lint, typecheck, test, and build.
- `pnpm check` retained the existing Turbo warning that `@weave/llm#test`
  has no configured output files; this did not affect the successful exit.

### Files Changed

- `packages/llm/src/openai-compatible.ts`
- `packages/llm/test/openai-compatible.test.ts`
- `.superpowers/sdd/2026-11-14-weave-foundation/task-5-report.md`

### Self-review

- The fix remains within the OpenAI-compatible adapter, its tests, and the
  required report.
- No retry behavior was added.
- Provider request and response structures remain private.
- Normal completion still releases the reader without forcing cancellation;
  consumer early return and stream errors cancel the underlying body.
- The pre-existing untracked `docs/` directory remains untouched and unstaged.
