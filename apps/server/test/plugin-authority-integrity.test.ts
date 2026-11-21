import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as authorityData from '../src/plugin-authority-data.js';
import { createSqlitePluginAuthorityDatabase } from '../src/plugin-authority-store.js';
import type {
  ManagedCommitInput,
  PluginAuthorityDatabase,
  PluginAuthoritySnapshot,
} from '../src/plugin-authority-types.js';
import { activateInput, artifact, importInput } from './support/plugin-authority-fixtures.js';

const occurredAt = '2026-11-21T00:00:00.000Z';
const databaseId = '342f1f06-cf56-4921-a196-df6c3c770510';
const filenames: string[] = [];
const owners: PluginAuthorityDatabase[] = [];
const streams = [
  'plugin_trust_events',
  'plugin_install_events',
  'plugin_operation_events',
] as const;

function filename(): string {
  const result = join(tmpdir(), `weave-plugin-integrity-${randomUUID()}.sqlite`);
  filenames.push(result);
  return result;
}

function openOwner(file = filename()): PluginAuthorityDatabase {
  const owner = createSqlitePluginAuthorityDatabase({
    filename: file,
    now: () => new Date(occurredAt),
    newDatabaseId: () => databaseId,
  });
  owners.push(owner);
  return owner;
}

function withDatabase<T>(file: string, action: (database: DatabaseSync) => T): T {
  const database = new DatabaseSync(file);
  try {
    return action(database);
  } finally {
    database.close();
  }
}

function facts(file: string): unknown {
  return withDatabase(file, (database) => ({
    identity: database.prepare('SELECT * FROM plugin_authority_identity ORDER BY singleton').all(),
    streams: streams.map((table) =>
      database.prepare(`SELECT * FROM ${table} ORDER BY sequence`).all(),
    ),
  }));
}

function importCandidate(owner: PluginAuthorityDatabase): PluginAuthoritySnapshot {
  owner.commitSync(importInput('import', 0));
  return owner.snapshotSync();
}

function operationFailure(file: string): void {
  withDatabase(file, (database) =>
    database.exec(`
      CREATE TRIGGER reject_operation BEFORE INSERT ON plugin_operation_events
      BEGIN SELECT RAISE(ABORT, 'primary operation failure'); END
    `),
  );
}

async function expectUnavailable(
  owner: PluginAuthorityDatabase,
  input: ManagedCommitInput,
): Promise<void> {
  for (const action of [
    () => owner.snapshotSync(),
    () => owner.lookupSync(input.request),
    () => owner.commitSync(input),
  ]) {
    expect(action).toThrow(expect.objectContaining({ code: 'plugin-authority-closed' }));
  }
  await expect(owner.trust.events()).rejects.toMatchObject({ code: 'plugin-trust-closed' });
  await expect(owner.trust.append({ kind: 'revoked', pluginId: 'manual' })).rejects.toMatchObject({
    code: 'plugin-trust-closed',
  });
}

function caught(action: () => unknown): unknown {
  try {
    action();
  } catch (error: unknown) {
    return error;
  }
  throw new Error('Expected the authority operation to fail');
}

function expectMutationRejected(value: unknown): void {
  if (value === null || typeof value !== 'object') return;
  expect(Reflect.set(value, 'attemptedMutation', true)).toBe(false);
  for (const [key, child] of Object.entries(value)) {
    expect(Reflect.set(value, key, null)).toBe(false);
    expectMutationRejected(child);
  }
}

afterEach(async () => {
  vi.restoreAllMocks();
  vi.doUnmock('node:sqlite');
  await Promise.all(owners.splice(0).map((owner) => owner.close()));
  await Promise.all(filenames.splice(0).map((file) => rm(file, { force: true })));
});

