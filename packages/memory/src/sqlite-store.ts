import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import {
  memoryAccessLevelSchema,
  memoryAccessSchema,
  memoryContentSchema,
  memoryCurrentSchema,
  memoryIdSchema,
  memoryProvenanceSchema,
  memoryRefSchema,
  memoryScopeSchema,
  type MemoryAccess,
  type MemoryCurrent,
  type MemoryHistoryEntry,
  type MemoryReceipt,
  type MemoryScope,
} from '@weave/protocol';
import { acquireMemoryOwnership } from './ownership.js';
import {
  agentInvocation,
  memoryContentDigest,
  memoryRequestKeySchema,
  parseMemoryEvent,
  scopeKey,
} from './projection.js';
import { MemoryStoreError, MemoryStoreStartupError, persistence } from './errors.js';
import { createMemorySearchManager, type MemorySearchWorkerFactory } from './search.js';
import { queryMemorySnapshot } from './search-worker.js';
import type {
  MemoryCommitGuard,
  MemoryEvent,
  MemoryMutation,
  MemoryRequestKey,
  MemoryStore,
} from './types.js';

const sql = `
CREATE TABLE memory_events (sequence INTEGER PRIMARY KEY, event_id TEXT NOT NULL UNIQUE, version INTEGER NOT NULL, kind TEXT NOT NULL, occurred_at TEXT NOT NULL, subject_json TEXT NOT NULL, payload_json TEXT NOT NULL);
CREATE INDEX memory_events_by_record ON memory_events(json_extract(subject_json,'$.scope.kind'),json_extract(subject_json,'$.scope.projectId'),json_extract(subject_json,'$.memoryId'),json_extract(subject_json,'$.revision') DESC);
CREATE TRIGGER memory_events_no_update BEFORE UPDATE ON memory_events BEGIN SELECT RAISE(ABORT, 'memory events are append-only'); END;
CREATE TRIGGER memory_events_no_delete BEFORE DELETE ON memory_events BEGIN SELECT RAISE(ABORT, 'memory events are append-only'); END;
CREATE TABLE memory_current (scope_key TEXT NOT NULL, memory_id TEXT NOT NULL, revision INTEGER NOT NULL, deleted INTEGER NOT NULL, current_json TEXT, updated_at TEXT NOT NULL, normalizer_version INTEGER NOT NULL, review TEXT, title_normalized TEXT, content_normalized TEXT, tags_normalized TEXT, PRIMARY KEY (scope_key,memory_id));
CREATE INDEX memory_current_by_scope_order ON memory_current(scope_key,deleted,updated_at DESC,memory_id);
CREATE TABLE memory_requests (scope_key TEXT NOT NULL, request_id TEXT NOT NULL, caller_key TEXT NOT NULL, digest TEXT NOT NULL, operation TEXT NOT NULL, invocation_key TEXT UNIQUE, event_sequence INTEGER NOT NULL UNIQUE, PRIMARY KEY(scope_key,request_id));
CREATE TABLE memory_access_current (scope_key TEXT PRIMARY KEY, access_json TEXT NOT NULL);
CREATE TABLE memory_scope_heads (scope_key TEXT PRIMARY KEY, sequence INTEGER NOT NULL);
PRAGMA user_version = 1;
`;
const base = { key: memoryRequestKeySchema, provenance: memoryProvenanceSchema };
const revision = z.number().int().positive().safe();
const mutationSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    ...base,
    kind: z.literal('create'),
    expectedRevision: z.literal(0),
    content: memoryContentSchema,
  }),
  z.strictObject({
    ...base,
    kind: z.literal('revise'),
    memoryId: memoryIdSchema,
    expectedRevision: revision,
    content: memoryContentSchema,
  }),
  z.strictObject({ ...base, kind: z.literal('review'), targetRef: memoryRefSchema }),
  z.strictObject({
    ...base,
    kind: z.literal('remove'),
    memoryId: memoryIdSchema,
    expectedRevision: revision,
    reason: z.string().max(1024).optional(),
  }),
  z.strictObject({
    ...base,
    kind: z.literal('setAccess'),
    level: memoryAccessLevelSchema,
    expectedSettingRevision: z.number().int().nonnegative().safe(),
  }),
]);
function exact(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
function requireNumber(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw persistence();
  return value;
}
function requireString(value: unknown): string {
  if (typeof value !== 'string') throw persistence();
  return value;
}
function eventFromRow(row: Record<string, unknown>): MemoryEvent {
  try {
    const event = parseMemoryEvent(JSON.parse(requireString(row.payload_json)) as unknown);
    if (
      event.sequence !== row.sequence ||
      event.eventId !== row.event_id ||
      event.version !== row.version ||
      event.kind !== row.kind ||
      event.occurredAt !== row.occurred_at ||
      !exact(event.subject, JSON.parse(requireString(row.subject_json)) as unknown)
    )
      throw persistence();
    return event;
  } catch (error) {
    throw persistence(error);
  }
}
function readEvents(database: DatabaseSync): MemoryEvent[] {
  return database.prepare('SELECT * FROM memory_events ORDER BY sequence').all().map(eventFromRow);
}
function accessFor(database: DatabaseSync, scope: MemoryScope): MemoryAccess {
  const row = database
    .prepare('SELECT access_json FROM memory_access_current WHERE scope_key = ?')
    .get(scopeKey(scope));
  return row === undefined
    ? { scope, level: 'disabled', settingRevision: 0 }
    : memoryAccessSchema.parse(JSON.parse(requireString(row.access_json)) as unknown);
}
function currentFor(
  database: DatabaseSync,
  scope: MemoryScope,
  memoryId: string,
): MemoryCurrent | undefined {
  const row = database
    .prepare(
      'SELECT current_json, deleted FROM memory_current WHERE scope_key = ? AND memory_id = ?',
    )
    .get(scopeKey(scope), memoryId);
  return !row || row.deleted === 1
    ? undefined
    : memoryCurrentSchema.parse(JSON.parse(requireString(row.current_json)) as unknown);
}
function applyEvent(database: DatabaseSync, event: MemoryEvent): void {
  const key = scopeKey(event.subject.scope);
  if (event.subject.kind === 'scope-access') {
    database
      .prepare(
        'INSERT INTO memory_access_current(scope_key,access_json) VALUES (?,?) ON CONFLICT(scope_key) DO UPDATE SET access_json = excluded.access_json',
      )
      .run(key, JSON.stringify(event.access));
  } else {
    const c = event.current;
    database
      .prepare(
        `INSERT INTO memory_current(scope_key,memory_id,revision,deleted,current_json,updated_at,normalizer_version,review,title_normalized,content_normalized,tags_normalized) VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(scope_key,memory_id) DO UPDATE SET revision=excluded.revision,deleted=excluded.deleted,current_json=excluded.current_json,updated_at=excluded.updated_at,normalizer_version=excluded.normalizer_version,review=excluded.review,title_normalized=excluded.title_normalized,content_normalized=excluded.content_normalized,tags_normalized=excluded.tags_normalized`,
      )
      .run(
        key,
        event.subject.memoryId,
        event.subject.revision,
        c ? 0 : 1,
        c ? JSON.stringify(c) : null,
        event.occurredAt,
        1,
        c?.review ?? null,
        c?.title.normalize('NFKC').toLowerCase() ?? null,
        c?.content.normalize('NFKC').toLowerCase() ?? null,
        c ? JSON.stringify(c.tags.map((tag) => tag.normalize('NFKC').toLowerCase())) : null,
      );
  }
  database
    .prepare(
      'INSERT INTO memory_requests(scope_key,request_id,caller_key,digest,operation,invocation_key,event_sequence) VALUES (?,?,?,?,?,?,?)',
    )
    .run(
      key,
      event.key.requestId,
      event.key.callerKey,
      event.key.digest,
      event.operation,
      agentInvocation(event) ?? null,
      event.sequence,
    );
  database
    .prepare(
      'INSERT INTO memory_scope_heads(scope_key,sequence) VALUES (?,?) ON CONFLICT(scope_key) DO UPDATE SET sequence=excluded.sequence',
    )
    .run(key, event.sequence);
}
function verifyHistory(events: readonly MemoryEvent[]): void {
  const current = new Map<string, MemoryEvent>();
  const access = new Map<string, number>();
  const requests = new Set<string>();
  const invocations = new Set<string>();
  let last = 0;
  for (const event of events) {
    if (event.sequence <= last) throw persistence();
    last = event.sequence;
    const scope = scopeKey(event.subject.scope);
    const request = `${scope}:${event.key.requestId}`;
    if (requests.has(request)) throw persistence();
    requests.add(request);
    const invocation = agentInvocation(event);
    if (invocation && invocations.has(invocation)) throw persistence();
    if (invocation) invocations.add(invocation);
    if (event.subject.kind === 'scope-access') {
      const previous = access.get(scope) ?? 0;
      if (event.subject.settingRevision !== previous + 1) throw persistence();
      access.set(scope, event.subject.settingRevision);
      continue;
    }
    const id = `${scope}:${event.subject.memoryId}`;
    const previous = current.get(id);
    if (
      !previous
        ? event.kind !== 'created' || event.subject.revision !== 1
        : previous.kind === 'deleted' ||
          previous.subject.kind !== 'record' ||
          event.subject.revision !== previous.subject.revision + 1 ||
          !exact(event.previousRef, previous.current?.ref)
    )
      throw persistence();
    if (
      event.kind === 'reviewed' &&
      (!previous?.current ||
        !event.current ||
        event.current.ref.sha256 !== previous.current.ref.sha256 ||
        event.current.createdAt !== previous.current.createdAt)
    )
      throw persistence();
    current.set(id, event);
  }
}
export interface SqliteMemoryStoreOptions {
  readonly filename: string;
  readonly databaseFactory?: (filename: string) => DatabaseSync;
  readonly searchWorkerFactory?: MemorySearchWorkerFactory;
}
export function createSqliteMemoryStore(options: SqliteMemoryStoreOptions): MemoryStore {
  const owner = acquireMemoryOwnership(options.filename);
  let database: DatabaseSync;
  try {
    owner.assertHeldSync();
    database = options.databaseFactory?.(owner.filename) ?? new DatabaseSync(owner.filename);
    database.exec('PRAGMA busy_timeout = 1000');
    database.exec('PRAGMA journal_mode = WAL');
    database.exec('PRAGMA foreign_keys = ON');
    const version = requireNumber(database.prepare('PRAGMA user_version').get()?.user_version);
    if (version !== 0 && version !== 1) throw persistence();
    if (version === 0) {
      const tables = database.prepare("SELECT name FROM sqlite_schema WHERE type='table'").all();
      if (tables.length) throw persistence();
      database.exec('BEGIN IMMEDIATE');
      database.exec(sql);
      database.exec('COMMIT');
    }
    owner.assertHeldSync();
    const events = readEvents(database);
    verifyHistory(events);
    // A persisted projection mismatch fails closed; explicit rebuild is the recovery operation.
    const expected = new DatabaseSync(':memory:');
    expected.exec(sql);
    for (const event of events) applyEvent(expected, event);
    try {
      for (const table of [
        'memory_current',
        'memory_requests',
        'memory_access_current',
        'memory_scope_heads',
      ]) {
        const sort =
          table === 'memory_requests'
            ? 'scope_key,request_id'
            : table === 'memory_current'
              ? 'scope_key,memory_id'
              : 'scope_key';
        if (
          !exact(
            database.prepare(`SELECT * FROM ${table} ORDER BY ${sort}`).all(),
            expected.prepare(`SELECT * FROM ${table} ORDER BY ${sort}`).all(),
          )
        )
          throw persistence();
      }
    } finally {
      expected.close();
    }
  } catch (error) {
    let released = false;
    const closeAcquired = () => {
      if (released) return;
      if (typeof database !== 'undefined' && database.isOpen) database.close();
      if (typeof database !== 'undefined' && database.isOpen) throw persistence();
      owner.close();
      released = true;
    };
    try {
      closeAcquired();
    } catch (cleanupError) {
      // Construction exposed no operations or workers. Retain the acquired
      // connections until this exact cleanup can finish, in data/owner order.
      const cleanup = Object.freeze({
        closeSync() {},
        async drain() {},
        async close() {
          try {
            closeAcquired();
          } catch (cause) {
            throw persistence(cause);
          }
        },
      });
      throw new MemoryStoreStartupError(cleanup, {
        cause: new AggregateError([error, cleanupError], 'Memory startup cleanup failed'),
      });
    }
    throw persistence(error);
  }
  const searchers = createMemorySearchManager(owner.filename, options.searchWorkerFactory);
  let closing = false;
  let closed = false;
  const pending = new Map<string, MemoryRequestKey>();
  const pendingInvocations = new Map<string, string>();
  function assertOpen(allowClosing = false) {
    if (closed || (!allowClosing && closing)) throw persistence();
    owner.assertHeldSync();
  }
  function assertReadable(scope: MemoryScope) {
    assertOpen();
    memoryScopeSchema.parse(scope);
    if (database.isTransaction || pending.has(scopeKey(scope)))
      throw new MemoryStoreError('memory-persistence-uncertain');
  }
  function receiptLookup(key: MemoryRequestKey): MemoryReceipt | undefined {
    const row = database
      .prepare('SELECT * FROM memory_requests WHERE scope_key = ? AND request_id = ?')
      .get(scopeKey(key.scope), key.requestId);
    if (!row) return undefined;
    if (row.caller_key !== key.callerKey || row.digest !== key.digest)
      throw new MemoryStoreError('memory-request-conflict');
    const eventRow = database
      .prepare('SELECT * FROM memory_events WHERE sequence = ?')
      .get(requireNumber(row.event_sequence));
    if (!eventRow) throw persistence();
    const event = eventFromRow(eventRow);
    if (
      !exact(event.key, key) ||
      event.operation !== row.operation ||
      (agentInvocation(event) ?? null) !== row.invocation_key
    )
      throw persistence();
    return event.receipt;
  }
  function clearPending(key: MemoryRequestKey) {
    pending.delete(scopeKey(key.scope));
    for (const [invocation, scope] of pendingInvocations)
      if (scope === scopeKey(key.scope)) pendingInvocations.delete(invocation);
  }
  function lookupReceipt(input: MemoryRequestKey): MemoryReceipt | undefined {
    assertOpen(true);
    const key = memoryRequestKeySchema.parse(input);
    const unresolved = pending.get(scopeKey(key.scope));
    if (unresolved && !exact(unresolved, key))
      throw new MemoryStoreError('memory-persistence-uncertain');
    try {
      // Reconciliation may finish a previously interrupted rollback, but never
      // repeats the original append or projection mutation.
      if (unresolved && database.isTransaction) database.exec('ROLLBACK');
      if (database.isTransaction) throw new MemoryStoreError('memory-persistence-uncertain');
      const receipt = receiptLookup(key);
      if (unresolved) clearPending(key);
      return receipt;
    } catch (error) {
      if (
        unresolved &&
        !(error instanceof MemoryStoreError && error.code === 'memory-request-conflict')
      )
        throw new MemoryStoreError('memory-persistence-uncertain');
      throw persistence(error);
    }
  }
  const store: MemoryStore = {
    lookupReceipt,
    commit(input, guard: MemoryCommitGuard) {
      assertOpen();
      let mutation: MemoryMutation;
      try {
        mutation = mutationSchema.parse(input);
      } catch (error) {
        throw persistence(error);
      }
      const key = mutation.key;
      const sk = scopeKey(key.scope);
      const invocation = agentInvocation({
        provenance: mutation.provenance,
        operation: mutation.kind,
      });
      if (pending.has(sk) || (invocation && pendingInvocations.has(invocation)))
        throw new MemoryStoreError('memory-persistence-uncertain');
      if (database.isTransaction) throw new MemoryStoreError('memory-persistence-uncertain');
      let attemptedWrite = false;
      try {
        database.exec('BEGIN IMMEDIATE');
        const access = accessFor(database, key.scope);
        guard.assertAuthorized(access);
        const existing = receiptLookup(key);
        if (existing) {
          if (existing.operation !== mutation.kind)
            throw new MemoryStoreError('memory-request-conflict');
          database.exec('ROLLBACK');
          return existing;
        }
        if (
          invocation &&
          database
            .prepare('SELECT event_sequence FROM memory_requests WHERE invocation_key = ?')
            .get(invocation)
        )
          throw new MemoryStoreError('memory-request-conflict');
        const memoryId =
          mutation.kind === 'create'
            ? randomUUID()
            : mutation.kind === 'review'
              ? mutation.targetRef.memoryId
              : mutation.kind === 'setAccess'
                ? undefined
                : mutation.memoryId;
        const current = memoryId ? currentFor(database, key.scope, memoryId) : undefined;
        if (mutation.kind === 'setAccess') {
          if (mutation.provenance.actor !== 'local-user')
            throw new MemoryStoreError('memory-scope-forbidden');
          if (access.settingRevision !== mutation.expectedSettingRevision)
            throw new MemoryStoreError('memory-stale-revision');
        } else if (mutation.kind !== 'create') {
          if (!current) throw new MemoryStoreError('memory-not-found');
          if (
            mutation.kind === 'review'
              ? !exact(current.ref, mutation.targetRef)
              : current.ref.revision !== mutation.expectedRevision
          )
            throw new MemoryStoreError('memory-stale-revision');
          if (mutation.kind === 'review' && mutation.provenance.actor !== 'local-user')
            throw new MemoryStoreError('memory-scope-forbidden');
        } else {
          const count = database
            .prepare('SELECT count(*) AS n FROM memory_current WHERE scope_key = ? AND deleted = 0')
            .get(sk);
          if (requireNumber(count?.n) >= 10000) throw new MemoryStoreError('memory-limit');
        }
        guard.assertNewMutation(access, current);
        const sequence =
          requireNumber(
            database
              .prepare('SELECT coalesce(max(sequence),0) AS sequence FROM memory_events')
              .get()?.sequence,
          ) + 1;
        const now = new Date().toISOString();
        const nextRevision =
          mutation.kind === 'setAccess'
            ? access.settingRevision + 1
            : (current?.ref.revision ?? 0) + 1;
        const subject: MemoryReceipt['subject'] =
          mutation.kind === 'setAccess'
            ? { kind: 'scope-access', scope: key.scope, settingRevision: nextRevision }
            : { kind: 'record', scope: key.scope, memoryId: memoryId!, revision: nextRevision };
        const nextAccess: MemoryAccess | undefined =
          mutation.kind === 'setAccess'
            ? { scope: key.scope, level: mutation.level, settingRevision: nextRevision }
            : undefined;
        const nextContent =
          mutation.kind === 'create' || mutation.kind === 'revise'
            ? mutation.content
            : mutation.kind === 'review'
              ? current
              : undefined;
        const nextCurrent: MemoryCurrent | undefined = nextContent
          ? {
              title: nextContent.title,
              content: nextContent.content,
              tags: nextContent.tags,
              ref: {
                scope: key.scope,
                memoryId: memoryId!,
                revision: nextRevision,
                sha256: memoryContentDigest({
                  title: nextContent.title,
                  content: nextContent.content,
                  tags: nextContent.tags,
                }),
              },
              createdAt: current?.createdAt ?? now,
              updatedAt: now,
              provenance: mutation.provenance,
              review: mutation.provenance.actor === 'agent' ? 'agent-authored' : 'user-reviewed',
            }
          : undefined;
        const result = nextAccess ??
          nextCurrent?.ref ?? {
            memoryId: memoryId!,
            revision: nextRevision,
            deleted: true as const,
          };
        const receipt: MemoryReceipt = {
          requestId: key.requestId,
          operation: mutation.kind,
          sequence,
          subject,
          result,
        };
        const kind = {
          create: 'created',
          revise: 'revised',
          review: 'reviewed',
          remove: 'deleted',
          setAccess: 'access-changed',
        } as const;
        const event = parseMemoryEvent({
          version: 1,
          eventId: randomUUID(),
          sequence,
          kind: kind[mutation.kind],
          occurredAt: now,
          subject,
          key,
          operation: mutation.kind,
          provenance: mutation.provenance,
          ...(current ? { previousRef: current.ref } : {}),
          ...(nextCurrent ? { current: nextCurrent } : {}),
          ...(nextAccess ? { access: nextAccess } : {}),
          ...(mutation.kind === 'remove' && mutation.reason !== undefined
            ? { reason: mutation.reason }
            : {}),
          receipt,
        });
        const callbackResult: unknown = guard.beforeCommit({
          scope: key.scope,
          ...(memoryId ? { memoryId } : {}),
        });
        if (callbackResult !== undefined) throw persistence();
        owner.assertHeldSync();
        attemptedWrite = true;
        database
          .prepare(
            'INSERT INTO memory_events(sequence,event_id,version,kind,occurred_at,subject_json,payload_json) VALUES (?,?,?,?,?,?,?)',
          )
          .run(
            sequence,
            event.eventId,
            1,
            event.kind,
            now,
            JSON.stringify(subject),
            JSON.stringify(event),
          );
        applyEvent(database, event);
        database.exec('COMMIT');
        return receipt;
      } catch (error) {
        try {
          if (database.isTransaction) database.exec('ROLLBACK');
        } catch {
          /* Reconciliation checks whether the transaction actually ended. */
        }
        if (!attemptedWrite) {
          if (database.isTransaction) {
            pending.set(sk, key);
            if (invocation) pendingInvocations.set(invocation, sk);
            throw new MemoryStoreError('memory-persistence-uncertain');
          }
          throw error;
        }
        try {
          if (database.isTransaction) throw persistence();
          const receipt = receiptLookup(key);
          if (receipt) return receipt;
        } catch {
          pending.set(sk, key);
          if (invocation) pendingInvocations.set(invocation, sk);
          throw new MemoryStoreError('memory-persistence-uncertain');
        }
        throw persistence(error);
      }
    },
    read(scope, memoryId) {
      assertReadable(scope);
      memoryIdSchema.parse(memoryId);
      try {
        return currentFor(database, scope, memoryId);
      } catch (error) {
        throw persistence(error);
      }
    },
    readRevision(input) {
      const ref = memoryRefSchema.parse(input);
      assertReadable(ref.scope);
      try {
        const rows = database
          .prepare(
            "SELECT * FROM memory_events WHERE json_extract(subject_json,'$.scope.kind') = ? AND json_extract(subject_json,'$.scope.projectId') IS ? AND json_extract(subject_json,'$.memoryId') = ? AND json_extract(subject_json,'$.revision') = ? LIMIT 1",
          )
          .all(
            ref.scope.kind,
            ref.scope.kind === 'project' ? ref.scope.projectId : null,
            ref.memoryId,
            ref.revision,
          );
        for (const row of rows) {
          const event = eventFromRow(row);
          if (event.current && exact(event.current.ref, ref)) return event.current;
        }
        return undefined;
      } catch (error) {
        throw persistence(error);
      }
    },
    history(scope, memoryId, input = {}) {
      assertReadable(scope);
      memoryIdSchema.parse(memoryId);
      const limit = input.limit ?? 20;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 20)
        throw new MemoryStoreError('memory-limit');
      const rows = database
        .prepare(
          "SELECT * FROM memory_events WHERE json_extract(subject_json,'$.scope.kind') = ? AND json_extract(subject_json,'$.scope.projectId') IS ? AND json_extract(subject_json,'$.memoryId') = ? AND json_extract(subject_json,'$.revision') < ? ORDER BY json_extract(subject_json,'$.revision') DESC LIMIT ?",
        )
        .all(
          scope.kind,
          scope.kind === 'project' ? scope.projectId : null,
          memoryId,
          input.afterRevision ?? Number.MAX_SAFE_INTEGER,
          limit,
        );
      const result: MemoryHistoryEntry[] = [];
      for (const row of rows) {
        const event = eventFromRow(row);
        if (scopeKey(event.subject.scope) !== scopeKey(scope)) continue;
        result.push({
          sequence: event.sequence,
          subject: event.subject,
          kind: event.kind,
          occurredAt: event.occurredAt,
          provenance: event.provenance,
          ...(event.current ? { ref: event.current.ref, review: event.current.review } : {}),
        });
        if (result.length === limit) break;
      }
      return result;
    },
    getAccess(scope) {
      assertReadable(scope);
      try {
        return accessFor(database, scope);
      } catch (error) {
        throw persistence(error);
      }
    },
    getScopeHead(scope) {
      assertReadable(scope);
      const row = database
        .prepare('SELECT sequence FROM memory_scope_heads WHERE scope_key = ?')
        .get(scopeKey(scope));
      return row ? requireNumber(row.sequence) : 0;
    },
    list(input) {
      for (const scope of input.scopes) assertReadable(scope);
      try {
        return queryMemorySnapshot(database, input, false);
      } catch (error) {
        if (error instanceof Error && error.message === 'memory-limit')
          throw new MemoryStoreError('memory-limit');
        throw persistence(error);
      }
    },
    async search(input, signal) {
      for (const scope of input.scopes) assertReadable(scope);
      const page = await searchers.search(input, signal);
      for (const scope of input.scopes) assertReadable(scope);
      return page;
    },
    readSnapshot(refs) {
      if (refs.length < 1 || refs.length > 48) throw new MemoryStoreError('memory-limit');
      for (const ref of refs) {
        memoryRefSchema.parse(ref);
        assertReadable(ref.scope);
      }
      database.exec('BEGIN');
      try {
        const result = refs.map((ref) => {
          const current = currentFor(database, ref.scope, ref.memoryId);
          if (!current || !exact(current.ref, ref))
            throw new MemoryStoreError('memory-stale-revision');
          return current;
        });
        database.exec('COMMIT');
        return result;
      } catch (error) {
        if (database.isTransaction) database.exec('ROLLBACK');
        throw error;
      }
    },
    rebuild() {
      assertOpen();
      if (pending.size) throw new MemoryStoreError('memory-persistence-uncertain');
      const events = readEvents(database);
      verifyHistory(events);
      database.exec('BEGIN IMMEDIATE');
      try {
        database.exec(
          'DELETE FROM memory_current; DELETE FROM memory_requests; DELETE FROM memory_access_current; DELETE FROM memory_scope_heads',
        );
        for (const event of events) applyEvent(database, event);
        database.exec('COMMIT');
      } catch (error) {
        if (database.isTransaction) database.exec('ROLLBACK');
        throw persistence(error);
      }
    },
    closeSync() {
      if (closed) return;
      closing = true;
      searchers.closeSync();
    },
    async drain() {
      if (closed) return;
      await searchers.drain();
      for (const key of [...pending.values()]) lookupReceipt(key);
      if (pending.size) throw new MemoryStoreError('memory-persistence-uncertain');
    },
    async close() {
      if (closed) return;
      store.closeSync();
      await store.drain();
      try {
        if (database.isOpen) database.close();
        owner.close();
        closed = true;
      } catch (error) {
        throw persistence(error);
      }
    },
  };
  return store;
}
