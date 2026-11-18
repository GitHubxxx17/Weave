import { describe, expect, it, vi } from 'vitest';
import { createLlmProviderRegistry, type LlmClient } from '@weave/llm';
import type { LlmRequest, StreamEvent } from '@weave/protocol';
import { z } from 'zod';
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
  createToolPipeline,
  createToolRegistry,
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

/** Drops the transient `context` events so assertions can target other events. */
function withoutContext(events: readonly AgentRuntimeEvent[]): AgentRuntimeEvent[] {
  return events.filter((event) => event.type !== 'context');
}

/** Asserts the next streamed event is the pre-stream `context` breakdown. */
async function expectContextEvent(iterator: AsyncIterator<AgentRuntimeEvent>): Promise<void> {
  await expect(iterator.next()).resolves.toMatchObject({
    done: false,
    value: { type: 'context' },
  });
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

function sequenceClient(
  scripts: readonly (readonly StreamEvent[])[],
  requests: LlmRequest[],
): LlmClient {
  let index = 0;
  return {
    async *stream(request): AsyncIterable<StreamEvent> {
      requests.push(structuredClone(request));
      const script = scripts[index++];
      if (script === undefined) {
        throw new Error(`Unexpected model request ${index}`);
      }
      yield* script;
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

function recordingSessionEventStore(): RecordingStore {
  const store = createInMemorySessionEventStore();
  const batches: NewSessionEvent[][] = [];

  return {
    store: {
      async append(sessionId, events) {
        batches.push(structuredClone(events));
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
    expect(
      agentRuntimeEventSchema.parse({
        type: 'tool-call',
        toolCall: { id: 'call-1', name: 'echo', arguments: '{}' },
      }),
    ).toEqual({
      type: 'tool-call',
      toolCall: { id: 'call-1', name: 'echo', arguments: '{}' },
    });
    expect(
      agentRuntimeEventSchema.parse({
        type: 'tool-executing',
        toolCall: { id: 'call-1', name: 'echo', arguments: '{}' },
      }),
    ).toMatchObject({ type: 'tool-executing' });
    expect(
      agentRuntimeEventSchema.parse({
        type: 'tool-result',
        result: {
          toolCallId: 'call-1',
          name: 'echo',
          content: 'ok',
          truncated: false,
        },
      }),
    ).toMatchObject({ type: 'tool-result' });
    expect(() => agentRuntimeEventSchema.parse({ type: 'completed', turnId: '' })).toThrow();
  });

  it('requires a registry and pipeline together for a tool-enabled runner', () => {
    const registry = createToolRegistry();
    const pipeline = createToolPipeline({ registry });

    expect(() =>
      createAgentRunner({
        llm: recordingClient([], []),
        sessionStore: createInMemorySessionEventStore(),
        toolRegistry: registry,
      }),
    ).toThrowError(/toolRegistry and toolPipeline must be provided together/);
    expect(() =>
      createAgentRunner({
        llm: recordingClient([], []),
        sessionStore: createInMemorySessionEventStore(),
        toolPipeline: pipeline,
      }),
    ).toThrowError(/toolRegistry and toolPipeline must be provided together/);
  });

  it('sends per-run instructions as a leading system message without persisting them', async () => {
    const store = createInMemorySessionEventStore();
    const requests: LlmRequest[] = [];
    const seen: string[] = [];
    const runner = createAgentRunner({
      llm: recordingClient(
        [
          { type: 'text-delta', text: '好的' },
          { type: 'finish', reason: 'stop' },
        ],
        requests,
      ),
      sessionStore: store,
      instructions: ({ sessionId }) => {
        seen.push(sessionId);
        return '你是 Weave Agent。';
      },
    });

    await collect(runner.run(validRequest));

    expect(seen).toEqual(['session-1']);
    expect(requests[0]?.messages[0]).toEqual({
      role: 'system',
      content: [{ type: 'text', text: '你是 Weave Agent。' }],
    });
    expect(requests[0]?.messages[1]).toMatchObject({ role: 'user' });
    const projection = projectSession(await store.read(validRequest.sessionId));
    expect(projection.messages.map(({ message }) => message.role)).toEqual(['user', 'assistant']);

    await store.close();
  });

  it('omits the system message when instructions are empty', async () => {
    const store = createInMemorySessionEventStore();
    const requests: LlmRequest[] = [];
    const runner = createAgentRunner({
      llm: recordingClient([{ type: 'finish', reason: 'stop' }], requests),
      sessionStore: store,
      instructions: () => undefined,
    });

    await collect(runner.run(validRequest));

    expect(requests[0]?.messages.map((message) => message.role)).toEqual(['user']);
    await store.close();
  });

  it('persists usage on each model step and emits it as a live event', async () => {
    const store = createInMemorySessionEventStore();
    const registry = createToolRegistry();
    registry.register({
      name: 'echo',
      description: 'echo',
      parameters: { type: 'object', properties: {} },
      inputSchema: z.object({}),
      execute: () => 'ok',
    });
    const requests: LlmRequest[] = [];
    const runner = createAgentRunner({
      llm: sequenceClient(
        [
          [
            { type: 'tool-call-start', id: 'call-1', name: 'echo' },
            { type: 'tool-call-delta', id: 'call-1', argumentsDelta: '{}' },
            {
              type: 'finish',
              reason: 'tool-call',
              usage: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 0 },
            },
          ],
          [
            { type: 'text-delta', text: '完成' },
            {
              type: 'finish',
              reason: 'stop',
              usage: { inputTokens: 130, outputTokens: 5, cacheReadTokens: 100 },
            },
          ],
        ],
        requests,
      ),
      sessionStore: store,
      toolRegistry: registry,
      toolPipeline: createToolPipeline({ registry }),
    });

    const events = await collect(runner.run(validRequest));

    expect(events.filter((event) => event.type === 'usage')).toEqual([
      {
        type: 'usage',
        usage: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 0 },
        provider: 'mock',
        model: 'test-model',
      },
      {
        type: 'usage',
        usage: { inputTokens: 130, outputTokens: 5, cacheReadTokens: 100 },
        provider: 'mock',
        model: 'test-model',
      },
    ]);
    const projection = projectSession(await store.read(validRequest.sessionId));
    expect(projection.turns[0]?.steps).toMatchObject([
      { kind: 'model', model: 'test-model', usage: { inputTokens: 100, cacheReadTokens: 0 } },
      { kind: 'tool' },
      { kind: 'model', model: 'test-model', usage: { inputTokens: 130, cacheReadTokens: 100 } },
    ]);
    expect(projection.turns[0]?.steps[1]?.usage).toBeUndefined();

    await store.close();
  });

  it('retries a model step that fails before emitting output, then succeeds', async () => {
    const store = createInMemorySessionEventStore();
    let attempts = 0;
    const llm: LlmClient = {
      async *stream(): AsyncIterable<StreamEvent> {
        attempts += 1;
        if (attempts < 3) {
          throw { code: 'rate-limit', message: 'slow down', retryable: true };
        }
        yield { type: 'text-delta', text: '终于成功' };
        yield { type: 'finish', reason: 'stop' };
      },
    };
    const runner = createAgentRunner({ llm, sessionStore: store });

    const events = await collect(runner.run(validRequest));

    expect(attempts).toBe(3);
    expect(events.at(-1)).toMatchObject({ type: 'completed' });
    const projection = projectSession(await store.read(validRequest.sessionId));
    expect(projection.messages.at(-1)?.message).toMatchObject({
      role: 'assistant',
      content: [{ type: 'text', text: '终于成功' }],
    });

    await store.close();
  });

  it('does not retry once a delta has reached the consumer', async () => {
    const store = createInMemorySessionEventStore();
    let attempts = 0;
    const llm: LlmClient = {
      async *stream(): AsyncIterable<StreamEvent> {
        attempts += 1;
        yield { type: 'text-delta', text: '已经发出的内容' };
        throw { code: 'network', message: 'dropped mid-stream', retryable: true };
      },
    };
    const runner = createAgentRunner({ llm, sessionStore: store });

    await expect(collect(runner.run(validRequest))).rejects.toMatchObject({ code: 'network' });
    expect(attempts).toBe(1);

    await store.close();
  });

  it('gives up after the retry limit on a persistent retryable error', async () => {
    const store = createInMemorySessionEventStore();
    let attempts = 0;
    const llm: LlmClient = {
      // eslint-disable-next-line require-yield
      async *stream(): AsyncIterable<StreamEvent> {
        attempts += 1;
        throw { code: 'rate-limit', message: 'always limited', retryable: true };
      },
    };
    const runner = createAgentRunner({ llm, sessionStore: store });

    await expect(collect(runner.run(validRequest))).rejects.toMatchObject({ code: 'rate-limit' });
    expect(attempts).toBe(3);

    await store.close();
  });

  it('routes each Agent request to the Provider selected by id', async () => {
    const requests: LlmRequest[] = [];
    const registry = createLlmProviderRegistry([
      {
        id: 'alpha',
        label: 'Alpha',
        type: 'mock',
        client: recordingClient(
          [
            { type: 'text-delta', text: '甲' },
            { type: 'finish', reason: 'stop' },
          ],
          requests,
        ),
      },
      {
        id: 'beta',
        label: 'Beta',
        type: 'mock',
        client: recordingClient(
          [
            { type: 'text-delta', text: '乙' },
            { type: 'finish', reason: 'stop' },
          ],
          requests,
        ),
      },
    ]);
    const runner = createAgentRunner({
      llmRegistry: registry,
      sessionStore: createInMemorySessionEventStore(),
    });

    const alphaEvents = await collect(
      runner.run({
        ...validRequest,
        sessionId: 'session-alpha',
        provider: 'alpha',
      }),
    );
    const betaEvents = await collect(
      runner.run({
        ...validRequest,
        sessionId: 'session-beta',
        provider: 'beta',
      }),
    );

    expect(alphaEvents).toContainEqual({ type: 'text-delta', text: '甲' });
    expect(betaEvents).toContainEqual({ type: 'text-delta', text: '乙' });
    expect(requests.map((request) => request.provider)).toEqual(['alpha', 'beta']);
  });

  it('rejects an Agent request when its Provider is unavailable', async () => {
    const store = createInMemorySessionEventStore();
    const runner = createAgentRunner({
      llmRegistry: createLlmProviderRegistry(),
      sessionStore: store,
    });

    await expect(
      collect(
        runner.run({
          ...validRequest,
          provider: 'missing',
        }),
      ),
    ).rejects.toMatchObject({
      code: 'agent-provider-unavailable',
    });
    await expect(store.read(validRequest.sessionId)).resolves.toEqual([]);
  });

  it('rejects an invalid maximum step count', () => {
    expect(() =>
      createAgentRunner({
        llm: recordingClient([], []),
        sessionStore: createInMemorySessionEventStore(),
        maxSteps: 0,
      }),
    ).toThrowError(/maxSteps must be a positive integer/);
  });

  it('executes a tool call through the pipeline and continues the model loop', async () => {
    const recording = recordingSessionEventStore();
    const requests: LlmRequest[] = [];
    const registry = createToolRegistry();
    let executions = 0;
    registry.register({
      name: 'echo',
      description: 'Returns the input value',
      parameters: {
        type: 'object',
        properties: { value: { type: 'string' } },
        required: ['value'],
      },
      inputSchema: z.object({ value: z.string() }),
      execute: ({ value }) => {
        executions += 1;
        return value;
      },
    });
    const runner = createAgentRunner({
      llm: sequenceClient(
        [
          [
            { type: 'tool-call-start', id: 'call-1', name: 'echo' },
            { type: 'tool-call-delta', id: 'call-1', argumentsDelta: '{"value":"x"}' },
            { type: 'finish', reason: 'tool-call' },
          ],
          [
            { type: 'text-delta', text: '工具结果是 x' },
            { type: 'finish', reason: 'stop' },
          ],
        ],
        requests,
      ),
      sessionStore: recording.store,
      toolRegistry: registry,
      toolPipeline: createToolPipeline({ registry }),
    });

    const events = await collect(runner.run(validRequest));
    expect(withoutContext(events).map((event) => event.type)).toEqual([
      'tool-call',
      'tool-executing',
      'tool-result',
      'text-delta',
      'completed',
    ]);
    expect(executions).toBe(1);
    expect(requests).toHaveLength(2);
    expect(requests[0]?.tools).toEqual([
      expect.objectContaining({
        name: 'echo',
        description: 'Returns the input value',
      }),
    ]);
    expect(requests[1]?.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: 'assistant',
          toolCalls: [{ id: 'call-1', name: 'echo', arguments: '{"value":"x"}' }],
        }),
        {
          role: 'tool',
          toolCallId: 'call-1',
          content: [{ type: 'text', text: 'x' }],
        },
      ]),
    );

    const projection = projectSession(await recording.store.read(validRequest.sessionId));
    expect(projection.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message: expect.objectContaining({
            role: 'assistant',
            toolCalls: [{ id: 'call-1', name: 'echo', arguments: '{"value":"x"}' }],
          }),
        }),
        expect.objectContaining({
          message: {
            role: 'tool',
            toolCallId: 'call-1',
            content: [{ type: 'text', text: 'x' }],
          },
        }),
      ]),
    );
    expect(projection.turns[0]?.toolCalls).toHaveLength(1);
    expect(projection.turns[0]?.toolResults).toMatchObject([
      {
        toolCallId: 'call-1',
        name: 'echo',
        content: 'x',
        status: 'completed',
      },
    ]);
  });

  it('returns a recoverable tool failure to the model and continues the turn', async () => {
    const store = createInMemorySessionEventStore();
    const registry = createToolRegistry();
    registry.register({
      name: 'fail',
      description: 'Always fails',
      parameters: { type: 'object', properties: {} },
      inputSchema: z.object({}),
      execute: () => {
        throw new Error('permission denied');
      },
    });
    const requests: LlmRequest[] = [];
    const llm = sequenceClient(
      [
        [
          { type: 'tool-call-start', id: 'call-1', name: 'fail' },
          { type: 'tool-call-delta', id: 'call-1', argumentsDelta: '{}' },
          { type: 'finish', reason: 'tool-call' },
        ],
        [
          { type: 'text-delta', text: '工具失败了' },
          { type: 'finish', reason: 'stop' },
        ],
      ],
      requests,
    );
    const runner = createAgentRunner({
      llm,
      sessionStore: store,
      toolRegistry: registry,
      toolPipeline: createToolPipeline({ registry }),
    });

    const events = await collect(runner.run(validRequest));

    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'tool-result',
        status: 'failed',
        errorCode: 'tool-execution-failed',
      }),
    );
    expect(events.at(-1)).toMatchObject({ type: 'completed' });

    const projection = projectSession(await store.read(validRequest.sessionId));
    expect(projection.turns[0]).toMatchObject({
      status: 'completed',
      steps: [
        { kind: 'model', status: 'completed' },
        { kind: 'tool', status: 'failed' },
        { kind: 'model', status: 'completed' },
      ],
      toolResults: [
        {
          toolCallId: 'call-1',
          status: 'failed',
          errorCode: 'tool-execution-failed',
        },
      ],
    });
    const toolMessage = projection.messages.find(({ message }) => message.role === 'tool');
    expect(toolMessage?.message.content[0]).toMatchObject({
      type: 'text',
      text: 'Tool "fail" failed (tool-execution-failed). Tool "fail" failed',
    });
    expect(requests[1]?.messages.at(-1)).toMatchObject({ role: 'tool', toolCallId: 'call-1' });

    await store.close();
  });

  it('still ends the turn when the tool pipeline is misconfigured', async () => {
    const store = createInMemorySessionEventStore();
    const registry = createToolRegistry();
    registry.register({
      name: 'protected',
      description: 'Needs approval',
      parameters: { type: 'object', properties: {} },
      inputSchema: z.object({}),
      approval: {
        operation: 'test.protected',
        risk: 'high',
        summarize: () => ({ summary: 'protected', inputSummary: {} }),
      },
      execute: () => 'never',
    });
    const runner = createAgentRunner({
      llm: recordingClient(
        [
          { type: 'tool-call-start', id: 'call-1', name: 'protected' },
          { type: 'tool-call-delta', id: 'call-1', argumentsDelta: '{}' },
          { type: 'finish', reason: 'tool-call' },
        ],
        [],
      ),
      sessionStore: store,
      toolRegistry: registry,
      toolPipeline: createToolPipeline({ registry }),
    });

    await expect(collect(runner.run(validRequest))).rejects.toMatchObject({
      code: 'tool-approval-required',
    });

    const projection = projectSession(await store.read(validRequest.sessionId));
    expect(projection.turns[0]).toMatchObject({
      status: 'failed',
      steps: [
        { kind: 'model', status: 'completed' },
        { kind: 'tool', status: 'failed' },
      ],
      toolResults: [
        { toolCallId: 'call-1', status: 'failed', errorCode: 'tool-approval-required' },
      ],
    });

    await store.close();
  });

  it('persists a cancelled tool step and turn when the request aborts during execution', async () => {
    const store = createInMemorySessionEventStore();
    const registry = createToolRegistry();
    let executionStarted: (() => void) | undefined;
    const executionStartedPromise = new Promise<void>((resolve) => {
      executionStarted = resolve;
    });
    registry.register({
      name: 'wait',
      description: 'Waits until cancellation',
      parameters: { type: 'object', properties: {} },
      inputSchema: z.object({}),
      execute: async (_input, { signal }) => {
        executionStarted?.();
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(abortError()), { once: true });
        });
      },
    });
    const controller = new AbortController();
    const runner = createAgentRunner({
      llm: recordingClient(
        [
          { type: 'tool-call-start', id: 'call-1', name: 'wait' },
          { type: 'tool-call-delta', id: 'call-1', argumentsDelta: '{}' },
          { type: 'finish', reason: 'tool-call' },
        ],
        [],
      ),
      sessionStore: store,
      toolRegistry: registry,
      toolPipeline: createToolPipeline({ registry }),
    });

    const run = collect(runner.run({ ...validRequest, signal: controller.signal }));
    await executionStartedPromise;
    controller.abort();

    await expect(run).rejects.toMatchObject({ code: 'tool-cancelled' });
    expect(projectSession(await store.read(validRequest.sessionId)).turns[0]).toMatchObject({
      status: 'cancelled',
      steps: [
        { kind: 'model', status: 'completed' },
        { kind: 'tool', status: 'cancelled' },
      ],
      toolResults: [
        {
          toolCallId: 'call-1',
          status: 'failed',
          errorCode: 'tool-cancelled',
        },
      ],
    });

    await store.close();
  });

  it('fails the turn at the model step limit without duplicating completed tool steps', async () => {
    const store = createInMemorySessionEventStore();
    const requests: LlmRequest[] = [];
    const registry = createToolRegistry();
    registry.register({
      name: 'echo',
      description: 'Returns the input value',
      parameters: {
        type: 'object',
        properties: { value: { type: 'string' } },
        required: ['value'],
      },
      inputSchema: z.object({ value: z.string() }),
      execute: ({ value }) => value,
    });
    const runner = createAgentRunner({
      llm: sequenceClient(
        [
          [
            { type: 'tool-call-start', id: 'call-1', name: 'echo' },
            { type: 'tool-call-delta', id: 'call-1', argumentsDelta: '{"value":"x"}' },
            { type: 'finish', reason: 'tool-call' },
          ],
        ],
        requests,
      ),
      sessionStore: store,
      toolRegistry: registry,
      toolPipeline: createToolPipeline({ registry }),
      maxSteps: 1,
    });

    await expect(collect(runner.run(validRequest))).rejects.toMatchObject({
      code: 'agent-step-limit',
    });

    const projection = projectSession(await store.read(validRequest.sessionId));
    expect(requests).toHaveLength(1);
    expect(projection.turns[0]).toMatchObject({
      status: 'failed',
      steps: [
        { kind: 'model', status: 'completed' },
        { kind: 'tool', status: 'completed' },
      ],
    });
    expect(projection.turns[0]?.steps).toHaveLength(2);

    await store.close();
  });

  it('executes multiple tool calls in model order before the next model step', async () => {
    const store = createInMemorySessionEventStore();
    const executions: string[] = [];
    const requests: LlmRequest[] = [];
    const registry = createToolRegistry();
    registry.register({
      name: 'echo',
      description: 'Returns the input value',
      parameters: {
        type: 'object',
        properties: { value: { type: 'string' } },
        required: ['value'],
      },
      inputSchema: z.object({ value: z.string() }),
      execute: ({ value }) => {
        executions.push(`echo:${value}`);
        return value;
      },
    });
    registry.register({
      name: 'upper',
      description: 'Uppercases the input value',
      parameters: {
        type: 'object',
        properties: { value: { type: 'string' } },
        required: ['value'],
      },
      inputSchema: z.object({ value: z.string() }),
      execute: ({ value }) => {
        executions.push(`upper:${value}`);
        return value.toUpperCase();
      },
    });
    const runner = createAgentRunner({
      llm: sequenceClient(
        [
          [
            { type: 'tool-call-start', id: 'call-1', name: 'echo' },
            { type: 'tool-call-delta', id: 'call-1', argumentsDelta: '{"value":"x"}' },
            { type: 'tool-call-start', id: 'call-2', name: 'upper' },
            { type: 'tool-call-delta', id: 'call-2', argumentsDelta: '{"value":"y"}' },
            { type: 'finish', reason: 'tool-call' },
          ],
          [
            { type: 'text-delta', text: '完成' },
            { type: 'finish', reason: 'stop' },
          ],
        ],
        requests,
      ),
      sessionStore: store,
      toolRegistry: registry,
      toolPipeline: createToolPipeline({ registry }),
    });

    const events = await collect(runner.run(validRequest));

    expect(executions).toEqual(['echo:x', 'upper:y']);
    expect(withoutContext(events).map((event) => event.type)).toEqual([
      'tool-call',
      'tool-executing',
      'tool-result',
      'tool-call',
      'tool-executing',
      'tool-result',
      'text-delta',
      'completed',
    ]);
    expect(requests[1]?.messages).toEqual(
      expect.arrayContaining([
        {
          role: 'tool',
          toolCallId: 'call-1',
          content: [{ type: 'text', text: 'x' }],
        },
        {
          role: 'tool',
          toolCallId: 'call-2',
          content: [{ type: 'text', text: 'Y' }],
        },
      ]),
    );

    const projection = projectSession(await store.read(validRequest.sessionId));
    expect(projection.turns[0]?.toolCalls.map(({ toolCall }) => toolCall.id)).toEqual([
      'call-1',
      'call-2',
    ]);
    expect(projection.turns[0]?.toolResults.map(({ toolCallId }) => toolCallId)).toEqual([
      'call-1',
      'call-2',
    ]);

    await store.close();
  });

  it('rejects duplicate tool-call starts in a tool-enabled model stream', async () => {
    const store = createInMemorySessionEventStore();
    const registry = createToolRegistry();
    registry.register({
      name: 'echo',
      description: 'Returns the input value',
      parameters: { type: 'object', properties: {} },
      inputSchema: z.object({}),
      execute: () => 'ok',
    });
    const runner = createAgentRunner({
      llm: recordingClient(
        [
          { type: 'tool-call-start', id: 'call-1', name: 'echo' },
          { type: 'tool-call-start', id: 'call-1', name: 'echo' },
        ],
        [],
      ),
      sessionStore: store,
      toolRegistry: registry,
      toolPipeline: createToolPipeline({ registry }),
    });

    await expect(collect(runner.run(validRequest))).rejects.toMatchObject({
      code: 'agent-tool-call-invalid',
    });

    await store.close();
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

    expect(withoutContext(runtimeEvents)).toEqual([
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
        content: [
          { type: 'reasoning', text: '内部推理' },
          { type: 'text', text: '分析完成' },
        ],
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
          provider: 'mock',
          model: 'test-model',
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

  it('persists reasoning content so a Session can restore the process view', async () => {
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

    expect(withoutContext(await collect(runner.run(validRequest)))).toEqual([
      { type: 'reasoning-delta', text: '只进行推理' },
      { type: 'completed', turnId: expect.any(String) },
    ]);
    const projection = projectSession(await store.read('session-1'));
    expect(projection.messages.map(({ message }) => message)).toEqual([
      validRequest.userMessage,
      {
        role: 'assistant',
        content: [{ type: 'reasoning', text: '只进行推理' }],
      },
    ]);

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

    await expectContextEvent(iterator);
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
        // Stay in-flight until the consumer stops reading and the run aborts.
        await new Promise<void>((_resolve, reject) => {
          options?.signal?.addEventListener('abort', () => reject(abortError()), { once: true });
        });
      },
    };
    const runner = createAgentRunner({ llm, sessionStore: store });
    const iterator = runner.run(validRequest)[Symbol.asyncIterator]();

    await expectContextEvent(iterator);
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

  it('closes after execution finishes with a queued completion event', async () => {
    const recordingStore = recordingSessionEventStore();
    const runner = createAgentRunner({
      llm: recordingClient(
        [
          { type: 'text-delta', text: '完成' },
          { type: 'finish', reason: 'stop' },
        ],
        [],
      ),
      sessionStore: recordingStore.store,
    });
    const iterator = runner.run(validRequest)[Symbol.asyncIterator]();

    await expectContextEvent(iterator);
    await expect(iterator.next()).resolves.toEqual({
      done: false,
      value: { type: 'text-delta', text: '完成' },
    });
    await vi.waitFor(async () => {
      expect(projectSession(await recordingStore.store.read('session-1')).turns[0]).toMatchObject({
        status: 'completed',
        steps: [{ status: 'completed' }],
      });
    });

    await expect(iterator.return?.()).resolves.toEqual({ done: true, value: undefined });
    await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined });
    expect(recordingStore.batches.map((batch) => batch.map(({ type }) => type))).toEqual([
      ['session.created'],
      ['message.created', 'turn.started', 'step.started'],
      ['message.created', 'step.completed', 'turn.completed'],
    ]);

    await recordingStore.store.close();
  });

  it('does not start execution when next follows return before iteration starts', async () => {
    const store = createInMemorySessionEventStore();
    let streamCalled = false;
    const runner = createAgentRunner({
      llm: {
        async *stream(): AsyncIterable<StreamEvent> {
          streamCalled = true;
          yield { type: 'finish', reason: 'stop' };
        },
      },
      sessionStore: store,
    });
    const iterator = runner.run(validRequest)[Symbol.asyncIterator]();

    await expect(iterator.return?.()).resolves.toEqual({ done: true, value: undefined });
    await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined });

    expect(streamCalled).toBe(false);
    expect(await store.read('session-1')).toEqual([]);
    await store.close();
  });

  it('aborts the provider immediately when return interrupts an in-flight operation', async () => {
    const store = createInMemorySessionEventStore();
    let receivedSignal: AbortSignal | undefined;
    let rejectPendingNext: ((error: unknown) => void) | undefined;
    const llm: LlmClient = {
      stream(_request, options): AsyncIterable<StreamEvent> {
        receivedSignal = options?.signal;
        let nextCount = 0;
        return {
          [Symbol.asyncIterator]() {
            return {
              async next(): Promise<IteratorResult<StreamEvent>> {
                nextCount += 1;
                if (nextCount === 1) {
                  return { done: false, value: { type: 'text-delta', text: 'first' } };
                }
                await new Promise<void>((_resolve, reject) => {
                  rejectPendingNext = reject;
                  options?.signal?.addEventListener('abort', () => reject(abortError()), {
                    once: true,
                  });
                });
                return { done: true, value: undefined };
              },
            };
          },
        };
      },
    };
    const runner = createAgentRunner({ llm, sessionStore: store });
    const iterator = runner.run(validRequest)[Symbol.asyncIterator]();

    await expectContextEvent(iterator);
    await expect(iterator.next()).resolves.toEqual({
      done: false,
      value: { type: 'text-delta', text: 'first' },
    });
    const pendingNext = iterator.next();
    await new Promise<void>((resolve) => queueMicrotask(resolve));

    let returnResolved = false;
    const returnPromise = iterator.return?.().then((result) => {
      returnResolved = true;
      return result;
    });
    expect(receivedSignal?.aborted).toBe(true);
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    expect(returnResolved).toBe(false);
    rejectPendingNext?.(abortError());
    await expect(pendingNext).resolves.toMatchObject({ done: true });
    await expect(returnPromise).resolves.toMatchObject({ done: true });
    expect(projectSession(await store.read('session-1')).turns[0]).toMatchObject({
      status: 'cancelled',
      steps: [{ status: 'cancelled' }],
    });

    await store.close();
  });

  it('waits for initialization cleanup when return races the initial append', async () => {
    const baseStore = createInMemorySessionEventStore();
    let releaseInitialization: (() => void) | undefined;
    let initializationStarted: (() => void) | undefined;
    const initializationReady = new Promise<void>((resolve) => {
      initializationStarted = resolve;
    });
    const initializationRelease = new Promise<void>((resolve) => {
      releaseInitialization = resolve;
    });
    let appendCount = 0;
    const store: SessionEventStore = {
      read: (sessionId, options) => baseStore.read(sessionId, options),
      close: () => baseStore.close(),
      append: async (sessionId, events) => {
        appendCount += 1;
        if (appendCount === 2) {
          initializationStarted?.();
          await initializationRelease;
        }
        return baseStore.append(sessionId, events);
      },
    };
    const runner = createAgentRunner({
      llm: {
        async *stream(): AsyncIterable<StreamEvent> {
          yield { type: 'finish', reason: 'stop' };
        },
      },
      sessionStore: store,
    });
    const iterator = runner.run(validRequest)[Symbol.asyncIterator]();
    const firstNext = iterator.next();
    await initializationReady;

    let returnResolved = false;
    const returnPromise = iterator.return?.().then((result) => {
      returnResolved = true;
      return result;
    });
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    expect(returnResolved).toBe(false);
    releaseInitialization?.();
    await expect(returnPromise).resolves.toMatchObject({ done: true });
    await expect(firstNext).resolves.toMatchObject({ done: true });
    expect(projectSession(await baseStore.read('session-1')).turns[0]).toMatchObject({
      status: 'cancelled',
      steps: [{ status: 'cancelled' }],
    });

    await baseStore.close();
  });

  it('aborts internal resources when cancelled terminal persistence fails', async () => {
    const baseStore = createInMemorySessionEventStore();
    const persistenceError = new Error('cancelled terminal append failed');
    let receivedSignal: AbortSignal | undefined;
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
      async *stream(_request, options): AsyncIterable<StreamEvent> {
        receivedSignal = options?.signal;
        yield { type: 'text-delta', text: 'partial' };
        await new Promise<void>((_resolve, reject) => {
          options?.signal?.addEventListener('abort', () => reject(abortError()), { once: true });
        });
      },
    };
    const runner = createAgentRunner({ llm, sessionStore: store });
    const iterator = runner.run(validRequest)[Symbol.asyncIterator]();

    await expectContextEvent(iterator);
    await expect(iterator.next()).resolves.toMatchObject({
      value: { type: 'text-delta', text: 'partial' },
    });
    const error = await iterator.return?.().catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors[1]).toBe(persistenceError);
    expect(receivedSignal?.aborted).toBe(true);

    await baseStore.close();
  });

  it('persists failure when the post-initialization Session read fails', async () => {
    const baseStore = createInMemorySessionEventStore();
    const readError = new Error('post-initialization read failed');
    let readCount = 0;
    const store: SessionEventStore = {
      append: (sessionId, events) => baseStore.append(sessionId, events),
      close: () => baseStore.close(),
      read: async (sessionId, options) => {
        readCount += 1;
        if (readCount === 3) {
          throw readError;
        }
        return baseStore.read(sessionId, options);
      },
    };
    const runner = createAgentRunner({
      llm: recordingClient([{ type: 'finish', reason: 'stop' }], []),
      sessionStore: store,
    });

    await expect(collect(runner.run(validRequest))).rejects.toBe(readError);
    expect(projectSession(await baseStore.read('session-1')).turns[0]).toMatchObject({
      status: 'failed',
      steps: [{ status: 'failed' }],
    });

    await baseStore.close();
  });

  it('preserves undefined as the primary provider error', async () => {
    const baseStore = createInMemorySessionEventStore();
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
      llm: throwingClient(undefined),
      sessionStore: store,
    });

    const error = await collect(runner.run(validRequest)).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toEqual([undefined, persistenceError]);

    await baseStore.close();
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

  it('retries a failed completion append as a failed terminal state', async () => {
    const baseStore = createInMemorySessionEventStore();
    const completionPersistenceError = new Error('completion append failed');
    let appendCount = 0;
    const store: SessionEventStore = {
      read: (sessionId, options) => baseStore.read(sessionId, options),
      close: () => baseStore.close(),
      append: async (sessionId, events) => {
        appendCount += 1;
        if (appendCount === 3) {
          throw completionPersistenceError;
        }
        return baseStore.append(sessionId, events);
      },
    };
    const runner = createAgentRunner({
      llm: recordingClient([{ type: 'finish', reason: 'stop' }], []),
      sessionStore: store,
    });

    await expect(collect(runner.run(validRequest))).rejects.toBe(completionPersistenceError);
    expect(appendCount).toBe(4);
    expect(projectSession(await baseStore.read('session-1')).turns[0]).toMatchObject({
      status: 'failed',
      steps: [{ status: 'failed' }],
    });

    await baseStore.close();
  });

  it('aggregates completion and failed-terminal persistence errors', async () => {
    const baseStore = createInMemorySessionEventStore();
    const completionPersistenceError = new Error('completion append failed');
    const failedTerminalPersistenceError = new Error('failed terminal append failed');
    let appendCount = 0;
    const store: SessionEventStore = {
      read: (sessionId, options) => baseStore.read(sessionId, options),
      close: () => baseStore.close(),
      append: async (sessionId, events) => {
        appendCount += 1;
        if (appendCount === 3) {
          throw completionPersistenceError;
        }
        if (appendCount === 4) {
          throw failedTerminalPersistenceError;
        }
        return baseStore.append(sessionId, events);
      },
    };
    const runner = createAgentRunner({
      llm: recordingClient([{ type: 'finish', reason: 'stop' }], []),
      sessionStore: store,
    });

    const error = await collect(runner.run(validRequest)).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toEqual([
      completionPersistenceError,
      failedTerminalPersistenceError,
    ]);
    expect((error as AggregateError).cause).toBe(completionPersistenceError);
    expect(appendCount).toBe(4);
    expect(projectSession(await baseStore.read('session-1')).turns[0]).toMatchObject({
      status: 'running',
      steps: [{ status: 'running' }],
    });

    await baseStore.close();
  });

  it('propagates a terminal failure when return races completion persistence', async () => {
    const baseStore = createInMemorySessionEventStore();
    const completionPersistenceError = new Error('completion append failed');
    const failedTerminalPersistenceError = new Error('failed terminal append failed');
    let appendCount = 0;
    let completionAppendStarted: (() => void) | undefined;
    const completionAppendReady = new Promise<void>((resolve) => {
      completionAppendStarted = resolve;
    });
    let releaseCompletionAppend: (() => void) | undefined;
    const completionAppendRelease = new Promise<void>((resolve) => {
      releaseCompletionAppend = resolve;
    });
    const store: SessionEventStore = {
      read: (sessionId, options) => baseStore.read(sessionId, options),
      close: () => baseStore.close(),
      append: async (sessionId, events) => {
        appendCount += 1;
        if (appendCount === 3) {
          completionAppendStarted?.();
          await completionAppendRelease;
          throw completionPersistenceError;
        }
        if (appendCount === 4) {
          throw failedTerminalPersistenceError;
        }
        return baseStore.append(sessionId, events);
      },
    };
    const runner = createAgentRunner({
      llm: recordingClient([{ type: 'finish', reason: 'stop' }], []),
      sessionStore: store,
    });
    const iterator = runner.run(validRequest)[Symbol.asyncIterator]();
    await expectContextEvent(iterator);
    const pendingNext = iterator.next();
    await completionAppendReady;

    const returnPromise = iterator.return?.();
    releaseCompletionAppend?.();

    await expect(pendingNext).resolves.toMatchObject({ done: true });
    await expect(returnPromise).rejects.toEqual(
      expect.objectContaining({
        errors: [completionPersistenceError, failedTerminalPersistenceError],
      }),
    );
    expect(projectSession(await baseStore.read('session-1')).turns[0]).toMatchObject({
      status: 'running',
      steps: [{ status: 'running' }],
    });

    await baseStore.close();
  });

  it('returns the original completion persistence error after a successful failed-terminal retry', async () => {
    const baseStore = createInMemorySessionEventStore();
    const completionPersistenceError = new Error('completion append failed');
    let appendCount = 0;
    let completionAppendStarted: (() => void) | undefined;
    const completionAppendReady = new Promise<void>((resolve) => {
      completionAppendStarted = resolve;
    });
    let releaseCompletionAppend: (() => void) | undefined;
    const completionAppendRelease = new Promise<void>((resolve) => {
      releaseCompletionAppend = resolve;
    });
    const store: SessionEventStore = {
      read: (sessionId, options) => baseStore.read(sessionId, options),
      close: () => baseStore.close(),
      append: async (sessionId, events) => {
        appendCount += 1;
        if (appendCount === 3) {
          completionAppendStarted?.();
          await completionAppendRelease;
          throw completionPersistenceError;
        }
        return baseStore.append(sessionId, events);
      },
    };
    const runner = createAgentRunner({
      llm: recordingClient(
        [
          { type: 'text-delta', text: 'first' },
          { type: 'text-delta', text: 'queued' },
          { type: 'finish', reason: 'stop' },
        ],
        [],
      ),
      sessionStore: store,
    });
    const iterator = runner.run(validRequest)[Symbol.asyncIterator]();

    await expectContextEvent(iterator);
    await expect(iterator.next()).resolves.toEqual({
      done: false,
      value: { type: 'text-delta', text: 'first' },
    });
    await completionAppendReady;
    const returnPromise = iterator.return?.();
    releaseCompletionAppend?.();

    await expect(returnPromise).rejects.toBe(completionPersistenceError);
    await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined });
    expect(appendCount).toBe(4);
    expect(projectSession(await baseStore.read('session-1')).turns[0]).toMatchObject({
      status: 'failed',
      steps: [{ status: 'failed' }],
    });
    const terminalEvents = (await baseStore.read('session-1')).filter(
      ({ type }) => type === 'step.completed' || type === 'turn.completed',
    );
    expect(terminalEvents).toHaveLength(2);
    expect(terminalEvents).toEqual([
      expect.objectContaining({ type: 'step.completed' }),
      expect.objectContaining({ type: 'turn.completed' }),
    ]);

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
        provider: 'mock',
        model: 'test-model',
      },
    });
    expect(failedTerminalBatch).toEqual([
      {
        type: 'step.completed',
        payload: {
          turnId,
          stepId,
          status: 'failed',
          context: expect.any(Object),
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

  it('serializes concurrent empty-Session runs within one Runner', async () => {
    const baseStore = createInMemorySessionEventStore();
    let readCount = 0;
    let releaseFirstRead: (() => void) | undefined;
    let firstReadStarted: (() => void) | undefined;
    const firstReadStartedPromise = new Promise<void>((resolve) => {
      firstReadStarted = resolve;
    });
    const firstReadRelease = new Promise<void>((resolve) => {
      releaseFirstRead = resolve;
    });
    const store: SessionEventStore = {
      append: (sessionId, events) => baseStore.append(sessionId, events),
      close: () => baseStore.close(),
      read: async (sessionId, options) => {
        readCount += 1;
        if (readCount === 1) {
          firstReadStarted?.();
          await firstReadRelease;
        }
        return baseStore.read(sessionId, options);
      },
    };
    const requests: LlmRequest[] = [];
    let releaseFirst: (() => void) | undefined;
    let firstStarted: (() => void) | undefined;
    const firstStartedPromise = new Promise<void>((resolve) => {
      firstStarted = resolve;
    });
    const firstRelease = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const runner = createAgentRunner({
      llm: {
        async *stream(request): AsyncIterable<StreamEvent> {
          requests.push(structuredClone(request));
          if (requests.length === 1) {
            firstStarted?.();
            await firstRelease;
          }
          yield { type: 'finish', reason: 'stop' };
        },
      },
      sessionStore: store,
    });

    const firstRun = collect(
      runner.run({
        ...validRequest,
        userMessage: {
          role: 'user',
          content: [{ type: 'text', text: '第一条消息' }],
        },
      }),
    );
    await firstReadStartedPromise;
    const secondRun = collect(
      runner.run({
        ...validRequest,
        userMessage: {
          role: 'user',
          content: [{ type: 'text', text: '第二条消息' }],
        },
      }),
    );
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    expect(readCount).toBe(1);
    expect(requests).toHaveLength(0);

    releaseFirstRead?.();
    await firstStartedPromise;
    expect(requests).toHaveLength(1);
    releaseFirst?.();
    await expect(Promise.all([firstRun, secondRun])).resolves.toHaveLength(2);

    const events = await baseStore.read('session-1');
    expect(events.filter(({ type }) => type === 'session.created')).toHaveLength(1);
    expect(requests.map(({ messages }) => messages)).toEqual([
      [
        {
          role: 'user',
          content: [{ type: 'text', text: '第一条消息' }],
        },
      ],
      [
        {
          role: 'user',
          content: [{ type: 'text', text: '第一条消息' }],
        },
        {
          role: 'user',
          content: [{ type: 'text', text: '第二条消息' }],
        },
      ],
    ]);

    await baseStore.close();
  });

  it('serializes concurrent existing-Session runs without cross-request messages', async () => {
    const baseStore = createInMemorySessionEventStore();
    await baseStore.append('session-1', [
      { type: 'session.created', payload: { title: 'Existing' } },
      {
        type: 'message.created',
        payload: {
          messageId: 'existing-message',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: '已有上下文' }],
          },
        },
      },
    ]);
    let readCount = 0;
    let releaseFirstRead: (() => void) | undefined;
    let firstReadStarted: (() => void) | undefined;
    const firstReadStartedPromise = new Promise<void>((resolve) => {
      firstReadStarted = resolve;
    });
    const firstReadRelease = new Promise<void>((resolve) => {
      releaseFirstRead = resolve;
    });
    const store: SessionEventStore = {
      append: (sessionId, events) => baseStore.append(sessionId, events),
      close: () => baseStore.close(),
      read: async (sessionId, options) => {
        readCount += 1;
        if (readCount === 1) {
          firstReadStarted?.();
          await firstReadRelease;
        }
        return baseStore.read(sessionId, options);
      },
    };
    const requests: LlmRequest[] = [];
    let releaseFirst: (() => void) | undefined;
    let firstStarted: (() => void) | undefined;
    const firstStartedPromise = new Promise<void>((resolve) => {
      firstStarted = resolve;
    });
    const firstRelease = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const runner = createAgentRunner({
      llm: {
        async *stream(request): AsyncIterable<StreamEvent> {
          requests.push(structuredClone(request));
          if (requests.length === 1) {
            firstStarted?.();
            await firstRelease;
          }
          yield { type: 'finish', reason: 'stop' };
        },
      },
      sessionStore: store,
    });

    const firstRun = collect(
      runner.run({
        ...validRequest,
        userMessage: {
          role: 'user',
          content: [{ type: 'text', text: '已有会话第一条' }],
        },
      }),
    );
    await firstReadStartedPromise;
    const secondRun = collect(
      runner.run({
        ...validRequest,
        userMessage: {
          role: 'user',
          content: [{ type: 'text', text: '已有会话第二条' }],
        },
      }),
    );
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    expect(readCount).toBe(1);
    expect(requests).toHaveLength(0);

    releaseFirstRead?.();
    await firstStartedPromise;
    expect(requests).toHaveLength(1);
    releaseFirst?.();
    await expect(Promise.all([firstRun, secondRun])).resolves.toHaveLength(2);

    const events = await baseStore.read('session-1');
    expect(events.filter(({ type }) => type === 'session.created')).toHaveLength(1);
    expect(requests.map(({ messages }) => messages)).toEqual([
      [
        {
          role: 'assistant',
          content: [{ type: 'text', text: '已有上下文' }],
        },
        {
          role: 'user',
          content: [{ type: 'text', text: '已有会话第一条' }],
        },
      ],
      [
        {
          role: 'assistant',
          content: [{ type: 'text', text: '已有上下文' }],
        },
        {
          role: 'user',
          content: [{ type: 'text', text: '已有会话第一条' }],
        },
        {
          role: 'user',
          content: [{ type: 'text', text: '已有会话第二条' }],
        },
      ],
    ]);

    await baseStore.close();
  });

  it('cancels a run waiting in the Session queue without invoking the model', async () => {
    const store = createInMemorySessionEventStore();
    let releaseFirst: (() => void) | undefined;
    let firstStarted: (() => void) | undefined;
    const firstStartedPromise = new Promise<void>((resolve) => {
      firstStarted = resolve;
    });
    const firstRelease = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let streamCalls = 0;
    const runner = createAgentRunner({
      llm: {
        async *stream(): AsyncIterable<StreamEvent> {
          streamCalls += 1;
          if (streamCalls === 1) {
            firstStarted?.();
            await firstRelease;
          }
          yield { type: 'finish', reason: 'stop' };
        },
      },
      sessionStore: store,
    });
    const firstRun = collect(runner.run(validRequest));
    await firstStartedPromise;

    const queuedStream = runner.run({
      ...validRequest,
      userMessage: {
        role: 'user',
        content: [{ type: 'text', text: '不应执行' }],
      },
    });
    const queuedIterator = queuedStream[Symbol.asyncIterator]();
    const queuedNext = queuedIterator.next();
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    expect(streamCalls).toBe(1);

    const queuedReturn = queuedIterator.return?.();
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    releaseFirst?.();

    await expect(firstRun).resolves.toEqual([
      { type: 'context', breakdown: expect.any(Object), provider: 'mock', model: 'test-model' },
      { type: 'completed', turnId: expect.any(String) },
    ]);
    await expect(queuedNext).resolves.toMatchObject({ done: true });
    await expect(queuedReturn).resolves.toEqual({ done: true, value: undefined });
    expect(streamCalls).toBe(1);
    expect(
      (await store.read('session-1')).filter(
        ({ type, payload }) =>
          type === 'message.created' &&
          payload.message.role === 'user' &&
          payload.message.content[0]?.type === 'text' &&
          payload.message.content[0].text === '不应执行',
      ),
    ).toHaveLength(0);

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

      await expect(collect(runner.run(validRequest)).then(withoutContext)).resolves.toEqual([
        { type: 'completed', turnId: expect.any(String) },
      ]);
      expect(projectSession(await store.read('session-1')).turns[0]?.status).toBe('completed');

      await store.close();
    },
  );
});

