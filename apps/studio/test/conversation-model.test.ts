import { describe, expect, it } from 'vitest';
import {
  conversationRows,
  getConversationRow,
  projectConversation,
  projectConversationView,
  resolveConversationTarget,
} from '../src/features/conversation/conversation-model.js';
import type { SessionDetail, TurnSummary } from '../src/features/workspace/workspace-types.js';

const at = '2026-11-24T00:00:00.000Z';
function turn(id: string, status: 'completed' | 'failed'): TurnSummary {
  return {
    turnId: id,
    userMessageId: `u-${id}`,
    status,
    startedAt: at,
    request: {
      provider: 'p',
      model: 'm',
      permissionMode: 'ask',
      useProviderDefaults: false,
    },
    modelSteps: [],
    toolResults: [{ toolCallId: 'same', status }],
    toolCalls: 1,
    failedToolCalls: status === 'failed' ? 1 : 0,
  };
}
const detail: SessionDetail = {
  id: 's',
  title: 'session',
  lastSequence: 10,
  turns: [turn('a', 'failed'), turn('b', 'completed')],
  messages: [
    { role: 'user', messageId: 'u-a', turnId: 'a', content: [{ type: 'text', text: 'first' }] },
    {
      role: 'assistant',
      messageId: 'a-1',
      turnId: 'a',
      content: [{ type: 'reasoning', text: 'think' }],
      toolCalls: [{ id: 'same', name: 'read', arguments: '{"path":"a"}' }],
    },
    { role: 'tool', turnId: 'a', toolCallId: 'same', content: [{ type: 'text', text: 'denied' }] },
    {
      role: 'assistant',
      messageId: 'a-2',
      turnId: 'a',
      content: [{ type: 'text', text: 'failed answer' }],
    },
    { role: 'user', messageId: 'u-b', turnId: 'b', content: [{ type: 'text', text: 'second' }] },
    {
      role: 'assistant',
      messageId: 'b-1',
      turnId: 'b',
      content: [{ type: 'text', text: 'done' }],
      toolCalls: [{ id: 'same', name: 'read', arguments: '{"path":"b"}' }],
    },
    {
      role: 'tool',
      turnId: 'b',
      toolCallId: 'same',
      content: [{ type: 'text', text: 'new result' }],
    },
    {
      role: 'assistant',
      messageId: 'legacy',
      content: [],
      toolCalls: [{ id: 'same', name: 'read', arguments: '{}' }],
    },
  ],
};

describe('conversation projection', () => {
  it('merges steps once, preserves every alias and joins reused tools only inside their Turn', () => {
    const snapshot = projectConversation(detail);
    expect(snapshot.rowIds).toEqual(['u-a', 'a', 'u-b', 'b', 'legacy']);
    expect(getConversationRow(snapshot, 'a')).toMatchObject({
      text: 'failed answer',
      reasoning: 'think',
      durableMessageIds: ['a-1', 'a-2'],
      tools: [{ result: 'denied', status: 'failed' }],
    });
    expect(getConversationRow(snapshot, 'b')?.tools[0]).toMatchObject({
      result: 'new result',
      status: 'completed',
    });
    expect(getConversationRow(snapshot, 'legacy')?.tools[0]).toEqual({
      toolCallId: 'same',
      name: 'read',
      arguments: '{}',
      status: 'called',
    });
    expect(
      resolveConversationTarget(snapshot, {
        kind: 'durable-message',
        sessionId: 's',
        turnId: 'a',
        messageId: 'a-2',
      })?.rowId,
    ).toBe('a');
    expect(
      resolveConversationTarget(snapshot, {
        kind: 'tool',
        sessionId: 'other',
        turnId: 'a',
        toolCallId: 'same',
      }),
    ).toBeUndefined();
    expect(snapshot.retryByTurn.get('a')).toMatchObject({
      sessionId: 's',
      provider: 'p',
      skills: [],
      userMessage: { role: 'user', content: [{ type: 'text', text: 'first' }] },
    });
  });
  it('reuses unchanged rows and preserves captured view extras on durable refresh', () => {
    const first = projectConversation(detail);
    const user = getConversationRow(first, 'u-a')!;
    const submission = {
      sessionId: 's',
      provider: 'captured',
      model: 'exact',
      skills: [],
      userMessage: user.originalUserMessage!,
    };
    const view = projectConversationView({
      sessionId: 's',
      detailKnown: true,
      messages: conversationRows(first).map((row) =>
        row.id === user.id ? { ...row, submission, selectedSkills: [] } : row,
      ),
      turns: detail.turns,
      durableSequence: 10,
    });
    const refreshed = projectConversation(
      {
        ...detail,
        lastSequence: 11,
        messages: detail.messages.map((message) =>
          message.messageId === 'b-1'
            ? { ...message, content: [{ type: 'text', text: 'changed' }] }
            : message,
        ),
      },
      view,
    );
    expect(getConversationRow(refreshed, 'a')).toBe(getConversationRow(view, 'a'));
    expect(getConversationRow(refreshed, 'u-a')).toBe(getConversationRow(view, 'u-a'));
    expect(refreshed.retryByTurn.get('a')).toBe(submission);
    expect(getConversationRow(refreshed, 'b')?.text).toBe('changed');
  });
});
