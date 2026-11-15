# Agent Loop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 Weave 增加一个无工具、可流式观察、可持久化并能正确处理失败和取消的最小 Agent Runner。

**Architecture:** `@weave/runtime` 新增独立 Agent Runner，通过构造参数依赖 `LlmClient` 和 `SessionEventStore`。Runner 从 Session Projection 恢复历史，持久化用户消息和 Turn/Step 生命周期，转发 transient 模型增量，并只在模型完成后持久化完整 assistant message。

**Tech Stack:** TypeScript、ESM、Zod、Vitest、`AsyncIterable`、`AbortSignal`、`@weave/llm`、`@weave/session`、pnpm workspace、Turborepo。

**Spec:** `docs/superpowers/specs/2026-11-15-agent-loop-design.md`

## Global Constraints

- TypeScript、ESM、strict typing；不使用 `any`、`@ts-ignore` 或不必要的类型断言。
- 外部 Agent Run 输入必须先经过 Zod，`userMessage` 必须是 `role: 'user'`。
- Durable Session Event 与 transient Agent Runtime Event 必须分离。
- `@weave/runtime` 不得依赖 Hono、React、Node HTTP Server 或 SQLite 具体 API。
- 工具调用不得执行或静默忽略；本轮稳定返回 `agent-tool-call-unsupported`。
- 模型流必须且只能包含一个 finish，并且 finish 必须是最后一个事件。
- 初始化、完成、失败、取消阶段分别使用批量 `append()`。
- 模型失败和取消时不持久化不完整 assistant message。
- Provider、Store 和 Abort 错误保留原始类型；只有 Agent 自身错误使用 `AgentRunError`。
- 测试放在 `packages/runtime/test/`，不放在 `src/`。
- 每个行为先写失败测试并确认失败原因，再写最小实现。
- 代码只保留关键 TSDoc 和不明显的不变量；详细学习解释写入仓库文档和飞书。
- 本分支不实现 Tool Pipeline、HTTP `/run`、SSE API、前端或 Crew。

---

## 目标文件地图

### Runtime 公共契约

- Create: `packages/runtime/src/agent-types.ts`
  - `agentRunRequestSchema`
  - `agentRuntimeEventSchema`
  - `AgentRunRequest`
  - `AgentRuntimeEvent`
  - `AgentRunErrorCode`
  - `AgentRunError`
  - `AgentRunner`
  - `AgentRunnerOptions`
- Modify: `packages/runtime/src/index.ts`
  - 导出 Agent 公共 Schema、类型、错误和 `createAgentRunner()`。

### Agent 行为

- Create: `packages/runtime/src/agent-runner.ts`
  - 输入校验；
  - Session 恢复和自动创建；
  - Turn/Step 初始化；
  - LLM Stream 消费；
  - Runtime Event 转发；
  - Assistant Message 聚合；
  - 完成、失败、取消持久化；
  - 工具调用和流协议拒绝。

### 测试

- Create: `packages/runtime/test/agent-runner.test.ts`
  - 公共输入；
  - 正常完成；
  - 已有 Session；
  - reasoning；
  - 流协议；
  - 工具调用；
  - 模型失败；
  - AbortSignal 取消；
  - 消费者提前停止；
  - 失败事件持久化失败。

### 文档

- Modify: `docs/superpowers/specs/2026-11-15-agent-loop-design.md`
  - 状态更新为已实施；
  - 公共输入类型使用 `UserMessage`。
- Modify: `docs/architecture/foundation.md`
  - 增加 Agent Runner 层、执行链路和边界说明。
- Modify: `README.md`
  - 增加 Agent Runner 能力、测试命令和当前非目标。
- Create in Feishu: `06 Weave Agent Loop：从 Session 到模型流式输出`
  - 详细解释 Agent、Turn、Step、模型流和 durable event。
- Update in Feishu: `Weave 全项目计划与前端验收路线`
  - 更新 M2 Headless Agent 进度和前端可验收范围。

## Task 1: 定义 Agent 公共契约和运行时校验

**Files:**

- Create: `packages/runtime/src/agent-types.ts`
- Modify: `packages/runtime/src/index.ts`
- Create: `packages/runtime/test/agent-runner.test.ts`

**Interfaces:**

- Consumes:
  - `UserMessage`、`userMessageSchema` from `@weave/protocol`
  - `LlmClient` from `@weave/llm`
  - `SessionEventStore` from `@weave/session`