describe('Agent Runner context management', () => {
  it('emits a context event before the model stream with a well-formed breakdown', async () => {
    const store = createInMemorySessionEventStore();
    const runner = createAgentRunner({
      llm: recordingClient(
        [
          { type: 'text-delta', text: '好的' },
          { type: 'finish', reason: 'stop' },
        ],
        [],
      ),
      sessionStore: store,
    });

    const events = await collect(runner.run(validRequest));
    const first = events[0];
    expect(first?.type).toBe('context');
    if (first?.type !== 'context') {
      throw new Error('Expected a context event first');
    }
    expect(first.provider).toBe('mock');
    expect(first.breakdown.windowTokens).toBe(128_000);
    expect(first.breakdown.sentTokens).toBeGreaterThan(0);
    expect(first.breakdown.ratio).toBeGreaterThanOrEqual(0);
    expect(first.breakdown.ratio).toBeLessThanOrEqual(1);
    expect(first.breakdown.categories.userMessages).toBeGreaterThan(0);

    await store.close();
  });

  it('persists the context breakdown on the completed model step', async () => {
    const store = createInMemorySessionEventStore();
    const runner = createAgentRunner({
      llm: recordingClient([{ type: 'finish', reason: 'stop' }], []),
      sessionStore: store,
    });

    await collect(runner.run(validRequest));
    const step = projectSession(await store.read('session-1')).turns[0]?.steps[0];
    expect(step?.context).toBeDefined();
    expect(step?.context?.windowTokens).toBe(128_000);
    expect(step?.context?.categories.userMessages).toBeGreaterThan(0);

    await store.close();
  });

  it('reads the context window from the Provider descriptor', async () => {
    const store = createInMemorySessionEventStore();
    const registry = createLlmProviderRegistry();
    registry.register({
      id: 'mock',
      label: '本地演示',
      type: 'mock',
      client: recordingClient([{ type: 'finish', reason: 'stop' }], []),
      contextWindowTokens: 50_000,
    });
    const runner = createAgentRunner({ llmRegistry: registry, sessionStore: store });

    const events = await collect(runner.run(validRequest));
    const context = events.find((event) => event.type === 'context');
    expect(context?.type).toBe('context');
    if (context?.type !== 'context') {
      throw new Error('Expected a context event');
    }
    expect(context.breakdown.windowTokens).toBe(50_000);

    await store.close();
  });

  it('fails with agent-context-overflow when the window cannot fit the turn', async () => {
    const store = createInMemorySessionEventStore();
    const runner = createAgentRunner({
      llm: recordingClient([{ type: 'finish', reason: 'stop' }], []),
      sessionStore: store,
      context: { defaultWindowTokens: 1 },
    });
    const iterator = runner.run(validRequest)[Symbol.asyncIterator]();

    await expect(iterator.next()).resolves.toMatchObject({
      done: false,
      value: { type: 'context', breakdown: { trimmed: expect.any(Boolean) } },
    });
    await expect(iterator.next()).rejects.toMatchObject({ code: 'agent-context-overflow' });
    expect(projectSession(await store.read('session-1')).turns[0]).toMatchObject({
      status: 'failed',
      steps: [{ status: 'failed' }],
    });

    await store.close();
  });

  it('maps a provider context-overflow error to agent-context-overflow', async () => {
    const store = createInMemorySessionEventStore();
    const runner = createAgentRunner({
      llm: throwingClient({ code: 'context-overflow', message: 'too long', retryable: false }),
      sessionStore: store,
    });

    await expect(collect(runner.run(validRequest))).rejects.toMatchObject({
      code: 'agent-context-overflow',
    });
    expect(projectSession(await store.read('session-1')).turns[0]).toMatchObject({
      status: 'failed',
      steps: [{ status: 'failed' }],
    });

    await store.close();
  });
});
