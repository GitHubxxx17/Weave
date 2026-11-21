import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSqlitePluginAuthorityDatabase } from '../src/plugin-authority-store.js';
import type {
  ManagedRootRegistration,
  ManagedStoreBinding,
} from '../src/plugin-authority-types.js';
import { acquireManagedStoreLease, type ManagedStoreLease } from '../src/plugin-store-lease.js';
import { validateStorePaths } from '../src/plugin-store-paths.js';

const databaseId = '145c7021-9281-4dbb-97d8-d7da00055aa2';
const otherId = '2a8ac99d-d6de-4df8-b965-ec938968c571';
const previousStoreId = 'ebe14129-3871-49ea-a248-8c9a8d56a393';
const occurredAt = '2026-11-21T00:00:00.000Z';
const artifactId = 'a'.repeat(64);
const operationId = 'aaac7021-9281-4dbb-97d8-d7da00055aa2';
const bindingTable = 'managed_store_binding_events';
const invalid = { code: 'plugin-store-invalid' };
const recoveryRequired = { code: 'plugin-store-recovery-required' };
const protocol = { code: 'plugin-store-protocol' };
const busy = { code: 'plugin-store-busy' };
const mismatch = { code: 'plugin-store-owner-mismatch' };
const lost = { code: 'plugin-store-ownership-lost' };
const closed = { code: 'plugin-store-closed' };
const storage = { code: 'plugin-store-storage' };
const directories: string[] = [];
const leases: ManagedStoreLease[] = [];

function fixture() {
  const parent = realpathSync.native(mkdtempSync(join(tmpdir(), 'weave-store-ownership-')));
  directories.push(parent);
  const databaseFile = join(parent, 'authority.sqlite');
  const directory = join(parent, 'store');
  writeFileSync(databaseFile, '');
  return {
    parent,
    databaseFile,
    directory,
    owner: join(directory, 'ownership.sqlite'),
    payload: join(directory, 'artifacts', artifactId, 'payload'),
    staging: join(directory, 'staging', operationId),
  };
}

type Fixture = ReturnType<typeof fixture>;

async function acquire(
  paths: Fixture,
  initialBinding: 'allow-unbound' | 'require-bound' = 'allow-unbound',
  existingRegistration: ManagedRootRegistration | null = null,
  id = databaseId,
) {
  const lease = await acquireManagedStoreLease({
    paths: await validateStorePaths({
      databaseFile: paths.databaseFile,
      directory: paths.directory,
      initialBinding,
    }),
    databaseId: id,
    existingRegistration,
    initialBinding,
  });
  leases.push(lease);
  return lease;
}

function bindingFor(paths: Fixture): ManagedStoreBinding {
  return {
    version: 1,
    databaseId,
    databaseFile: paths.databaseFile,
    storeId: previousStoreId,
    storeDirectory: paths.directory,
    ownerDatabaseFile: paths.owner,
  };
}

function registration(binding: ManagedStoreBinding): ManagedRootRegistration {
  return { version: 1, sequence: 1, kind: 'managed-root-registered', occurredAt, binding };
}

function queryOwner<T>(owner: string, operation: (database: DatabaseSync) => T): T {
  const database = new DatabaseSync(owner);
  try {
    return operation(database);
  } finally {
    database.close();
  }
}

function bindingRows(owner: string) {
  return queryOwner(owner, (database) => database.prepare(`SELECT * FROM ${bindingTable}`).all());
}

function populateDirectories(root: string, count: number) {
  mkdirSync(root, { recursive: true });
  for (let index = 0; index < count; index += 1) mkdirSync(join(root, String(index)));
}

function populateDepth(root: string, depth: number) {
  mkdirSync(join(root, ...Array<string>(depth).fill('d')), { recursive: true });
}

afterEach(async () => {
  vi.restoreAllMocks();
  try {
    await Promise.all(leases.splice(0).map((lease) => lease.close()));
  } finally {
    for (const directory of directories.splice(0))
      rmSync(directory, { recursive: true, force: true });
  }
});