- Produces:

```ts
export const agentRunRequestSchema: z.ZodType<AgentRunRequest>;
export const agentRuntimeEventSchema: z.ZodType<AgentRuntimeEvent>;

export interface AgentRunRequest {
  readonly sessionId: string;
  readonly userMessage: UserMessage;
  readonly provider: string;
  readonly model: string;
  readonly temperature?: number;
  readonly maxTokens?: number;
  readonly reasoningEffort?: string;
  readonly signal?: AbortSignal;
}

export type AgentRuntimeEvent =
  | { readonly type: 'text-delta'; readonly text: string }
  | { readonly type: 'reasoning-delta'; readonly text: string }
  | { readonly type: 'completed'; readonly turnId: string };

export type AgentRunErrorCode =
  | 'agent-invalid-input'
  | 'agent-stream-protocol'
  | 'agent-tool-call-unsupported';

export class AgentRunError extends Error {
  readonly code: AgentRunErrorCode;
}

export interface AgentRunner {
  run(request: AgentRunRequest): AsyncIterable<AgentRuntimeEvent>;
}

export interface AgentRunnerOptions {
  readonly llm: LlmClient;
  readonly sessionStore: SessionEventStore;
}
```

- [x] **Step 1: 创建契约失败测试**

在 `packages/runtime/test/agent-runner.test.ts` 写入最小测试和收集助手：

```ts
import { describe, expect, it } from 'vitest';
import type { AgentRunRequest } from '../src/index.js';
import {
  AgentRunError,
  agentRunRequestSchema,
  agentRuntimeEventSchema,
} from '../src/index.js';

const validRequest: AgentRunRequest = {
  sessionId: 'session-1',
  userMessage: {
    role: 'user',
    content: [{ type: 'text', text: '开始分析' }],
  },
  provider: 'mock',
  model: 'test-model',
};

describe('Agent Runner contracts', () => {
  it('validates a provider-independent Agent Run request', () => {
    expect(agentRunRequestSchema.parse(validRequest)).toMatchObject({
      sessionId: 'session-1',
      provider: 'mock',
      model: 'test-model',
    });
  });

  it('rejects an empty session id and non-user message', () => {
    expect(() =>
      agentRunRequestSchema.parse({ ...validRequest, sessionId: '' }),
    ).toThrow();
    expect(() =>
      agentRunRequestSchema.parse({
        ...validRequest,
        userMessage: {
          role: 'assistant',
          content: [{ type: 'text', text: '错误角色' }],
        },
      }),
    ).toThrow();
  });

  it('validates transient Agent Runtime Events', () => {
    expect(
      agentRuntimeEventSchema.parse({ type: 'text-delta', text: '内容' }),
    ).toEqual({ type: 'text-delta', text: '内容' });
    expect(() =>
      agentRuntimeEventSchema.parse({ type: 'completed', turnId: '' }),
    ).toThrow();
  });

  it('exposes stable Agent error codes', () => {
    expect(
      new AgentRunError('agent-invalid-input', 'Agent Run input is invalid'),
    ).toMatchObject({
      name: 'AgentRunError',
      code: 'agent-invalid-input',
    });
  });
});
```

- [x] **Step 2: 运行测试确认 RED**

Run:

```bash
pnpm exec vitest run packages/runtime/test/agent-runner.test.ts --config vitest.config.ts
```

Expected: FAIL，因为 `AgentRunError`、两个 Schema 和公共类型尚未导出。

- [x] **Step 3: 实现最小公共契约**

在 `agent-types.ts` 中使用：

