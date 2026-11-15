# Tool Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 `@weave/runtime` 建立可测试、可取消、可限流的共享 Tool Registry 和 Tool Pipeline。

**Architecture:** Registry 只管理工具定义和稳定查找，Pipeline 负责输入校验、执行生命周期、错误归一化和结果限制。Pipeline 不写 Session，不执行文件或 Shell，也不修改当前 Agent Runner 的工具拒绝语义。

**Tech Stack:** TypeScript、ESM、Node.js 24.4、Zod、Vitest、pnpm workspace、Turborepo。

**Spec:** `docs/superpowers/specs/2026-11-15-tool-pipeline-design.md`

## Global Constraints

- 使用 TypeScript、ESM 和严格类型。
- 所有外部 Tool Call 输入在 Runtime 边界使用 Zod 校验。
- 工具只能通过共享 Tool Pipeline 执行。
- 不实现 Workspace、Sandbox、Approval、HTTP、SSE 或前端。
- 不添加 JSON Schema 转换库；模型参数描述和本地 Zod 校验器分开保存。
- 工具错误保留原始 `cause`，取消和超时使用稳定错误 code。
- 测试放在 `packages/runtime/test/`，不得放入 `src/`。
- 直接使用的 workspace 依赖必须声明在 `packages/runtime/package.json`。
- 每个可独立验证的任务完成后使用中文 Conventional Commit。
- 完成后更新仓库架构文档、飞书学习文档和总计划。

### Task 1: 固定 Tool Pipeline 契约与依赖

**Files:**
- Modify: `packages/runtime/package.json`
- Create: `packages/runtime/src/tool-types.ts`
- Modify: `packages/runtime/src/index.ts`
- Test: `packages/runtime/test/tool-types.test.ts`

**Interfaces:**
- Produces `ToolExecutionContext`, `ToolDefinition`, `ToolExecutionRequest`,
  `ToolExecutionResult`, `ToolExecutionError` and `ToolExecutionErrorCode`.
- Produces `toolExecutionRequestSchema` and `toolDefinitionSchema`.
- Does not execute tools.

- [x] **Step 1: Write the failing contract tests**

```ts
it('accepts a valid tool execution request', () => {
  const result = toolExecutionRequestSchema.safeParse({
    toolCallId: 'call-1',
    name: 'echo',
    arguments: '{"text":"hello"}',
  });

  expect(result.success).toBe(true);
});

it('rejects an empty tool name and negative timeout', () => {
  const result = toolExecutionRequestSchema.safeParse({
    toolCallId: 'call-1',
    name: '',
    arguments: '{}',
    timeoutMs: -1,
  });

  expect(result.success).toBe(false);
});

it('exposes a stable ToolExecutionError code and cause', () => {
  const cause = new Error('provider detail');
  const error = new ToolExecutionError('tool-execution-failed', 'Tool failed', { cause });

  expect(error.name).toBe('ToolExecutionError');
  expect(error.code).toBe('tool-execution-failed');
  expect(error.cause).toBe(cause);
});
```

- [x] **Step 2: Run the focused test and verify it fails**

Run: `pnpm exec vitest run packages/runtime/test/tool-types.test.ts --config vitest.config.ts`

Expected: FAIL because the Tool Pipeline contract exports do not exist yet.

- [x] **Step 3: Add the runtime Zod dependency and implement the contract**

Add `"zod": "4.6.7"` to `packages/runtime/package.json`. Define non-empty string
validation, non-negative finite timeout validation, the execution context and
result types, and the typed error class in `tool-types.ts`. The request schema
must validate `toolCallId`, `name`, `arguments`, optional `sessionId`,
`timeoutMs`, and optional `AbortSignal`.

- [x] **Step 4: Export the public contract**

Export the new types, schemas and error class from `packages/runtime/src/index.ts`.
Do not export implementation internals yet.

- [x] **Step 5: Run the focused test and verify it passes**

