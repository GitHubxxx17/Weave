import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { PluginTrustEvent } from '@weave/plugin-host';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSqlitePluginAuthorityDatabase } from '../src/plugin-authority-store.js';
import {
  type ManagedCommitInput,
  type ManagedPreparation,
  type ManagedRequest,
  type PluginAuthorityDatabase,
  PluginAuthorityError,
} from '../src/plugin-authority-types.js';
import { createSqlitePluginTrustStore, PluginTrustStoreError } from '../src/plugin-trust-store.js';
import { PluginTrustStoreError as PrimitiveTrustError } from '../src/plugin-trust-sqlite.js';
import {
  activateInput,
  artifact,
  decisionInput,
  digestA,
  digestB,
  importInput,
} from './support/plugin-authority-fixtures.js';

const occurredAt = '2026-11-21T00:00:00.000Z';
const databaseId = '145c7021-9281-4dbb-97d8-d7da00055aa2';
const filenames: string[] = [];
const owners: { close(): Promise<void> }[] = [];

function filename(): string {
  const result = join(tmpdir(), `weave-plugin-authority-${randomUUID()}.sqlite`);
  filenames.push(result);
  return result;
}

function openOwner(file = filename(), now: () => Date = () => new Date(occurredAt)) {
  const owner = createSqlitePluginAuthorityDatabase({
    filename: file,
    now,
    newDatabaseId: () => databaseId,
  });
  owners.push(owner);
  return owner;
}

function openLegacy(file = filename()) {
  const store = createSqlitePluginTrustStore({ filename: file, now: () => new Date(occurredAt) });
  owners.push(store);
  return store;
}

function activate(owner: PluginAuthorityDatabase, requestId = 'activate') {
  owner.commitSync(importInput(`import-${requestId}`, owner.snapshotSync().heads.installSequence));
  return owner.commitSync(activateInput(requestId, owner.snapshotSync()));
}

function trusted(pluginId = 'notes'): PluginTrustEvent {
  const identity = artifact();
  return {
    kind: 'trusted',
    pluginId,
    digest: identity.digest,
    manifest: { ...identity.manifest, id: pluginId },
  };
}

function expectFrozen(value: unknown): void {
  if (value !== null && typeof value === 'object') {
    expect(Object.isFrozen(value)).toBe(true);
    for (const child of Object.values(value)) expectFrozen(child);
  }
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(owners.splice(0).map((owner) => owner.close()));
  await Promise.all(filenames.splice(0).map((file) => rm(file, { force: true })));
});

