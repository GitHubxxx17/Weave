import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { initializeAuthoritySchemaTx } from '../src/plugin-authority-log.js';
import { createSqlitePluginAuthorityDatabase } from '../src/plugin-authority-store.js';
import type {
  ManagedStoreBinding,
  PluginAuthorityDatabase,
} from '../src/plugin-authority-types.js';
import { activateInput, importInput } from './support/plugin-authority-fixtures.js';

const databaseId = '145c7021-9281-4dbb-97d8-d7da00055aa2';
const storeId = 'ebe14129-3871-49ea-a248-8c9a8d56a393';
const otherId = '2a8ac99d-d6de-4df8-b965-ec938968c571';
const occurredAt = '2026-11-21T00:00:00.000Z';
const markerTable = 'plugin_managed_root_schema';
const rootTable = 'plugin_managed_root_events';
const protocol = expect.objectContaining({ code: 'plugin-authority-protocol' });
const invalid = expect.objectContaining({ code: 'plugin-authority-invalid' });
const conflict = expect.objectContaining({ code: 'plugin-authority-conflict' });
const closed = expect.objectContaining({ code: 'plugin-authority-closed' });
const directories: string[] = [];
const owners: PluginAuthorityDatabase[] = [];

function filename(): string {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'weave-root-registration-')));
  directories.push(directory);
  return join(directory, 'authority.sqlite');
}

function openOwner(file: string, now = () => new Date(occurredAt)) {
  const owner = createSqlitePluginAuthorityDatabase({
    filename: file,
    now,
    newDatabaseId: () => databaseId,
  });
  owners.push(owner);
  return owner;
}

function bindingFor(databaseFile: string, storeDirectory = join(databaseFile, '..', 'store')) {
  return {
    version: 1,
    databaseId,
    databaseFile,
    storeId,
    storeDirectory,
    ownerDatabaseFile: join(storeDirectory, 'ownership.sqlite'),
  } satisfies ManagedStoreBinding;
}

function withDatabase<T>(file: string, operation: (database: DatabaseSync) => T): T {
  const database = new DatabaseSync(file);
  try {
    return operation(database);
  } finally {
    database.close();
  }
}

function createLegacyCore(file: string) {
  return withDatabase(file, (database) => {
    database.exec('BEGIN IMMEDIATE');
    initializeAuthoritySchemaTx(database, () => databaseId);
    const identityJson = `{ "databaseId": "${databaseId}", "version": 1 }`;
    database.prepare('UPDATE plugin_authority_identity SET identity_json = ?').run(identityJson);
    database.exec(`
      PRAGMA user_version = 17;
      CREATE TABLE unrelated (value TEXT NOT NULL);
      INSERT INTO unrelated VALUES ('untouched');
      COMMIT;
    `);
    return identityJson;
  });
}

function tables(file: string) {
  return withDatabase(file, (database) =>
    database.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name").all(),
  );
}

function rows(file: string, table: string) {
  return withDatabase(file, (database) => database.prepare(`SELECT * FROM ${table}`).all());
}