```ts
import type { LlmClient } from '@weave/llm';
import { userMessageSchema, type UserMessage } from '@weave/protocol';
import type { SessionEventStore } from '@weave/session';
import { z } from 'zod';

const nonEmptyStringSchema = z.string().min(1);

export const agentRunRequestSchema = z
  .object({
    sessionId: nonEmptyStringSchema,
    userMessage: userMessageSchema,
    provider: nonEmptyStringSchema,
    model: nonEmptyStringSchema,
    temperature: z.number().finite().nonnegative().optional(),
    maxTokens: z.number().finite().nonnegative().optional(),
    reasoningEffort: nonEmptyStringSchema.optional(),
    signal: z.instanceof(AbortSignal).optional(),
  })
  .passthrough();

export type AgentRunRequest = z.infer<typeof agentRunRequestSchema>;

export const agentRuntimeEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text-delta'), text: z.string() }),
  z.object({ type: z.literal('reasoning-delta'), text: z.string() }),
  z.object({
    type: z.literal('completed'),
    turnId: nonEmptyStringSchema,
  }),
]);

export type AgentRuntimeEvent = z.infer<typeof agentRuntimeEventSchema>;

export type AgentRunErrorCode =
  | 'agent-invalid-input'
  | 'agent-stream-protocol'
  | 'agent-tool-call-unsupported';

export class AgentRunError extends Error {
  readonly code: AgentRunErrorCode;

  constructor(code: AgentRunErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'AgentRunError';
    this.code = code;
  }
}

export interface AgentRunner {
  run(request: AgentRunRequest): AsyncIterable<AgentRuntimeEvent>;
}

export interface AgentRunnerOptions {
  readonly llm: LlmClient;
  readonly sessionStore: SessionEventStore;
}
```

在 `packages/runtime/src/index.ts` 导出这些值和类型。此 Task 不创建
`createAgentRunner()` 的空占位实现。

- [x] **Step 4: 运行契约测试和静态检查**

Run:

```bash
pnpm exec vitest run packages/runtime/test/agent-runner.test.ts --config vitest.config.ts
pnpm --filter @weave/runtime lint
pnpm --filter @weave/runtime typecheck
```

Expected: 契约测试、lint 和 typecheck 全部 PASS。

- [x] **Step 5: 提交公共契约**

```bash
git add packages/runtime/src/agent-types.ts packages/runtime/src/index.ts packages/runtime/test/agent-runner.test.ts
git commit -m "feat: 定义 Agent Runner 公共契约"
```

## Task 2: 实现正常 Agent 执行和 Session 恢复

**Files:**

- Create: `packages/runtime/src/agent-runner.ts`
- Modify: `packages/runtime/src/index.ts`
- Modify: `packages/runtime/test/agent-runner.test.ts`

**Interfaces:**

- Consumes:
  - `AgentRunnerOptions`、`AgentRunRequest`、`AgentRuntimeEvent`
  - `LlmClient.stream(request, { signal })`
  - `SessionEventStore.read()`、`append()`
  - `projectSession()`
- Produces:

```ts
export function createAgentRunner(options: AgentRunnerOptions): AgentRunner;
```

- [x] **Step 1: 增加测试助手和正常完成失败测试**

在测试文件增加：

```ts
import type { LlmClient } from '@weave/llm';
import type { LlmRequest, StreamEvent } from '@weave/protocol';
import {
  createInMemorySessionEventStore,
  projectSession,
} from '@weave/session';
import {
  createAgentRunner,
  type AgentRuntimeEvent,
} from '../src/index.js';

async function collect(
  events: AsyncIterable<AgentRuntimeEvent>,
): Promise<readonly AgentRuntimeEvent[]> {
  const result: AgentRuntimeEvent[] = [];
  for await (const event of events) {
    result.push(event);
  }
  return result;
}

function recordingClient(
  script: readonly StreamEvent[],
  requests: LlmRequest[],
): LlmClient {
  return {
    async *stream(request): AsyncIterable<StreamEvent> {
      requests.push(structuredClone(request));
      for (const event of script) {
        yield event;
      }
    },
  };
}
```

写正常完成测试：

```ts
it('streams a model response and persists a completed Turn', async () => {
  const store = createInMemorySessionEventStore();
  const requests: LlmRequest[] = [];
  const runner = createAgentRunner({
    llm: recordingClient(
      [
        { type: 'text-delta', text: '分析' },
        { type: 'reasoning-delta', text: '内部推理' },
        { type: 'text-delta', text: '完成' },
        { type: 'finish', reason: 'stop' },
      ],
      requests,
    ),
    sessionStore: store,
  });

  const runtimeEvents = await collect(runner.run(validRequest));
  const projection = projectSession(await store.read('session-1'));

  expect(runtimeEvents).toEqual([
    { type: 'text-delta', text: '分析' },
    { type: 'reasoning-delta', text: '内部推理' },
    { type: 'text-delta', text: '完成' },
    { type: 'completed', turnId: expect.any(String) },
  ]);
  expect(requests[0]?.messages).toEqual([validRequest.userMessage]);
  expect(projection.messages.map(({ message }) => message)).toEqual([
    validRequest.userMessage,
    {
      role: 'assistant',
      content: [{ type: 'text', text: '分析完成' }],
    },
  ]);
  expect(projection.turns[0]).toMatchObject({
    status: 'completed',
    steps: [{ kind: 'model', status: 'completed' }],
  });

  await store.close();
});
```

