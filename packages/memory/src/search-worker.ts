import { parentPort, workerData } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import {
  memoryCurrentSchema,
  memoryQuerySchema,
  memoryScopeSchema,
  normalizeMemoryText,
  type MemoryCurrent,
  type MemoryScope,
} from '@weave/protocol';
import type { MemorySearchInput, MemorySearchPage, MemorySortKey } from './types.js';

const searchInputSchema = z.strictObject({
  scopes: z.array(memoryScopeSchema).min(1).max(2),
  limit: z.number().int().min(1).max(50),
  query: memoryQuerySchema.shape.query,
  tag: memoryQuerySchema.shape.tag,
  includeAgentAuthored: z.boolean().optional(),
  after: z
    .strictObject({
      titleHit: z.number().int().min(0).max(1),
      updatedAt: z.iso.datetime(),
      scopeRank: z.number().int().min(0).max(1),
      memoryId: z.string().uuid(),
    })
    .optional(),
});
function validatedSearchInput(value: unknown): MemorySearchInput {
  const parsed = searchInputSchema.safeParse(value);
  if (!parsed.success) throw new Error('memory-limit');
  const input = parsed.data;
  return {
    scopes: input.scopes,
    limit: input.limit,
    ...(input.query === undefined ? {} : { query: input.query }),
    ...(input.tag === undefined ? {} : { tag: input.tag }),
    ...(input.includeAgentAuthored === undefined
      ? {}
      : { includeAgentAuthored: input.includeAgentAuthored }),
    ...(input.after === undefined ? {} : { after: input.after }),
  };
}

