import { mkdtempSync, rmSync, symlinkSync, linkSync, unlinkSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { createSqliteMemoryStore, memoryContentDigest } from '../src/index.js';
import type { MemoryCommitGuard, MemoryMutation, MemoryStore } from '../src/types.js';
import type { MemoryRef } from '@weave/protocol';

const dirs: string[] = [];
const stores: MemoryStore[] = [];
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const scope = { kind: 'project' as const, projectId: 'd495a6df-265d-4fc7-93c8-a4452c197b62' };
const otherScope = { kind: 'user' as const };
const provenance = { actor: 'local-user' as const };
const guard: MemoryCommitGuard = {
  assertAuthorized() {},
  assertNewMutation() {},
  beforeCommit() {},
};
const content = { title: 'Remember', content: 'Use strict TypeScript', tags: ['dev'] };
const key = (
  requestId = randomUUID(),
  selectedScope = scope as typeof scope | typeof otherScope,
) => ({ scope: selectedScope, requestId, callerKey: 'local-user', digest: 'a'.repeat(64) });
const create = (): MemoryMutation => ({
  kind: 'create',
  key: key(),
  provenance,
  content,
  expectedRevision: 0,
});
function open() {
  const dir = mkdtempSync(join(tmpdir(), 'weave-memory-'));
  dirs.push(dir);
  const filename = join(dir, 'memory.sqlite');
  const store = createSqliteMemoryStore({ filename });
  stores.push(store);
  return { filename, store, dir };
}
function ref(receipt: ReturnType<MemoryStore['commit']>): MemoryRef {
  if (!('sha256' in receipt.result)) throw new Error('Expected ref');
  return receipt.result;
}

describe('append-only SQLite memory', () => {
  it('rebuilds content/access/receipt projections from facts after terminal deletion', async () => {
    const { store, filename } = open();
    const initial = create();
    const first = store.commit(initial, guard);
    const firstRef = ref(first);
    const revised = ref(
      store.commit(
        {
          kind: 'revise',
          key: key(),
          provenance: {
            actor: 'agent',
            sessionId: 's',
            executionId: 'e',
            turnId: 't',
            toolCallId: 'c',
          },
          memoryId: firstRef.memoryId,
          expectedRevision: 1,
          content,
        },
        guard,
      ),
    );
    expect(store.read(scope, firstRef.memoryId)?.review).toBe('agent-authored');
    const reviewed = ref(
      store.commit({ kind: 'review', key: key(), provenance, targetRef: revised }, guard),
    );
    expect(reviewed.revision).toBe(3);
    expect(reviewed.sha256).toBe(revised.sha256);
    const deleted = store.commit(
      { kind: 'remove', key: key(), provenance, memoryId: firstRef.memoryId, expectedRevision: 3 },
      guard,
    );
    expect(deleted.result).toEqual({ memoryId: firstRef.memoryId, revision: 4, deleted: true });
    expect(store.read(scope, firstRef.memoryId)).toBeUndefined();
    expect(store.readRevision(firstRef)?.content).toBe(content.content);
    expect(store.history(scope, firstRef.memoryId).map((entry) => entry.kind)).toEqual([
      'deleted',
      'reviewed',
      'revised',
      'created',
    ]);
    expect(() =>
      store.commit({ kind: 'review', key: key(), provenance, targetRef: reviewed }, guard),
    ).toThrow(expect.objectContaining({ code: 'memory-not-found' }));
    const access = store.commit(
      {
        kind: 'setAccess',
        key: key(),
        provenance,
        level: 'read-write',
        expectedSettingRevision: 0,
      },
      guard,
    );
    store.rebuild();
    expect(store.lookupReceipt(initial.key)).toEqual(first);
    expect(store.getAccess(scope).settingRevision).toBe(1);
    await store.close();
    const reopened = createSqliteMemoryStore({ filename });
    stores.push(reopened);
    expect(reopened.lookupReceipt(initial.key)).toEqual(first);
    expect(reopened.getAccess(scope)).toEqual(access.result);
    expect(reopened.read(scope, firstRef.memoryId)).toBeUndefined();
  });
  it('authorizes replay before receipt lookup and admits new CAS before invalidation', () => {
    const { store } = open();
    const mutation = create();
    const order: string[] = [];
    const ordered = {
      assertAuthorized() {
        order.push('authorized');
      },
      assertNewMutation() {
        order.push('CAS');
      },
      beforeCommit() {
        order.push('beforeCommit');
      },
    };
    const receipt = store.commit(mutation, ordered);
    expect(order).toEqual(['authorized', 'CAS', 'beforeCommit']);
    order.length = 0;
    expect(store.commit(mutation, ordered)).toEqual(receipt);
    expect(order).toEqual(['authorized']);
    expect(() =>
      store.commit(mutation, {
        ...guard,
        assertAuthorized() {
          throw new Error('denied');
        },
      }),
    ).toThrow('denied');
    expect(() =>
      store.commit({ ...mutation, key: { ...mutation.key, digest: 'b'.repeat(64) } }, guard),
    ).toThrow(expect.objectContaining({ code: 'memory-request-conflict' }));
    const current = ref(receipt);
    store.commit(
      {
        kind: 'revise',
        key: key(),
        provenance,
        memoryId: current.memoryId,
        expectedRevision: 1,
        content,
      },
      guard,
    );
    expect(() =>
      store.commit(
        {
          kind: 'revise',
          key: key(),
          provenance,
          memoryId: current.memoryId,
          expectedRevision: 1,
          content,
        },
        guard,
      ),
    ).toThrow(expect.objectContaining({ code: 'memory-stale-revision' }));
  });
  it('rolls back failed precommit and changes no head or request receipt', () => {
    const { store } = open();
    const mutation = create();
    expect(() =>
      store.commit(mutation, {
        ...guard,
        beforeCommit() {
          throw new Error('consumer failure');
        },
      }),
    ).toThrow('consumer failure');
    expect(store.lookupReceipt(mutation.key)).toBeUndefined();
    expect(store.getScopeHead(scope)).toBe(0);
    expect(store.list({ scopes: [scope], limit: 50 }).entries).toEqual([]);
  });
  it('reconciles committed-then-thrown exact receipts and fences uncertain outcomes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'weave-memory-'));
    dirs.push(dir);
    let throwCommit = false;
    let failRead = false;
    class FaultDatabase extends DatabaseSync {
      override exec(sql: string) {
        super.exec(sql);
        if (sql === 'COMMIT' && throwCommit) {
          throwCommit = false;
          throw new Error('response lost');
        }
      }
      override prepare(sql: string) {
        if (failRead && sql.includes('memory_requests') && sql.startsWith('SELECT'))
          throw new Error('read unavailable');
        return super.prepare(sql);
      }
    }
    const store = createSqliteMemoryStore({
      filename: join(dir, 'memory.sqlite'),
      databaseFactory: (filename) => new FaultDatabase(filename),
    });
    stores.push(store);
    const first = create();
    throwCommit = true;
    expect(store.commit(first, guard).sequence).toBe(1);
    const second = create();
    throwCommit = true;
    failRead = true;
    // The receipt lookup inside the transaction must still run before simulated readback loss.
    failRead = false;
    let fenceAfterCommit = true;
    const faultGuard = {
      ...guard,
      beforeCommit() {
        if (fenceAfterCommit) {
          failRead = true;
          fenceAfterCommit = false;
        }
      },
    };
    expect(() => store.commit(second, faultGuard)).toThrow(
      expect.objectContaining({ code: 'memory-persistence-uncertain' }),
    );
    expect(() => store.read(scope, 'd495a6df-265d-4fc7-93c8-a4452c197b62')).toThrow(
      expect.objectContaining({ code: 'memory-persistence-uncertain' }),
    );
    expect(() => store.commit(create(), guard)).toThrow(
      expect.objectContaining({ code: 'memory-persistence-uncertain' }),
    );
    failRead = false;
    const recovered = store.lookupReceipt(second.key);
    expect(recovered?.sequence).toBe(2);
    expect(store.getScopeHead(scope)).toBe(2);
    expect(store.commit(second, guard)).toEqual(recovered);
    expect(store.history(scope, ref(recovered!).memoryId)).toHaveLength(1);
  });
  it.each(['commit', 'rollback'] as const)(
    'reconciles only the original Agent request after an uncertain %s',
    (mode) => {
      const dir = mkdtempSync(join(tmpdir(), 'weave-memory-'));
      dirs.push(dir);
      let active = false;
      let unreadable = false;
      class UncertainDatabase extends DatabaseSync {
        override exec(sql: string) {
          if (active && sql === 'COMMIT' && mode === 'rollback') {
            active = false;
            unreadable = true;
            throw new Error('commit failed');
          }
          super.exec(sql);
          if (active && sql === 'COMMIT') {
            active = false;
            unreadable = true;
            throw new Error('commit response lost');
          }
        }
        override prepare(sql: string) {
          if (unreadable && sql.startsWith('SELECT') && sql.includes('memory_requests'))
            throw new Error('readback unavailable');
          return super.prepare(sql);
        }
      }
      const store = createSqliteMemoryStore({
        filename: join(dir, 'memory.sqlite'),
        databaseFactory: (filename) => new UncertainDatabase(filename),
      });
      stores.push(store);
      const agent = {
        actor: 'agent' as const,
        sessionId: 's',
        executionId: 'e',
        turnId: 't',
        toolCallId: 'c',
      };
      const mutation = { ...create(), provenance: agent };
      active = true;
      expect(() => store.commit(mutation, guard)).toThrow(
        expect.objectContaining({ code: 'memory-persistence-uncertain' }),
      );
      expect(() => store.lookupReceipt({ ...mutation.key, requestId: randomUUID() })).toThrow(
        expect.objectContaining({ code: 'memory-persistence-uncertain' }),
      );
      expect(() =>
        store.commit({ ...mutation, key: { ...mutation.key, scope: otherScope } }, guard),
      ).toThrow(expect.objectContaining({ code: 'memory-persistence-uncertain' }));
      unreadable = false;
      const receipt = store.lookupReceipt(mutation.key);
      if (mode === 'commit') {
        expect(receipt?.sequence).toBe(1);
        expect(store.commit(mutation, guard)).toEqual(receipt);
      } else {
        expect(receipt).toBeUndefined();
        expect(store.getScopeHead(scope)).toBe(0);
        expect(store.commit(mutation, guard).sequence).toBe(1);
      }
      const db = new DatabaseSync(join(dir, 'memory.sqlite'), { readOnly: true });
      expect(db.prepare('SELECT count(*) AS n FROM memory_events').get()?.n).toBe(1);
      db.close();
    },
  );
  it('blocks every scope while an uncertain transaction remains open and retries rollback only', () => {
    const dir = mkdtempSync(join(tmpdir(), 'weave-memory-'));
    dirs.push(dir);
    let rejectCommit = false;
    let rejectRollback = false;
    class InterruptedDatabase extends DatabaseSync {
      override exec(sql: string) {
        if (sql === 'COMMIT' && rejectCommit) {
          rejectCommit = false;
          rejectRollback = true;
          throw new Error('commit rejected');
        }
        if (sql === 'ROLLBACK' && rejectRollback) throw new Error('rollback temporarily failed');
        super.exec(sql);
      }
    }
    const store = createSqliteMemoryStore({
      filename: join(dir, 'memory.sqlite'),
      databaseFactory: (filename) => new InterruptedDatabase(filename),
    });
    stores.push(store);
    const mutation = create();
    rejectCommit = true;
    expect(() => store.commit(mutation, guard)).toThrow(
      expect.objectContaining({ code: 'memory-persistence-uncertain' }),
    );
    expect(() => store.getAccess(otherScope)).toThrow(
      expect.objectContaining({ code: 'memory-persistence-uncertain' }),
    );
    rejectRollback = false;
    expect(store.lookupReceipt(mutation.key)).toBeUndefined();
    expect(store.getScopeHead(scope)).toBe(0);
    expect(store.commit(mutation, guard).sequence).toBe(1);
  });
  it('preserves access setting revision on same-level changes and cross-scope isolation', () => {
    const { store } = open();
    const request = key();
    store.commit(
      {
        kind: 'setAccess',
        key: request,
        provenance,
        level: 'read-only',
        expectedSettingRevision: 0,
      },
      guard,
    );
    const next = store.commit(
      { kind: 'setAccess', key: key(), provenance, level: 'read-only', expectedSettingRevision: 1 },
      guard,
    );
    expect(next.result).toEqual({ scope, level: 'read-only', settingRevision: 2 });
    expect(store.getAccess(otherScope).settingRevision).toBe(0);
    expect(() =>
      store.commit(
        { kind: 'create', key: request, provenance, content, expectedRevision: 0 },
        guard,
      ),
    ).toThrow(expect.objectContaining({ code: 'memory-request-conflict' }));
    const agent = {
      actor: 'agent' as const,
      sessionId: 's',
      executionId: 'e',
      turnId: 't',
      toolCallId: 'c',
    };
    const agentKey = { ...key(), callerKey: 'agent:s:e:t:c' };
    store.commit(
      { kind: 'create', key: agentKey, provenance: agent, content, expectedRevision: 0 },
      guard,
    );
    expect(() =>
      store.commit(
        {
          kind: 'create',
          key: { ...agentKey, scope: otherScope },
          provenance: agent,
          content,
          expectedRevision: 0,
        },
        guard,
      ),
    ).toThrow(expect.objectContaining({ code: 'memory-request-conflict' }));
  });
  it('deduplicates create and revise as one Agent save invocation across scopes', () => {
    const { store } = open();
    const original = ref(store.commit({ ...create(), key: key(randomUUID(), otherScope) }, guard));
    const agent = {
      actor: 'agent' as const,
      sessionId: 's',
      executionId: 'e',
      turnId: 't',
      toolCallId: 'same-save',
    };
    const agentKey = { ...key(), callerKey: 'agent-save' };
    store.commit({ ...create(), key: agentKey, provenance: agent }, guard);
    expect(() =>
      store.commit(
        {
          kind: 'revise',
          key: { ...agentKey, scope: otherScope },
          provenance: agent,
          memoryId: original.memoryId,
          expectedRevision: 1,
          content,
        },
        guard,
      ),
    ).toThrow(expect.objectContaining({ code: 'memory-request-conflict' }));
    expect(store.read(otherScope, original.memoryId)?.ref.revision).toBe(1);
  });
  it('locks a canonical owner before opening WAL and detects replacement', async () => {
    const { store, filename, dir } = open();
    const first = store.commit(create(), guard);
    expect(() => createSqliteMemoryStore({ filename })).toThrow(
      expect.objectContaining({ code: 'memory-busy' }),
    );
    const alias = `${dir}-alias`;
    symlinkSync(dir, alias);
    try {
      expect(() => createSqliteMemoryStore({ filename: join(alias, 'memory.sqlite') })).toThrow(
        expect.objectContaining({ code: 'memory-busy' }),
      );
    } finally {
      unlinkSync(alias);
    }
    const reader = new DatabaseSync(filename, { readOnly: true });
    expect(reader.prepare('SELECT count(*) AS n FROM memory_events').get()?.n).toBe(1);
    reader.close();
    await store.close();
    const reopened = createSqliteMemoryStore({ filename });
    stores.push(reopened);
    expect(reopened.getScopeHead(scope)).toBe(first.sequence);
    unlinkSync(`${filename}.owner.sqlite`);
    expect(() => reopened.commit(create(), guard)).toThrow(
      expect.objectContaining({ code: 'memory-persistence-error' }),
    );
  });
  it('permanently fences an owner after observing file identity loss', () => {
    const { store, filename } = open();
    const ownerFile = `${filename}.owner.sqlite`;
    renameSync(ownerFile, `${ownerFile}.moved`);
    expect(() => store.commit(create(), guard)).toThrow(
      expect.objectContaining({ code: 'memory-persistence-error' }),
    );
    renameSync(`${ownerFile}.moved`, ownerFile);
    expect(() => store.commit(create(), guard)).toThrow(
      expect.objectContaining({ code: 'memory-persistence-error' }),
    );
  });
  it('rejects symlink/hardlink file identities and invalid persisted events', async () => {
    const { store, filename, dir } = open();
    await store.close();
    const link = join(dir, 'hard.sqlite');
    linkSync(filename, link);
    expect(() => createSqliteMemoryStore({ filename: link })).toThrow(
      expect.objectContaining({ code: 'memory-persistence-error' }),
    );
    unlinkSync(link);
    const symbolic = join(dir, 'symbolic.sqlite');
    symlinkSync(filename, symbolic);
    expect(() => createSqliteMemoryStore({ filename: symbolic })).toThrow(
      expect.objectContaining({ code: 'memory-persistence-error' }),
    );
    const reopened = createSqliteMemoryStore({ filename });
    stores.push(reopened);
    reopened.commit(create(), guard);
    await reopened.close();
    const db = new DatabaseSync(filename);
    expect(() => db.exec('UPDATE memory_events SET version = 2')).toThrow();
    db.exec('DROP TRIGGER memory_events_no_update');
    db.exec('UPDATE memory_events SET version = 2');
    db.close();
    expect(() => createSqliteMemoryStore({ filename })).toThrow(
      expect.objectContaining({ code: 'memory-persistence-error' }),
    );
  });
  it('rejects symbolic SQLite sidecars before opening the data connection', async () => {
    const { store, filename, dir } = open();
    await store.close();
    const target = join(dir, 'target');
    const db = new DatabaseSync(target);
    db.close();
    symlinkSync(target, `${filename}-wal`);
    let dataOpened = false;
    expect(() =>
      createSqliteMemoryStore({
        filename,
        databaseFactory: (file) => {
          dataOpened = true;
          return new DatabaseSync(file);
        },
      }),
    ).toThrow(expect.objectContaining({ code: 'memory-persistence-error' }));
    expect(dataOpened).toBe(false);
    unlinkSync(`${filename}-wal`);
    symlinkSync(target, `${filename}.owner.sqlite-journal`);
    expect(() => createSqliteMemoryStore({ filename })).toThrow(
      expect.objectContaining({ code: 'memory-persistence-error' }),
    );
  });
  it('hashes all normalized content fields and keeps SQL-shaped content inert', () => {
    expect(memoryContentDigest(content)).not.toBe(
      memoryContentDigest({ ...content, title: 'Changed' }),
    );
    expect(memoryContentDigest(content)).not.toBe(
      memoryContentDigest({ ...content, tags: ['other'] }),
    );
    const { store } = open();
    const mutation = {
      ...create(),
      content: {
        title: "'; DROP TABLE memory_events; --",
        content: 'SELECT * FROM memory_events',
        tags: [],
      },
    };
    const saved = ref(store.commit(mutation, guard));
    expect(store.read(scope, saved.memoryId)?.title).toBe(mutation.content.title);
    expect(store.getScopeHead(scope)).toBe(1);
  });
});
