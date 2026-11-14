# Task 3: 实现可测试的 SSE Parser

## What Was Implemented

- Added the `@weave/llm` package with strict TypeScript, ESM, build, typecheck,
  lint, and test scripts.
- Added immutable `SseParserState` and `ParsedSseFrame` interfaces.
- Implemented `createSseParserState`, `pushSseChunk`, and `flushSseParser`.
- Implemented SSE framing for LF and CRLF boundaries, incomplete chunks,
  multiple frames, comments, empty/non-data frames, and multiple `data:` lines.
- Kept `data: [DONE]` as ordinary frame data. The parser does not call
  `JSON.parse` and does not emit `StreamEvent` values.
- Added `decodeSseChunks`, using `TextDecoder.decode(chunk, { stream: true })`
  and a final flush to preserve UTF-8 characters split across byte chunks.

## TDD Evidence

### RED

Command:

```text
pnpm --filter @weave/llm test -- sse-parser
```

Result:

```text
FAIL packages/llm/test/sse-parser.test.ts
Error: Cannot find module '../src/index.js'
Test Files 1 failed | 1 passed (2)
Tests 6 passed (6)
```

The failure was expected because the `@weave/llm` source entrypoint and parser
had not yet been implemented. The existing protocol suite still passed.

### GREEN

Command:

```text
pnpm --filter @weave/llm test -- sse-parser
```

Result:

```text
Test Files 2 passed (2)
Tests 15 passed (15)
```

The 9 LLM parser tests cover the 5 required brief cases plus multiple data
lines, non-data frames, `[DONE]`, and split UTF-8 bytes. The command also runs
the existing 6 protocol tests.

## Files Changed

- `packages/llm/package.json`
- `packages/llm/tsconfig.json`
- `packages/llm/src/types.ts`
- `packages/llm/src/sse-parser.ts`
- `packages/llm/src/index.ts`
- `packages/llm/test/sse-parser.test.ts`
- `.superpowers/sdd/2026-11-14-weave-foundation/task-3-report.md`

The pre-existing untracked `docs/` directory was not modified or staged.

## Verification

Commands and results:

```text
pnpm --filter @weave/llm test -- sse-parser
PASS, 15/15 tests

pnpm --filter @weave/llm typecheck
PASS

pnpm --filter @weave/llm build
PASS

pnpm exec prettier --check packages/llm/package.json packages/llm/tsconfig.json packages/llm/src packages/llm/test
PASS, all matched files use Prettier code style

pnpm exec eslint packages/llm/src packages/llm/test
PASS

pnpm test
PASS, 2 tasks successful

pnpm typecheck
PASS, 2 tasks successful

pnpm build
PASS, 2 tasks successful
```

The repository-level test command reports the existing Turbo warning that
`@weave/llm#test` has no configured output files. It exits successfully and
does not indicate a test failure.

## Self-Review

- Parser state is immutable: calls create new state objects and do not mutate
  the input state.
- Provider JSON parsing is intentionally absent.
- `[DONE]` is intentionally not interpreted.
- SSE comments, fields other than `data:`, and blank lines do not produce
  frames.
- Multiple `data:` lines are joined with `\n`.
- CRLF and LF event boundaries are supported, including boundaries split
  across calls because chunks are appended before scanning.
- UTF-8 decoding uses a streaming `TextDecoder`, not independent decoding of
  each byte chunk.

## Concerns

- The worktree is detached at the foundation task commit, so the requested
  local commit will be created on the detached worktree HEAD.
- Turbo's test output warning is pre-existing task configuration behavior; no
  unrelated Turbo configuration was changed.
