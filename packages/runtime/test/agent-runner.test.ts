import { describe, expect, it } from 'vitest';
import type { LlmClient } from '@weave/llm';
import type { LlmRequest, StreamEvent } from '@weave/protocol';
import {
  createInMemorySessionEventStore,
  projectSession,
  type NewSessionEvent,
  type SessionEventStore,
} from '@weave/session';
import {
  AgentRunError,
  agentRunRequestSchema,
  agentRuntimeEventSchema,
  createAgentRunner,
  type AgentRunRequest,
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

function recordingClient(script: readonly StreamEvent[], requests: LlmRequest[]): LlmClient {
  return {
    async *stream(request): AsyncIterable<StreamEvent> {
      requests.push(structuredClone(request));
      for (const event of script) {
        yield event;
      }
    },
  };
}

function throwingClient(error: unknown): LlmClient {
  return {
    stream(): AsyncIterable<StreamEvent> {
      return {
        [Symbol.asyncIterator]() {
          return {
            async next(): Promise<IteratorResult<StreamEvent>> {
              throw error;
            },
          };
        },
      };
    },
  };
}

function abortError(): DOMException {
  return new DOMException('The operation was aborted', 'AbortError');
}

interface RecordingStore {
  readonly store: SessionEventStore;
  readonly batches: readonly (readonly NewSessionEvent[])[];
}

function recordingSessionEventStore(options?: {
  readonly failedTerminalError?: unknown;
}): RecordingStore {
  const store = createInMemorySessionEventStore();
  const batches: NewSessionEvent[][] = [];

  return {
    store: {
      async append(sessionId, events) {
        batches.push(structuredClone(events));
        if (
          options?.failedTerminalError !== undefined &&
          events[0]?.type === 'step.completed' &&
          events[0].payload.status === 'failed'
        ) {
          throw options.failedTerminalError;
        }
        return store.append(sessionId, events);
      },
      read: (sessionId, readOptions) => store.read(sessionId, readOptions),
      close: () => store.close(),
    },
    batches,
  };
}

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
    expect(() => agentRunRequestSchema.parse({ ...validRequest, sessionId: '' })).toThrow();
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

  it('rejects empty provider, model, and reasoning effort', () => {
    for (const field of ['provider', 'model', 'reasoningEffort'] as const) {
      expect(() =>
        agentRunRequestSchema.parse({
          ...validRequest,
          [field]: '',
        }),
      ).toThrow();
    }
  });

  it('rejects invalid numeric options and signals', () => {
    for (const value of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() =>
        agentRunRequestSchema.parse({
          ...validRequest,
          temperature: value,
        }),
      ).toThrow();
      expect(() =>
        agentRunRequestSchema.parse({
          ...validRequest,
          maxTokens: value,
        }),
      ).toThrow();
    }

    expect(() =>
      agentRunRequestSchema.parse({
        ...validRequest,
        signal: {},
      }),
    ).toThrow();
  });

  it('validates all transient Agent Runtime Event branches', () => {
    expect(agentRuntimeEventSchema.parse({ type: 'text-delta', text: '内容' })).toEqual({
      type: 'text-delta',
      text: '内容',
    });
    expect(agentRuntimeEventSchema.parse({ type: 'reasoning-delta', text: '推理' })).toEqual({
      type: 'reasoning-delta',
      text: '推理',
    });
    expect(agentRuntimeEventSchema.parse({ type: 'completed', turnId: 'turn-1' })).toEqual({
      type: 'completed',
      turnId: 'turn-1',
    });
    expect(() => agentRuntimeEventSchema.parse({ type: 'completed', turnId: '' })).toThrow();
  });

  it('exposes stable Agent error codes', () => {
    expect(new AgentRunError('agent-invalid-input', 'Agent Run input is invalid')).toMatchObject({
      name: 'AgentRunError',
      code: 'agent-invalid-input',
    });
  });

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

  it('records initialization and completion events in append batches', async () => {
    const recordingStore = recordingSessionEventStore();
    const runner = createAgentRunner({
      llm: recordingClient([{ type: 'finish', reason: 'stop' }], []),
      sessionStore: recordingStore.store,
    });

    await collect(runner.run(validRequest));

    const initializationBatch = recordingStore.batches[1];
    if (
      initializationBatch === undefined ||
      initializationBatch[0]?.type !== 'message.created' ||
      initializationBatch[1]?.type !== 'turn.started' ||
      initializationBatch[2]?.type !== 'step.started'
    ) {
      throw new Error('Expected the initialization append batch');
    }

    expect(recordingStore.batches.map((batch) => batch.map(({ type }) => type))).toEqual([
      ['session.created'],
      ['message.created', 'turn.started', 'step.started'],
      ['step.completed', 'turn.completed'],
    ]);
    expect(initializationBatch).toEqual([
      {
        type: 'message.created',
        payload: {
          messageId: expect.any(String),
          message: validRequest.userMessage,
        },
      },
      {
        type: 'turn.started',
        payload: {
          turnId: initializationBatch[1].payload.turnId,
        },
      },
      {
        type: 'step.started',
        payload: {
          turnId: initializationBatch[1].payload.turnId,
          stepId: initializationBatch[2].payload.stepId,
          kind: 'model',
        },
      },
    ]);

    await recordingStore.store.close();
  });

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
    expect(projection.messages.map(({ message }) => message)).toEqual([validRequest.userMessage]);

    await store.close();
  });

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
    expect(projection.messages.map(({ message }) => message)).toEqual([validRequest.userMessage]);
    expect(projection.turns[0]).toMatchObject({
      status: 'failed',
      steps: [{ status: 'failed' }],
    });

    await store.close();
  });

  it('persists failure and rethrows the original model error', async () => {
    const store = createInMemorySessionEventStore();
    const modelError = { code: 'network', message: 'offline', retryable: true };
    const runner = createAgentRunner({
      llm: throwingClient(modelError),
      sessionStore: store,
    });

    await expect(collect(runner.run(validRequest))).rejects.toBe(modelError);
    const projection = projectSession(await store.read('session-1'));
    expect(projection.messages.map(({ message }) => message)).toEqual([validRequest.userMessage]);
    expect(projection.turns[0]).toMatchObject({
      status: 'failed',
      steps: [{ status: 'failed' }],
    });

    await store.close();
  });

  it('persists cancellation when the request signal aborts', async () => {
    const store = createInMemorySessionEventStore();
    const controller = new AbortController();
    const llm: LlmClient = {
      async *stream(_request, options): AsyncIterable<StreamEvent> {
        yield { type: 'text-delta', text: 'partial' };
        await new Promise<void>((_resolve, reject) => {
          const rejectAbort = (): void => reject(abortError());
          if (options?.signal?.aborted) {
            rejectAbort();
            return;
          }
          options?.signal?.addEventListener('abort', rejectAbort, { once: true });
        });
      },
    };
    const runner = createAgentRunner({ llm, sessionStore: store });
    const stream = runner.run({
      ...validRequest,
      signal: controller.signal,
    });
    const iterator = stream[Symbol.asyncIterator]();

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

  it('preserves the model and terminal persistence errors', async () => {
    const baseStore = createInMemorySessionEventStore();
    const originalError = new AgentRunError(
      'agent-stream-protocol',
      'The LLM raised this exact error',
    );
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
    const runner = createAgentRunner({
      llm: throwingClient(originalError),
      sessionStore: store,
    });

    const error = await collect(runner.run(validRequest)).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toEqual([originalError, persistenceError]);

    await baseStore.close();
  });

  it('preserves failed terminal events as one ordered batch without an assistant message', async () => {
    const recordingStore = recordingSessionEventStore();
    const runner = createAgentRunner({
      llm: recordingClient(
        [
          { type: 'text-delta', text: 'partial' },
          { type: 'finish', reason: 'tool-call' },
        ],
        [],
      ),
      sessionStore: recordingStore.store,
    });

    await expect(collect(runner.run(validRequest))).rejects.toMatchObject({
      code: 'agent-tool-call-unsupported',
    });

    const initializationBatch = recordingStore.batches[1];
    const failedTerminalBatch = recordingStore.batches[2];
    if (
      initializationBatch === undefined ||
      initializationBatch[1]?.type !== 'turn.started' ||
      initializationBatch[2]?.type !== 'step.started' ||
      failedTerminalBatch === undefined ||
      failedTerminalBatch[0]?.type !== 'step.completed' ||
      failedTerminalBatch[1]?.type !== 'turn.completed'
    ) {
      throw new Error('Expected initialization and failed terminal append batches');
    }

    const { turnId } = initializationBatch[1].payload;
    const { stepId } = initializationBatch[2].payload;
    expect(recordingStore.batches.map((batch) => batch.map(({ type }) => type))).toEqual([
      ['session.created'],
      ['message.created', 'turn.started', 'step.started'],
      ['step.completed', 'turn.completed'],
    ]);
    expect(initializationBatch[2]).toEqual({
      type: 'step.started',
      payload: {
        turnId,
        stepId,
        kind: 'model',
      },
    });
    expect(failedTerminalBatch).toEqual([
      {
        type: 'step.completed',
        payload: {
          turnId,
          stepId,
          status: 'failed',
        },
      },
      {
        type: 'turn.completed',
        payload: {
          turnId,
          status: 'failed',
          reason: 'agent-tool-call-unsupported',
        },
      },
    ]);
    expect(failedTerminalBatch).not.toContainEqual(
      expect.objectContaining({ type: 'message.created' }),
    );
    expect(projectSession(await recordingStore.store.read('session-1')).messages).toHaveLength(1);

    await recordingStore.store.close();
  });

  it('prioritizes stream protocol errors for tool events after finish', async () => {
    const store = createInMemorySessionEventStore();
    const runner = createAgentRunner({
      llm: recordingClient(
        [
          { type: 'finish', reason: 'stop' },
          { type: 'tool-call-start', id: 'call-1', name: 'read_file' },
        ],
        [],
      ),
      sessionStore: store,
    });

    await expect(collect(runner.run(validRequest))).rejects.toMatchObject({
      code: 'agent-stream-protocol',
    });

    await store.close();
  });

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
      expect(projectSession(await store.read('session-1')).turns[0]?.status).toBe('completed');

      await store.close();
    },
  );
});