afterEach(async () => {
  await Promise.all(owners.splice(0).map((owner) => owner.close()));
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe('authority managed root registration', () => {
  it('upgrades a 6.2a core without rewriting existing identity bytes or unrelated data', async () => {
    const file = filename();
    const identityJson = createLegacyCore(file);
    const before = tables(file);
    const owner = openOwner(file);
    expect(tables(file)).toEqual(
      [...before, { name: markerTable }, { name: rootTable }].sort((a, b) =>
        String(a.name).localeCompare(String(b.name)),
      ),
    );
    const marker = rows(file, markerTable);
    expect(marker).toEqual([
      { singleton: 1, marker_json: JSON.stringify({ version: 1, databaseId }) },
    ]);
    expect(rows(file, rootTable)).toEqual([]);
    expect(owner.readManagedRootStateSync()).toEqual({
      databaseId,
      databaseFile: file,
      registration: null,
    });
    await owner.close();
    openOwner(file);
    expect(rows(file, markerTable)).toEqual(marker);
    expect(rows(file, 'plugin_authority_identity')).toEqual([
      { singleton: 1, identity_json: identityJson },
    ]);
    expect(rows(file, 'unrelated')).toEqual([{ value: 'untouched' }]);
    expect(withDatabase(file, (database) => database.prepare('PRAGMA user_version').get())).toEqual(
      {
        user_version: 17,
      },
    );
  });

  it('appends one immutable event and replays exact binding across reopen without advancing heads', async () => {
    const file = filename();
    const now = vi.fn(() => new Date(occurredAt));
    const owner = openOwner(file, now);
    owner.commitSync(importInput('import', 0));
    owner.commitSync(activateInput('activate', owner.snapshotSync()));
    const before = owner.snapshotSync();
    now.mockClear();
    const binding = bindingFor(file);
    const expected = {
      version: 1,
      sequence: 1,
      kind: 'managed-root-registered',
      occurredAt,
      binding,
    };
    const result = owner.registerManagedRootSync(binding);
    expect(result).toEqual(expected);
    expect(result.binding).not.toBe(binding);
    expect(Object.isFrozen(binding)).toBe(false);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.binding)).toBe(true);
    const state = owner.readManagedRootStateSync();
    expect(state).toEqual({ databaseId, databaseFile: file, registration: expected });
    expect(Object.isFrozen(state)).toBe(true);
    expect(Object.isFrozen(state.registration)).toBe(true);
    expect(Object.isFrozen(state.registration?.binding)).toBe(true);
    expect(owner.registerManagedRootSync({ ...binding })).toEqual(result);
    expect(now).toHaveBeenCalledTimes(1);
    const stored = rows(file, rootTable);
    expect(stored).toEqual([
      { sequence: 1, occurred_at: occurredAt, event_json: JSON.stringify(expected) },
    ]);
    await owner.close();
    const reopened = openOwner(file, () => {
      throw new Error('Replay must not read the clock');
    });
    expect(reopened.registerManagedRootSync(binding)).toEqual(result);
    expect(reopened.snapshotSync()).toEqual(before);
    expect(rows(file, rootTable)).toEqual(stored);
  });

  it('conflicts on another root, store ID, database ID or database path', () => {
    const file = filename();
    const owner = openOwner(file);
    const binding = bindingFor(file);
    owner.registerManagedRootSync(binding);
    const registered = rows(file, rootTable);
    for (const changed of [
      bindingFor(file, join(file, '..', 'another-store')),
      { ...binding, storeId: otherId },
      { ...binding, databaseId: otherId },
      { ...binding, databaseFile: join(file, '..', 'another.sqlite') },
    ]) {
      expect(() => owner.registerManagedRootSync(changed)).toThrow(conflict);
    }
    expect(rows(file, rootTable)).toEqual(registered);
  });

  it('rejects another database identity or path before establishing the first registration', () => {
    const file = filename();
    const owner = openOwner(file);
    const binding = bindingFor(file);
    expect(() => owner.registerManagedRootSync({ ...binding, databaseId: otherId })).toThrow(
      conflict,
    );
    expect(() => owner.registerManagedRootSync({ ...binding, databaseFile: filename() })).toThrow(
      conflict,
    );
    expect(rows(file, rootTable)).toEqual([]);
  });

  it('reports a null main location for a memory database and rejects registration', () => {
    const owner = openOwner(':memory:');
    expect(owner.readManagedRootStateSync()).toEqual({
      databaseId,
      databaseFile: null,
      registration: null,
    });
    expect(() => owner.registerManagedRootSync(bindingFor(filename()))).toThrow(invalid);
  });

  it('accepts linked ancestors while requiring the canonical actual main filename in the binding', () => {
    const file = filename();
    const directory = join(file, '..', 'canonical');
    const alias = join(file, '..', 'ancestor-alias');
    mkdirSync(directory);
    symlinkSync(directory, alias, 'dir');
    const aliasFile = join(alias, 'main.sqlite');
    const canonicalFile = join(directory, 'main.sqlite');
    const owner = openOwner(aliasFile);
    expect(owner.readManagedRootStateSync().databaseFile).toBe(canonicalFile);
    expect(() => owner.registerManagedRootSync(bindingFor(aliasFile))).toThrow(conflict);
    expect(owner.registerManagedRootSync(bindingFor(canonicalFile)).binding.databaseFile).toBe(
      canonicalFile,
    );
  });

  it.each(['absolute', 'relative'])(
    'resolves a linked ancestor before .. for a raw %s opening path',
    (kind) => {
      const file = filename();
      const directory = join(file, '..', 'canonical');
      const nested = join(directory, 'nested');
      const alias = join(file, '..', 'ancestor-alias');
      mkdirSync(nested, { recursive: true });
      symlinkSync(nested, alias, 'dir');
      const openingAlias = kind === 'relative' ? relative(process.cwd(), alias) : alias;
      const openingPath = `${openingAlias}${sep}..${sep}main.sqlite`;
      const canonicalFile = join(directory, 'main.sqlite');
      const owner = openOwner(openingPath);
      const binding = bindingFor(canonicalFile);
      expect(owner.readManagedRootStateSync().databaseFile).toBe(canonicalFile);
      expect(owner.registerManagedRootSync(binding).binding).toEqual(binding);
    },
  );

  it('refuses managed reads and exact replay on an open authority whose main file was replaced', async () => {
    const file = filename();
    const original = openOwner(file);
    const binding = bindingFor(file);
    original.registerManagedRootSync(binding);
    await original.close();

    const stale = openOwner(file);
    const replacement = filename();
    const other = createSqlitePluginAuthorityDatabase({
      filename: replacement,
      newDatabaseId: () => otherId,
    });
    owners.push(other);
    await other.close();
    renameSync(file, join(file, '..', 'original.sqlite'));
    renameSync(replacement, file);
    expect(rows(file, rootTable)).toEqual([]);
    expect(stale.snapshotSync().identity.databaseId).toBe(databaseId);
    expect.soft(() => stale.readManagedRootStateSync()).toThrow(invalid);
    expect.soft(() => stale.registerManagedRootSync(binding)).toThrow(invalid);
    expect(rows(file, rootTable)).toEqual([]);
  });

  it('refuses a main database with multiple hardlinks', () => {
    const file = filename();
    const owner = openOwner(file);
    linkSync(file, join(file, '..', 'hardlink.sqlite'));
    expect(() => owner.registerManagedRootSync(bindingFor(file))).toThrow(invalid);
    expect(rows(file, rootTable)).toEqual([]);
  });

  it('refuses a symlink main leaf even when SQLite reports its target', () => {
    const file = filename();
    withDatabase(file, () => {});
    const alias = join(file, '..', 'leaf-alias.sqlite');
    symlinkSync(file, alias, 'file');
    const owner = openOwner(alias);
    expect(owner.snapshotSync().identity.databaseId).toBe(databaseId);
    expect(() => owner.readManagedRootStateSync()).toThrow(invalid);
    expect(() => owner.registerManagedRootSync(bindingFor(file))).toThrow(invalid);
    expect(rows(file, rootTable)).toEqual([]);
  });

  it('reads detached and frozen durable startup authority through a main-file symlink', async () => {
    const file = filename();
    const original = openOwner(file);
    original.commitSync(importInput('import', 0));
    const snapshot = original.snapshotSync();
    const registration = original.registerManagedRootSync(bindingFor(file));
    await original.close();
    const alias = join(file, '..', 'leaf-alias.sqlite');
    symlinkSync(file, alias, 'file');
    const owner = openOwner(alias);

    const startup = owner.readStartupAuthoritySync();
    expect(startup).toEqual({ snapshot, registration });
    expect(startup.snapshot).not.toBe(snapshot);
    expect(startup.registration).not.toBe(registration);
    expect(Object.isFrozen(startup)).toBe(true);
    expect(Object.isFrozen(startup.snapshot.installations[0]?.candidates)).toBe(true);
    expect(Object.isFrozen(startup.registration?.binding)).toBe(true);
    expect(() => owner.readManagedRootStateSync()).toThrow(invalid);
  });

  it.each([
    { databaseId: 'invalid' },
    { storeId: 'invalid' },
    { databaseFile: 'relative.sqlite' },
    { storeDirectory: 'relative-store' },
    { ownerDatabaseFile: '/wrong/ownership.sqlite' },
    { databaseFile: '/main\0.sqlite' },
    { version: 2 },
    { extra: true },
  ])('rejects invalid input with a strict binding schema (%j)', (patch) => {
    const file = filename();
    const owner = openOwner(file);
    const untyped = { ...bindingFor(file), ...patch } as ManagedStoreBinding;
    expect(() => owner.registerManagedRootSync(untyped)).toThrow(invalid);
    expect(rows(file, rootTable)).toEqual([]);
  });
});

