import { describe, expect, it } from 'vitest';
import {
  projectSession,
  type SessionEvent,
  type SessionProjection,
  type SessionEventType,
} from '../src/index.js';

function event<T extends SessionEventType>(
  sequence: number,
  type: T,
  payload: Extract<SessionEvent, { type: T }>['payload'],
  sessionId = 'session-1',
): SessionEvent {
  return {
    eventId: `event-${sequence}`,
    sessionId,
    sequence,
    occurredAt: `2026-11-15T00:00:${String(sequence).padStart(2, '0')}.000Z`,
    type,
    payload,
  } as SessionEvent;
}

function completeEvents(): readonly SessionEvent[] {
  return [
    event(1, 'session.created', { title: 'Demo' }),
    event(2, 'message.created', {
      messageId: 'message-1',
      message: {
        role: 'user',
        content: [{ type: 'text', text: '开始' }],
      },
    }),
    event(3, 'turn.started', { turnId: 'turn-1' }),
    event(4, 'step.started', { turnId: 'turn-1', stepId: 'step-1', kind: 'model' }),
    event(5, 'step.completed', {
      turnId: 'turn-1',
      stepId: 'step-1',
      status: 'completed',
    }),
    event(6, 'turn.completed', { turnId: 'turn-1', status: 'completed' }),
  ];
}

