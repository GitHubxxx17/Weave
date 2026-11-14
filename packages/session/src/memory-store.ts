import { randomUUID } from 'node:crypto';
import {
  newSessionEventSchema,
  sessionEventSchema,
  type NewSessionEvent,
  type SessionEvent,
} from './events.js';
import {
  readSessionEventsOptionsSchema,
  sessionIdSchema,
  SessionStoreError,
  type SessionEventStore,
} from './store.js';

const closedMessage = 'Session Event Store is closed';
const invalidInputMessage = 'Session Event Store input is invalid';

function cloneEvent(event: SessionEvent): SessionEvent {
  return structuredClone(event);
}

function requireOpen(closed: boolean): void {
  if (closed) {
    throw new SessionStoreError('session-store-closed', closedMessage);
  }
}

/**
 * Creates an isolated in-memory implementation of the append-only Store.
 */
export function createInMemorySessionEventStore(): SessionEventStore {
  const eventsBySession = new Map<string, SessionEvent[]>();
  let closed = false;

  return {
    async append(
      sessionIdInput: string,
      eventsInput: readonly NewSessionEvent[],
    ): Promise<readonly SessionEvent[]> {
      requireOpen(closed);

      const sessionIdResult = sessionIdSchema.safeParse(sessionIdInput);
      const eventsResult = Array.isArray(eventsInput)
        ? eventsInput.map((event) => newSessionEventSchema.safeParse(event))
        : [];

      if (
        !sessionIdResult.success ||
        !Array.isArray(eventsInput) ||
        eventsResult.some((result) => !result.success)
      ) {
        throw new SessionStoreError('session-store-invalid-input', invalidInputMessage);
      }

      if (eventsInput.length === 0) {
        return [];
      }

      const existingEvents = eventsBySession.get(sessionIdInput) ?? [];
      const nextEvents = eventsInput.map((event, index) =>
        sessionEventSchema.parse({
          eventId: randomUUID(),
          sessionId: sessionIdInput,
          sequence: existingEvents.length + index + 1,
          occurredAt: new Date().toISOString(),
          ...event,
        }),
      );

      eventsBySession.set(sessionIdInput, [...existingEvents, ...nextEvents]);
      return nextEvents.map(cloneEvent);
    },

    async read(
      sessionIdInput: string,
      optionsInput?: { readonly afterSequence?: number },
    ): Promise<readonly SessionEvent[]> {
      requireOpen(closed);

      const sessionIdResult = sessionIdSchema.safeParse(sessionIdInput);
      const optionsResult = readSessionEventsOptionsSchema.safeParse(optionsInput ?? {});
      if (!sessionIdResult.success || !optionsResult.success) {
        throw new SessionStoreError('session-store-invalid-input', invalidInputMessage);
      }

      const afterSequence = optionsResult.data.afterSequence ?? 0;
      return (eventsBySession.get(sessionIdInput) ?? [])
        .filter((event) => event.sequence > afterSequence)
        .map(cloneEvent);
    },

    async close(): Promise<void> {
      closed = true;
      eventsBySession.clear();
    },
  };
}