describe('managed registry integrity', () => {
  it.each([markerTable, rootTable])(
    'rejects a missing %s on reopen without recreating it',
    async (missing) => {
      const file = filename();
      await openOwner(file).close();
      withDatabase(file, (database) => database.exec(`DROP TABLE IF EXISTS ${missing}`));
      const before = tables(file);
      expect(() => openOwner(file)).toThrow(protocol);
      expect(tables(file)).toEqual(before);
    },
  );

  it.each(['after CREATE', 'after INSERT'] as const)(
    'rolls back registry initialization when native SQL fails %s',
    (point) => {
      const file = filename();
      const identityJson = createLegacyCore(file);
      const before = tables(file);
      const failure = new Error('injected registry initialization failure');
      const nativeExec = DatabaseSync.prototype.exec;
      const nativePrepare = DatabaseSync.prototype.prepare;
      const exec = vi.spyOn(DatabaseSync.prototype, 'exec').mockImplementation(function (
        this: DatabaseSync,
        sql,
      ) {
        nativeExec.call(this, sql);
        if (point === 'after CREATE' && /CREATE TABLE\s+plugin_managed_root_events\b/i.test(sql))
          throw failure;
      });
      const prepare = vi.spyOn(DatabaseSync.prototype, 'prepare').mockImplementation(function (
        this: DatabaseSync,
        sql,
      ) {
        const statement = nativePrepare.call(this, sql);
        if (point === 'after INSERT' && /INSERT INTO\s+plugin_managed_root_schema\b/i.test(sql)) {
          const run = statement.run.bind(statement);
          statement.run = (...params: Parameters<typeof statement.run>) => {
            run(...params);
            throw failure;
          };
        }
        return statement;
      });
      try {
        expect(() => openOwner(file)).toThrow(
          expect.objectContaining({ code: 'plugin-authority-storage', cause: failure }),
        );
      } finally {
        prepare.mockRestore();
        exec.mockRestore();
      }
      expect(tables(file)).toEqual(before);
      expect(rows(file, 'plugin_authority_identity')).toEqual([
        { singleton: 1, identity_json: identityJson },
      ]);
      expect(openOwner(file).readManagedRootStateSync().registration).toBeNull();
    },
  );

  it.each([
    `DELETE FROM ${markerTable}`,
    `UPDATE ${markerTable} SET marker_json = '{broken'`,
    `UPDATE ${markerTable} SET marker_json = '{"version":2,"databaseId":"${databaseId}"}'`,
    `UPDATE ${markerTable} SET marker_json = '{"version":1,"databaseId":"${otherId}"}'`,
    `UPDATE ${markerTable} SET marker_json = '{"version":1,"databaseId":"${databaseId}","extra":true}'`,
  ])('rejects malformed marker metadata on reopen without repair (%s)', async (sql) => {
    const file = filename();
    await openOwner(file).close();
    withDatabase(file, (database) => database.exec(sql));
    const corrupt = rows(file, markerTable);
    expect(() => openOwner(file)).toThrow(protocol);
    expect(rows(file, markerTable)).toEqual(corrupt);
  });

  it.each([
    `UPDATE ${rootTable} SET occurred_at = '2026-11-21T00:00:01.000Z'`,
    `UPDATE ${rootTable} SET event_json = '{broken'`,
    `UPDATE ${rootTable} SET event_json = json_set(event_json, '$.sequence', 2)`,
    `UPDATE ${rootTable} SET event_json = json_set(event_json, '$.binding.storeDirectory', 'relative')`,
    `UPDATE ${rootTable} SET event_json = json_set(event_json, '$.binding.storeId', 'invalid')`,
    `UPDATE ${rootTable} SET event_json = json_set(event_json, '$.binding.databaseId', '${otherId}')`,
    `UPDATE ${rootTable} SET event_json = json_set(event_json, '$.extra', 1)`,
    `PRAGMA ignore_check_constraints = ON; UPDATE ${rootTable} SET sequence = 2`,
    `ALTER TABLE ${rootTable} RENAME TO orphaned; CREATE TABLE ${rootTable} (sequence INTEGER NOT NULL, occurred_at TEXT NOT NULL, event_json TEXT NOT NULL); INSERT INTO ${rootTable} SELECT * FROM orphaned UNION ALL SELECT * FROM orphaned`,
    `ALTER TABLE ${rootTable} RENAME COLUMN occurred_at TO wrong_time`,
  ])('rejects corrupt root schema or events on read, register and reopen (%s)', async (sql) => {
    const file = filename();
    const owner = openOwner(file);
    const binding = bindingFor(file);
    owner.registerManagedRootSync(binding);
    withDatabase(file, (database) => database.exec(sql));
    const corrupt = rows(file, rootTable);
    expect(() => owner.readStartupAuthoritySync()).toThrow(protocol);
    expect(() => owner.readManagedRootStateSync()).toThrow(protocol);
    expect(() => owner.registerManagedRootSync(binding)).toThrow(protocol);
    await owner.close();
    expect(() => openOwner(file)).toThrow(protocol);
    expect(rows(file, rootTable)).toEqual(corrupt);
  });

  it.each([markerTable, rootTable])('never recreates a runtime-missing %s', (missing) => {
    const file = filename();
    const owner = openOwner(file);
    withDatabase(file, (database) => database.exec(`DROP TABLE ${missing}`));
    const before = tables(file);
    expect(() => owner.readManagedRootStateSync()).toThrow(protocol);
    expect(() => owner.registerManagedRootSync(bindingFor(file))).toThrow(protocol);
    expect(tables(file)).toEqual(before);
  });

  it('preserves an insertion trigger failure and rolls back the root event', () => {
    const file = filename();
    const owner = openOwner(file);
    const binding = bindingFor(file);
    withDatabase(file, (database) =>
      database.exec(`
      CREATE TRIGGER block_registration AFTER INSERT ON ${rootTable}
      BEGIN SELECT RAISE(ABORT, 'injected registration trigger failure'); END;
    `),
    );
    expect(() => owner.registerManagedRootSync(binding)).toThrow(
      expect.objectContaining({
        code: 'plugin-authority-storage',
        cause: expect.objectContaining({ message: 'injected registration trigger failure' }),
      }),
    );
    expect(owner.readManagedRootStateSync().registration).toBeNull();
    expect(rows(file, rootTable)).toEqual([]);
    withDatabase(file, (database) => database.exec('DROP TRIGGER block_registration'));
    expect(owner.registerManagedRootSync(binding)).toMatchObject({ sequence: 1 });
  });

  it('rolls back registration if an insertion trigger silently replaces its binding', () => {
    const file = filename();
    const owner = openOwner(file);
    withDatabase(file, (database) =>
      database.exec(`
      CREATE TRIGGER replace_registration AFTER INSERT ON ${rootTable}
      BEGIN UPDATE ${rootTable} SET event_json = json_set(event_json, '$.binding.storeId', '${otherId}'); END;
    `),
    );
    expect(() => owner.registerManagedRootSync(bindingFor(file))).toThrow(protocol);
    expect(rows(file, rootTable)).toEqual([]);
  });
});