describe('Session Projection', () => {
  it('projects a session with messages, turns, and steps', () => {
    const state = projectSession(completeEvents());

    expect(state).toMatchObject({
      sessionId: 'session-1',
      title: 'Demo',
      lastSequence: 6,
    });
    expect(state.messages).toHaveLength(1);
    expect(state.turns[0]).toMatchObject({
      turnId: 'turn-1',
      status: 'completed',
    });
    expect(state.turns[0]?.steps[0]).toMatchObject({
      stepId: 'step-1',
      kind: 'model',
      status: 'completed',
    });
  });

  it('projects durable tool calls and tool results onto a Turn', () => {
    const state = projectSession([
      event(1, 'session.created', {}),
      event(2, 'turn.started', { turnId: 'turn-1' }),
      event(3, 'step.started', { turnId: 'turn-1', stepId: 'model-1', kind: 'model' }),
      event(4, 'message.created', {
        messageId: 'assistant-1',
        message: {
          role: 'assistant',
          content: [],
          toolCalls: [{ id: 'call-1', name: 'echo', arguments: '{"value":"x"}' }],
        },
      }),
      event(5, 'step.completed', {
        turnId: 'turn-1',
        stepId: 'model-1',
        status: 'completed',
      }),
      event(6, 'step.started', { turnId: 'turn-1', stepId: 'tool-1', kind: 'tool' }),
      event(7, 'tool-call.created', {
        turnId: 'turn-1',
        stepId: 'tool-1',
        toolCall: { id: 'call-1', name: 'echo', arguments: '{"value":"x"}' },
      }),
      event(8, 'tool-result.created', {
        turnId: 'turn-1',
        stepId: 'tool-1',
        toolCallId: 'call-1',
        name: 'echo',
        content: 'x',
        truncated: false,
        status: 'completed',
      }),
      event(9, 'message.created', {
        messageId: 'tool-message-1',
        message: {
          role: 'tool',
          toolCallId: 'call-1',
          content: [{ type: 'text', text: 'x' }],
        },
      }),
      event(10, 'step.completed', {
        turnId: 'turn-1',
        stepId: 'tool-1',
        status: 'completed',
      }),
    ]);

    expect(state.turns[0]).toMatchObject({
      toolCalls: [
        {
          stepId: 'tool-1',
          toolCall: { id: 'call-1', name: 'echo' },
        },
      ],
      toolResults: [
        {
          stepId: 'tool-1',
          toolCallId: 'call-1',
          content: 'x',
          status: 'completed',
        },
      ],
    });
  });

  it('projects Session title and lifecycle timestamps', () => {
    const state = projectSession([
      event(1, 'session.created', { title: '初始标题' }),
      event(2, 'session.renamed', { title: '新标题' }),
      event(3, 'session.archived', {}),
      event(4, 'session.restored', {}),
      event(5, 'session.archived', {}),
      event(6, 'session.deleted', {}),
    ]);

    expect(state).toMatchObject({
      title: '新标题',
      archivedAt: '2026-11-15T00:00:05.000Z',
      deletedAt: '2026-11-15T00:00:06.000Z',
      lastSequence: 6,
    });
  });

  it('rejects invalid Session lifecycle transitions', () => {
    const invalidCases: readonly SessionEvent[][] = [
      [event(1, 'session.created', {}), event(2, 'session.restored', {})],
      [
        event(1, 'session.created', {}),
        event(2, 'session.archived', {}),
        event(3, 'session.archived', {}),
      ],
      [
        event(1, 'session.created', {}),
        event(2, 'session.deleted', {}),
        event(3, 'session.restored', {}),
      ],
      [
        event(1, 'session.created', {}),
        event(2, 'session.archived', {}),
        event(3, 'turn.started', { turnId: 'turn-1' }),
      ],
      [
        event(1, 'session.created', {}),
        event(2, 'session.deleted', {}),
        event(3, 'session.renamed', { title: '删除后修改' }),
      ],
    ];

    for (const events of invalidCases) {
      expect(() => projectSession(events)).toThrowError(
        expect.objectContaining({ code: 'session-projection-invalid-order' }),
      );
    }
  });

  it('rejects tool events that reference unknown turns or steps', () => {
    expect(() =>
      projectSession([
        event(1, 'session.created', {}),
        event(2, 'tool-call.created', {
          turnId: 'missing-turn',
          stepId: 'missing-step',
          toolCall: { id: 'call-1', name: 'echo', arguments: '{}' },
        }),
      ]),
    ).toThrow();
  });

  it('rejects invalid event ordering and references', () => {
    const cases: readonly [string, readonly SessionEvent[]][] = [
      ['missing session.created', completeEvents().slice(1)],
      [
        'first sequence is not one',
        completeEvents().map((currentEvent) => ({
          ...currentEvent,
          sequence: currentEvent.sequence + 1,
        })),
      ],
      ['duplicate session.created', [completeEvents()[0]!, completeEvents()[0]!]],
      [
        'missing turn reference',
        [
          event(1, 'session.created', { title: 'Demo' }),
          event(2, 'turn.completed', { turnId: 'turn-1', status: 'completed' }),
        ],
      ],
      [
        'missing step reference',
        [
          event(1, 'session.created', { title: 'Demo' }),
          event(2, 'turn.started', { turnId: 'turn-1' }),
          event(3, 'step.completed', {
            turnId: 'turn-1',
            stepId: 'step-1',
            status: 'completed',
          }),
        ],
      ],
    ];

    for (const [name, events] of cases) {
      expect(() => projectSession(events), name).toThrow();
    }
  });

  it('rejects duplicate turn and step identifiers', () => {
    expect(() =>
      projectSession([
        event(1, 'session.created', { title: 'Demo' }),
        event(2, 'turn.started', { turnId: 'turn-1' }),
        event(3, 'turn.started', { turnId: 'turn-1' }),
      ]),
    ).toThrow();

    expect(() =>
      projectSession([
        event(1, 'session.created', { title: 'Demo' }),
        event(2, 'turn.started', { turnId: 'turn-1' }),
        event(3, 'step.started', { turnId: 'turn-1', stepId: 'step-1', kind: 'model' }),
        event(4, 'step.started', { turnId: 'turn-1', stepId: 'step-1', kind: 'tool' }),
      ]),
    ).toThrow();
  });

  it('does not mutate the input events', () => {
    const input = completeEvents();
    const snapshot = structuredClone(input);

    const result: SessionProjection = projectSession(input);

    expect(input).toEqual(snapshot);
    expect(result.messages).not.toBe((input as SessionEvent[])[1]);
  });
});