- [x] **Step 2: 增加 Runner 输入校验失败测试**

```ts
it('rejects invalid input before reading or writing the Session', async () => {
  const store = createInMemorySessionEventStore();
  const requests: LlmRequest[] = [];
  const runner = createAgentRunner({
    llm: recordingClient([{ type: 'finish', reason: 'stop' }], requests),
    sessionStore: store,
  });

  await expect(
    collect(
      runner.run({
        ...validRequest,
        sessionId: '',
      }),
    ),
  ).rejects.toMatchObject({
    code: 'agent-invalid-input',
  });
  expect(await store.read('session-1')).toEqual([]);
  expect(requests).toEqual([]);

  await store.close();
});
```

- [x] **Step 3: 增加已有 Session 和纯 reasoning 失败测试**

```ts
it('continues an existing Session without duplicating session.created', async () => {
  const store = createInMemorySessionEventStore();
  await store.append('session-1', [
    { type: 'session.created', payload: { title: 'Existing' } },
    {
      type: 'message.created',
      payload: {
        messageId: 'existing-message',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: '上一轮结果' }],
        },
      },
    },
  ]);
  const requests: LlmRequest[] = [];
  const runner = createAgentRunner({
    llm: recordingClient([{ type: 'finish', reason: 'stop' }], requests),
    sessionStore: store,
  });

  await collect(runner.run(validRequest));

  const events = await store.read('session-1');
  expect(events.filter(({ type }) => type === 'session.created')).toHaveLength(1);
  expect(requests[0]?.messages).toEqual([
    {
      role: 'assistant',
      content: [{ type: 'text', text: '上一轮结果' }],
    },
    validRequest.userMessage,
  ]);
  expect(projectSession(events).messages).toHaveLength(2);

  await store.close();
});

it('does not persist an empty assistant message for reasoning-only output', async () => {
  const store = createInMemorySessionEventStore();
  const runner = createAgentRunner({
    llm: recordingClient(
      [
        { type: 'reasoning-delta', text: '只进行推理' },
        { type: 'finish', reason: 'stop' },
      ],
      [],
    ),
    sessionStore: store,
  });

  expect(await collect(runner.run(validRequest))).toEqual([
    { type: 'reasoning-delta', text: '只进行推理' },
    { type: 'completed', turnId: expect.any(String) },
  ]);
  const projection = projectSession(await store.read('session-1'));
  expect(projection.messages.map(({ message }) => message)).toEqual([
    validRequest.userMessage,
  ]);

  await store.close();
});
```

- [x] **Step 4: 运行测试确认 RED**

Run:

```bash
pnpm exec vitest run packages/runtime/test/agent-runner.test.ts --config vitest.config.ts
```

Expected: FAIL，因为 `createAgentRunner` 尚不存在。

- [x] **Step 5: 实现 Session 初始化和正常模型流**

在 `agent-runner.ts`：

1. 使用 `agentRunRequestSchema.safeParse()`；失败时抛出
   `new AgentRunError('agent-invalid-input', 'Agent Run input is invalid')`。
2. `read(sessionId)`；为空时先追加 `session.created`。
3. 对已有事件调用 `projectSession()`。
4. 用 `randomUUID()` 生成 user message、turn、step ID。
5. 单次批量追加 user `message.created`、`turn.started`、
   `step.started(kind = 'model')`。
6. 重新读取并 Projection，使用投影中的所有 Message 创建 `LlmRequest`。
7. 构造请求时只在值存在时添加 optional 字段，满足
   `exactOptionalPropertyTypes`：

```ts
const llmRequest: LlmRequest = {
  provider: request.provider,
  model: request.model,
  messages,
  ...(request.temperature === undefined
    ? {}
    : { temperature: request.temperature }),
  ...(request.maxTokens === undefined ? {} : { maxTokens: request.maxTokens }),
  ...(request.reasoningEffort === undefined
    ? {}
    : { reasoningEffort: request.reasoningEffort }),
};
```

8. 消费 stream，立即 yield text/reasoning，聚合 text。
9. 正常结束时，单次批量追加可选 assistant message、step completed、
   turn completed。
10. 最后 yield completed。

