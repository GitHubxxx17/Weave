import { describe, expect, it } from 'vitest';
import type { AgentRunRequest } from '../src/index.js';
import { AgentRunError, agentRunRequestSchema, agentRuntimeEventSchema } from '../src/index.js';

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

  it('validates transient Agent Runtime Events', () => {
    expect(agentRuntimeEventSchema.parse({ type: 'text-delta', text: '内容' })).toEqual({
      type: 'text-delta',
      text: '内容',
    });
    expect(() => agentRuntimeEventSchema.parse({ type: 'completed', turnId: '' })).toThrow();
  });

  it('exposes stable Agent error codes', () => {
    expect(new AgentRunError('agent-invalid-input', 'Agent Run input is invalid')).toMatchObject({
      name: 'AgentRunError',
      code: 'agent-invalid-input',
    });
  });
});