function keyFor(scope: MemoryScope): string {
  return scope.kind === 'user' ? 'user' : `project:${scope.projectId}`;
}
export function compareMemoryKeys(a: MemorySortKey, b: MemorySortKey): number {
  return (
    b.titleHit - a.titleHit ||
    (a.updatedAt > b.updatedAt ? -1 : a.updatedAt < b.updatedAt ? 1 : 0) ||
    a.scopeRank - b.scopeRank ||
    (a.memoryId < b.memoryId ? -1 : a.memoryId > b.memoryId ? 1 : 0)
  );
}
function excerpt(value: string): string {
  let result = '';
  let bytes = 0;
  for (const point of value) {
    bytes += Buffer.byteLength(point);
    if (bytes > 512) break;
    result += point;
  }
  return result;
}
export function queryMemorySnapshot(
  database: DatabaseSync,
  input: MemorySearchInput,
  search: boolean,
): MemorySearchPage {
  input = validatedSearchInput(input);
  const scopes = input.scopes.map((scope) => memoryScopeSchema.parse(scope));
  const scopeKeys = scopes.map(keyFor);
  if (new Set(scopeKeys).size !== scopeKeys.length) throw new Error('memory-limit');
  const query = normalizeMemoryText(input.query ?? '');
  const tag = input.tag === undefined ? undefined : normalizeMemoryText(input.tag);
  if ([...query].length > 512 || Buffer.byteLength(query) > 2048) throw new Error('memory-limit');
  const placeholders = scopeKeys.map(() => '?').join(',');
  database.exec('BEGIN');
  try {
    const scopeHeads = scopes.map((scope) => {
      const row = database
        .prepare('SELECT sequence FROM memory_scope_heads WHERE scope_key = ?')
        .get(keyFor(scope));
      if (
        row &&
        (typeof row.sequence !== 'number' ||
          !Number.isSafeInteger(row.sequence) ||
          row.sequence < 0)
      )
        throw new Error('memory-persistence-error');
      return { scope, sequence: row?.sequence === undefined ? 0 : Number(row.sequence) };
    });
    if (search) {
      const count = database
        .prepare(
          `SELECT count(*) AS n, coalesce(sum(length(CAST(json_extract(current_json,'$.content') AS BLOB))),0) AS bytes FROM memory_current WHERE scope_key IN (${placeholders}) AND deleted = 0`,
        )
        .get(...scopeKeys);
      if (!count || typeof count.n !== 'number' || typeof count.bytes !== 'number')
        throw new Error('memory-persistence-error');
      if (count.n > 10000 || count.bytes > 83_886_080) throw new Error('memory-limit');
    }
    const params: (string | number)[] = [...scopeKeys];
    let filters = input.includeAgentAuthored ? '' : " AND review = 'user-reviewed'";
    if (tag !== undefined) {
      filters += ' AND EXISTS (SELECT 1 FROM json_each(tags_normalized) WHERE value = ?)';
      params.push(tag);
    }
    if (search && query) {
      filters +=
        ' AND (instr(title_normalized, ?) > 0 OR instr(content_normalized, ?) > 0 OR EXISTS (SELECT 1 FROM json_each(tags_normalized) WHERE instr(value, ?) > 0))';
      params.push(query, query, query);
    }
    // List admits bounded indexed rows. Search performs its bounded scan in this worker snapshot.
    const after = input.after;
    if (!search && after) {
      filters +=
        " AND (updated_at < ? OR (updated_at = ? AND (CASE WHEN scope_key = 'user' THEN 1 ELSE 0 END > ? OR (CASE WHEN scope_key = 'user' THEN 1 ELSE 0 END = ? AND memory_id > ?))))";
      params.push(
        after.updatedAt,
        after.updatedAt,
        after.scopeRank,
        after.scopeRank,
        after.memoryId,
      );
    }
    const rows = database
      .prepare(
        `SELECT current_json FROM memory_current WHERE scope_key IN (${placeholders}) AND deleted = 0${filters} ORDER BY updated_at DESC, CASE WHEN scope_key = 'user' THEN 1 ELSE 0 END, memory_id COLLATE BINARY${search ? '' : ' LIMIT ?'}`,
      )
      .all(...params, ...(search ? [] : [input.limit + 1]));
    const records: { current: MemoryCurrent; key: MemorySortKey }[] = rows
      .map((row) => {
        if (typeof row.current_json !== 'string') throw new Error('memory-persistence-error');
        const current = memoryCurrentSchema.parse(JSON.parse(row.current_json) as unknown);
        if (!scopeKeys.includes(keyFor(current.ref.scope)))
          throw new Error('memory-persistence-error');
        return {
          current,
          key: {
            titleHit: search && query && normalizeMemoryText(current.title).includes(query) ? 1 : 0,
            updatedAt: current.updatedAt,
            scopeRank: current.ref.scope.kind === 'user' ? 1 : 0,
            memoryId: current.ref.memoryId,
          },
        };
      })
      .sort((a, b) => compareMemoryKeys(a.key, b.key))
      .filter((item) => !search || !after || compareMemoryKeys(item.key, after) > 0);
    const page = records.slice(0, input.limit);
    database.exec('COMMIT');
    return {
      entries: page.map(({ current }) => {
        const { content, ...summary } = current;
        return { ...summary, excerpt: excerpt(content) };
      }),
      keys: page.map((item) => item.key),
      scopeHeads,
      hasMore: records.length > page.length,
    };
  } catch (error) {
    if (database.isTransaction) database.exec('ROLLBACK');
    throw error;
  }
}
if (parentPort) {
  let database: DatabaseSync | undefined;
  try {
    const input = z
      .strictObject({ filename: z.string().min(1), input: z.unknown() })
      .parse(workerData);
    database = new DatabaseSync(input.filename, { readOnly: true });
    database.exec('PRAGMA query_only = ON');
    const page = queryMemorySnapshot(database, validatedSearchInput(input.input), true);
    parentPort.postMessage({ ok: true, page });
  } catch (error) {
    parentPort.postMessage({
      ok: false,
      code:
        error instanceof Error && error.message === 'memory-limit'
          ? 'memory-limit'
          : 'memory-persistence-error',
    });
  } finally {
    database?.close();
  }
}