本 Task 暂时只支持恰好一个位于末尾的 `finish(reason !== 'tool-call')`；
协议和错误清理在后续 Task 补齐。

- [x] **Step 6: 运行正常路径测试**

Run:

```bash
pnpm exec vitest run packages/runtime/test/agent-runner.test.ts --config vitest.config.ts
pnpm --filter @weave/runtime typecheck
```

Expected: 正常完成、已有 Session 和 reasoning-only 测试 PASS。

- [x] **Step 7: 提交正常执行路径**

```bash
git add packages/runtime/src/agent-runner.ts packages/runtime/src/index.ts packages/runtime/test/agent-runner.test.ts
git commit -m "feat: 实现 Agent Runner 正常执行"
```

## Task 3: 拒绝非法模型流和工具调用

**Files:**

- Modify: `packages/runtime/src/agent-runner.ts`
- Modify: `packages/runtime/test/agent-runner.test.ts`

**Interfaces:**

- Consumes: Task 2 的 `createAgentRunner()`
- Produces:
  - `agent-stream-protocol`
  - `agent-tool-call-unsupported`
  - 失败的 durable Step/Turn

- [x] **Step 1: 写流协议失败测试**

```ts
it.each([
  ['missing finish', [{ type: 'text-delta', text: 'partial' }] as const],
  [
    'duplicate finish',
    [
      { type: 'finish', reason: 'stop' },
      { type: 'finish', reason: 'stop' },
    ] as const,
  ],
  [
    'event after finish',
    [
      { type: 'finish', reason: 'stop' },
      { type: 'text-delta', text: 'late' },
    ] as const,
  ],
])('rejects %s as an Agent stream protocol error', async (_name, script) => {
  const store = createInMemorySessionEventStore();
  const runner = createAgentRunner({
    llm: recordingClient(script, []),
    sessionStore: store,
  });

  await expect(collect(runner.run(validRequest))).rejects.toMatchObject({
    code: 'agent-stream-protocol',
  });
  const projection = projectSession(await store.read('session-1'));
  expect(projection.messages.map(({ message }) => message)).toEqual([
    validRequest.userMessage,
  ]);
  expect(projection.turns[0]).toMatchObject({
    status: 'failed',
    steps: [{ status: 'failed' }],
  });

  await store.close();
});
```

- [x] **Step 2: 写工具调用失败测试**

```ts
it.each([
  [
    'tool-call-start',
    [
      { type: 'tool-call-start', id: 'call-1', name: 'read_file' },
      { type: 'finish', reason: 'tool-call' },
    ] as const,
  ],
  [
    'tool-call-delta',
    [
      {
        type: 'tool-call-delta',
        id: 'call-1',
        argumentsDelta: '{"path":',
      },
      { type: 'finish', reason: 'tool-call' },
    ] as const,
  ],
  ['tool finish', [{ type: 'finish', reason: 'tool-call' }] as const],
])('rejects %s before a Tool Pipeline exists', async (_name, script) => {
  const store = createInMemorySessionEventStore();
  const runner = createAgentRunner({
    llm: recordingClient(script, []),
    sessionStore: store,
  });

  await expect(collect(runner.run(validRequest))).rejects.toMatchObject({
    code: 'agent-tool-call-unsupported',
  });
  expect(projectSession(await store.read('session-1')).turns[0]).toMatchObject({
    status: 'failed',
    steps: [{ status: 'failed' }],
  });

  await store.close();
});
```

- [x] **Step 3: 写非工具 finish reason 正常完成测试**

```ts
it.each(['stop', 'length', 'content-filter', 'unknown'] as const)(
  'accepts the %s finish reason',
  async (reason) => {
    const store = createInMemorySessionEventStore();
    const runner = createAgentRunner({
      llm: recordingClient([{ type: 'finish', reason }], []),
      sessionStore: store,
    });

    await expect(collect(runner.run(validRequest))).resolves.toEqual([
      { type: 'completed', turnId: expect.any(String) },
    ]);
    expect(projectSession(await store.read('session-1')).turns[0]?.status).toBe(
      'completed',
    );

    await store.close();
  },
);
```

- [x] **Step 4: 运行测试确认 RED**

Run:

```bash
pnpm exec vitest run packages/runtime/test/agent-runner.test.ts --config vitest.config.ts
```

Expected: FAIL，因为当前实现尚未稳定分类所有协议和工具错误。

