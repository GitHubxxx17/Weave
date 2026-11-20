/**
 * Public API for durable Session events and Session projections.
 *
 * Implementations are added in focused modules so callers can depend on the
 * event contract without importing SQLite-specific details.
 */

export {
  isPluginEventType,
  newSessionEventSchema,
  pluginEventTypePattern,
  sessionEventPayloadSchema,
  sessionEventSchema,
} from './events.js';
export type { NewSessionEvent, PluginEventType, SessionEvent, SessionEventType } from './events.js';

export { readSessionEventsOptionsSchema, sessionIdSchema, SessionStoreError } from './store.js';
export type { SessionEventStore, SessionStoreErrorCode } from './store.js';

export { createInMemorySessionEventStore } from './memory-store.js';

export {
  createSqliteSessionEventStore,
  sqliteSessionEventStoreOptionsSchema,
} from './sqlite-store.js';
export type { SqliteSessionEventStoreOptions } from './sqlite-store.js';

export { projectSession, SessionProjectionError, sumTokenUsage } from './projection.js';
export type {
  SessionMessage,
  SessionProjection,
  SessionProjectionErrorCode,
  SessionStep,
  SessionToolCall,
  SessionToolResult,
  SessionTurn,
} from './projection.js';

export { createSessionProjectionCache } from './projection-cache.js';
export type { SessionProjectionCache, SessionProjectionCacheOptions } from './projection-cache.js';

export { collectFileUndo, fileUndoForTurn } from './file-undo.js';
export type { FileSnapshot, TurnFileUndo } from './file-undo.js';
