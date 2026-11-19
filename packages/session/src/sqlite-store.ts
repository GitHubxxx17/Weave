import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
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

const createTableSql = `
  CREATE TABLE IF NOT EXISTS session_events (
    session_id TEXT NOT NULL,
    sequence INTEGER NOT NULL,
    event_id TEXT NOT NULL UNIQUE,
    type TEXT NOT NULL,
    occurred_at TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    PRIMARY KEY (session_id, sequence)
  )
`;

const closedMessage = 'Session Event Store is closed';
const invalidInputMessage = 'Session Event Store input is invalid';
const ioMessage = 'Session Event Store database operation failed';
const protocolMessage = 'Session Event Store contains an invalid persisted event';
const migrationMessage = 'Session Event Store database schema is newer than this build supports';

const defaultBusyTimeoutMs = 5000;

/**
 * Ordered schema migrations. `schemaMigrations[n]` upgrades a database from
 * `user_version` n to n + 1, so the array length is the current schema version.
 * Migration 0 creates the append-only event table and is idempotent, so a
 * database created by earlier code (table present, `user_version` 0) upgrades
 * cleanly without touching existing rows.
 */
const schemaMigrations: readonly ((database: DatabaseSync) => void)[] = [
  (database) => {
    database.exec(createTableSql);
  },
];

const schemaVersion = schemaMigrations.length;

/**
 * Reads the integer `user_version` that records the applied schema version.
 */
function readUserVersion(database: DatabaseSync): number {
  const row = database.prepare('PRAGMA user_version').get();
  if (row === undefined || typeof row.user_version !== 'number') {
    return 0;
  }
  return row.user_version;
}

/**
 * Applies per-connection pragmas before any migration runs. `journal_mode`
 * cannot change inside a transaction, so all three are set before `migrate`
 * opens one. `busy_timeout` and `foreign_keys` are per-connection and must be
 * set on every open; WAL is a persistent database-file setting.
 */