- [x] **Step 5: 实现 finish 状态机**

在消费模型流时维护 `finishSeen`：

```ts
let finishSeen = false;

for await (const event of llm.stream(llmRequest, { signal })) {
  if (finishSeen) {
    throw new AgentRunError(
      'agent-stream-protocol',
      'The model stream emitted an event after finish',
    );
  }

  if (event.type === 'finish') {
    if (event.reason === 'tool-call') {
      throw new AgentRunError(
        'agent-tool-call-unsupported',
        'Tool calls are not supported by the current Agent Runner',
      );
    }
    finishSeen = true;
    continue;
  }

  if (event.type === 'tool-call-start' || event.type === 'tool-call-delta') {
    throw new AgentRunError(
      'agent-tool-call-unsupported',
      'Tool calls are not supported by the current Agent Runner',
    );
  }

  // text/reasoning handling from Task 2
}

if (!finishSeen) {
  throw new AgentRunError(
    'agent-stream-protocol',
    'The model stream ended without finish',
  );
}
```

发生 Agent 错误后，单次批量追加 failed Step/Turn，不写 assistant message，
然后重新抛出同一个 `AgentRunError`。

- [x] **Step 6: 运行协议测试和 Runtime 检查**

Run:

```bash
pnpm exec vitest run packages/runtime/test/agent-runner.test.ts --config vitest.config.ts
pnpm --filter @weave/runtime lint
pnpm --filter @weave/runtime typecheck
```

Expected: 协议和工具调用测试 PASS，已有正常测试继续 PASS。

- [x] **Step 7: 提交协议边界**

```bash
git add packages/runtime/src/agent-runner.ts packages/runtime/test/agent-runner.test.ts
git commit -m "feat: 增加 Agent 模型流协议校验"
```

## Task 4: 实现模型失败、取消和消费者提前停止

**Files:**

- Modify: `packages/runtime/src/agent-runner.ts`
- Modify: `packages/runtime/test/agent-runner.test.ts`

**Interfaces:**

- Consumes:
  - Request `signal`
  - Provider `LlmError` 或 AbortError
  - Async Iterator `return()`
- Produces:
  - failed 或 cancelled durable Step/Turn
  - `AggregateError([primaryError, persistenceError])`

- [x] **Step 1: 写模型失败测试**

```ts
it('persists failure and rethrows the original model error', async () => {
  const store = createInMemorySessionEventStore();
  const modelError = { code: 'network', message: 'offline', retryable: true };
  const llm: LlmClient = {
    async *stream(): AsyncIterable<StreamEvent> {
      throw modelError;
    },
  };
  const runner = createAgentRunner({ llm, sessionStore: store });

  await expect(collect(runner.run(validRequest))).rejects.toBe(modelError);
  const projection = projectSession(await store.read('session-1'));
  expect(projection.messages.map(({ message }) => message)).toEqual([
    validRequest.userMessage,
  ]);
  expect(projection.turns[0]).toMatchObject({
    status: 'failed',
    steps: [{ status: 'failed' }],
  });

  await store.close();
});
```

- [x] **Step 2: 写 AbortSignal 取消测试**

```ts
it('persists cancellation when the request signal aborts', async () => {
  const store = createInMemorySessionEventStore();
  const controller = new AbortController();
  const llm: LlmClient = {
    async *stream(_request, options): AsyncIterable<StreamEvent> {
      yield { type: 'text-delta', text: 'partial' };
      await new Promise<void>((_resolve, reject) => {
        const rejectAbort = (): void =>
          reject(new DOMException('The operation was aborted', 'AbortError'));
        if (options?.signal?.aborted) {
          rejectAbort();
          return;
        }
        options?.signal?.addEventListener('abort', rejectAbort, { once: true });
      });
    },
  };
  const runner = createAgentRunner({ llm, sessionStore: store });
  const iterator = runner.run({
    ...validRequest,
    signal: controller.signal,
  })[Symbol.asyncIterator]();

  expect((await iterator.next()).value).toEqual({
    type: 'text-delta',
    text: 'partial',
  });
  controller.abort();
  await expect(iterator.next()).rejects.toMatchObject({ name: 'AbortError' });
  expect(projectSession(await store.read('session-1')).turns[0]).toMatchObject({
    status: 'cancelled',
    steps: [{ status: 'cancelled' }],
  });

  await store.close();
});
```

- [x] **Step 3: 写消费者提前停止测试**

