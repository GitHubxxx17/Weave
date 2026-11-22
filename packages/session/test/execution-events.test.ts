import { describe, expect, it } from 'vitest';
import {
  agentExecutionInputSchema,
  createInMemorySessionEventStore,
  projectAgentExecutions,
  projectSession,
} from '../src/index.js';

const input = {
  userMessage: { role: 'user', content: [{ type: 'text', text: 'hello' }] },
  provider: 'mock',
  model: 'test',
  permissionMode: 'ask',
} as const;

describe('durable execution facts', () => {
  it('keeps acceptance out of the conversation and resolves its durable terminal prefix', async () => {
    const store = createInMemorySessionEventStore();
    await store.append('session', [
      { type: 'session.created', payload: {} },
      {
        type: 'execution.accepted',
        payload: {
          executionId: 'execution',
          requestId: 'request',
          requestDigest: 'a'.repeat(64),
          turnId: 'turn',
          userMessageId: 'user',
          input,
        },
      },
      {
        type: 'execution.finished',
        payload: { executionId: 'execution', status: 'interrupted', reason: 'server-restarted' },
      },
    ]);
    const events = await store.read('session');
    expect(projectSession(events).messages).toEqual([]);
    expect(projectAgentExecutions(events)).toMatchObject([
      {
        executionId: 'execution',
        requestId: 'request',
        turnId: 'turn',
        userMessageId: 'user',
        input,
        status: 'interrupted',
        durableThroughSequence: 3,
        reason: 'server-restarted',
      },
    ]);
  });

  it('rejects unknown nested fields and non-JSON optional values before hashing or storing', () => {
    expect(agentExecutionInputSchema.safeParse(input).success).toBe(true);
    for (const invalid of [
      { ...input, signal: new AbortController().signal },
      { ...input, temperature: undefined },
      { ...input, maxTokens: Number.NaN },
      { ...input, userMessage: { ...input.userMessage, extra: true } },
      {
        ...input,
        userMessage: {
          ...input.userMessage,
          content: [{ type: 'text', text: 'hello', extra: true }],
        },
      },
    ])
      expect(agentExecutionInputSchema.safeParse(invalid).success).toBe(false);
  });
});