Run: `pnpm exec vitest run packages/runtime/test/tool-types.test.ts --config vitest.config.ts`

Expected: PASS.

- [x] **Step 6: Commit the contract**

```bash
git add packages/runtime/package.json packages/runtime/src/tool-types.ts packages/runtime/src/index.ts packages/runtime/test/tool-types.test.ts pnpm-lock.yaml
git commit -m "feat: 定义工具管线公共契约"
```

### Task 2: Implement the Tool Registry

**Files:**
- Create: `packages/runtime/src/tool-registry.ts`
- Create: `packages/runtime/test/tool-registry.test.ts`
- Modify: `packages/runtime/src/index.ts`

**Interfaces:**
- Consumes `ToolDefinition` from Task 1.
- Produces `createToolRegistry(): ToolRegistry`.
- `register()` rejects duplicate names and invalid definitions.
- `get()` returns the exact registered definition or `undefined`.
- `list()` returns definitions in registration order.

- [x] **Step 1: Write the failing Registry tests**

```ts
const echoTool: ToolDefinition<{ text: string }, string> = {
  name: 'echo',
  description: 'Returns the input text',
  parameters: { type: 'object', properties: { text: { type: 'string' } } },
  inputSchema: z.object({ text: z.string() }),
  execute: ({ text }) => text,
};

it('registers and finds a tool', () => {
  const registry = createToolRegistry();
  registry.register(echoTool);

  expect(registry.get('echo')).toBe(echoTool);
  expect(registry.list()).toEqual([echoTool]);
});

it('rejects duplicate names', () => {
  const registry = createToolRegistry();
  registry.register(echoTool);

  expect(() => registry.register(echoTool)).toThrow(/already registered/);
});

it('returns a stable snapshot from list', () => {
  const registry = createToolRegistry();
  registry.register(echoTool);
  const listed = registry.list();

  expect(() => (listed as ToolDefinition[]).push(echoTool)).toThrow();
  expect(registry.list()).toHaveLength(1);
});
```

- [x] **Step 2: Run the focused tests and verify they fail**

Run: `pnpm exec vitest run packages/runtime/test/tool-registry.test.ts --config vitest.config.ts`

Expected: FAIL because `createToolRegistry` is not implemented.

- [x] **Step 3: Implement the registry**

Use a private `Map<string, ToolDefinition>` and a registration-order array or
Map iteration. Validate the definition with the contract schema before storing
it. Return a frozen list snapshot so callers cannot mutate Registry state.

- [x] **Step 4: Export the registry factory**

Export `createToolRegistry` and `ToolRegistry` from `packages/runtime/src/index.ts`.

- [x] **Step 5: Run the focused tests and verify they pass**

Run: `pnpm exec vitest run packages/runtime/test/tool-registry.test.ts --config vitest.config.ts`

Expected: PASS.

- [x] **Step 6: Commit the Registry**

```bash
git add packages/runtime/src/tool-registry.ts packages/runtime/test/tool-registry.test.ts packages/runtime/src/index.ts
git commit -m "feat: 增加工具注册表"
```

### Task 3: Implement Tool Pipeline execution

**Files:**
- Create: `packages/runtime/src/tool-pipeline.ts`
- Create: `packages/runtime/test/tool-pipeline.test.ts`
- Modify: `packages/runtime/src/index.ts`

**Interfaces:**
- Consumes `ToolRegistry`, `ToolExecutionRequest`, and `ToolExecutionError`.
- Produces `createToolPipeline({ registry, timeoutMs, maxResultBytes })`.
- Produces `ToolPipeline.execute(request): Promise<ToolExecutionResult>`.
- Does not write Session events or call Agent Runner.

- [x] **Step 1: Write the failing normal execution tests**

