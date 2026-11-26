import type { DatabaseSync } from 'node:sqlite';
import { isSqliteBusyError, openSharedDatabase } from './sqlite-busy-timeout.js';
import { z } from 'zod';
import {
  providerSettingsRecordSchema,
  type ProviderSettingsRecord,
} from './provider-settings-types.js';

const createTableSql = `
  CREATE TABLE IF NOT EXISTS provider_settings (
    id TEXT NOT NULL PRIMARY KEY,
    label TEXT NOT NULL,
    type TEXT NOT NULL,
    base_url TEXT NOT NULL,
    encrypted_api_key TEXT,
    default_model TEXT NOT NULL,
    is_default INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
`;

/**
 * Adds the per-Provider model-parameter columns to an existing table.
 *
 * This SQLite file is shared with the Session and Project stores, so the
 * migration must NOT use the single per-database `PRAGMA user_version`: another
 * store already owns it, and reading it here would wrongly skip these columns.
 * Instead it inspects the actual columns and adds only the missing ones, which
 * is idempotent and independent of any other store's schema version.
 */
function migrateProviderSettingsSchema(database: DatabaseSync): void {
  const existingColumns = new Set(
    database
      .prepare('PRAGMA table_info(provider_settings)')
      .all()
      .map((row) => row.name),
  );
  const additions: readonly (readonly [string, string])[] = [
    ['context_window_tokens', 'INTEGER'],
    ['temperature', 'REAL'],
    ['max_tokens', 'INTEGER'],
  ];
  for (const [column, definition] of additions) {
    if (!existingColumns.has(column)) {
      database.exec(`ALTER TABLE provider_settings ADD COLUMN ${column} ${definition}`);
    }
  }
}

const invalidMessage = 'Provider Settings Store input is invalid';
const closedMessage = 'Provider Settings Store is closed';
const storageMessage = 'Provider Settings Store database operation failed';
const protocolMessage = 'Provider Settings Store contains invalid persisted data';
const notFoundMessage = 'Provider configuration does not exist';

export type ProviderSettingsStoreErrorCode =
  | 'provider-settings-storage'
  | 'provider-settings-busy'
  | 'provider-settings-invalid'
  | 'provider-settings-closed'
  | 'provider-settings-protocol'
  | 'provider-settings-not-found';

export class ProviderSettingsStoreError extends Error {
  readonly code: ProviderSettingsStoreErrorCode;

  constructor(code: ProviderSettingsStoreErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ProviderSettingsStoreError';
    this.code = code;
  }
}

export interface ProviderSettingsStore {
  list(): Promise<readonly ProviderSettingsRecord[]>;
  get(id: string): Promise<ProviderSettingsRecord | undefined>;
  create(record: ProviderSettingsRecord): Promise<void>;
  update(record: ProviderSettingsRecord): Promise<void>;
  delete(id: string): Promise<void>;
  close(): Promise<void>;
}

const optionsSchema = z.object({
  filename: z.string().min(1),
});

interface ProviderSettingsRow {
  readonly id: unknown;
  readonly label: unknown;
  readonly type: unknown;
  readonly base_url: unknown;
  readonly encrypted_api_key: unknown;
  readonly default_model: unknown;
  readonly is_default: unknown;
  readonly context_window_tokens: unknown;
  readonly temperature: unknown;
  readonly max_tokens: unknown;
  readonly created_at: unknown;
  readonly updated_at: unknown;
}

function requireOpen(closed: boolean): void {
  if (closed) {
    throw new ProviderSettingsStoreError('provider-settings-closed', closedMessage);
  }
}

function parseRecord(row: Record<string, unknown>): ProviderSettingsRecord {
  const stored: ProviderSettingsRow = {
    id: row.id,
    label: row.label,
    type: row.type,
    base_url: row.base_url,
    encrypted_api_key: row.encrypted_api_key,
    default_model: row.default_model,
    is_default: row.is_default,
    context_window_tokens: row.context_window_tokens,
    temperature: row.temperature,
    max_tokens: row.max_tokens,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };

  const parsed = providerSettingsRecordSchema.safeParse({
    id: stored.id,
    label: stored.label,
    type: stored.type,
    baseUrl: stored.base_url,
    encryptedApiKey: stored.encrypted_api_key,
    defaultModel: stored.default_model,
    isDefault: stored.is_default === 1,
    ...(typeof stored.context_window_tokens === 'number'
      ? { contextWindowTokens: stored.context_window_tokens }
      : {}),
    ...(typeof stored.temperature === 'number' ? { temperature: stored.temperature } : {}),
    ...(typeof stored.max_tokens === 'number' ? { maxTokens: stored.max_tokens } : {}),
    createdAt: stored.created_at,
    updatedAt: stored.updated_at,
  });
  if (!parsed.success) {
    throw new ProviderSettingsStoreError('provider-settings-protocol', protocolMessage, {
      cause: parsed.error,
    });
  }
  return parsed.data;
}

function parseInput(record: ProviderSettingsRecord): ProviderSettingsRecord {
  const parsed = providerSettingsRecordSchema.safeParse(record);
  if (!parsed.success) {
    throw new ProviderSettingsStoreError('provider-settings-invalid', invalidMessage, {
      cause: parsed.error,
    });
  }
  return parsed.data;
}