describe('real SQLite managed atomicity', () => {
  it.each(
    streams.flatMap((table) =>
      (['ABORT', 'ROLLBACK'] as const).map((failure) => ({ table, failure })),
    ),
  )(
    'rolls back activation when $table raises $failure and preserves the exact request for retry',
    async ({ table, failure }) => {
      const file = filename();
      const owner = openOwner(file);
      const before = importCandidate(owner);
      const beforeFacts = facts(file);
      const input = activateInput('activate', before);
      withDatabase(file, (database) =>
        database.exec(`
        CREATE TRIGGER reject_write BEFORE INSERT ON ${table}
        BEGIN SELECT RAISE(${failure}, 'injected ${table} failure'); END
      `),
      );

      expect(() => owner.commitSync(input)).toThrow(
        expect.objectContaining({
          code: 'plugin-authority-storage',
          cause: expect.objectContaining({ message: `injected ${table} failure` }),
        }),
      );
      expect(owner.snapshotSync()).toEqual(before);
      expect(facts(file)).toEqual(beforeFacts);
      expect(owner.lookupSync(input.request)).toEqual({ kind: 'absent' });

      withDatabase(file, (database) => database.exec('DROP TRIGGER reject_write'));
      const result = owner.commitSync(input);
      expect(result).toMatchObject({
        kind: 'committed',
        operation: { requestId: 'activate', sequence: 2 },
        afterSnapshot: {
          heads: { installSequence: 2, trustSequence: 1, operationSequence: 2 },
        },
      });
      await owner.close();
      expect(openOwner(file).snapshotSync()).toEqual(
        result.kind === 'committed' ? result.afterSnapshot : null,
      );
    },
  );

  it('rolls back every activation fact if post-insert readback finds malformed operation JSON', () => {
    const file = filename();
    const owner = openOwner(file);
    const before = importCandidate(owner);
    const beforeFacts = facts(file);
    const input = activateInput('activate', before);
    withDatabase(file, (database) =>
      database.exec(`
        CREATE TRIGGER corrupt_operation AFTER INSERT ON plugin_operation_events
        BEGIN
          UPDATE plugin_operation_events SET event_json = '{broken' WHERE sequence = NEW.sequence;
        END
      `),
    );
    expect(() => owner.commitSync(input)).toThrow(
      expect.objectContaining({ code: 'plugin-authority-protocol' }),
    );
    expect(owner.snapshotSync()).toEqual(before);
    expect(facts(file)).toEqual(beforeFacts);
    withDatabase(file, (database) => database.exec('DROP TRIGGER corrupt_operation'));
    expect(owner.commitSync(input)).toMatchObject({
      kind: 'committed',
      operation: { sequence: 2 },
      afterSnapshot: { heads: { installSequence: 2, trustSequence: 1, operationSequence: 2 } },
    });
  });

  it('rolls back all inserted facts if final result detachment fails before COMMIT', () => {
    const file = filename();
    const owner = openOwner(file);
    const before = importCandidate(owner);
    const beforeFacts = facts(file);
    const input = activateInput('activate', before);
    const failure = new Error('final result construction failed');
    const nativeDetach = authorityData.detachAndFreeze;
    const spy = vi.spyOn(authorityData, 'detachAndFreeze').mockImplementation((value) => {
      if (
        value !== null &&
        typeof value === 'object' &&
        'kind' in value &&
        value.kind === 'committed'
      ) {
        throw failure;
      }
      return nativeDetach(value);
    });
    try {
      expect(() => owner.commitSync(input)).toThrow(
        expect.objectContaining({ code: 'plugin-authority-storage', cause: failure }),
      );
    } finally {
      spy.mockRestore();
    }
    expect(owner.snapshotSync()).toEqual(before);
    expect(facts(file)).toEqual(beforeFacts);
    expect(owner.lookupSync(input.request)).toEqual({ kind: 'absent' });
    expect(owner.commitSync(input)).toMatchObject({
      kind: 'committed',
      operation: { sequence: 2 },
      afterSnapshot: { heads: { installSequence: 2, trustSequence: 1, operationSequence: 2 } },
    });
  });
});