```ts
it('parses and validates arguments before invoking the tool', async () => {
  const execute = vi.fn(({ text }: { text: string }) => text.toUpperCase());
  const pipeline = createToolPipeline({
    registry: createRegistry({ execute }),
  });

  await expect(
    pipeline.execute({
      toolCallId: 'call-1',
      name: 'echo',
      arguments: '{"text":"hello"}',
    }),
  ).resolves.toMatchObject({
    toolCallId: 'call-1',
    name: 'echo',
    content: 'HELLO',
    truncated: false,
  });
  expect(execute).toHaveBeenCalledOnce();
});

it('rejects unknown tools and invalid JSON without invoking a handler', async () => {
  const execute = vi.fn();
  const pipeline = createToolPipeline({ registry: createRegistry({ execute }) });

  await expect(
    pipeline.execute({ toolCallId: 'call-1', name: 'missing', arguments: '{}' }),
  ).rejects.toMatchObject({ code: 'tool-not-found' });
  await expect(
    pipeline.execute({ toolCallId: 'call-2', name: 'echo', arguments: '{' }),
  ).rejects.toMatchObject({ code: 'tool-invalid-json' });
  expect(execute).not.toHaveBeenCalled();
});
```

- [x] **Step 2: Run the focused tests and verify they fail**

Run: `pnpm exec vitest run packages/runtime/test/tool-pipeline.test.ts --config vitest.config.ts`

Expected: FAIL because `createToolPipeline` is not implemented.

- [x] **Step 3: Implement request validation and lookup**

Parse the request with `toolExecutionRequestSchema`, look up the name in the
Registry, parse JSON arguments, and run the registered `inputSchema` before
calling `execute`. Wrap each failure in its documented `ToolExecutionError`
code and never invoke a handler on an earlier failure.

- [x] **Step 4: Implement cooperative cancellation and timeout**

Create an internal `AbortController`, combine it with the request signal, and
optionally start a timer. Before and after `execute`, check whether cancellation
or timeout happened. Clear the timer and remove listeners in a `finally` block.
If both timeout and a later AbortError occur, return `tool-timeout`.

- [x] **Step 5: Implement serialization and UTF-8 result limiting**

Serialize strings directly and other JSON values with `JSON.stringify`; map
`undefined` to an empty string. Use `TextEncoder` to enforce
`maxResultBytes`, truncate only at valid UTF-8 boundaries, and set
`truncated: true`. Convert circular JSON failures to
`tool-result-serialization-failed`.

- [x] **Step 6: Add cancellation, timeout, error and result-limit tests**

```ts
it('maps an aborted request to tool-cancelled', async () => {
  const controller = new AbortController();
  controller.abort();

  await expect(
    pipeline.execute({
      toolCallId: 'call-1',
      name: 'echo',
      arguments: '{"text":"hello"}',
      signal: controller.signal,
    }),
  ).rejects.toMatchObject({ code: 'tool-cancelled' });
});

it('maps a deadline to tool-timeout', async () => {
  const pipeline = createToolPipeline({
    registry: createRegistry({
      execute: (_input, { signal }) =>
        new Promise<string>((resolve, reject) => {
          signal.addEventListener('abort', () => reject(new DOMException('', 'AbortError')), {
            once: true,
          });
        }),
    }),
    timeoutMs: 5,
  });

  await expect(
    pipeline.execute({ toolCallId: 'call-1', name: 'echo', arguments: '{"text":"hello"}' }),
  ).rejects.toMatchObject({ code: 'tool-timeout' });
});

it('preserves tool errors as causes', async () => {
  const cause = new Error('disk unavailable');
  const pipeline = createToolPipeline({
    registry: createRegistry({ execute: () => Promise.reject(cause) }),
  });

  await expect(
    pipeline.execute({ toolCallId: 'call-1', name: 'echo', arguments: '{}' }),
  ).rejects.toMatchObject({ code: 'tool-execution-failed', cause });
});

it('limits UTF-8 output without splitting a multibyte character', async () => {
  const pipeline = createToolPipeline({
    registry: createRegistry({ execute: () => '你好a' }),
    maxResultBytes: 5,
  });

  await expect(
    pipeline.execute({ toolCallId: 'call-1', name: 'echo', arguments: '{}' }),
  ).resolves.toMatchObject({ content: '你', truncated: true });
});
```