describe('managed store filesystem policy', () => {
  it('canonicalizes linked ancestors with native traversal and leaves initial validation read-only', async () => {
    const paths = fixture();
    const target = join(paths.parent, 'target');
    mkdirSync(join(target, 'child'), { recursive: true });
    const alias = join(paths.parent, 'alias');
    symlinkSync(join(target, 'child'), alias, 'dir');
    const databaseFile = join(target, 'main.sqlite');
    writeFileSync(databaseFile, '');

    const validated = await validateStorePaths({
      databaseFile: `${alias}/../main.sqlite`,
      directory: `${alias}/../store`,
      initialBinding: 'allow-unbound',
    });

    expect(validated).toMatchObject({
      databaseFile,
      storeDirectory: join(target, 'store'),
      ownerDatabaseFile: join(target, 'store', 'ownership.sqlite'),
      rootExists: false,
    });
    expect(existsSync(join(target, 'store'))).toBe(false);
  });

  it.each([
    ['root symlink', (paths: Fixture) => symlinkSync(paths.parent, paths.directory, 'dir')],
    ['root file', (paths: Fixture) => writeFileSync(paths.directory, '')],
    [
      'unexpected root entry',
      (paths: Fixture) => {
        mkdirSync(paths.directory);
        writeFileSync(join(paths.directory, 'manual.mjs'), '');
      },
    ],
    [
      'WAL sidecar',
      (paths: Fixture) => {
        mkdirSync(paths.directory);
        writeFileSync(`${paths.owner}-wal`, '');
      },
    ],
    [
      'journal without owner',
      (paths: Fixture) => {
        mkdirSync(paths.directory);
        writeFileSync(`${paths.owner}-journal`, '');
      },
    ],
    [
      'owner symlink',
      (paths: Fixture) => {
        mkdirSync(paths.directory);
        symlinkSync(paths.databaseFile, paths.owner, 'file');
      },
    ],
    [
      'owner hard link',
      (paths: Fixture) => {
        mkdirSync(paths.directory);
        linkSync(paths.databaseFile, paths.owner);
      },
    ],
    [
      'main symlink',
      (paths: Fixture) => {
        const target = join(paths.parent, 'target.sqlite');
        renameSync(paths.databaseFile, target);
        symlinkSync(target, paths.databaseFile, 'file');
      },
    ],
    [
      'main hard link',
      (paths: Fixture) => linkSync(paths.databaseFile, join(paths.parent, 'extra.sqlite')),
    ],
    [
      'payload hard link',
      (paths: Fixture) => {
        const extra = join(paths.parent, 'extra');
        mkdirSync(paths.payload, { recursive: true });
        writeFileSync(extra, '');
        linkSync(extra, join(paths.payload, 'entry.mjs'));
      },
    ],
    [
      'staging hard link',
      (paths: Fixture) => {
        const extra = join(paths.parent, 'extra');
        const payload = join(paths.staging, 'payload');
        mkdirSync(payload, { recursive: true });
        writeFileSync(extra, '');
        linkSync(extra, join(payload, 'entry.mjs'));
      },
    ],
    [
      'payload symlink',
      (paths: Fixture) => {
        mkdirSync(paths.payload, { recursive: true });
        symlinkSync(paths.databaseFile, join(paths.payload, 'entry.mjs'), 'file');
      },
    ],
    [
      'uppercase staging UUID',
      (paths: Fixture) => {
        mkdirSync(join(paths.directory, 'staging', operationId.toUpperCase()), { recursive: true });
      },
    ],
    [
      'non-v4 staging UUID',
      (paths: Fixture) => {
        mkdirSync(join(paths.directory, 'staging', operationId.replace('-4dbb-', '-7dbb-')), {
          recursive: true,
        });
      },
    ],
  ] as const)('rejects %s', async (_name, setup) => {
    const paths = fixture();
    setup(paths);
    await expect(validateStorePaths({ ...pathOptions(paths) })).rejects.toMatchObject(invalid);
  });

  it('rejects the main database inside the managed root', async () => {
    const paths = fixture();
    mkdirSync(paths.directory);
    const databaseFile = join(paths.directory, 'main.sqlite');
    renameSync(paths.databaseFile, databaseFile);
    await expect(validateStorePaths({ ...pathOptions(paths), databaseFile })).rejects.toMatchObject(
      invalid,
    );
  });

  it.each(['-journal', '-wal', '-shm'])(
    'rejects the main SQLite %s sidecar location as the root',
    async (suffix) => {
      const paths = fixture();
      const directory = `${paths.databaseFile}${suffix}`;
      await expect(validateStorePaths({ ...pathOptions(paths), directory })).rejects.toMatchObject(
        invalid,
      );
      expect(existsSync(directory)).toBe(false);
    },
  );

  it.each(['-JOURNAL', '-WAL', '-SHM'])(
    'reserves the main SQLite %s sidecar spelling before creating a root',
    async (suffix) => {
      const paths = fixture();
      queryOwner(paths.databaseFile, (database) =>
        database.exec('CREATE TABLE writes (value TEXT)'),
      );
      const directory = `${paths.databaseFile}${suffix}`;
      await expect(acquire({ ...paths, directory })).rejects.toMatchObject(invalid);
      expect(existsSync(directory)).toBe(false);
      queryOwner(paths.databaseFile, (database) =>
        database.exec("INSERT INTO writes VALUES ('committed')"),
      );
    },
  );

  it('uses native file identity for a sidecar stem with alternate case', async () => {
    const paths = fixture();
    const stem = join(paths.parent, 'AUTHORITY.SQLITE');
    const directory = `${stem}-JOURNAL`;
    const validation = validateStorePaths({ ...pathOptions(paths), directory });
    if (existsSync(stem)) {
      await expect(validation).rejects.toMatchObject(invalid);
    } else {
      await expect(validation).resolves.toMatchObject({ storeDirectory: directory });
    }
  });

  it.each([
    ['artifact entries', (paths: Fixture) => paths.payload, populateDirectories, 2_000],
    [
      'staging entries',
      (paths: Fixture) => join(paths.staging, 'payload'),
      populateDirectories,
      2_000,
    ],
    ['artifact depth', (paths: Fixture) => paths.payload, populateDepth, 64],
    ['staging depth', (paths: Fixture) => join(paths.staging, 'payload'), populateDepth, 64],
  ] as const)(
    'accepts the exact bound and rejects one more for %s',
    async (_name, root, populate, bound) => {
      const atLimit = fixture();
      populate(root(atLimit), bound);
      await expect(validateStorePaths(pathOptions(atLimit))).resolves.toMatchObject({
        rootExists: true,
      });
      const aboveLimit = fixture();
      populate(root(aboveLimit), bound + 1);
      await expect(validateStorePaths(pathOptions(aboveLimit))).rejects.toMatchObject(invalid);
    },
  );

  it.each([
    [
      'artifact count',
      (paths: Fixture, index: number) =>
        join(paths.directory, 'artifacts', index.toString(16).padStart(64, '0'), 'payload'),
    ],
    [
      'staging count',
      (paths: Fixture, index: number) =>
        join(
          paths.directory,
          'staging',
          `aaac7021-9281-4dbb-97d8-${index.toString(16).padStart(12, '0')}`,
        ),
    ],
  ] as const)('accepts 64 trees and rejects 65 for %s', async (_name, tree) => {
    const paths = fixture();
    for (let index = 0; index < 64; index += 1) mkdirSync(tree(paths, index), { recursive: true });
    await expect(validateStorePaths(pathOptions(paths))).resolves.toMatchObject({
      rootExists: true,
    });
    mkdirSync(tree(paths, 64), { recursive: true });
    await expect(validateStorePaths(pathOptions(paths))).rejects.toMatchObject(invalid);
  });

  it('rejects published payloads exceeding the byte bound using file sizes', async () => {
    const paths = fixture();
    mkdirSync(paths.payload, { recursive: true });
    const file = join(paths.payload, 'binary');
    writeFileSync(file, '');
    truncateSync(file, 20 * 1024 * 1024);
    await expect(validateStorePaths(pathOptions(paths))).resolves.toMatchObject({
      rootExists: true,
    });
    truncateSync(file, 20 * 1024 * 1024 + 1);
    await expect(validateStorePaths(pathOptions(paths))).rejects.toMatchObject(invalid);
  });

  it('rejects published payloads exceeding the file bound', async () => {
    const paths = fixture();
    mkdirSync(paths.payload, { recursive: true });
    for (let index = 0; index < 1_000; index += 1)
      writeFileSync(join(paths.payload, String(index)), '');
    await expect(validateStorePaths(pathOptions(paths))).resolves.toMatchObject({
      rootExists: true,
    });
    writeFileSync(join(paths.payload, 'extra'), '');
    await expect(validateStorePaths(pathOptions(paths))).rejects.toMatchObject(invalid);
  });
});