describe('managed registry owner lifecycle', () => {
  it('rejects root methods after the shared authority owner closes', async () => {
    const file = filename();
    const owner = openOwner(file);
    await owner.close();
    expect(() => owner.readManagedRootStateSync()).toThrow(closed);
    expect(() => owner.registerManagedRootSync(bindingFor(file))).toThrow(closed);
  });

  it('preserves primary and cleanup causes when rollback fails and poisons the shared owner', async () => {
    const file = filename();
    const owner = openOwner(file);
    withDatabase(file, (database) =>
      database.exec(`
      CREATE TRIGGER block_registration AFTER INSERT ON ${rootTable}
      BEGIN SELECT RAISE(ABORT, 'primary registration failure'); END;
    `),
    );
    const cleanup = new Error('injected rollback failure');
    const nativeExec = DatabaseSync.prototype.exec;
    const spy = vi.spyOn(DatabaseSync.prototype, 'exec').mockImplementation(function (
      this: DatabaseSync,
      sql,
    ) {
      if (sql === 'ROLLBACK') throw cleanup;
      nativeExec.call(this, sql);
    });
    try {
      expect(() => owner.registerManagedRootSync(bindingFor(file))).toThrow(
        expect.objectContaining({
          code: 'plugin-authority-storage',
          cause: expect.objectContaining({
            errors: [expect.objectContaining({ message: 'primary registration failure' }), cleanup],
          }),
        }),
      );
      expect(() => owner.readManagedRootStateSync()).toThrow(closed);
      expect(() => owner.registerManagedRootSync(bindingFor(file))).toThrow(closed);
      expect(() => owner.snapshotSync()).toThrow(closed);
    } finally {
      spy.mockRestore();
    }
    await owner.close();
    expect(openOwner(file).readManagedRootStateSync().registration).toBeNull();
  });

  it('reconciles a lost COMMIT acknowledgement on reopen with the exact original binding', async () => {
    const file = filename();
    const owner = openOwner(file);
    const binding = bindingFor(file);
    const nativeExec = DatabaseSync.prototype.exec;
    const failure = new Error('registration COMMIT acknowledgement lost');
    const spy = vi.spyOn(DatabaseSync.prototype, 'exec').mockImplementation(function (
      this: DatabaseSync,
      sql,
    ) {
      nativeExec.call(this, sql);
      if (sql === 'COMMIT') throw failure;
    });
    try {
      expect(() => owner.registerManagedRootSync(binding)).toThrow(
        expect.objectContaining({
          code: 'plugin-authority-storage',
          cause: failure,
        }),
      );
      expect(() => owner.readManagedRootStateSync()).toThrow(closed);
      expect(() => owner.registerManagedRootSync(binding)).toThrow(closed);
    } finally {
      spy.mockRestore();
    }
    await owner.close();
    const reopened = openOwner(file);
    const before = rows(file, rootTable);
    expect(reopened.registerManagedRootSync(binding)).toMatchObject({ sequence: 1, binding });
    expect(() => reopened.registerManagedRootSync({ ...binding, storeId: otherId })).toThrow(
      conflict,
    );
    expect(rows(file, rootTable)).toEqual(before);
  });
});
