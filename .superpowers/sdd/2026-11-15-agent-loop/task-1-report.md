# Task 1: 定义 Agent 公共契约和运行时校验

## Implementation Summary

Implemented the public Runtime contracts consumed by the next Agent Runner task:

- Added `agentRunRequestSchema` and `AgentRunRequest`.
- Added `agentRuntimeEventSchema` and `AgentRuntimeEvent`.
- Added `AgentRunErrorCode` and `AgentRunError`.
- Added `AgentRunner` and `AgentRunnerOptions`.
- Exported the runtime contracts and schemas from `packages/runtime/src/index.ts`.
- Declared the existing `zod@4.6.7` dependency directly in `@weave/runtime`, as required by the package boundary and strict TypeScript resolution.
- Did not implement `createAgentRunner`.

## Files

- `packages/runtime/src/agent-types.ts`
- `packages/runtime/src/index.ts`
- `packages/runtime/test/agent-runner.test.ts`
- `packages/runtime/package.json`
- `pnpm-lock.yaml`

## TDD Evidence

### RED

Command:

```bash
pnpm exec vitest run packages/runtime/test/agent-runner.test.ts --config vitest.config.ts
```

Result: failed as expected before implementation. The test suite reported 3 failed tests: the two schemas were undefined and `AgentRunError` was not constructible. One rejection test passed because the missing schema caused the wrapped call to throw.

### GREEN

Command:

```bash
pnpm exec vitest run packages/runtime/test/agent-runner.test.ts --config vitest.config.ts
```

Result:

```text
Test Files  1 passed (1)
Tests       4 passed (4)
```

## Verification

The focused contract test passed:

```bash
pnpm exec vitest run packages/runtime/test/agent-runner.test.ts --config vitest.config.ts
```

Runtime lint passed:

```bash
pnpm --filter @weave/runtime lint
```

Runtime typecheck passed:

```bash
pnpm --filter @weave/runtime typecheck
```

Dependency and runtime build passed:

```bash
pnpm --filter @weave/runtime... build
```

Formatting passed for all task files:

```bash
pnpm exec prettier --check packages/runtime/src/agent-types.ts packages/runtime/src/index.ts packages/runtime/test/agent-runner.test.ts packages/runtime/package.json
```

## Self-Review

- Request validation uses the existing `userMessageSchema` and rejects empty session, provider, model, and reasoning-effort strings.
- Numeric options reject non-finite and negative values.
- Runtime events use a discriminated union and require a non-empty `turnId` for completion.
- `AgentRunError` preserves stable error codes and sets the expected error name.
- Public types and values are exported through the runtime entry point.
- No Agent Runner implementation was added.
- `git diff --check` passed.
- The final diff was inspected and contained no unrelated source changes.

## Concerns

- `AbortSignal` validation uses `z.instanceof(AbortSignal)`, matching the task brief and assuming a runtime with the standard global `AbortSignal`.
- `AgentRunRequest` is inferred from the schema so its optional fields remain compatible with the repository's `exactOptionalPropertyTypes` setting.