function pathOptions(paths: Fixture) {
  return {
    databaseFile: paths.databaseFile,
    directory: paths.directory,
    initialBinding: 'allow-unbound',
  } as const;
}

describe('managed store binding and lease', () => {
  it('reserves and binds an absent root only with explicit permission', async () => {
    const paths = fixture();
    await expect(acquire(paths, 'require-bound')).rejects.toMatchObject(recoveryRequired);
    expect(existsSync(paths.directory)).toBe(false);
    const lease = await acquire(paths);
    expect(lease.binding).toEqual({ ...bindingFor(paths), storeId: expect.any(String) });
    expect(Object.isFrozen(lease.binding)).toBe(true);
    expect(statSync(paths.owner).mode & 0o777).toBe(0o600);
    lease.assertHeldSync();
    await lease.close();
    await lease.close();
    expect(() => lease.assertHeldSync()).toThrow(expect.objectContaining(closed));
    expect(
      queryOwner(paths.owner, (database) => database.prepare('PRAGMA journal_mode').get()),
    ).toEqual({ journal_mode: 'delete' });
    const [row] = bindingRows(paths.owner);
    expect(row).toMatchObject({ sequence: 1, occurred_at: expect.any(String) });
    expect(JSON.parse(String(row?.event_json))).toEqual({
      version: 1,
      sequence: 1,
      occurredAt: row?.occurred_at,
      kind: 'managed-store-bound',
      binding: lease.binding,
    });
    expect(bindingRows(paths.owner)).toHaveLength(1);
  });

  it('scans populated roots structurally and leaves payload, abandoned staging and authority heads intact', async () => {
    const paths = fixture();
    mkdirSync(paths.payload, { recursive: true });
    mkdirSync(paths.staging, { recursive: true });
    const published = join(paths.payload, 'index.mjs');
    const stagingPayload = join(paths.staging, 'payload');
    const staged = join(stagingPayload, 'index.mjs');
    mkdirSync(stagingPayload);
    writeFileSync(published, 'throw new Error("must stay inert");');
    writeFileSync(staged, 'partial', { mode: 0o200 });
    const authority = createSqlitePluginAuthorityDatabase({
      filename: paths.databaseFile,
      newDatabaseId: () => databaseId,
    });
    try {
      const before = authority.snapshotSync();
      await expect(acquire(paths, 'require-bound')).rejects.toMatchObject(recoveryRequired);
      await expect(
        acquire(paths, 'allow-unbound', registration(bindingFor(paths))),
      ).rejects.toMatchObject(recoveryRequired);
      const lease = await acquire(paths);
      expect(readFileSync(published, 'utf8')).toBe('throw new Error("must stay inert");');
      expect(statSync(staged).size).toBe(7);
      expect(authority.readManagedRootStateSync().registration).toBeNull();
      expect(authority.snapshotSync()).toEqual(before);
      await lease.close();
    } finally {
      await authority.close();
    }
  });

  it('rejects a different main registration before creating the requested root', async () => {
    const paths = fixture();
    const other = fixture();
    await expect(
      acquire(
        paths,
        'allow-unbound',
        registration({
          ...bindingFor(other),
          databaseFile: paths.databaseFile,
        }),
      ),
    ).rejects.toMatchObject(mismatch);
    expect(existsSync(paths.directory)).toBe(false);
  });

  it.each([
    ['empty', (file: string) => writeFileSync(file, '')],
    ['corrupt', (file: string) => writeFileSync(file, 'not an sqlite database')],
    [
      'missing schema',
      (file: string) => queryOwner(file, (database) => database.exec('PRAGMA user_version = 1')),
    ],
  ] as const)('leaves an existing %s owner file untouched', async (_name, create) => {
    const paths = fixture();
    mkdirSync(paths.directory);
    create(paths.owner);
    const before = readFileSync(paths.owner);
    await expect(acquire(paths)).rejects.toMatchObject(recoveryRequired);
    expect(readFileSync(paths.owner)).toEqual(before);
  });

  it('does not initialize an owner that another invocation reserved after validation', async () => {
    const paths = fixture();
    mkdirSync(paths.directory);
    const validated = await validateStorePaths(pathOptions(paths));
    writeFileSync(paths.owner, '', { flag: 'wx', mode: 0o600 });
    await expect(
      acquireManagedStoreLease({
        paths: validated,
        databaseId,
        existingRegistration: null,
        initialBinding: 'allow-unbound',
      }),
    ).rejects.toMatchObject(recoveryRequired);
    expect(statSync(paths.owner).size).toBe(0);
  });

  it('does not recreate a previously seen owner after it disappears', async () => {
    const paths = fixture();
    const lease = await acquire(paths);
    await lease.close();
    const validated = await validateStorePaths(pathOptions(paths));
    renameSync(paths.owner, join(paths.parent, 'saved-owner'));
    await expect(
      acquireManagedStoreLease({
        paths: validated,
        databaseId,
        existingRegistration: null,
        initialBinding: 'allow-unbound',
      }),
    ).rejects.toMatchObject(recoveryRequired);
    expect(existsSync(paths.owner)).toBe(false);
  });

  it('reopens exact binding without rewriting its bytes and rejects conflicting UUID, path and store ID', async () => {
    const paths = fixture();
    const first = await acquire(paths);
    await first.close();
    const bytes = readFileSync(paths.owner);
    const original = first.binding;
    const reopened = await acquire(paths, 'require-bound', registration(original));
    expect(reopened.binding).toEqual(original);
    await reopened.close();
    await expect(acquire(paths, 'allow-unbound', null, otherId)).rejects.toMatchObject(mismatch);
    const alternateMain = join(paths.parent, 'copied.sqlite');
    writeFileSync(alternateMain, readFileSync(paths.databaseFile));
    await expect(acquire({ ...paths, databaseFile: alternateMain })).rejects.toMatchObject(
      mismatch,
    );
    await expect(
      acquire(paths, 'allow-unbound', registration({ ...original, storeId: otherId })),
    ).rejects.toMatchObject(mismatch);
    expect(readFileSync(paths.owner)).toEqual(bytes);
  });

  it.each([
    ['unknown table', 'CREATE TABLE unexpected (value TEXT)'],
    ['unknown index', `CREATE INDEX unexpected ON ${bindingTable} (occurred_at)`],
    ['unknown view', `CREATE VIEW unexpected AS SELECT * FROM ${bindingTable}`],
    [
      'unknown trigger',
      `CREATE TRIGGER unexpected AFTER UPDATE ON ${bindingTable} BEGIN SELECT 1; END`,
    ],
    ['missing bound event', `DELETE FROM ${bindingTable}`],
    ['malformed JSON', `UPDATE ${bindingTable} SET event_json = '{'`],
    [
      'unexpected field',
      `UPDATE ${bindingTable} SET event_json=json_set(event_json, '$.extra', 1)`,
    ],
    ['mismatched timestamp', `UPDATE ${bindingTable} SET occurred_at = '${occurredAt}'`],
    [
      'wrong primary key',
      `ALTER TABLE ${bindingTable} RENAME TO old; CREATE TABLE ${bindingTable} (sequence INTEGER NOT NULL, occurred_at TEXT NOT NULL, event_json TEXT NOT NULL); INSERT INTO ${bindingTable} SELECT * FROM old; DROP TABLE old`,
    ],
  ])('rejects %s without modifying the owner', async (_name, sql) => {
    const paths = fixture();
    const lease = await acquire(paths);
    await lease.close();
    queryOwner(paths.owner, (database) => database.exec(sql));
    const bytes = readFileSync(paths.owner);
    await expect(acquire(paths)).rejects.toMatchObject(protocol);
    expect(readFileSync(paths.owner)).toEqual(bytes);
  });

  it('rejects WAL without mutating its journal mode', async () => {
    const paths = fixture();
    const lease = await acquire(paths);
    await lease.close();
    queryOwner(paths.owner, (database) => database.exec('PRAGMA journal_mode = WAL'));
    await expect(acquire(paths)).rejects.toMatchObject(protocol);
    expect(
      queryOwner(paths.owner, (database) => database.prepare('PRAGMA journal_mode').get()),
    ).toEqual({ journal_mode: 'wal' });
  });

  it('allows a regular rollback sidecar and refuses a linked sidecar', async () => {
    const paths = fixture();
    const lease = await acquire(paths);
    await lease.close();
    const journal = `${paths.owner}-journal`;
    writeFileSync(journal, '');
    const reopened = await acquire(paths, 'require-bound');
    expect(reopened.binding).toEqual(lease.binding);
    await reopened.close();
    if (!existsSync(journal)) writeFileSync(journal, '');
    const extra = join(paths.parent, 'extra');
    linkSync(journal, extra);
    await expect(acquire(paths)).rejects.toMatchObject(invalid);
    expect(statSync(extra).nlink).toBe(2);
  });

  it('lets SQLite recover a hot rollback journal before reading the binding', async () => {
    const paths = fixture();
    const lease = await acquire(paths);
    await lease.close();
    const [original] = bindingRows(paths.owner);
    const journal = `${paths.owner}-journal`;

    // Save the disk image after SQLite spills an uncommitted change and its rollback journal.
    const interrupted = queryOwner(paths.owner, (database) => {
      database.exec('PRAGMA cache_size = 1; PRAGMA synchronous = FULL; BEGIN IMMEDIATE');
      database.prepare(`UPDATE ${bindingTable} SET event_json = ?`).run('x'.repeat(200_000));
      const image = { database: readFileSync(paths.owner), journal: readFileSync(journal) };
      database.exec('ROLLBACK');
      return image;
    });
    expect(interrupted.journal.subarray(0, 8).toString('hex')).toBe('d9d505f920a163d7');
    writeFileSync(paths.owner, interrupted.database);
    writeFileSync(journal, interrupted.journal);
    const recovered = await acquire(paths, 'require-bound');
    expect(recovered.binding).toEqual(lease.binding);
    await recovered.close();
    expect(bindingRows(paths.owner)).toEqual([original]);
    expect(existsSync(journal)).toBe(false);
  });

  it('fails promptly when the root is leased while the unrelated main remains writable', async () => {
    const paths = fixture();
    const lease = await acquire(paths);
    await expect(acquire(paths)).rejects.toMatchObject(busy);
    queryOwner(paths.databaseFile, (database) =>
      database.exec('CREATE TABLE writable (value TEXT)'),
    );
    lease.assertHeldSync();
    await lease.close();
    expect((await acquire(paths, 'require-bound')).binding).toEqual(lease.binding);
  });

  it('checks bound staging contents only after acquiring the lease', async () => {
    const paths = fixture();
    const lease = await acquire(paths);
    mkdirSync(join(paths.directory, 'staging', 'invalid-operation'), { recursive: true });
    await expect(acquire(paths)).rejects.toMatchObject(busy);
    await lease.close();
    await expect(acquire(paths, 'require-bound')).rejects.toMatchObject(invalid);
    expect(existsSync(join(paths.directory, 'staging', 'invalid-operation'))).toBe(true);
  });

  it.each(['main', 'root', 'owner'] as const)(
    'fails closed when the held %s path is replaced',
    async (entry) => {
      const paths = fixture();
      const lease = await acquire(paths);
      const target = { main: paths.databaseFile, root: paths.directory, owner: paths.owner }[entry];
      renameSync(target, join(paths.parent, 'former-entry'));
      if (entry === 'root') mkdirSync(target);
      else writeFileSync(target, '');
      expect(() => lease.assertHeldSync()).toThrow(expect.objectContaining(lost));
      rmSync(target, { recursive: true, force: true });
      renameSync(join(paths.parent, 'former-entry'), target);
      expect(() => lease.assertHeldSync()).toThrow(expect.objectContaining(lost));
      await lease.close();
    },
  );

  it('fails closed when the native lifetime transaction ends', async () => {
    const paths = fixture();
    const realExec = DatabaseSync.prototype.exec;
    const connections = new Set<DatabaseSync>();
    vi.spyOn(DatabaseSync.prototype, 'exec').mockImplementation(function (this: DatabaseSync, sql) {
      if (sql === 'BEGIN EXCLUSIVE') connections.add(this);
      return realExec.call(this, sql);
    });
    const lease = await acquire(paths);
    expect(connections.size).toBe(1);
    for (const owner of connections) owner.exec('ROLLBACK');
    expect(() => lease.assertHeldSync()).toThrow(expect.objectContaining(lost));
    await lease.close();
    await expect(acquire(paths, 'require-bound')).resolves.toMatchObject({
      binding: lease.binding,
    });
  });

  it('preserves rollback and close errors and retries cleanup without restoring operations', async () => {
    const paths = fixture();
    const lease = await acquire(paths);
    const rollbackFailure = new Error('rollback failure');
    const closeFailure = new Error('close failure');
    vi.spyOn(DatabaseSync.prototype, 'exec').mockImplementationOnce(() => {
      throw rollbackFailure;
    });
    vi.spyOn(DatabaseSync.prototype, 'close').mockImplementationOnce(() => {
      throw closeFailure;
    });
    const firstClose = lease.close();
    expect(lease.close()).toBe(firstClose);
    await expect(firstClose).rejects.toMatchObject({
      ...storage,
      cause: { errors: [rollbackFailure, closeFailure] },
    });
    expect(() => lease.assertHeldSync()).toThrow(expect.objectContaining(closed));
    await lease.close();
    await lease.close();
    await expect(acquire(paths, 'require-bound')).resolves.toMatchObject({
      binding: lease.binding,
    });
  });

  it('retains the committed root binding if lifetime acquisition fails', async () => {
    const paths = fixture();
    const failure = new Error('second transaction failed');
    const realExec = DatabaseSync.prototype.exec;
    let beginCount = 0;
    vi.spyOn(DatabaseSync.prototype, 'exec').mockImplementation(function (this: DatabaseSync, sql) {
      if (sql === 'BEGIN EXCLUSIVE' && ++beginCount === 2) throw failure;
      return realExec.call(this, sql);
    });
    await expect(acquire(paths)).rejects.toMatchObject({ ...storage, cause: failure });
    const [saved] = bindingRows(paths.owner);
    const reopened = await acquire(paths, 'require-bound');
    expect(JSON.parse(String(saved?.event_json))).toMatchObject({ binding: reopened.binding });
  });
});
