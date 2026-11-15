import { describe, expect, it } from 'vitest';
import {
  newSessionEventSchema,
  readSessionEventsOptionsSchema,
  sessionEventSchema,
  sessionIdSchema,
  sqliteSessionEventStoreOptionsSchema,
} from '../src/index.js';

describe('session event schemas', () => {
  it('accepts a message.created event with a protocol message', () => {
    expect(
      newSessionEventSchema.parse({
        type: 'message.created',
        payload: {
          messageId: 'message-1',
          message: {
            role: 'user',
            content: [{ type: 'text', text: '开始分析' }],
          },
        },
      }),
    ).toEqual({
      type: 'message.created',
      payload: {
        messageId: 'message-1',
        message: {
          role: 'user',
          content: [{ type: 'text', text: '开始分析' }],
        },
      },
    });
  });

  it('accepts tool call and tool result events', () => {
    expect(
      newSessionEventSchema.parse({
        type: 'tool-call.created',
        payload: {
          turnId: 'turn-1',
          stepId: 'tool-step-1',
          toolCall: {
            id: 'call-1',
            name: 'echo',
            arguments: '{"value":"x"}',
          },
        },
      }),
    ).toMatchObject({
      type: 'tool-call.created',
      payload: {
        turnId: 'turn-1',
        stepId: 'tool-step-1',
        toolCall: { id: 'call-1', name: 'echo' },
      },
    });

    expect(
      newSessionEventSchema.parse({
        type: 'tool-result.created',
        payload: {
          turnId: 'turn-1',
          stepId: 'tool-step-1',
          toolCallId: 'call-1',
          name: 'echo',
          content: 'x',
          truncated: false,
          status: 'completed',
        },
      }),
    ).toMatchObject({
      type: 'tool-result.created',
      payload: {
        toolCallId: 'call-1',
        status: 'completed',
      },
    });
  });

  it('rejects an unknown event type', () => {
    expect(() =>
      newSessionEventSchema.parse({
        type: 'session.deleted',
        payload: {},
      }),
    ).toThrow();
  });

  it('requires store-generated fields on a persisted event', () => {
    expect(() =>
      sessionEventSchema.parse({
        sessionId: 'session-1',
        type: 'session.created',
        payload: { title: 'Demo' },
      }),
    ).toThrow();
  });

  it('rejects a non-positive sequence', () => {
    expect(() =>
      sessionEventSchema.parse({
        eventId: 'event-1',
        sessionId: 'session-1',
        sequence: 0,
        type: 'session.created',
        occurredAt: '2026-11-15T00:00:00.000Z',
        payload: { title: 'Demo' },
      }),
    ).toThrow();
  });

  it('rejects an empty session id before a store implementation runs', () => {
    expect(() => sessionIdSchema.parse('')).toThrow();
  });

  it('rejects a negative afterSequence value', () => {
    expect(() => readSessionEventsOptionsSchema.parse({ afterSequence: -1 })).toThrow();
  });

  it('requires a non-empty SQLite filename', () => {
    expect(() => sqliteSessionEventStoreOptionsSchema.parse({ filename: '' })).toThrow();
  });
});
