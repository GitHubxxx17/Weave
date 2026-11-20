import { DatabaseSync } from 'node:sqlite';
import {
  pluginTrustEventSchema,
  recordedPluginTrustEventSchema,
  type PluginTrustEvent,
  type PluginTrustStore,
  type RecordedPluginTrustEvent,
} from '@weave/plugin-host';
import { z } from 'zod';

const createTableSql = `
  CREATE TABLE IF NOT EXISTS plugin_trust_events (
    sequence INTEGER NOT NULL PRIMARY KEY,
    occurred_at TEXT NOT NULL,
    scope TEXT NOT NULL,
    event_json TEXT NOT NULL
  )
`;

const optionsSchema = z.object({
  filename: z.string().min(1),
  now: z.custom<() => Date>((value) => typeof value === 'function').optional(),
});
const rowSchema = z.object({
  sequence: z.bigint().positive().max(BigInt(Number.MAX_SAFE_INTEGER)).transform(Number),
  occurred_at: z.string().min(1),
  scope: z.literal('user'),
  event_json: z.string().min(1),
});
const maximumSchema = z.object({
  sequence: z.bigint().nonnegative().max(BigInt(Number.MAX_SAFE_INTEGER)).transform(Number),
});
const invalidMessage = 'Plugin Trust Store input is invalid';
const protocolMessage = 'Plugin Trust Store contains invalid persisted data';

export type PluginTrustStoreErrorCode =
  'plugin-trust-invalid' | 'plugin-trust-storage' | 'plugin-trust-closed' | 'plugin-trust-protocol';

export class PluginTrustStoreError extends Error {
  constructor(
    readonly code: PluginTrustStoreErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'PluginTrustStoreError';
  }
}

function withStorageError<T>(operation: () => T): T {
  try {
    return operation();
  } catch (error: unknown) {
    if (error instanceof PluginTrustStoreError) throw error;
    throw new PluginTrustStoreError(
      'plugin-trust-storage',
      'Plugin Trust Store database operation failed',
      {
        cause: error,
      },
    );
  }
}

function matchesManifestIdentity(event: PluginTrustEvent): boolean {
  return event.kind !== 'trusted' || event.pluginId === event.manifest.id;
}

function readEvent(rowInput: unknown, expectedSequence: number): RecordedPluginTrustEvent {
  try {
    const row = rowSchema.parse(rowInput);
    const payload: unknown = JSON.parse(row.event_json);
    const event = recordedPluginTrustEventSchema.parse(payload);
    if (
      row.sequence !== expectedSequence ||
      event.sequence !== row.sequence ||
      event.occurredAt !== row.occurred_at ||
      event.scope !== row.scope ||
      !matchesManifestIdentity(event)
    ) {
      throw new Error('Trust event metadata does not match its row or contiguous sequence');
    }
    return event;
  } catch (error: unknown) {
    throw new PluginTrustStoreError('plugin-trust-protocol', protocolMessage, { cause: error });
  }
}

function readEvents(database: DatabaseSync): readonly RecordedPluginTrustEvent[] {
  const statement = database.prepare(
    'SELECT sequence, occurred_at, scope, event_json FROM plugin_trust_events ORDER BY sequence ASC',
  );
  // Read every SQLite integer losslessly, then reject values beyond the JS
  // protocol range as corrupt data rather than an opaque driver range error.
  statement.setReadBigInts(true);
  return statement.all().map((row, index) => readEvent(row, index + 1));
}

/**
 * An append-only trust log on its own connection to the shared database.
 * This table owns no database-wide user_version or mutable trust projection.
 */
export function createSqlitePluginTrustStore(options: {
  readonly filename: string;
  readonly now?: () => Date;
}): PluginTrustStore & { close(): Promise<void> } {
  const parsedOptions = optionsSchema.safeParse(options);
  if (!parsedOptions.success) {
    throw new PluginTrustStoreError('plugin-trust-invalid', invalidMessage, {
      cause: parsedOptions.error,
    });
  }
  const database = withStorageError(() => {
    const opened = new DatabaseSync(parsedOptions.data.filename);
    try {
      opened.exec(createTableSql);
      return opened;
    } catch (error: unknown) {
      opened.close();
      throw error;
    }
  });
  const now = parsedOptions.data.now ?? (() => new Date());
  let closed = false;
  const requireOpen = (): void => {
    if (closed) {
      throw new PluginTrustStoreError('plugin-trust-closed', 'Plugin Trust Store is closed');
    }
  };

  return {
    async append(eventInput) {
      requireOpen();
      const parsed = pluginTrustEventSchema.safeParse(eventInput);
      if (!parsed.success) {
        throw new PluginTrustStoreError('plugin-trust-invalid', invalidMessage, {
          cause: parsed.error,
        });
      }
      if (!matchesManifestIdentity(parsed.data)) {
        throw new PluginTrustStoreError('plugin-trust-invalid', invalidMessage);
      }
      let occurredAt: string;
      try {
        occurredAt = z.date().parse(now()).toISOString();
      } catch (error: unknown) {
        throw new PluginTrustStoreError('plugin-trust-invalid', invalidMessage, { cause: error });
      }

      return withStorageError(() => {
        database.exec('BEGIN IMMEDIATE');
        try {
          readEvents(database);
          const maximumStatement = database.prepare(
            'SELECT COALESCE(MAX(sequence), 0) AS sequence FROM plugin_trust_events',
          );
          maximumStatement.setReadBigInts(true);
          const maximum = maximumSchema.safeParse(maximumStatement.get());
          if (!maximum.success) {
            throw new PluginTrustStoreError('plugin-trust-protocol', protocolMessage, {
              cause: maximum.error,
            });
          }
          const recorded = recordedPluginTrustEventSchema.safeParse({
            ...parsed.data,
            sequence: maximum.data.sequence + 1,
            occurredAt,
            scope: 'user',
          });
          if (!recorded.success) {
            throw new PluginTrustStoreError('plugin-trust-invalid', invalidMessage, {
              cause: recorded.error,
            });
          }
          database
            .prepare(
              'INSERT INTO plugin_trust_events (sequence, occurred_at, scope, event_json) VALUES (?, ?, ?, ?)',
            )
            .run(recorded.data.sequence, occurredAt, 'user', JSON.stringify(recorded.data));
          database.exec('COMMIT');
          return recorded.data;
        } catch (error: unknown) {
          try {
            database.exec('ROLLBACK');
          } catch {
            // SQLite may already have rolled back (for example in a trigger).
            // The failure that prevented the append remains the useful cause.
          }
          throw error;
        }
      });
    },
    async events() {
      requireOpen();
      return withStorageError(() => readEvents(database));
    },
    async close() {
      if (closed) return;
      withStorageError(() => database.close());
      closed = true;
    },
  };
}
