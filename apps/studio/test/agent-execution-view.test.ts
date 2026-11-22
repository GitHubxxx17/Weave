import { describe, expect, it } from 'vitest';
import {
  appendExecutionEvent,
  executionTurnView,
  replaceExecutionTurn,
} from '../src/features/agent/agent-execution-view.js';
import type { AgentExecutionSnapshot } from '../src/features/agent/agent-execution-types.js';

const snapshot: AgentExecutionSnapshot = {
  executionId: 'e',
  requestId: 'r',
  sessionId: 's',
  turnId: 't',
  userMessageId: 'u',
  status: 'running',
  cursor: 'epoch:e:4',
  createdAt: '2026-11-23T00:00:00.000Z',
  input: {
    provider: 'p',
    model: 'm',
    permissionMode: 'ask',
    userMessage: { role: 'user', content: [{ type: 'text', text: 'question' }] },
  },
  events: [
    { type: 'reasoning-delta', text: 'think' },
    { type: 'text-delta', text: 'whole answer' },
    { type: 'tool-call', toolCall: { id: 'call', name: 'read', arguments: '{}' } },
    { type: 'tool-executing', toolCall: { id: 'call', name: 'read', arguments: '{}' } },
    {
      type: 'tool-result',
      result: { toolCallId: 'call', name: 'read', content: 'result', truncated: false },
    },
    { type: 'usage', provider: 'p', model: 'm', usage: { totalTokens: 5 } },
    { type: 'usage', provider: 'p', model: 'm', usage: { totalTokens: 7 } },
  ],
};
describe('exact execution Turn view', () => {
  it('replaces the whole owned Turn including user row while preserving unrelated history', () => {
    const detail = {
      id: 's',
      title: 'session',
      lastSequence: 10,
      messages: [
        {
          role: 'user' as const,
          messageId: 'old',
          turnId: 'previous',
          content: [{ type: 'text' as const, text: 'older' }],
        },
        {
          role: 'user' as const,
          messageId: 'u',
          turnId: 't',
          content: [{ type: 'text' as const, text: 'question' }],
        },
        {
          role: 'assistant' as const,
          turnId: 't',
          content: [{ type: 'text' as const, text: 'whole ' }],
        },
      ],
      turns: [],
    };
    const replaced = replaceExecutionTurn(detail, snapshot);
    expect(
      replaced.messages
        .filter((message) => message.role === 'user')
        .map((message) => message.messageId),
    ).toEqual(['old', 'u']);
    expect(
      replaced.messages
        .filter((message) => message.role === 'assistant')
        .map((message) => message.content),
    ).toEqual([
      [
        { type: 'text', text: 'whole answer' },
        { type: 'reasoning', text: 'think' },
      ],
    ]);
    expect(replaced.turns[0]).toMatchObject({
      turnId: 't',
      userMessageId: 'u',
      usage: { totalTokens: 12 },
      toolCalls: 1,
    });
  });
  it('replacement snapshots rebuild from their own events rather than appending previous partial text', () => {
    const first = executionTurnView(snapshot);
    const next = executionTurnView({
      ...snapshot,
      events: [{ type: 'text-delta', text: 'resynced' }],
    });
    expect(first.messages[1]?.content[0]).toEqual({ type: 'text', text: 'whole answer' });
    expect(next.messages[1]?.content).toEqual([{ type: 'text', text: 'resynced' }]);
    expect(next.turn.toolCalls).toBe(0);
  });
  it('coalesces adjacent live deltas without mutating a previously rendered snapshot', () => {
    const previous = { ...snapshot, events: [{ type: 'text-delta' as const, text: 'a' }] };
    const next = appendExecutionEvent(previous, { type: 'text-delta', text: 'b' });
    expect(next.events).toEqual([{ type: 'text-delta', text: 'ab' }]);
    expect(previous.events).toEqual([{ type: 'text-delta', text: 'a' }]);
  });
});