describe('SQLite Plugin Authority Database ownership', () => {
  it('exposes a frozen identity and borrowed trust facade with owner-only lifetime', async () => {
    const owner = openOwner();
    expect(owner.identity).toEqual({ version: 1, databaseId });
    expectFrozen(owner.identity);
    expect('close' in owner.trust).toBe(false);
    await owner.close();
    await expect(owner.close()).resolves.toBeUndefined();
    expect(() => owner.snapshotSync()).toThrow(
      expect.objectContaining({ code: 'plugin-authority-closed' }),
    );
    expect(() => owner.lookupSync(importInput('missing', 0).request)).toThrow(PluginAuthorityError);
    expect(() => owner.commitSync(importInput('closed', 0))).toThrow(
      expect.objectContaining({ code: 'plugin-authority-closed' }),
    );
    await expect(owner.trust.events()).rejects.toMatchObject({ code: 'plugin-trust-closed' });
    await expect(
      owner.trust.append({ kind: 'revoked', pluginId: 'manual' }),
    ).rejects.toBeInstanceOf(PluginTrustStoreError);
  });

  it('shares manual sequencing across both constructors and keeps the old error class', async () => {
    const file = filename();
    const owner = openOwner(file);
    const legacy = openLegacy(file);
    expect(PluginTrustStoreError).toBe(PrimitiveTrustError);
    await expect(
      owner.trust.append({ kind: 'enabled', pluginId: 'manual' }),
    ).resolves.toMatchObject({
      sequence: 1,
    });
    await expect(legacy.append({ kind: 'disabled', pluginId: 'manual' })).resolves.toMatchObject({
      sequence: 2,
    });
    expect(owner.snapshotSync().heads).toEqual({
      installSequence: 0,
      trustSequence: 2,
      operationSequence: 0,
    });
    await expect(legacy.events()).resolves.toHaveLength(2);
  });

  it.each(['borrowed', 'standalone'] as const)(
    'returns mutable detached trust append and read results through %s facade',
    async (kind) => {
      const store = kind === 'borrowed' ? openOwner().trust : openLegacy();
      const input = trusted('manual');
      const appended = await store.append(input);
      if (appended.kind !== 'trusted' || input.kind !== 'trusted') throw new Error('fixture');
      expect(Object.isFrozen(appended)).toBe(false);
      (appended.manifest as { name: string }).name = 'append mutation';
      (input.manifest as { name: string }).name = 'input mutation';
      const read = await store.events();
      const first = read[0];
      if (first?.kind !== 'trusted') throw new Error('fixture');
      (first.manifest as { name: string }).name = 'read mutation';
      await expect(store.events()).resolves.toMatchObject([{ manifest: { name: 'Notes' } }]);
    },
  );

  it.each(['trusted', 'enabled', 'disabled', 'revoked'] as const)(
    'rejects manual %s for sticky managed ownership through both facades',
    async (kind) => {
      const file = filename();
      const owner = openOwner(file);
      const legacy = openLegacy(file);
      owner.commitSync(importInput('import', 0));
      const event = kind === 'trusted' ? trusted() : { kind, pluginId: 'notes' };
      for (const facade of [owner.trust, legacy]) {
        await expect(facade.append(event)).rejects.toMatchObject({
          code: 'plugin-trust-invalid',
          message: expect.stringContaining('combined managed API'),
        });
      }
      owner.commitSync(decisionInput('uninstall', 'uninstall', owner.snapshotSync()));
      await expect(legacy.append(event)).rejects.toMatchObject({ code: 'plugin-trust-invalid' });
      expect(owner.snapshotSync().trustEvents).toHaveLength(0);
    },
  );

  it('keeps constructor corruption checks lazy for legacy trust rows', async () => {
    const file = filename();
    const legacy = openLegacy(file);
    const database = new DatabaseSync(file);
    database.exec("INSERT INTO plugin_trust_events VALUES (1, 'bad', 'user', '{broken')");
    database.close();
    const owner = openOwner(file);
    await expect(legacy.events()).rejects.toMatchObject({ code: 'plugin-trust-protocol' });
    expect(() => owner.snapshotSync()).toThrow(
      expect.objectContaining({ code: 'plugin-authority-protocol' }),
    );
  });

  it('accepts memory filenames and legacy extra options while authority options are strict', async () => {
    const owner = openOwner(':memory:');
    expect(owner.snapshotSync().heads.operationSequence).toBe(0);
    const legacy = createSqlitePluginTrustStore({
      filename: ':memory:',
      harmless: true,
    } as Parameters<typeof createSqlitePluginTrustStore>[0]);
    owners.push(legacy);
    await expect(legacy.events()).resolves.toEqual([]);
    expect(() =>
      createSqlitePluginAuthorityDatabase({ filename: ':memory:', harmless: true } as never),
    ).toThrow(expect.objectContaining({ code: 'plugin-authority-invalid' }));
  });

  it.each([
    { filename: '' },
    { filename: ':memory:', now: 'bad' },
    { filename: ':memory:', newDatabaseId: 'bad' },
    { filename: ':memory:', newDatabaseId: () => 'bad' },
  ])('rejects invalid authority options or generated identity', (options) => {
    expect(() => createSqlitePluginAuthorityDatabase(options as never)).toThrow(
      expect.objectContaining({ code: 'plugin-authority-invalid' }),
    );
  });
});

