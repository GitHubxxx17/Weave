import type { SessionEvent } from './events.js';

/** One captured pre-write snapshot of a workspace file. */
export interface FileSnapshot {
  readonly path: string;
  readonly existedBefore: boolean;
  readonly previousContent: string;
}

/** The undoable file changes of one turn, with the earliest original per path. */
export interface TurnFileUndo {
  readonly turnId: string;
  readonly snapshots: readonly FileSnapshot[];
}

/**
 * Groups `workspace.file-snapshot` events by the turn that was running when
 * each was recorded, keeping the first snapshot per path (that turn's original
 * state). Snapshots recorded outside any running turn are ignored.
 */
export function collectFileUndo(events: readonly SessionEvent[]): readonly TurnFileUndo[] {
  const order: string[] = [];
  const byTurn = new Map<string, Map<string, FileSnapshot>>();
  let activeTurnId: string | undefined;

  for (const event of events) {
    if (event.type === 'turn.started') {
      activeTurnId = event.payload.turnId;
    } else if (event.type === 'turn.completed') {
      if (activeTurnId === event.payload.turnId) {
        activeTurnId = undefined;
      }
    } else if (event.type === 'workspace.file-snapshot') {
      if (activeTurnId === undefined) {
        continue;
      }
      let paths = byTurn.get(activeTurnId);
      if (paths === undefined) {
        paths = new Map<string, FileSnapshot>();
        byTurn.set(activeTurnId, paths);
        order.push(activeTurnId);
      }
      if (!paths.has(event.payload.path)) {
        paths.set(event.payload.path, {
          path: event.payload.path,
          existedBefore: event.payload.existedBefore,
          previousContent: event.payload.previousContent,
        });
      }
    }
  }

  return order.map((turnId) => ({
    turnId,
    snapshots: [...byTurn.get(turnId)!.values()],
  }));
}

/** Returns the undoable snapshots for one turn, oldest original per path. */
export function fileUndoForTurn(
  events: readonly SessionEvent[],
  turnId: string,
): readonly FileSnapshot[] {
  return collectFileUndo(events).find((entry) => entry.turnId === turnId)?.snapshots ?? [];
}