- [x] **Step 7: Run focused tests and verify they pass**

Run: `pnpm exec vitest run packages/runtime/test/tool-pipeline.test.ts --config vitest.config.ts`

Expected: PASS.

- [x] **Step 8: Commit the Pipeline**

```bash
git add packages/runtime/src/tool-pipeline.ts packages/runtime/test/tool-pipeline.test.ts packages/runtime/src/index.ts
git commit -m "feat: 实现工具统一执行管线"
```

### Task 4: Update architecture and learning documentation

**Files:**
- Modify: `docs/architecture/foundation.md`
- Modify: `README.md`
- Modify: `docs/superpowers/specs/2026-11-15-tool-pipeline-design.md`
- Modify: `docs/superpowers/plans/2026-11-15-tool-pipeline.md`
- Create externally: Feishu document `07 Weave Tool Pipeline：工具注册、校验与安全执行`
- Modify externally: Feishu document `Weave 全项目计划与前端验收路线`

**Interfaces:**
- Documents the implemented contract only.
- Does not add code behavior.

- [x] **Step 1: Update the architecture text**

Add the completed Tool Pipeline boundary to `docs/architecture/foundation.md`:

```text
Agent Runner -> Tool Registry -> Tool Pipeline -> Tool Result
```

State explicitly that Pipeline does not provide Workspace, Approval, Session
persistence, HTTP, or SSE.

- [x] **Step 2: Update README status**

Change the capability status so readers can see that Tool Registry and Pipeline
are implemented, while Workspace/Sandbox, Approval, HTTP/SSE and Studio remain
future work.

- [x] **Step 3: Mark the implementation plan complete**

Mark all implementation steps as `[x]` only after the focused tests and full
verification pass. Record the exact verification commands and test count.

- [x] **Step 4: Create the Feishu learning document**

Create `07 Weave Tool Pipeline：工具注册、校验与安全执行` in the Weave document
folder. Include:

- Tool Definition、Tool Registry、Tool Pipeline 的职责差异；
- 为什么模型参数 Schema 和 Zod 执行 Schema 分开；
- 一次 Tool Call 的完整生命周期；
- JSON 解析、参数校验、取消、超时和结果限制；
- 为什么 Pipeline 不直接操作文件和 Shell；
- 与 Agent Loop、Workspace、Approval、SSE 和前端的关系；
- 前后端学习要点、面试回答和自测题。

- [x] **Step 5: Update the Feishu total plan**

Record the completed Tool Pipeline stage, link the learning document, and revise
the next step to Workspace/Sandbox/Approval.

- [x] **Step 6: Run the complete verification**

Run:

```bash
pnpm check
git diff --check
```

Expected: all format, lint, typecheck, test and build tasks pass with no
whitespace errors. The final run passed 14 test files with 145 tests.

- [x] **Step 7: Commit the documentation**

```bash
git add README.md docs/architecture/foundation.md docs/superpowers/specs/2026-11-15-tool-pipeline-design.md docs/superpowers/plans/2026-11-15-tool-pipeline.md
git commit -m "docs: 补充工具管线架构与学习说明"
```

## Completion Checklist

- [x] Tool contract tests pass.
- [x] Registry tests pass.
- [x] Pipeline tests pass.
- [x] `pnpm check` passes.
- [x] Runtime focused tests pass: 16 tests across the Tool Pipeline contract,
  Registry, and execution suites.
- [x] `git diff --check` passes.
- [x] Repository architecture and README reflect the implementation.
- [x] Feishu learning document is created and linked.
- [x] Feishu total plan is updated.
- [x] Branch contains only Tool Pipeline changes.