```ts
it('cancels the Turn when a consumer stops reading early', async () => {
  const store = createInMemorySessionEventStore();
  let receivedSignal: AbortSignal | undefined;
  const llm: LlmClient = {
    async *stream(_request, options): AsyncIterable<StreamEvent> {
      receivedSignal = options?.signal;
      yield { type: 'text-delta', text: 'first' };
      yield { type: 'text-delta', text: 'second' };
      yield { type: 'finish', reason: 'stop' };
    },
  };
  const runner = createAgentRunner({ llm, sessionStore: store });
  const iterator = runner.run(validRequest)[Symbol.asyncIterator]();

  expect((await iterator.next()).value).toEqual({
    type: 'text-delta',
    text: 'first',
  });
  await iterator.return?.();

  expect(receivedSignal?.aborted).toBe(true);
  expect(projectSession(await store.read('session-1')).turns[0]).toMatchObject({
    status: 'cancelled',
    steps: [{ status: 'cancelled' }],
  });

  await store.close();
});
```

- [x] **Step 4: 写清理持久化失败测试**

```ts
it('preserves the model and terminal persistence errors', async () => {
  const baseStore = createInMemorySessionEventStore();
  const modelError = new Error('model failed');
  const persistenceError = new Error('terminal append failed');
  let appendCount = 0;
  const store: SessionEventStore = {
    read: (sessionId, options) => baseStore.read(sessionId, options),
    close: () => baseStore.close(),
    append: async (sessionId, events) => {
      appendCount += 1;
      if (appendCount === 3) {
        throw persistenceError;
      }
      return baseStore.append(sessionId, events);
    },
  };
  const llm: LlmClient = {
    async *stream(): AsyncIterable<StreamEvent> {
      throw modelError;
    },
  };
  const runner = createAgentRunner({ llm, sessionStore: store });

  const error = await collect(runner.run(validRequest)).catch(
    (caught: unknown) => caught,
  );

  expect(error).toBeInstanceOf(AggregateError);
  expect((error as AggregateError).errors).toEqual([
    modelError,
    persistenceError,
  ]);

  await store.close();
});
```

- [x] **Step 5: 运行测试确认 RED**

Run:

```bash
pnpm exec vitest run packages/runtime/test/agent-runner.test.ts --config vitest.config.ts
```

Expected: FAIL，因为取消分类、内部取消信号、iterator return 清理和聚合错误尚未完整实现。

- [x] **Step 6: 实现统一终态清理**

实现要点：

1. Runner 内部创建 `AbortController`；
2. 外部 signal 存在时使用
   `AbortSignal.any([request.signal, internalController.signal])`；
3. 调用模型前执行 `signal.throwIfAborted()`；
4. 维护：

```ts
let lifecycleStarted = false;
let terminalPersisted = false;
let completed = false;
```

5. 初始化 batch 成功后设置 `lifecycleStarted = true`；
6. 完成 batch 成功后设置 `terminalPersisted = true` 和 `completed = true`；
7. catch 中使用以下规则识别取消：

```ts
function isCancellation(error: unknown, signal: AbortSignal): boolean {
  return (
    signal.aborted ||
    (error instanceof DOMException && error.name === 'AbortError') ||
    (typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'cancelled')
  );
}
```

8. catch 中若生命周期已经开始且终态尚未持久化，批量追加 cancelled 或 failed；
9. 终态 append 失败时抛出：

```ts
throw new AggregateError(
  [primaryError, persistenceError],
  'Agent run and terminal persistence failed',
  { cause: primaryError },
);
```

10. finally 中如果是消费者提前 return，abort 内部 signal，批量追加 cancelled；
11. 无论哪条路径都 abort 内部 controller，释放 Provider 资源；
12. 已经成功完成或 catch 已经持久化终态时，finally 不重复追加。

- [x] **Step 7: 运行 Agent Runner 和 Runtime 全包测试**

Run:

```bash
pnpm exec vitest run packages/runtime/test/agent-runner.test.ts --config vitest.config.ts
pnpm --filter @weave/runtime test
pnpm --filter @weave/runtime lint
pnpm --filter @weave/runtime typecheck
pnpm --filter @weave/runtime build
```

Expected: 所有 Agent Runner 和既有 Runtime 测试 PASS。

- [x] **Step 8: 提交错误和取消语义**

