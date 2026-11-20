import type { TurnEndInfo, TurnInfo } from '@weave/plugin';
import type { SessionEventStore } from '@weave/session';

/** What the Server tells plugins about the turns an Agent Runner runs. */
export interface TurnObserver {
  start(info: TurnInfo): Promise<void>;
  end(info: TurnEndInfo): Promise<void>;
}

/**
 * Wraps a Session Store so a turn's start and end are announced to `observer`
 * once they are durable.
 *
 * Turns already record both as session events (`turn.started` and
 * `turn.completed`, the latter for completed, failed and cancelled turns alike),
 * so listening to the store covers every way a turn can end without the Agent
 * Runner knowing about plugins. The announcement follows the append: observers
 * never see a turn the Store has not recorded, and an observer that fails or
 * throws cannot undo or hide what was recorded.
 */
export function observeTurns(store: SessionEventStore, observer: TurnObserver): SessionEventStore {
  return {
    async append(sessionId, events) {
      const stored = await store.append(sessionId, events);
      for (const event of events) {
        try {
          if (event.type === 'turn.started') {
            await observer.start({ sessionId, turnId: event.payload.turnId });
          } else if (event.type === 'turn.completed') {
            await observer.end({
              sessionId,
              turnId: event.payload.turnId,
              status: event.payload.status,
              ...(event.payload.reason === undefined ? {} : { reason: event.payload.reason }),
            });
          }
        } catch {
          // Observation never fails the append that was already recorded.
        }
      }
      return stored;
    },
    read: (sessionId, options) => store.read(sessionId, options),
    close: () => store.close(),
  };
}
