import type { DatabaseSync } from 'node:sqlite';
import {
  pluginTrustEventSchema,
  recordedPluginTrustEventSchema,
  type PluginTrustEvent,
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

const rowSchema = z.object({
  sequence: z.bigint().positive().max(BigInt(Number.MAX_SAFE_INTEGER)).transform(Number),
  occurred_at: z.string().min(1),
  scope: z.literal('user'),
  event_json: z.string().min(1),
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

export function createTrustTableSync(database: DatabaseSync): void {
  database.exec(createTableSql);
}

export function validateTrustInput(input: unknown): PluginTrustEvent {
  const parsed = pluginTrustEventSchema.safeParse(input);
  if (!parsed.success) {
    throw new PluginTrustStoreError('plugin-trust-invalid', invalidMessage, {
      cause: parsed.error,
    });
  }
  if (!matchesManifestIdentity(parsed.data)) {
    throw new PluginTrustStoreError('plugin-trust-invalid', invalidMessage);
  }
  return parsed.data;
}

export function readTrustEventsTx(database: DatabaseSync): readonly RecordedPluginTrustEvent[] {
  const statement = database.prepare(
    'SELECT sequence, occurred_at, scope, event_json FROM plugin_trust_events ORDER BY sequence ASC',
  );
  // Read every SQLite integer losslessly, then reject values beyond the JS
  // protocol range as corrupt data rather than an opaque driver range error.
  statement.setReadBigInts(true);
  return statement.all().map((row, index) => readEvent(row, index + 1));
}

export function createRecordedTrustEvent(
  event: PluginTrustEvent,
  sequence: number,
  occurredAt: string,
): RecordedPluginTrustEvent {
  const recorded = recordedPluginTrustEventSchema.safeParse({
    ...event,
    sequence,
    occurredAt,
    scope: 'user',
  });
  if (!recorded.success) {
    throw new PluginTrustStoreError('plugin-trust-invalid', invalidMessage, {
      cause: recorded.error,
    });
  }
  return recorded.data;
}

export function appendRecordedTrustEventTx(
  database: DatabaseSync,
  event: RecordedPluginTrustEvent,
): void {
  database
    .prepare(
      'INSERT INTO plugin_trust_events (sequence, occurred_at, scope, event_json) VALUES (?, ?, ?, ?)',
    )
    .run(event.sequence, event.occurredAt, event.scope, JSON.stringify(event));
}
