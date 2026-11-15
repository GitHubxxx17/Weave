import { describe, expect, it } from 'vitest';
import type { LlmClient } from '@weave/llm';
import type { LlmRequest, StreamEvent } from '@weave/protocol';
import { createInMemorySessionEventStore, projectSession } from '@weave/session';
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
});