function withStorageError<T>(operation: () => T): T {
  try {
    return operation();
  } catch (error: unknown) {
    if (error instanceof ProviderSettingsStoreError) {
      throw error;
    }
    throw new ProviderSettingsStoreError(
      isSqliteBusyError(error) ? 'provider-settings-busy' : 'provider-settings-storage',
      storageMessage,
      {
        cause: error,
      },
    );
  }
}

/**
 * Creates a file-backed SQLite Store for Desktop-managed Provider settings.
 *
 * The Store treats encrypted API keys as opaque values. Encryption and
 * decryption belong to the Provider Settings Manager and Desktop boundary.
 */
export function createSqliteProviderSettingsStore(options: {
  readonly filename: string;
}): ProviderSettingsStore {
  const parsedOptions = optionsSchema.safeParse(options);
  if (!parsedOptions.success) {
    throw new ProviderSettingsStoreError('provider-settings-invalid', invalidMessage, {
      cause: parsedOptions.error,
    });
  }

  const database = withStorageError(() => {
    const created = openSharedDatabase(parsedOptions.data.filename);
    created.exec(createTableSql);
    migrateProviderSettingsSchema(created);
    return created;
  });
  let closed = false;

  return {
    async list(): Promise<readonly ProviderSettingsRecord[]> {
      requireOpen(closed);
      return withStorageError(() => {
        const rows = database
          .prepare(
            `SELECT id, label, type, base_url, encrypted_api_key,
                    default_model, is_default, context_window_tokens, temperature, max_tokens,
                    created_at, updated_at
             FROM provider_settings
             ORDER BY created_at ASC, rowid ASC`,
          )
          .all();
        return rows.map((row) => parseRecord(row));
      });
    },

    async get(id: string): Promise<ProviderSettingsRecord | undefined> {
      requireOpen(closed);
      if (!z.string().trim().min(1).safeParse(id).success) {
        throw new ProviderSettingsStoreError('provider-settings-invalid', invalidMessage);
      }

      return withStorageError(() => {
        const row = database
          .prepare(
            `SELECT id, label, type, base_url, encrypted_api_key,
                    default_model, is_default, context_window_tokens, temperature, max_tokens,
                    created_at, updated_at
             FROM provider_settings
             WHERE id = ?`,
          )
          .get(id);
        return row === undefined ? undefined : parseRecord(row);
      });
    },

    async create(recordInput: ProviderSettingsRecord): Promise<void> {
      requireOpen(closed);
      const record = parseInput(recordInput);
      withStorageError(() => {
        database
          .prepare(
            `INSERT INTO provider_settings
              (id, label, type, base_url, encrypted_api_key, default_model, is_default,
               context_window_tokens, temperature, max_tokens, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            record.id,
            record.label,
            record.type,
            record.baseUrl,
            record.encryptedApiKey,
            record.defaultModel,
            record.isDefault ? 1 : 0,
            record.contextWindowTokens ?? null,
            record.temperature ?? null,
            record.maxTokens ?? null,
            record.createdAt,
            record.updatedAt,
          );
      });
    },

    async update(recordInput: ProviderSettingsRecord): Promise<void> {
      requireOpen(closed);
      const record = parseInput(recordInput);
      withStorageError(() => {
        let transactionStarted = false;
        try {
          database.exec('BEGIN IMMEDIATE');
          transactionStarted = true;
          const result = database
            .prepare(
              `UPDATE provider_settings
               SET label = ?, type = ?, base_url = ?, encrypted_api_key = ?,
                   default_model = ?, is_default = ?, context_window_tokens = ?,
                   temperature = ?, max_tokens = ?, created_at = ?, updated_at = ?
               WHERE id = ?`,
            )
            .run(
              record.label,
              record.type,
              record.baseUrl,
              record.encryptedApiKey,
              record.defaultModel,
              record.isDefault ? 1 : 0,
              record.contextWindowTokens ?? null,
              record.temperature ?? null,
              record.maxTokens ?? null,
              record.createdAt,
              record.updatedAt,
              record.id,
            );
          if (result.changes === 0) {
            throw new ProviderSettingsStoreError('provider-settings-not-found', notFoundMessage);
          }
          database.exec('COMMIT');
          transactionStarted = false;
        } finally {
          if (transactionStarted) {
            try {
              database.exec('ROLLBACK');
            } catch {
              // Preserve the original Store or database error.
            }
          }
        }
      });
    },

    async delete(id: string): Promise<void> {
      requireOpen(closed);
      if (!z.string().trim().min(1).safeParse(id).success) {
        throw new ProviderSettingsStoreError('provider-settings-invalid', invalidMessage);
      }

      withStorageError(() => {
        let transactionStarted = false;
        try {
          database.exec('BEGIN IMMEDIATE');
          transactionStarted = true;
          const result = database.prepare('DELETE FROM provider_settings WHERE id = ?').run(id);
          if (result.changes === 0) {
            throw new ProviderSettingsStoreError('provider-settings-not-found', notFoundMessage);
          }
          database.exec('COMMIT');
          transactionStarted = false;
        } finally {
          if (transactionStarted) {
            try {
              database.exec('ROLLBACK');
            } catch {
              // Preserve the original Store or database error.
            }
          }
        }
      });
    },

    async close(): Promise<void> {
      if (closed) {
        return;
      }
      closed = true;
      withStorageError(() => database.close());
    },
  };
}

export type { ProviderSettingsRecord } from './provider-settings-types.js';
