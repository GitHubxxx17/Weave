import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { openSharedDatabase } from './sqlite-busy-timeout.js';

const filenameSchema = z.string().min(1);
const digestSchema = z.string().regex(/^[0-9a-f]{64}$/);
const pluginIdSchema = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
const hookIdSchema = z.string().min(1).max(128);

/**
 * User confirmations for undeclared high-risk hooks. A row binds one plugin id
 * and content digest to one hook; a changed digest therefore needs a new
 * confirmation. This is plugin state (ADR 0005 amendment 2026-11-24), so it is
 * updated in place beside the other plugin authority tables.
 */
export interface PluginHookConfirmationStore {
  /** Keys built by {@link hookConfirmationKey} for every confirmed hook. */
  confirmed(): ReadonlySet<string>;
  /**
   * Records confirmations for the plugin's current digest and drops rows kept
   * for earlier digests of the same plugin.
   */
  confirm(pluginId: string, digest: string, hookIds: readonly string[]): void;
}

export function hookConfirmationKey(pluginId: string, digest: string, hookId: string): string {
  return JSON.stringify([pluginId, digest, hookId]);
}

const createTableSql = `
  CREATE TABLE IF NOT EXISTS plugin_hook_confirmations (
    plugin_id TEXT NOT NULL,
    digest TEXT NOT NULL,
    hook_id TEXT NOT NULL,
    confirmed_at TEXT NOT NULL,
    PRIMARY KEY (plugin_id, digest, hook_id)
  )
`;

const rowSchema = z.object({
  plugin_id: pluginIdSchema,
  digest: digestSchema,
  hook_id: hookIdSchema,
});

/**
 * Opens the database for each operation. Confirmations are written by explicit
 * user action and read once per generation, so no connection is kept open.
 */
export function createSqlitePluginHookConfirmationStore(options: {
  readonly filename: string;
  readonly now?: () => Date;
}): PluginHookConfirmationStore {
  const filename = filenameSchema.parse(options.filename);
  const now = options.now ?? (() => new Date());

  function withDatabase<T>(operation: (database: DatabaseSync) => T): T {
    const database = openSharedDatabase(filename);
    try {
      database.exec(createTableSql);
      return operation(database);
    } finally {
      database.close();
    }
  }

  return {
    confirmed() {
      return withDatabase((database) => {
        const rows = database
          .prepare('SELECT plugin_id, digest, hook_id FROM plugin_hook_confirmations')
          .all();
        return new Set(
          rows.flatMap((row) => {
            // A malformed row can never match a real plugin, so it is ignored.
            const parsed = rowSchema.safeParse(row);
            return parsed.success
              ? [
                  hookConfirmationKey(
                    parsed.data.plugin_id,
                    parsed.data.digest,
                    parsed.data.hook_id,
                  ),
                ]
              : [];
          }),
        );
      });
    },
    confirm(pluginId, digest, hookIds) {
      const id = pluginIdSchema.parse(pluginId);
      const hash = digestSchema.parse(digest);
      const hooks = z.array(hookIdSchema).min(1).parse(hookIds);
      const confirmedAt = now().toISOString();
      withDatabase((database) => {
        database.exec('BEGIN IMMEDIATE');
        try {
          database
            .prepare('DELETE FROM plugin_hook_confirmations WHERE plugin_id = ? AND digest <> ?')
            .run(id, hash);
          const insert = database.prepare(
            'INSERT OR REPLACE INTO plugin_hook_confirmations (plugin_id, digest, hook_id, confirmed_at) VALUES (?, ?, ?, ?)',
          );
          for (const hookId of hooks) insert.run(id, hash, hookId, confirmedAt);
          database.exec('COMMIT');
        } catch (error: unknown) {
          database.exec('ROLLBACK');
          throw error;
        }
      });
    },
  };
}
