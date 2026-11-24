import { describe, expect, it } from 'vitest';
import { createLiveTurnProjector } from '../src/features/agent/live-turn-projector.js';
import type { AgentExecutionSnapshot } from '../src/features/agent/agent-execution-types.js';
import type { AgentRuntimeEvent } from '../src/features/agent/agent-types.js';
import { executionTurnView } from '../src/features/agent/agent-execution-view.js';
const initial: AgentExecutionSnapshot = {
  executionId: 'e',
  requestId: 'r',
  sessionId: 's',
  turnId: 't',
  userMessageId: 'u',
  status: 'running',
  cursor: 'e:r:0',
  createdAt: '2026-11-24T00:00:00.000Z',
  input: {
    provider: 'p',
    model: 'm',
    permissionMode: 'ask',
    userMessage: { role: 'user', content: [{ type: 'text', text: 'q' }] },
  },
  events: [],
};
const owner = {
  sessionId: 's',
  executionId: 'e',
  turnId: 't',
  userMessageId: 'u',
  runId: 'run',
  epoch: 1,
};
describe('live turn projector', () => {
  it('updates only the answer when text changes and keeps unfinished tool status exact', () => {
    const p = createLiveTurnProjector(owner, initial);
    p.append({ type: 'tool-call', toolCall: { id: 'x', name: 'read', arguments: '{}' } });
    const before = p.getProjection();
    expect(before.rowsById.get('t')?.tools[0]?.status).toBe('called');
    p.append({ type: 'text-delta', text: 'a' });
    const after = p.getProjection();
    expect(after.rowsById.get('t')?.text).toBe('a');
    expect(after.rowsById.get('t')?.tools).toBe(before.rowsById.get('t')?.tools);
    expect(after.rowsById.get('u')).toBe(before.rowsById.get('u'));
    expect(after.turnById).toBe(before.turnById);
    expect(p.getProjection()).toBe(after);
  });
  it('reduces 1000 interleaved deltas, tools and usage in arrival order without replay', () => {
    const events: AgentRuntimeEvent[] = [];
    for (let i = 0; i < 1000; i++) {
      events.push(
        { type: 'text-delta', text: String(i % 10) },
        { type: 'reasoning-delta', text: `r${i};` },
      );
      if (i % 20 === 0)
        events.push(
          { type: 'tool-call', toolCall: { id: `c${i}`, name: 'read', arguments: `{"i":${i}}` } },
          {
            type: 'tool-executing',
            toolCall: { id: `c${i}`, name: 'read', arguments: `{"i":${i}}` },
          },
          {
            type: 'tool-result',
            result: { toolCallId: `c${i}`, name: 'read', content: `result${i}`, truncated: false },
            status: i % 40 === 0 ? 'failed' : 'completed',
          },
          { type: 'usage', provider: 'p', model: 'm', usage: { totalTokens: 3 } },
        );
    }
    const p = createLiveTurnProjector(owner, initial);
    for (const event of events) p.append(event);
    const projection = p.getProjection();
    const expected = executionTurnView({ ...initial, events });
    expect(projection.rowsById.get('t')?.text).toBe(
      Array.from({ length: 1000 }, (_, i) => String(i % 10)).join(''),
    );
    expect(projection.rowsById.get('t')?.reasoning).toBe(
      expected.messages[1]?.content
        .filter((x) => x.type === 'reasoning')
        .map((x) => ('text' in x ? x.text : ''))
        .join(''),
    );
    expect(projection.turnById.get('t')).toEqual(expected.turn);
    expect(projection.rowsById.get('t')?.tools).toHaveLength(50);
    expect(projection.rowsById.get('t')?.tools.at(-1)).toMatchObject({
      toolCallId: 'c980',
      status: 'completed',
      result: 'result980',
    });
  });
});
