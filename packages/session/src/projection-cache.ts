import type { SessionEventStore } from './store.js';
import {
  applyEvent,
  createProjectionState,
  snapshotProjection,
  type ProjectionState,
  type SessionProjection,
} from './projection.js';

const defaultMaxEntries = 128;

/**
 * A read-through projection cache over a {@link SessionEventStore}.
 *
 * Each call reads only events after the last projected sequence and folds them
 * onto the retained accumulation, so a Session's history is parsed once instead
 * of on every projection. This is safe because the Store is append-only: older
 * events never change, so an incremental fold always equals a full replay.
 */
export interface SessionProjectionCache {
  /**
   * Projects a Session. Returns `undefined` when the Session has no durable
   * events (it does not exist). Throws `SessionProjectionError` when the stored
   * events cannot describe a valid Session.
   */
  project(sessionId: string): Promise<SessionProjection | undefined>;
  /** Drops the retained state for one Session, e.g. to free memory after deletion. */
  invalidate(sessionId: string): void;
  /** Drops all retained state. */
  clear(): void;
}

/** Construction options for {@link createSessionProjectionCache}. */
export interface SessionProjectionCacheOptions {
  /**
   * Maximum number of Sessions whose projection state is retained, evicted
   * least-recently-used. Defaults to 128. An evicted Session simply re-reads
   * its full log on the next projection.
   */
  readonly maxEntries?: number;
}

interface CacheEntry {
  readonly state: ProjectionState;
  snapshot: SessionProjection;
}

function normalizeMaxEntries(value: number | undefined): number {
  if (value === undefined || !Number.isInteger(value) || value < 1) {
    return defaultMaxEntries;
  }
  return value;
}

/**
 * Creates an incremental, read-through projection cache for a Store.
 */
export function createSessionProjectionCache(
  store: SessionEventStore,
  options?: SessionProjectionCacheOptions,
): SessionProjectionCache {
  const maxEntries = normalizeMaxEntries(options?.maxEntries);
  const entries = new Map<string, CacheEntry>();
  // Serializes projection per Session so concurrent calls never fold the same
  // new events onto the shared accumulation twice.
  const inFlight = new Map<string, Promise<SessionProjection | undefined>>();

  function markRecentlyUsed(sessionId: string, entry: CacheEntry): void {
    // Map iteration is insertion order; delete + set moves the key to the end.
    entries.delete(sessionId);
    entries.set(sessionId, entry);
    while (entries.size > maxEntries) {
      const oldest = entries.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      entries.delete(oldest);
    }
  }

  async function doProject(sessionId: string): Promise<SessionProjection | undefined> {
    const existing = entries.get(sessionId);
    const afterSequence = existing?.state.lastSequence ?? 0;
    const newEvents = await store.read(sessionId, { afterSequence });

    if (existing === undefined) {
      if (newEvents.length === 0) {
        return undefined;
      }
      // A throw here leaves nothing cached; the next call re-reads from zero.
      const state = createProjectionState();
      for (const event of newEvents) {
        applyEvent(state, event);
      }
      const entry: CacheEntry = { state, snapshot: snapshotProjection(state) };
      markRecentlyUsed(sessionId, entry);
      return entry.snapshot;
    }

    if (newEvents.length === 0) {
      markRecentlyUsed(sessionId, existing);
      return existing.snapshot;
    }

    try {
      for (const event of newEvents) {
        applyEvent(existing.state, event);
      }
    } catch (error) {
      // Drop the partially-folded state so the next call re-reads from zero and
      // reproduces the same deterministic error instead of reading dirty state.
      entries.delete(sessionId);
      throw error;
    }
    existing.snapshot = snapshotProjection(existing.state);
    markRecentlyUsed(sessionId, existing);
    return existing.snapshot;
  }

  return {
    async project(sessionId: string): Promise<SessionProjection | undefined> {
      const previous = inFlight.get(sessionId) ?? Promise.resolve(undefined);
      const next = previous.catch(() => undefined).then(() => doProject(sessionId));
      inFlight.set(sessionId, next);
      try {
        return await next;
      } finally {
        if (inFlight.get(sessionId) === next) {
          inFlight.delete(sessionId);
        }
      }
    },

    invalidate(sessionId: string): void {
      entries.delete(sessionId);
    },

    clear(): void {
      entries.clear();
    },
  };
}