```bash
git add packages/runtime/src/agent-runner.ts packages/runtime/test/agent-runner.test.ts
git commit -m "feat: 完善 Agent 失败和取消语义"
```

## Task 5: 同步架构、学习文档并完成仓库验证

**Files:**

- Modify: `README.md`
- Modify: `docs/architecture/foundation.md`
- Modify: `docs/superpowers/specs/2026-11-15-agent-loop-design.md`
- Modify: `docs/superpowers/plans/2026-11-15-agent-loop.md`
- Create in Feishu: `06 Weave Agent Loop：从 Session 到模型流式输出`
- Update in Feishu: `Weave 全项目计划与前端验收路线`

**Interfaces:**

- Consumes: Tasks 1-4 的实际公共 API 和测试结果
- Produces:
  - 仓库中的可版本化架构说明；
  - 飞书中的学习和面试说明；
  - 完整验证结果。

- [x] **Step 1: 更新 Foundation 执行链路**

在 `docs/architecture/foundation.md` 增加：

```text
Session Projection
  -> Agent Runner
  -> LlmClient.stream()
  -> AgentRuntimeEvent
  -> complete assistant message
  -> SessionEventStore.append()
```

明确：

- Agent Runner 位于 Runtime；
- Runtime Event 不等于 Session Event；
- 当前没有 Tool Pipeline；
- Server 仍然只有 health endpoint；
- HTTP/SSE 将作为后续 Adapter 消费 Agent Runner。

- [x] **Step 2: 更新 README**

增加：

- `createAgentRunner()` 的职责；
- 一段最小调用示例；
- `pnpm exec vitest run packages/runtime/test/agent-runner.test.ts --config vitest.config.ts`；
- 当前不支持工具执行和 HTTP `/run`；
- Agent Loop 设计文档链接。

- [x] **Step 3: 更新设计与计划状态**

将设计文档状态改为：

```text
**状态：** 已实施
```

把本计划中已经完成的 checkbox 逐项更新为 `[x]`，不要一次性提前标记。

- [x] **Step 4: 创建飞书学习文档**

在 Weave 飞书文件夹
`IaaUfCD1klneledtbUycz7bLndh` 创建：

```text
06 Weave Agent Loop：从 Session 到模型流式输出
```

文档至少包含以下完整章节：

1. Agent Loop 解决什么问题；
2. Agent、Session、Turn、Step、Message 的关系；
3. 从 Session Projection 构造 LLM Request；
4. transient StreamEvent 和 durable SessionEvent 的区别；
5. 文本与 reasoning 如何处理；
6. 正常完成的事件顺序；
7. 模型失败、AbortSignal 和用户停止；
8. 为什么当前拒绝工具调用；
9. 未来 Tool Pipeline 插入位置；
10. 前端如何消费 AgentRuntimeEvent；
11. 代码文件对应关系；
12. 测试方法；
13. 面试回答；
14. 自测任务。

- [x] **Step 5: 更新飞书总计划**

在 `Weave 全项目计划与前端验收路线`
（token `KhEZdcTTSoi7fMxjpT4cxviRniT`）追加：

- M2 Headless Agent 的当前进度；
- 当前可以验证单轮模型执行和 Session 恢复；
- 仍然不能验证工具、Workspace 和 Approval；
- 下一阶段是 Tool Pipeline；
- 新增 `06` 学习文档链接。

- [x] **Step 6: 运行完整仓库验证**

Run:

```bash
pnpm check
git diff --check
git status --short --branch
```

Expected:

- format check PASS；
- 5 个 workspace package lint PASS；
- typecheck PASS；
- 所有测试 PASS；
- build PASS；
- `git diff --check` 无输出；
- 工作区只包含本 Task 的文档改动。

- [x] **Step 7: 提交文档同步**

```bash
git add README.md docs/architecture/foundation.md docs/superpowers/specs/2026-11-15-agent-loop-design.md docs/superpowers/plans/2026-11-15-agent-loop.md
git commit -m "docs: 补充 Agent Loop 学习说明"
```

- [x] **Step 8: 准备 PR 前最终审查**

Run:

```bash
git log --oneline origin/main..HEAD
git diff --stat origin/main...HEAD
git status --short --branch
```

Expected:

- 分支仅包含 Agent Loop 设计、实现、测试和文档；
- 没有 Tool Pipeline、HTTP `/run`、前端或无关重构；
- 工作区干净；
- 等待用户明确要求后再 push 和创建 Pull Request。
