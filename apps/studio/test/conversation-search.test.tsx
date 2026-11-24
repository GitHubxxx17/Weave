// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { projectConversationView } from '../src/features/conversation/conversation-model.js';
import {
  ConversationSearch,
  findConversationHits,
} from '../src/features/conversation/conversation-search.js';
import { conversationTranscript } from '../src/features/conversation/conversation-transcript.js';

afterEach(cleanup);
const snapshot = projectConversationView({
  sessionId: 'session',
  detailKnown: true,
  turns: [],
  messages: Array.from({ length: 100 }, (_, index) => ({
    id: `row-${index}`,
    turnId: `turn-${index}`,
    role: 'assistant' as const,
    text: `message ${index}`,
    reasoning: index === 49 ? 'secret reasoning https://example.test/full?q=1' : '',
    tools:
      index === 99
        ? [
            {
              toolCallId: 'tool',
              name: 'read_file',
              arguments: '{"path":"far-sentinel.ts"}',
              result: 'exact complete result',
              status: 'completed' as const,
            },
          ]
        : [],
    occurredAt: '2026-11-24T00:00:00Z',
  })),
});

describe('full logical conversation search', () => {
  it('finds distant reasoning, tool arguments and results outside a mounted window', () => {
    expect(findConversationHits(snapshot, 'secret reasoning').map((hit) => hit.rowId)).toEqual([
      'row-49',
    ]);
    expect(findConversationHits(snapshot, 'far-sentinel.ts').map((hit) => hit.rowId)).toEqual([
      'row-99',
    ]);
    expect(findConversationHits(snapshot, 'complete result').map((hit) => hit.rowId)).toEqual([
      'row-99',
    ]);
  });
  it('reveals the exact owner of a result and keeps logical ordinal in its button', () => {
    const reveal = vi.fn();
    render(<ConversationSearch snapshot={snapshot} onReveal={reveal} />);
    fireEvent.change(screen.getByRole('searchbox', { name: '查找会话内容' }), {
      target: { value: 'far-sentinel.ts' },
    });
    fireEvent.click(screen.getByRole('button', { name: /第 100 条/ }));
    expect(reveal).toHaveBeenCalledWith({
      kind: 'tool',
      sessionId: 'session',
      turnId: 'turn-99',
      toolCallId: 'tool',
    });
  });
  it('includes all logical text, reasoning, arguments, results and original URL in transcript', () => {
    const transcript = conversationTranscript(snapshot);
    expect(transcript).toContain('message 0');
    expect(transcript).toContain('message 99');
    expect(transcript).toContain('https://example.test/full?q=1');
    expect(transcript).toContain('{"path":"far-sentinel.ts"}');
    expect(transcript).toContain('exact complete result');
  });
});