describe('successful and ambiguous COMMIT boundaries', () => {
  it('returns prebuilt fresh and replay results without fallible work after native COMMIT', () => {
    const file = filename();
    const owner = openOwner(file);
    const input = activateInput('activate', importCandidate(owner));
    const nativeExec = DatabaseSync.prototype.exec;
    const nativePrepare = DatabaseSync.prototype.prepare;
    const nativeDetach = authorityData.detachAndFreeze;
    const nativeCanonical = authorityData.canonicalJson;
    let phase: 'idle' | 'transaction' | 'committed' = 'idle';
    const guard = () => {
      if (phase === 'committed') throw new Error('fallible work after successful COMMIT');
    };
    const exec = vi.spyOn(DatabaseSync.prototype, 'exec').mockImplementation(function (
      this: DatabaseSync,
      sql,
    ) {
      guard();
      nativeExec.call(this, sql);
      if (phase === 'transaction' && sql === 'COMMIT') phase = 'committed';
    });
    const prepare = vi.spyOn(DatabaseSync.prototype, 'prepare').mockImplementation(function (
      this: DatabaseSync,
      sql,
    ) {
      guard();
      return nativePrepare.call(this, sql);
    });
    const detach = vi.spyOn(authorityData, 'detachAndFreeze').mockImplementation((value) => {
      guard();
      return nativeDetach(value);
    });
    const canonical = vi.spyOn(authorityData, 'canonicalJson').mockImplementation((value) => {
      guard();
      return nativeCanonical(value);
    });
    try {
      for (const kind of ['committed', 'replayed']) {
        phase = 'transaction';
        const result = owner.commitSync(input);
        phase = 'idle';
        expect(result).not.toBeInstanceOf(Promise);
        expect(result.kind).toBe(kind);
      }
    } finally {
      phase = 'idle';
      exec.mockRestore();
      prepare.mockRestore();
      detach.mockRestore();
      canonical.mockRestore();
    }
    expect(owner.snapshotSync().heads).toEqual({
      installSequence: 2,
      trustSequence: 1,
      operationSequence: 2,
    });
  });

  it('reconciles all three durable activation streams with the same ID after COMMIT acknowledgement loss', async () => {
    const file = filename();
    const owner = openOwner(file);
    const input = activateInput('activate', importCandidate(owner));
    const nativeExec = DatabaseSync.prototype.exec;
    const failure = new Error('activation COMMIT acknowledgement lost');
    const spy = vi.spyOn(DatabaseSync.prototype, 'exec').mockImplementation(function (
      this: DatabaseSync,
      sql,
    ) {
      nativeExec.call(this, sql);
      if (sql === 'COMMIT') throw failure;
    });
    try {
      expect(() => owner.commitSync(input)).toThrow(
        expect.objectContaining({ code: 'plugin-authority-storage', cause: failure }),
      );
    } finally {
      spy.mockRestore();
    }
    await expectUnavailable(owner, input);
    await owner.close();
    const reopened = openOwner(file);
    const beforeReplay = facts(file);
    expect(reopened.commitSync(input)).toMatchObject({
      kind: 'replayed',
      operation: { requestId: 'activate', sequence: 2 },
      currentSnapshot: { heads: { installSequence: 2, trustSequence: 1, operationSequence: 2 } },
    });
    expect(facts(file)).toEqual(beforeReplay);
  });
});

describe('poisoned transaction cleanup', () => {
  it.each(['throws', 'leaves-active'] as const)(
    'keeps the primary cause and closes every data API when rollback %s',
    async (mode) => {
      const file = filename();
      const owner = openOwner(file);
      const before = importCandidate(owner);
      const input = activateInput('activate', before);
      operationFailure(file);
      const cleanup = new Error('injected rollback cleanup failure');
      const nativeExec = DatabaseSync.prototype.exec;
      const spy = vi.spyOn(DatabaseSync.prototype, 'exec').mockImplementation(function (
        this: DatabaseSync,
        sql,
      ) {
        if (sql === 'ROLLBACK') {
          if (mode === 'throws') throw cleanup;
          return;
        }
        nativeExec.call(this, sql);
      });
      try {
        const error = caught(() => owner.commitSync(input));
        expect(error).toMatchObject({ cause: expect.any(AggregateError) });
        expect(error).toMatchObject({
          code: 'plugin-authority-storage',
          cause: expect.objectContaining({
            errors: [
              expect.objectContaining({ message: 'primary operation failure' }),
              mode === 'throws'
                ? cleanup
                : expect.objectContaining({
                    message: 'Plugin authority rollback left an active transaction',
                  }),
            ],
          }),
        });
        await expectUnavailable(owner, input);
      } finally {
        spy.mockRestore();
      }
      await expect(owner.close()).resolves.toBeUndefined();
      await expect(owner.close()).resolves.toBeUndefined();
      expect(openOwner(file).snapshotSync()).toEqual(before);
    },
  );

  it('preserves primary and unreadable transaction-state causes while allowing real native close cleanup', async () => {
    const file = filename();
    const stateFailure = new Error('transaction state unavailable');
    let unreadable = false;
    vi.resetModules();
    // Native state getters are nonconfigurable instance properties; only this test's wrapper faults them.
    vi.doMock('node:sqlite', () => ({
      DatabaseSync: class {
        constructor(path: string) {
          const native = new DatabaseSync(path);
          return new Proxy(native, {
            get(target, property) {
              if (property === 'isTransaction' && unreadable) throw stateFailure;
              const value: unknown = Reflect.get(target, property, target);
              return typeof value === 'function' ? value.bind(target) : value;
            },
          });
        }
      },
    }));
    try {
      const { createSqlitePluginAuthorityDatabase: createIsolatedOwner } =
        await import('../src/plugin-authority-store.js');
      const owner = createIsolatedOwner({ filename: file, now: () => new Date(occurredAt) });
      owners.push(owner);
      const before = importCandidate(owner);
      const input = activateInput('activate', before);
      operationFailure(file);
      unreadable = true;
      const error = caught(() => owner.commitSync(input));
      expect(error).toMatchObject({ cause: expect.any(AggregateError) });
      expect(error).toMatchObject({
        code: 'plugin-authority-storage',
        cause: expect.objectContaining({
          errors: [expect.objectContaining({ message: 'primary operation failure' }), stateFailure],
        }),
      });
      await expectUnavailable(owner, input);
      await expect(owner.close()).resolves.toBeUndefined();
      expect(openOwner(file).snapshotSync()).toEqual(before);
    } finally {
      unreadable = false;
      vi.doUnmock('node:sqlite');
      vi.resetModules();
    }
  });

  it('finishes close retry after native close succeeded but its acknowledgement failed', async () => {
    const file = filename();
    const owner = openOwner(file);
    const before = importCandidate(owner);
    const input = activateInput('activate', before);
    const nativeClose = DatabaseSync.prototype.close;
    const failure = new Error('close acknowledgement lost');
    const spy = vi.spyOn(DatabaseSync.prototype, 'close').mockImplementationOnce(function (
      this: DatabaseSync,
    ) {
      nativeClose.call(this);
      throw failure;
    });
    try {
      await expect(owner.close()).rejects.toMatchObject({
        code: 'plugin-authority-storage',
        cause: failure,
      });
      await expectUnavailable(owner, input);
      spy.mockImplementation(() => {
        throw new Error('closed native connection must not be closed twice');
      });
      await expect(owner.close()).resolves.toBeUndefined();
      await expect(owner.close()).resolves.toBeUndefined();
    } finally {
      spy.mockRestore();
    }
    expect(openOwner(file).snapshotSync()).toEqual(before);
  });
});