function configureConnection(database: DatabaseSync, busyTimeoutMs: number): void {
  database.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}`);
  database.exec('PRAGMA journal_mode = WAL');
  database.exec('PRAGMA foreign_keys = ON');
}

/**
 * Brings a database up to the current schema version in a single transaction.
 * A database written by a newer build is refused rather than opened, so newer
 * on-disk structures are never read or written through older assumptions.
 */
function migrate(database: DatabaseSync): void {
  const current = readUserVersion(database);
  if (current > schemaVersion) {
    throw new SessionStoreError('session-store-migration', migrationMessage);
  }
  if (current === schemaVersion) {
    return;
  }

  database.exec('BEGIN IMMEDIATE');
  try {
    for (let version = current; version < schemaVersion; version += 1) {
      const migration = schemaMigrations[version];
      if (migration === undefined) {
        throw new SessionStoreError('session-store-migration', migrationMessage);
      }
      migration(database);
    }
    database.exec(`PRAGMA user_version = ${schemaVersion}`);
    database.exec('COMMIT');
  } catch (error) {
    try {
      database.exec('ROLLBACK');
    } catch {
      // Preserve the original migration failure.
    }
    throw error;
  }
}

/**
 * Configuration for a file-backed SQLite Session Event Store.
 */
export interface SqliteSessionEventStoreOptions {
  readonly filename: string;
  /** Milliseconds a blocked connection waits before `SQLITE_BUSY`. Defaults to 5000. */
  readonly busyTimeoutMs?: number;
}

/**
 * Runtime validation for SQLite Store construction options.
 */
export const sqliteSessionEventStoreOptionsSchema = z.object({
  filename: z.string().min(1),
  busyTimeoutMs: z.number().int().positive().safe().optional(),
});

interface StoredEventRow {
  readonly event_id: unknown;
  readonly session_id: unknown;
  readonly sequence: unknown;
  readonly type: unknown;
  readonly occurred_at: unknown;
  readonly payload_json: unknown;
}

function requireOpen(closed: boolean): void {
  if (closed) {
    throw new SessionStoreError('session-store-closed', closedMessage);
  }
}

function asStoredEventRow(row: Record<string, unknown>): StoredEventRow {
  return {
    event_id: row.event_id,
    session_id: row.session_id,
    sequence: row.sequence,
    type: row.type,
    occurred_at: row.occurred_at,
    payload_json: row.payload_json,
  };
}

function readPersistedEvent(row: Record<string, unknown>): SessionEvent {
  const stored = asStoredEventRow(row);
  if (
    typeof stored.event_id !== 'string' ||
    typeof stored.session_id !== 'string' ||
    typeof stored.sequence !== 'number' ||
    typeof stored.type !== 'string' ||
    typeof stored.occurred_at !== 'string' ||
    typeof stored.payload_json !== 'string'
  ) {
    throw new SessionStoreError('session-store-protocol', protocolMessage);
  }

  let payload: unknown;
  try {
    payload = JSON.parse(stored.payload_json);
  } catch (error) {
    throw new SessionStoreError('session-store-protocol', protocolMessage, { cause: error });
  }

  try {
    return sessionEventSchema.parse({
      eventId: stored.event_id,
      sessionId: stored.session_id,
      sequence: stored.sequence,
      type: stored.type,
      occurredAt: stored.occurred_at,
      payload,
    });
  } catch (error) {
    throw new SessionStoreError('session-store-protocol', protocolMessage, { cause: error });
  }
}

/**
 * Creates a file-backed append-only Session Event Store using Node's built-in SQLite API.
 */
export function createSqliteSessionEventStore(
  options: SqliteSessionEventStoreOptions,
): SessionEventStore {
  const optionsResult = sqliteSessionEventStoreOptionsSchema.safeParse(options);
  if (!optionsResult.success) {
    throw new SessionStoreError('session-store-invalid-input', invalidInputMessage);
  }

  let database: DatabaseSync;
  try {
    database = new DatabaseSync(optionsResult.data.filename);
  } catch (error) {
    throw new SessionStoreError('session-store-io', ioMessage, { cause: error });
  }

  try {
    configureConnection(database, optionsResult.data.busyTimeoutMs ?? defaultBusyTimeoutMs);
    migrate(database);
  } catch (error) {
    try {
      database.close();
    } catch {
      // Preserve the original configuration or migration failure.
    }
    if (error instanceof SessionStoreError) {
      throw error;
    }
    throw new SessionStoreError('session-store-io', ioMessage, { cause: error });
  }

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

      const nextEvents: SessionEvent[] = [];
      let transactionStarted = false;

      try {
        database.exec('BEGIN IMMEDIATE');
        transactionStarted = true;

        const sequenceRow = database
          .prepare(
            'SELECT COALESCE(MAX(sequence), 0) AS max_sequence FROM session_events WHERE session_id = ?',
          )
          .get(sessionIdInput);
        const currentSequence =
          sequenceRow === undefined || typeof sequenceRow.max_sequence !== 'number'
            ? 0
            : sequenceRow.max_sequence;

        for (const [index, event] of eventsInput.entries()) {
          const persistedEvent = sessionEventSchema.parse({
            type: event.type,
            payload: event.payload,
            eventId: randomUUID(),
            sessionId: sessionIdInput,
            sequence: currentSequence + index + 1,
            occurredAt: new Date().toISOString(),
          });
          nextEvents.push(persistedEvent);

          database
            .prepare(
              `INSERT INTO session_events
                (session_id, sequence, event_id, type, occurred_at, payload_json)
               VALUES (?, ?, ?, ?, ?, ?)`,
            )
            .run(
              persistedEvent.sessionId,
              persistedEvent.sequence,
              persistedEvent.eventId,
              persistedEvent.type,
              persistedEvent.occurredAt,
              JSON.stringify(persistedEvent.payload),
            );
        }

        database.exec('COMMIT');
        transactionStarted = false;
        return nextEvents;
      } catch (error) {
        if (transactionStarted) {
          try {
            database.exec('ROLLBACK');
          } catch {
            // Preserve the original database or validation failure.
          }
        }

        if (error instanceof SessionStoreError) {
          throw error;
        }
        throw new SessionStoreError('session-store-io', ioMessage, { cause: error });
      }
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

      try {
        const rows = database
          .prepare(
            `SELECT
              event_id,
              session_id,
              sequence,
              type,
              occurred_at,
              payload_json
             FROM session_events
             WHERE session_id = ? AND sequence > ?
             ORDER BY sequence ASC`,
          )
          .all(sessionIdInput, optionsResult.data.afterSequence ?? 0);

        return rows.map((row) => readPersistedEvent(row));
      } catch (error) {
        if (error instanceof SessionStoreError) {
          throw error;
        }
        throw new SessionStoreError('session-store-io', ioMessage, { cause: error });
      }
    },

    async close(): Promise<void> {
      if (closed) {
        return;
      }

      closed = true;
      try {
        database.close();
      } catch (error) {
        throw new SessionStoreError('session-store-io', ioMessage, { cause: error });
      }
    },
  };
}