describe('SQLite Plugin Authority Database managed transactions', () => {
  it('records exact linked command facts and preserves them across reopen', async () => {
    const file = filename();
    const owner = openOwner(file);
    const imported = owner.commitSync(importInput('import', 0));
    expect(imported.kind).toBe('committed');
    expect(imported.operation.decision).toMatchObject({
      changed: true,
      before: { installSequence: 0, trustSequence: 0 },
      after: { installSequence: 1, trustSequence: 0 },
      links: { installEventSequence: 1, trustEventSequence: null },
    });
    const activated = owner.commitSync(activateInput('activate', owner.snapshotSync()));
    expect(activated.operation.decision.links).toEqual({
      installEventSequence: 2,
      trustEventSequence: 1,
    });
    for (const [kind, requestId] of [
      ['disable', 'disable'],
      ['enable', 'enable'],
      ['revoke', 'revoke'],
      ['uninstall', 'uninstall'],
    ] as const) {
      owner.commitSync(decisionInput(kind, requestId, owner.snapshotSync()));
    }
    expect(owner.snapshotSync().heads).toEqual({
      installSequence: 3,
      trustSequence: 5,
      operationSequence: 6,
    });
    const reactivated = owner.commitSync(activateInput('reactivate', owner.snapshotSync()));
    expect(reactivated.operation.decision.links).toEqual({
      installEventSequence: 4,
      trustEventSequence: 6,
    });
    const snapshot = owner.snapshotSync();
    expect(snapshot.installEvents.map((event) => [event.kind, event.operationSequence])).toEqual([
      ['imported', 1],
      ['activated', 2],
      ['uninstalled', 6],
      ['activated', 7],
    ]);
    expect(snapshot.trustEvents.map((event) => event.kind)).toEqual([
      'trusted',
      'disabled',
      'enabled',
      'revoked',
      'revoked',
      'trusted',
    ]);
    expectFrozen(snapshot);
    expectFrozen(reactivated);
    await owner.close();
    expect(openOwner(file).snapshotSync()).toEqual(snapshot);
  });

  it.each(['import', 'enable', 'disable', 'revoke', 'uninstall'] as const)(
    'persists each fresh %s no-op while equal request replay appends nothing',
    (kind) => {
      const owner = openOwner();
      owner.commitSync(importInput('import', 0));
      if (kind === 'enable') owner.commitSync(activateInput('activate', owner.snapshotSync()));
      if (kind === 'disable') {
        owner.commitSync(activateInput('activate', owner.snapshotSync()));
        owner.commitSync(decisionInput('disable', 'disable', owner.snapshotSync()));
      }
      const before = owner.snapshotSync();
      const input =
        kind === 'import'
          ? importInput('no-op', before.heads.installSequence)
          : decisionInput(kind, 'no-op', before);
      const result = owner.commitSync(input);
      expect(result.operation.decision).toMatchObject({
        changed: false,
        before: {
          installSequence: before.heads.installSequence,
          trustSequence: before.heads.trustSequence,
        },
        after: {
          installSequence: before.heads.installSequence,
          trustSequence: before.heads.trustSequence,
        },
        links: { installEventSequence: null, trustEventSequence: null },
      });
      expect(owner.snapshotSync().heads.operationSequence).toBe(before.heads.operationSequence + 1);
      expect(owner.commitSync(input)).toMatchObject({
        kind: 'replayed',
        operation: result.operation,
      });
      expect(owner.snapshotSync().heads.operationSequence).toBe(before.heads.operationSequence + 1);
    },
  );

  it('always writes fresh trust for repeated activation and rollback to the same digest', () => {
    const owner = openOwner();
    activate(owner);
    owner.commitSync(activateInput('activate-again', owner.snapshotSync()));
    owner.commitSync(activateInput('rollback', owner.snapshotSync(), artifact(), 'rollback'));
    expect(owner.snapshotSync().heads).toEqual({
      installSequence: 4,
      trustSequence: 3,
      operationSequence: 4,
    });
    expect(owner.snapshotSync().trustEvents.map((event) => event.kind)).toEqual([
      'trusted',
      'trusted',
      'trusted',
    ]);
  });

  it('replays before parsing preparation or checking stale original heads and calls no clock', () => {
    const now = vi.fn(() => new Date(occurredAt));
    const owner = openOwner(filename(), now);
    const input = importInput('import', 0);
    const first = owner.commitSync(input);
    owner.commitSync(activateInput('activate', owner.snapshotSync()));
    now.mockClear();
    const replay = owner.commitSync({
      request: input.request,
      prepared: { kind: 'invalid' } as unknown as ManagedPreparation,
    });
    expect(replay).toMatchObject({ kind: 'replayed', operation: first.operation });
    expect(replay.kind === 'replayed' && replay.currentSnapshot.heads).toEqual({
      installSequence: 2,
      trustSequence: 1,
      operationSequence: 2,
    });
    expect(owner.commitSync({ request: input.request } as ManagedCommitInput).kind).toBe(
      'replayed',
    );
    const getter = vi.fn(() => {
      throw new Error('evidence must not be read');
    });
    const withGetter = { request: input.request };
    Object.defineProperty(withGetter, 'prepared', { enumerable: true, get: getter });
    expect(owner.commitSync(withGetter as ManagedCommitInput).kind).toBe('replayed');
    expect(getter).not.toHaveBeenCalled();
    expect(now).not.toHaveBeenCalled();
    expectFrozen(replay);
  });

  it('looks up the original operation with current authority after revoke and reopen', async () => {
    const file = filename();
    const owner = openOwner(file);
    owner.commitSync(importInput('import', 0));
    const input = activateInput('activate', owner.snapshotSync());
    const first = owner.commitSync(input);
    owner.commitSync(decisionInput('revoke', 'revoke', owner.snapshotSync()));
    await owner.close();
    const reopened = openOwner(file);
    const replay = reopened.lookupSync(input.request);
    expect(replay).toMatchObject({ kind: 'replayed', operation: first.operation });
    if (replay.kind !== 'replayed') throw new Error('fixture');
    expect(replay.currentSnapshot.trustEvents.at(-1)?.kind).toBe('revoked');
    expect(replay.currentSnapshot.heads.operationSequence).toBe(3);
    expect(reopened.lookupSync(importInput('unknown', 0).request)).toEqual({ kind: 'absent' });
    expectFrozen(replay);
  });

  it.each(['previewId', 'expectedInstallSequence', 'kind'] as const)(
    'rejects reuse of an import ID with changed %s before preparation',
    (field) => {
      const owner = openOwner();
      const input = importInput('same', 0);
      owner.commitSync(input);
      const request =
        field === 'kind'
          ? decisionInput('revoke', 'same', owner.snapshotSync()).request
          : {
              ...input.request,
              command: {
                ...input.request.command,
                [field]: field === 'previewId' ? 'different' : 1,
              },
            };
      expect(() => owner.lookupSync(request as ManagedRequest)).toThrow(
        expect.objectContaining({ code: 'plugin-authority-request-conflict' }),
      );
      expect(() => owner.commitSync({ request, prepared: null } as never)).toThrow(
        expect.objectContaining({ code: 'plugin-authority-request-conflict' }),
      );
    },
  );

  it.each([
    'pluginId',
    'digest',
    'manifest',
    'previousSelection',
    'expectedInstallSequence',
    'expectedTrustSequence',
    'intent',
  ] as const)('treats changed activation %s as a global request conflict', (field) => {
    const owner = openOwner();
    owner.commitSync(importInput('import', 0));
    const input = activateInput('same', owner.snapshotSync());
    owner.commitSync(input);
    const values = {
      pluginId: 'other',
      digest: digestB,
      manifest: { ...artifact().manifest, name: 'Other review' },
      previousSelection: digestA,
      expectedInstallSequence: 99,
      expectedTrustSequence: 99,
      intent: 'rollback',
    };
    const command = {
      ...input.request.command,
      [field]: values[field],
      ...(field === 'pluginId' ? { manifest: { ...artifact().manifest, id: 'other' } } : {}),
    };
    expect(() => owner.lookupSync({ ...input.request, command } as ManagedRequest)).toThrow(
      expect.objectContaining({ code: 'plugin-authority-request-conflict' }),
    );
  });

  it('normalizes omitted false timing but conflicts on changed immediate intent', () => {
    const owner = openOwner();
    owner.commitSync(importInput('import', 0));
    const input = decisionInput('disable', 'disable', owner.snapshotSync());
    owner.commitSync(input);
    const command = { ...input.request.command } as Record<string, unknown>;
    delete command.immediate;
    expect(
      owner.lookupSync({ requestId: 'disable', command } as unknown as ManagedRequest).kind,
    ).toBe('replayed');
    expect(() =>
      owner.lookupSync({
        ...input.request,
        command: { ...input.request.command, immediate: true },
      } as ManagedRequest),
    ).toThrow(expect.objectContaining({ code: 'plugin-authority-request-conflict' }));
  });

  it('rejects stale fresh no-op review and revoked enable without consuming operation IDs', () => {
    const owner = openOwner();
    activate(owner);
    const stale = decisionInput('enable', 'stale', owner.snapshotSync());
    owner.commitSync(decisionInput('revoke', 'revoke', owner.snapshotSync()));
    const before = owner.snapshotSync();
    expect(() => owner.commitSync(stale)).toThrow(
      expect.objectContaining({ code: 'plugin-authority-conflict' }),
    );
    expect(() => owner.commitSync(decisionInput('enable', 'enable', before))).toThrow(
      expect.objectContaining({ code: 'plugin-authority-activation-required' }),
    );
    expect(owner.snapshotSync()).toEqual(before);
  });

  it.each([
    null,
    {},
    { request: null },
    { request: importInput('bad', 0).request, prepared: null },
    { request: importInput('bad', 0).request, prepared: { kind: 'disable' } },
    { ...importInput('bad', 0), extra: true },
  ])('rejects invalid fresh input without consuming a head', (input) => {
    const owner = openOwner();
    expect(() => owner.commitSync(input as ManagedCommitInput)).toThrow(
      expect.objectContaining({ code: 'plugin-authority-invalid' }),
    );
    expect(owner.snapshotSync().heads).toEqual({
      installSequence: 0,
      trustSequence: 0,
      operationSequence: 0,
    });
  });

  it('rolls back clock failure and preserves healthy contiguous sequencing', () => {
    const now = vi.fn(() => new Date(NaN));
    const owner = openOwner(filename(), now);
    expect(() => owner.commitSync(importInput('import', 0))).toThrow(
      expect.objectContaining({ code: 'plugin-authority-invalid' }),
    );
    expect(owner.snapshotSync().heads.operationSequence).toBe(0);
    now.mockReturnValue(new Date(occurredAt));
    expect(owner.commitSync(importInput('import', 0)).operation.sequence).toBe(1);
  });

  it('validates fresh preparation before calling the clock', () => {
    const now = vi.fn(() => new Date(occurredAt));
    const owner = openOwner(filename(), now);
    expect(() =>
      owner.commitSync({ request: importInput('import', 0).request, prepared: null } as never),
    ).toThrow(expect.objectContaining({ code: 'plugin-authority-invalid' }));
    expect(now).not.toHaveBeenCalled();
  });

  it('keeps a managed writer healthy after SQLite automatically rolls back', () => {
    const file = filename();
    const owner = openOwner(file);
    const database = new DatabaseSync(file);
    try {
      database.exec(`
        CREATE TRIGGER rollback_operation BEFORE INSERT ON plugin_operation_events
        BEGIN SELECT RAISE(ROLLBACK, 'original managed failure'); END
      `);
      expect(() => owner.commitSync(importInput('import', 0))).toThrow(
        expect.objectContaining({
          code: 'plugin-authority-storage',
          cause: expect.objectContaining({ message: 'original managed failure' }),
        }),
      );
      expect(owner.snapshotSync().heads).toEqual({
        installSequence: 0,
        trustSequence: 0,
        operationSequence: 0,
      });
      database.exec('DROP TRIGGER rollback_operation');
      expect(owner.commitSync(importInput('import', 0)).operation.sequence).toBe(1);
    } finally {
      database.close();
    }
  });

  it('poisons an ambiguous COMMIT outcome and reconciles its durable operation after reopen', async () => {
    const file = filename();
    const owner = openOwner(file);
    const nativeExec = DatabaseSync.prototype.exec;
    const failure = new Error('COMMIT acknowledgement lost');
    const spy = vi.spyOn(DatabaseSync.prototype, 'exec').mockImplementation(function (
      this: DatabaseSync,
      sql,
    ) {
      nativeExec.call(this, sql);
      if (sql === 'COMMIT') throw failure;
    });
    const input = importInput('import', 0);
    expect(() => owner.commitSync(input)).toThrow(
      expect.objectContaining({ code: 'plugin-authority-storage', cause: failure }),
    );
    spy.mockRestore();
    expect(() => owner.snapshotSync()).toThrow(
      expect.objectContaining({ code: 'plugin-authority-closed' }),
    );
    expect(() => owner.commitSync(input)).toThrow(
      expect.objectContaining({ code: 'plugin-authority-closed' }),
    );
    await expect(owner.trust.events()).rejects.toMatchObject({ code: 'plugin-trust-closed' });
    await owner.close();
    const reopened = openOwner(file);
    const replay = reopened.lookupSync(input.request);
    expect(replay).toMatchObject({
      kind: 'replayed',
      operation: { requestId: 'import', sequence: 1 },
    });
    expect(reopened.snapshotSync().heads).toEqual({
      installSequence: 1,
      trustSequence: 0,
      operationSequence: 1,
    });
  });

  it('marks native close failures unavailable and permits cleanup retry', async () => {
    const owner = openOwner();
    const failure = new Error('native close failure');
    const nativeClose = DatabaseSync.prototype.close;
    const spy = vi.spyOn(DatabaseSync.prototype, 'close').mockImplementationOnce(() => {
      throw failure;
    });
    await expect(owner.close()).rejects.toMatchObject({
      code: 'plugin-authority-storage',
      cause: failure,
    });
    expect(() => owner.snapshotSync()).toThrow(
      expect.objectContaining({ code: 'plugin-authority-closed' }),
    );
    await expect(owner.trust.events()).rejects.toMatchObject({ code: 'plugin-trust-closed' });
    spy.mockImplementation(function (this: DatabaseSync) {
      nativeClose.call(this);
    });
    await expect(owner.close()).resolves.toBeUndefined();
    await expect(owner.close()).resolves.toBeUndefined();
  });

  it('cleans up when beginning a transaction throws after SQLite began it', () => {
    const owner = openOwner();
    const nativeExec = DatabaseSync.prototype.exec;
    const failure = new Error('BEGIN acknowledgement lost');
    const spy = vi.spyOn(DatabaseSync.prototype, 'exec').mockImplementationOnce(function (
      this: DatabaseSync,
      sql,
    ) {
      nativeExec.call(this, sql);
      throw failure;
    });
    expect(() => owner.commitSync(importInput('import', 0))).toThrow(
      expect.objectContaining({ code: 'plugin-authority-storage', cause: failure }),
    );
    spy.mockRestore();
    expect(owner.commitSync(importInput('import', 0)).operation.sequence).toBe(1);
  });
});