describe('public owner integrity boundaries', () => {
  it.each([
    "UPDATE plugin_operation_events SET event_json = '{broken' WHERE sequence = 1",
    'DELETE FROM plugin_authority_identity',
    `INSERT INTO plugin_trust_events VALUES (1, '${occurredAt}', 'user', '{"kind":"enabled","pluginId":"notes","sequence":1,"occurredAt":"${occurredAt}","scope":"user"}')`,
  ])('blocks every read and write without repairing corrupt durable history: %s', async (sql) => {
    const file = filename();
    const owner = openOwner(file);
    const before = importCandidate(owner);
    const input = activateInput('activate', before);
    withDatabase(file, (database) => database.exec(sql));
    const corruptFacts = facts(file);
    for (const action of [
      () => owner.snapshotSync(),
      () => owner.lookupSync(input.request),
      () => owner.commitSync(input),
    ]) {
      expect(action).toThrow(expect.objectContaining({ code: 'plugin-authority-protocol' }));
    }
    await expect(owner.trust.events()).rejects.toMatchObject({ code: 'plugin-trust-protocol' });
    await expect(owner.trust.append({ kind: 'revoked', pluginId: 'manual' })).rejects.toMatchObject(
      {
        code: 'plugin-trust-protocol',
      },
    );
    expect(facts(file)).toEqual(corruptFacts);
  });

  it('isolates committed data from input mutation and rejects mutation at every result depth', async () => {
    const file = filename();
    const owner = openOwner(file);
    const identity = artifact();
    const input = importInput('import', 0, identity);
    const result = owner.commitSync(input);
    const beforeFacts = facts(file);
    (identity.manifest as { name: string }).name = 'changed after commit';
    (identity.manifest.permissions as string[]).push('workspace:write');
    (identity as { files: number }).files = 99;
    if (input.prepared.kind !== 'import' || input.request.command.kind !== 'import')
      throw new Error('fixture');
    (input.prepared.provenance as { sourceDirectory: string }).sourceDirectory = '/changed';
    (input.request.command as { previewId: string }).previewId = 'changed-preview';
    expectMutationRejected(result);
    expectMutationRejected(owner.snapshotSync());
    const lookup = owner.lookupSync(importInput('import', 0).request);
    expectMutationRejected(lookup);
    expect(facts(file)).toEqual(beforeFacts);
    await owner.close();
    const reopened = openOwner(file);
    expect(reopened.snapshotSync()).toMatchObject({
      heads: { installSequence: 1, trustSequence: 0, operationSequence: 1 },
      installations: [
        {
          candidates: [{ manifest: { name: 'Notes', permissions: ['workspace:read'] }, files: 2 }],
        },
      ],
    });
  });
});
