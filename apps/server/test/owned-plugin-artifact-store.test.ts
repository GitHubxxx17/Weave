import {
  existsSync,
  lstatSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setImmediate } from 'node:timers/promises';
import { createPluginArtifactStore, type StagePluginArtifactOptions } from '@weave/plugin-host';
import { afterEach, expect, it, vi } from 'vitest';
import {
  openOwnedPluginArtifactStore,
  type OwnedPluginArtifactStore,
} from '../src/owned-plugin-artifact-store.js';
import { createSqlitePluginAuthorityDatabase } from '../src/plugin-authority-store.js';
import type {
  ManagedStoreBinding,
  PluginAuthorityDatabase,
} from '../src/plugin-authority-types.js';
import type { PluginStoreOwnershipError } from '../src/plugin-store-ownership-types.js';

vi.mock('@weave/plugin-host', async (importOriginal) => {
  const host = await importOriginal<typeof import('@weave/plugin-host')>();
  return { ...host, createPluginArtifactStore: vi.fn(host.createPluginArtifactStore) };
});

const storeFactory = vi.mocked(createPluginArtifactStore);
const cleanup: (() => void | Promise<void>)[] = [];
const closed = { code: 'plugin-store-closed' };
const busy = { code: 'plugin-store-busy' };
const lost = { code: 'plugin-store-ownership-lost' };

afterEach(async () => {
  vi.restoreAllMocks();
  storeFactory.mockReset();
  const failures: unknown[] = [];
  for (const dispose of cleanup.splice(0).reverse()) {
    try {
      await dispose();
    } catch (error: unknown) {
      failures.push(error);
    }
  }
  if (failures.length > 0) throw new AggregateError(failures, 'Owned store fixture cleanup failed');
});

type StoreOptions = Parameters<typeof openOwnedPluginArtifactStore>[0];

function fixture(databaseBasename = 'authority.sqlite') {
  const parent = realpathSync.native(mkdtempSync(join(tmpdir(), 'weave-owned-artifacts-')));
  cleanup.push(() => rmSync(parent, { recursive: true, force: true }));
  const databaseFile = join(parent, databaseBasename);
  const authority = createSqlitePluginAuthorityDatabase({ filename: databaseFile });
  cleanup.push(() => authority.close());
  const directory = join(parent, 'store');
  const ownerFile = join(directory, 'ownership.sqlite');
  const observer = vi.fn<StoreOptions['onOwnershipLost']>(() => undefined);
  const options: StoreOptions = {
    authority,
    directory,
    initialBinding: 'allow-unbound',
    onOwnershipLost: observer,
  };

  async function open(overrides: Partial<StoreOptions> = {}): Promise<OwnedPluginArtifactStore> {
    const store = await openOwnedPluginArtifactStore({ ...options, ...overrides });
    cleanup.push(() => store.close());
    return store;
  }

  function contender(filename = databaseFile): PluginAuthorityDatabase {
    const authority = createSqlitePluginAuthorityDatabase({ filename });
    cleanup.push(() => authority.close());
    return authority;
  }

  return { parent, databaseFile, authority, directory, ownerFile, observer, open, contender };
}

function bindingOnDisk(ownerFile: string): ManagedStoreBinding {
  const reader = new DatabaseSync(ownerFile, { readOnly: true });
  try {
    const rows = reader.prepare('SELECT event_json FROM managed_store_binding_events').all();
    expect(rows).toHaveLength(1);
    return (JSON.parse(String(rows[0]!.event_json)) as { binding: ManagedStoreBinding }).binding;
  } finally {
    reader.close();
  }
}

function errorTree(error: unknown): unknown[] {
  if (error instanceof AggregateError) return [error, ...error.errors.flatMap(errorTree)];
  if (error instanceof Error && 'cause' in error) return [error, ...errorTree(error.cause)];
  return [error];
}

function syncFailure(run: () => void): unknown {
  try {
    run();
  } catch (error: unknown) {
    return error;
  }
  throw new Error('Expected synchronous failure');
}

async function pluginSource(parent: string, id: string) {
  const sourceDirectory = join(parent, id);
  await fs.mkdir(sourceDirectory);
  await fs.writeFile(join(sourceDirectory, 'index.mjs'), `export default ${JSON.stringify(id)};\n`);
  await fs.writeFile(
    join(sourceDirectory, 'weave-plugin.json'),
    JSON.stringify({
      schemaVersion: 1,
      entry: 'index.mjs',
      manifest: {
        id,
        name: id,
        version: '1.0.0',
        apiVersion: '1.0.0',
        capabilities: ['command'],
        contributes: { commands: [id] },
        permissions: [],
      },
    }),
  );
  return sourceDirectory;
}

function filesystemGate(directory: string) {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  return { directory, entered, release };
}

function fsSentry(object: string, gates: ReturnType<typeof filesystemGate>[]) {
  const lstat = fs.lstat;
  const opendir = fs.opendir;
  const open = fs.open;
  const hits: string[] = [];
  const unusedGates = new Map(gates.map((gate) => [gate.directory, gate]));
  const inside = (candidate: unknown) =>
    typeof candidate === 'string' && (candidate === object || candidate.startsWith(object + sep));
  const spies = [
    vi.spyOn(fs, 'lstat').mockImplementation((file, options) => {
      if (inside(file)) hits.push('lstat');
      return lstat(file, options);
    }),
    vi.spyOn(fs, 'opendir').mockImplementation(async (file, options) => {
      if (inside(file)) hits.push('opendir');
      const gate = typeof file === 'string' ? unusedGates.get(file) : undefined;
      if (gate !== undefined) {
        unusedGates.delete(gate.directory);
        gate.entered.resolve();
        await gate.release.promise;
      }
      return opendir(file, options);
    }),
    vi.spyOn(fs, 'open').mockImplementation((file, flags, mode) => {
      if (inside(file)) hits.push('open');
      return open(file, flags, mode);
    }),
  ];
  return { hits, restore: () => spies.forEach((spy) => spy.mockRestore()) };
}

async function queueFixture(onOwnershipLost?: StoreOptions['onOwnershipLost']) {
  const fx = fixture();
  const host = await vi.importActual<typeof import('@weave/plugin-host')>('@weave/plugin-host');
  const signals = {
    preview: [] as (AbortSignal | undefined)[],
    stage: [] as (AbortSignal | undefined)[],
    read: [] as (AbortSignal | undefined)[],
  };
  storeFactory.mockImplementation((options) => {
    const store = host.createPluginArtifactStore(options);
    return {
      preview(input) {
        signals.preview.push(input.signal);
        return store.preview(input);
      },
      stage(input) {
        signals.stage.push(input.signal);
        return store.stage(input);
      },
      read(digest, options) {
        signals.read.push(options?.signal);
        return store.read(digest, options);
      },
    };
  });
  const store = await fx.open(onOwnershipLost === undefined ? {} : { onOwnershipLost });
  const a = await store.stage({ sourceDirectory: await pluginSource(fx.parent, 'alpha') });
  const b = await store.stage({ sourceDirectory: await pluginSource(fx.parent, 'beta') });
  const aGate = filesystemGate(a.directory);
  const operations: Promise<unknown>[] = [];
  function track<T>(operation: Promise<T>): Promise<T> {
    operations.push(operation);
    void operation.catch(() => undefined);
    return operation;
  }
  async function waitForGate(gate: ReturnType<typeof filesystemGate>, operation: Promise<unknown>) {
    await Promise.race([
      gate.entered.promise,
      operation.then(() => {
        throw new Error('Artifact operation finished before its filesystem gate');
      }),
    ]);
  }
  async function runWithGates<T>(
    gates: ReturnType<typeof filesystemGate>[],
    run: (hits: string[]) => Promise<T>,
  ) {
    const sentry = fsSentry(dirname(b.directory), [aGate, ...gates]);
    try {
      return await run(sentry.hits);
    } finally {
      aGate.release.resolve();
      for (const gate of gates) gate.release.resolve();
      await Promise.allSettled(operations);
      sentry.restore();
    }
  }

  return { ...fx, a, b, store, signals, aGate, track, waitForGate, runWithGates };
}

it('commits the root binding before taking the lifetime lock and registers main while held', async () => {
  const { authority, ownerFile, open } = fixture();
  const nativeExec = DatabaseSync.prototype.exec;
  const register = authority.registerManagedRootSync.bind(authority);
  let ownerBegins = 0;
  let beforeLifetime: ManagedStoreBinding | undefined;
  vi.spyOn(DatabaseSync.prototype, 'exec').mockImplementation(function (this: DatabaseSync, sql) {
    if (sql === 'BEGIN EXCLUSIVE' && this.location('main') === ownerFile && ++ownerBegins === 2) {
      beforeLifetime = bindingOnDisk(ownerFile);
      expect(authority.readManagedRootStateSync().registration).toBeNull();
    }
    nativeExec.call(this, sql);
  });
  vi.spyOn(authority, 'registerManagedRootSync').mockImplementation((binding) => {
    expect(binding).toEqual(beforeLifetime);
    expect(authority.readManagedRootStateSync().registration).toBeNull();
    expect(() => bindingOnDisk(ownerFile)).toThrow(expect.objectContaining({ errcode: 5 }));
    expect(storeFactory).not.toHaveBeenCalled();
    return register(binding);
  });

  const store = await open();
  expect(ownerBegins).toBe(2);
  expect(authority.readManagedRootStateSync().registration?.binding).toEqual(store.binding);
  expect(store.binding).toEqual(beforeLifetime);
  expect(Object.isFrozen(store.binding)).toBe(true);
  expect(Object.keys(store).sort()).toEqual([
    'assertHeldSync',
    'binding',
    'close',
    'list',
    'preview',
    'quiesce',
    'read',
    'remove',
    'stage',
  ]);
  expect(storeFactory).toHaveBeenCalledTimes(1);

  await store.close();
  expect(bindingOnDisk(ownerFile)).toEqual(store.binding);
  expect(authority.readManagedRootStateSync().registration?.binding).toEqual(store.binding);
});

it('binds an existing authority opened with a case-equivalent filename and reuses the binding', async ({
  skip,
}) => {
  const fx = fixture('Authority.sqlite');
  await fx.authority.close();
  const alias = join(fx.parent, 'AUTHORITY.SQLITE');
  const originalEntry = lstatSync(fx.databaseFile, { bigint: true });
  const aliasEntry = lstatSync(alias, { bigint: true, throwIfNoEntry: false });
  if (aliasEntry?.dev !== originalEntry.dev || aliasEntry.ino !== originalEntry.ino) {
    skip('The temporary filesystem does not resolve the case alias to the same file');
  }

  const authority = fx.contender(alias);
  const reader = new DatabaseSync(alias, { readOnly: true });
  try {
    expect(authority.readManagedRootStateSync().databaseFile).toBe(reader.location('main'));
  } finally {
    reader.close();
  }
  const store = await fx.open({ authority });
  store.assertHeldSync();
  const binding = store.binding;
  const registration = authority.readManagedRootStateSync().registration;
  expect(binding.databaseFile).toBe(fx.databaseFile);
  expect(registration?.binding).toEqual(binding);
  await store.close();
  await authority.close();
  expect(bindingOnDisk(fx.ownerFile)).toEqual(binding);

  for (const filename of [fx.databaseFile, alias]) {
    const reopenedAuthority = fx.contender(filename);
    const reopened = await fx.open({
      authority: reopenedAuthority,
      initialBinding: 'require-bound',
    });
    reopened.assertHeldSync();
    expect(reopened.binding).toEqual(binding);
    expect(reopenedAuthority.readManagedRootStateSync().registration).toEqual(registration);
    await reopened.close();
    await reopenedAuthority.close();
    expect(bindingOnDisk(fx.ownerFile)).toEqual(binding);
  }
});

it('keeps the committed root binding and permits exact retry after main registration fails', async () => {
  const { authority, ownerFile, open, observer } = fixture();
  const failure = new Error('registration did not run');
  vi.spyOn(authority, 'registerManagedRootSync').mockImplementationOnce(() => {
    throw failure;
  });

  const error = await open().catch((error: unknown) => error);
  expect(error).toMatchObject({ code: 'plugin-store-storage' });
  expect(errorTree(error)).toContain(failure);
  expect(authority.readManagedRootStateSync().registration).toBeNull();
  expect(storeFactory).not.toHaveBeenCalled();
  const binding = bindingOnDisk(ownerFile);

  const reopened = await open({ initialBinding: 'require-bound' });
  expect(reopened.binding).toEqual(binding);
  expect(authority.readManagedRootStateSync().registration?.binding).toEqual(binding);
  expect(observer).not.toHaveBeenCalled();
});

it('rejects a conflicting registered root before creating the requested owner file', async () => {
  const { parent, authority, open, observer } = fixture();
  const store = await open();
  const directory = join(parent, 'other-root');
  await expect(open({ directory })).rejects.toMatchObject({ code: 'plugin-store-owner-mismatch' });
  expect(existsSync(join(directory, 'ownership.sqlite'))).toBe(false);
  expect(authority.readManagedRootStateSync().registration?.binding).toEqual(store.binding);
  expect(observer).not.toHaveBeenCalled();
  expect(storeFactory).toHaveBeenCalledTimes(1);
});

it('validates startup options and a live persistent authority before creating an owner file', async () => {
  const { authority, ownerFile, open } = fixture();
  await expect(open({ hostVersion: 'latest' })).rejects.toMatchObject({
    code: 'plugin-store-invalid',
  });
  await expect(
    open({
      onOwnershipLost: 'observer' as unknown as (error: PluginStoreOwnershipError) => undefined,
    }),
  ).rejects.toMatchObject({ code: 'plugin-store-invalid' });
  const memory = createSqlitePluginAuthorityDatabase({ filename: ':memory:' });
  try {
    await expect(open({ authority: memory })).rejects.toMatchObject({
      code: 'plugin-store-invalid',
    });
  } finally {
    await memory.close();
  }
  await authority.close();
  await expect(open()).rejects.toMatchObject({ code: 'plugin-store-closed' });
  expect(existsSync(ownerFile)).toBe(false);
  expect(storeFactory).not.toHaveBeenCalled();
});

it('aborts active and queued effective signals before the observer, keeping the queued digest out of the filesystem', async () => {
  const caller = new AbortController();
  const observations: {
    error: PluginStoreOwnershipError;
    reasons: unknown[];
    callerAborted: boolean;
  }[] = [];
  const fx = await queueFixture((error) => {
    observations.push({
      error,
      reasons: fx.signals.read.map((signal) => (signal?.aborted ? signal.reason : undefined)),
      callerAborted: caller.signal.aborted,
    });
    return undefined;
  });
  const names = ['index.mjs', 'weave-plugin.json'];
  const originalBytes = await Promise.all(
    names.map((name) => fs.readFile(join(fx.b.directory, name))),
  );

  await fx.runWithGates([], async (hits) => {
    const a = fx.track(fx.store.read(fx.a.digest));
    await fx.waitForGate(fx.aGate, a);
    const b = fx.track(fx.store.read(fx.b.digest, { signal: caller.signal }));
    expect(fx.signals.read.map((signal) => signal?.aborted)).toEqual([false, false]);
    expect(fx.signals.stage.map((signal) => signal?.aborted)).toEqual([false, false]);
    expect(hits).toEqual([]);

    await fx.authority.close();
    const failure = syncFailure(fx.store.assertHeldSync);
    expect(failure).toMatchObject(lost);
    expect(errorTree(failure)).toContainEqual(
      expect.objectContaining({ code: 'plugin-authority-closed' }),
    );
    expect(observations).toEqual([
      { error: failure, reasons: [failure, failure], callerAborted: false },
    ]);
    expect(fx.signals.stage.map((signal) => signal?.reason)).toEqual([failure, failure]);

    const drain = fx.track(fx.store.quiesce());
    await expect(fx.store.read(fx.b.digest)).rejects.toBe(failure);
    await expect(fx.store.stage({ sourceDirectory: fx.a.directory })).rejects.toBe(failure);
    expect(syncFailure(fx.store.assertHeldSync)).toBe(failure);
    fx.aGate.release.resolve();
    await expect(a).rejects.toBe(failure);
    await expect(b).rejects.toBe(failure);
    await drain;
    expect(hits).toEqual([]);
    expect(observations).toHaveLength(1);
  });
  expect(await Promise.all(names.map((name) => fs.readFile(join(fx.b.directory, name))))).toEqual(
    originalBytes,
  );
});

it('quiesces synchronously, drains both dispatched reads and retains the lease through a consumer barrier', async () => {
  const fx = await queueFixture();
  const bGate = filesystemGate(fx.b.directory);
  const contender = fx.contender();
  const consumer = Promise.withResolvers<void>();
  await fx.runWithGates([bGate], async (hits) => {
    const a = fx.track(fx.store.read(fx.a.digest));
    await fx.waitForGate(fx.aGate, a);
    const b = fx.track(fx.store.read(fx.b.digest));
    let drained = false;
    const first = fx.track(
      fx.store.quiesce().then(() => {
        drained = true;
      }),
    );
    const second = fx.track(fx.store.quiesce());
    const rejected = fx.track(fx.store.read(fx.a.digest));
    expect(fx.signals.read).toHaveLength(2);
    await expect(rejected).rejects.toMatchObject(closed);
    fx.store.assertHeldSync();
    expect(fx.signals.read.map((signal) => signal?.aborted)).toEqual([false, false]);
    fx.aGate.release.resolve();
    await expect(a).resolves.toEqual(fx.a);
    await fx.waitForGate(bGate, b);
    expect(drained).toBe(false);
    await expect(fx.open({ authority: contender })).rejects.toMatchObject(busy);
    bGate.release.resolve();
    await expect(b).resolves.toEqual(fx.b);
    await Promise.all([first, second]);
    expect(hits).toEqual(expect.arrayContaining(['lstat', 'opendir', 'open']));
    expect(fx.signals.read.map((signal) => signal?.aborted)).toEqual([false, false]);

    const shutdown = consumer.promise.then(() => fx.store.close());
    fx.track(shutdown);
    try {
      fx.store.assertHeldSync();
      await expect(fx.open({ authority: contender })).rejects.toMatchObject(busy);
    } finally {
      consumer.resolve();
    }
    await shutdown;
    expect(fx.observer).not.toHaveBeenCalled();
  });
  const reopened = await fx.open({ authority: contender, initialBinding: 'require-bound' });
  expect(reopened.binding).toEqual(fx.store.binding);
  expect(fx.authority.readManagedRootStateSync().registration?.binding).toEqual(fx.store.binding);
});

it('preserves caller abort and artifact errors while ownership stays healthy', async () => {
  const fx = await queueFixture();
  const caller = new AbortController();
  const reason = new Error('caller cancelled');
  await fx.runWithGates([], async (hits) => {
    const a = fx.track(fx.store.read(fx.a.digest));
    await fx.waitForGate(fx.aGate, a);
    const b = fx.track(fx.store.read(fx.b.digest, { signal: caller.signal }));
    caller.abort(reason);
    expect(fx.signals.read[0]?.aborted).toBe(false);
    expect(fx.signals.read[1]?.reason).toBe(reason);
    fx.aGate.release.resolve();
    await expect(a).resolves.toEqual(fx.a);
    await expect(b).rejects.toBe(reason);
    expect(hits).toEqual([]);
  });
  await expect(fx.store.read(fx.b.digest, { signal: caller.signal })).rejects.toBe(reason);
  await expect(fx.store.read('f'.repeat(64))).rejects.toMatchObject({
    code: 'plugin-artifact-not-found',
  });
  await expect(fx.store.read(fx.b.digest)).resolves.toEqual(fx.b);
  fx.store.assertHeldSync();
  expect(fx.observer).not.toHaveBeenCalled();
});

it('detects lost ownership before dispatching a preview', async () => {
  const fx = await queueFixture();
  const sourceDirectory = await pluginSource(fx.parent, 'draft');
  await fx.authority.close();

  const error = await fx.store.preview({ sourceDirectory }).catch((cause: unknown) => cause);
  expect(error).toMatchObject(lost);
  expect(errorTree(error)).toContainEqual(
    expect.objectContaining({ code: 'plugin-authority-closed' }),
  );
  expect(fx.observer).toHaveBeenCalledExactlyOnceWith(error);
  expect(fx.signals.preview).toEqual([]);
});

it('checks ownership after preview and preserves an independent failure from dispatched work', async () => {
  const fx = await queueFixture();
  const sourceDirectory = await pluginSource(fx.parent, 'draft');
  const previewGate = filesystemGate(sourceDirectory);
  const cause = Object.assign(new Error('preview read failed'), { code: 'EIO' });
  const lstat = fs.lstat;
  await fx.runWithGates([previewGate], async () => {
    vi.spyOn(fs, 'lstat').mockImplementation((file, options) => {
      if (file === join(sourceDirectory, 'index.mjs')) throw cause;
      return lstat(file, options);
    });
    const preview = fx.track(fx.store.preview({ sourceDirectory }));
    await fx.waitForGate(previewGate, preview);
    await fx.authority.close();
    expect(fx.signals.preview[0]?.aborted).toBe(false);
    previewGate.release.resolve();

    const error = await preview.catch((operation: unknown) => operation);
    expect(error).toMatchObject(lost);
    expect(errorTree(error)).toContain(cause);
    expect(errorTree(error)).toContain(fx.observer.mock.calls[0]?.[0]);
    expect(fx.observer).toHaveBeenCalledTimes(1);
    await expect(fx.store.preview({ sourceDirectory })).rejects.toBe(
      fx.observer.mock.calls[0]?.[0],
    );
  });
});

it('tracks an in-flight preview through quiescence and propagates caller cancellation', async () => {
  const fx = await queueFixture();
  const sourceDirectory = await pluginSource(fx.parent, 'draft');
  const previewGate = filesystemGate(sourceDirectory);
  const contender = fx.contender();
  const caller = new AbortController();
  const reason = new Error('preview cancelled');

  await fx.runWithGates([previewGate], async () => {
    const preview = fx.track(fx.store.preview({ sourceDirectory, signal: caller.signal }));
    await fx.waitForGate(previewGate, preview);
    let drained = false;
    const drain = fx.track(
      fx.store.quiesce().then(() => {
        drained = true;
      }),
    );
    const close = fx.track(fx.store.close());
    await expect(fx.store.preview({ sourceDirectory })).rejects.toMatchObject(closed);
    await expect(fx.open({ authority: contender })).rejects.toMatchObject(busy);
    caller.abort(reason);
    expect(fx.signals.preview).toHaveLength(1);
    expect(fx.signals.preview[0]?.reason).toBe(reason);
    expect(drained).toBe(false);
    previewGate.release.resolve();

    await expect(preview).rejects.toBe(reason);
    await drain;
    await close;
    expect(fx.observer).not.toHaveBeenCalled();
  });
  expect(
    (await fx.open({ authority: contender, initialBinding: 'require-bound' })).binding,
  ).toEqual(fx.store.binding);
});

it('forwards reviewed evidence through the same owned artifact store', async () => {
  const fx = await queueFixture();
  const sourceDirectory = await pluginSource(fx.parent, 'draft');
  const expectedSource = await fx.store.preview({ sourceDirectory });
  const invalidEvidence: StagePluginArtifactOptions = {
    sourceDirectory,
    expectedSource: { ...expectedSource, files: 0 },
  };
  await expect(fx.store.stage(invalidEvidence)).rejects.toMatchObject({
    code: 'plugin-artifact-invalid',
  });
  expect(fx.signals.stage).toHaveLength(2);
  await fs.writeFile(join(sourceDirectory, 'index.mjs'), 'export default "changed";');

  await expect(fx.store.stage({ sourceDirectory, expectedSource })).rejects.toMatchObject({
    code: 'plugin-artifact-source-changed',
  });
  expect(fx.signals.stage).toHaveLength(3);
  expect(storeFactory).toHaveBeenCalledTimes(1);
  expect(await fs.readdir(join(fx.directory, 'artifacts'))).toHaveLength(2);
  await expect(fx.store.read(expectedSource.digest)).rejects.toMatchObject({
    code: 'plugin-artifact-not-found',
  });
});

it('validates read and stage input before dispatch without changing artifact error codes', async () => {
  const fx = await queueFixture();
  const invalid = { code: 'plugin-artifact-invalid' };
  await expect(fx.store.read('../invalid')).rejects.toMatchObject(invalid);
  await expect(fx.store.read(fx.a.digest, { signal: {} as AbortSignal })).rejects.toMatchObject(
    invalid,
  );
  await expect(fx.store.stage({ sourceDirectory: 'relative' })).rejects.toMatchObject(invalid);
  await expect(
    fx.store.stage({ sourceDirectory: fx.a.directory, extra: true } as Parameters<
      OwnedPluginArtifactStore['stage']
    >[0]),
  ).rejects.toMatchObject(invalid);
  expect(fx.signals.read).toEqual([]);
  expect(fx.signals.stage).toHaveLength(2);
  fx.store.assertHeldSync();
});

function captureLifetimeOwner(ownerFile: string) {
  const exec = DatabaseSync.prototype.exec;
  const candidates: DatabaseSync[] = [];
  vi.spyOn(DatabaseSync.prototype, 'exec').mockImplementation(function (this: DatabaseSync, sql) {
    exec.call(this, sql);
    if (sql === 'BEGIN EXCLUSIVE' && this.location('main') === ownerFile) candidates.push(this);
  });
  return {
    owner() {
      const owner = candidates.at(-1);
      if (owner === undefined) throw new Error('Expected a native lease connection');
      return owner;
    },
    exec,
  };
}

it('preserves startup and unwind failures while keeping the first owner binding readable', async () => {
  const { authority, ownerFile, open, observer } = fixture();
  const startup = new Error('main registration failed');
  const rollback = new Error('owner rollback failed');
  vi.spyOn(authority, 'registerManagedRootSync').mockImplementationOnce(() => {
    throw startup;
  });
  const nativeExec = DatabaseSync.prototype.exec;
  const spy = vi.spyOn(DatabaseSync.prototype, 'exec').mockImplementation(function (
    this: DatabaseSync,
    sql,
  ) {
    if (sql === 'ROLLBACK' && this.location('main') === ownerFile) throw rollback;
    nativeExec.call(this, sql);
  });

  const failure = await open().catch((error: unknown) => error);
  expect(failure).toMatchObject({ code: 'plugin-store-storage' });
  expect(errorTree(failure)).toEqual(expect.arrayContaining([startup, rollback]));
  expect(authority.readManagedRootStateSync().registration).toBeNull();
  expect(storeFactory).not.toHaveBeenCalled();
  expect(observer).not.toHaveBeenCalled();
  spy.mockRestore();
  const binding = bindingOnDisk(ownerFile);
  expect((await open({ initialBinding: 'require-bound' })).binding).toEqual(binding);
});

it('rejects a valid stage when a caller getter starts quiesce during validation', async () => {
  const fx = await queueFixture();
  const stage = fx.track(
    fx.store.stage({
      get sourceDirectory() {
        void fx.store.quiesce();
        return fx.a.directory;
      },
    }),
  );
  try {
    expect(fx.signals.stage).toHaveLength(2);
    await expect(stage).rejects.toMatchObject(closed);
  } finally {
    await Promise.allSettled([stage]);
  }
  fx.store.assertHeldSync();
});

it('completes its drain ticket when the underlying dispatch throws synchronously', async () => {
  const fx = fixture();
  const host = await vi.importActual<typeof import('@weave/plugin-host')>('@weave/plugin-host');
  const operation = new Error('dispatch threw');
  let drain: Promise<void> | undefined;
  storeFactory.mockImplementationOnce((options) => {
    const real = host.createPluginArtifactStore(options);
    return {
      ...real,
      read() {
        drain = store.quiesce();
        throw operation;
      },
    };
  });
  const store = await fx.open();
  await expect(store.read('f'.repeat(64))).rejects.toBe(operation);
  expect(drain).toBeDefined();
  await drain;
  await store.close();
  expect(fx.observer).not.toHaveBeenCalled();
});

it('keeps both registrations and releases the lease when artifact-store construction fails', async () => {
  const { authority, ownerFile, open, observer } = fixture();
  const construction = new Error('artifact-store construction failed');
  storeFactory.mockImplementationOnce(() => {
    throw construction;
  });

  const failure = await open().catch((error: unknown) => error);
  expect(failure).toMatchObject({ code: 'plugin-store-storage' });
  expect(errorTree(failure)).toContain(construction);
  const binding = bindingOnDisk(ownerFile);
  expect(authority.readManagedRootStateSync().registration?.binding).toEqual(binding);
  expect((await open({ initialBinding: 'require-bound' })).binding).toEqual(binding);
  expect(observer).not.toHaveBeenCalled();
});

it('reports a lost native lifetime transaction exactly once', async () => {
  const { ownerFile, open, observer } = fixture();
  const native = captureLifetimeOwner(ownerFile);
  const store = await open();
  native.exec.call(native.owner(), 'ROLLBACK');
  const failure = syncFailure(store.assertHeldSync);
  expect(failure).toMatchObject(lost);
  expect(observer).toHaveBeenCalledExactlyOnceWith(failure);
  await expect(store.read('f'.repeat(64))).rejects.toBe(failure);
});

it.each(['missing', 'replaced'])('fails closed when the owner path is %s', async (change) => {
  const { ownerFile, open, observer } = fixture();
  const store = await open();
  renameSync(ownerFile, `${ownerFile}.moved`);
  if (change === 'replaced') writeFileSync(ownerFile, 'different file');
  const failure = syncFailure(store.assertHeldSync);
  expect(failure).toMatchObject(lost);
  expect(observer).toHaveBeenCalledExactlyOnceWith(failure);
  await expect(store.read('f'.repeat(64))).rejects.toBe(failure);
  await store.close();
});

it('preserves a throwing observer with the original loss and never reenters the observer', async () => {
  const { authority, open } = fixture();
  const observerError = new Error('observer threw');
  let reentrant: unknown;
  const onOwnershipLost = vi.fn<StoreOptions['onOwnershipLost']>(() => {
    reentrant = syncFailure(store.assertHeldSync);
    throw observerError;
  });
  const store = await open({ onOwnershipLost });
  await authority.close();

  const failure = syncFailure(store.assertHeldSync);
  expect(failure).toMatchObject(lost);
  expect(reentrant).toBe(onOwnershipLost.mock.calls[0]?.[0]);
  expect(errorTree(failure)).toEqual(expect.arrayContaining([reentrant, observerError]));
  expect(syncFailure(store.assertHeldSync)).toBe(failure);
  await expect(store.read('f'.repeat(64))).rejects.toBe(failure);
  expect(onOwnershipLost).toHaveBeenCalledTimes(1);
});

it.each(['async', 'thenable', 'throwing then getter', 'value'])(
  'rejects a %s observer return synchronously',
  async (kind) => {
    const { authority, open } = fixture();
    const deferred = Promise.withResolvers<never>();
    const eventual = new Error('eventual rejection');
    const invalidGetter = new Error('then getter threw');
    let thenReads = 0;
    const thenEntered = Promise.withResolvers<void>();
    let rejectThen: ((reason: unknown) => void) | undefined;
    const outcomes = {
      async: async () => await deferred.promise,
      thenable: () => ({
        get then() {
          thenReads += 1;
          return (_resolve: unknown, reject: (reason: unknown) => void) => {
            rejectThen = reject;
            thenEntered.resolve();
          };
        },
      }),
      'throwing then getter': () => ({
        get then() {
          throw invalidGetter;
        },
      }),
      value: () => 42,
    };
    const onOwnershipLost = vi.fn<StoreOptions['onOwnershipLost']>(
      outcomes[kind] as unknown as StoreOptions['onOwnershipLost'],
    );
    const store = await open({ onOwnershipLost });
    await authority.close();

    const failure = syncFailure(store.assertHeldSync);
    expect(failure).toMatchObject(lost);
    expect(errorTree(failure)).toContain(onOwnershipLost.mock.calls[0]?.[0]);
    if (kind === 'throwing then getter') expect(errorTree(failure)).toContain(invalidGetter);
    else
      expect(errorTree(failure)).toContainEqual(
        expect.objectContaining({ message: expect.stringMatching(/return undefined/) }),
      );
    try {
      if (kind === 'async') deferred.reject(eventual);
      if (kind === 'thenable') {
        expect(thenReads).toBe(1);
        expect(rejectThen).toBeUndefined();
        await thenEntered.promise;
        rejectThen?.(eventual);
        expect(thenReads).toBe(1);
      }
    } finally {
      await expect(store.read('f'.repeat(64))).rejects.toBe(failure);
    }
    expect(onOwnershipLost).toHaveBeenCalledTimes(1);
  },
);

it('observes a rejection returned by a thenable observer method', async () => {
  const { authority, open } = fixture();
  const eventual = new Error('async then method rejected');
  const invoked = vi.fn();
  const invalidObserver = () => ({
    async then() {
      invoked();
      throw eventual;
    },
  });
  const onOwnershipLost = invalidObserver as unknown as StoreOptions['onOwnershipLost'];
  const store = await open({ onOwnershipLost });
  await authority.close();

  const unhandled: unknown[] = [];
  const recordUnhandled = (reason: unknown) => unhandled.push(reason);
  process.on('unhandledRejection', recordUnhandled);
  try {
    const failure = syncFailure(store.assertHeldSync);
    expect(failure).toMatchObject(lost);
    expect(errorTree(failure)).toContainEqual(
      expect.objectContaining({ message: expect.stringMatching(/return undefined/) }),
    );
    expect(invoked).not.toHaveBeenCalled();
    await setImmediate();
    expect(invoked).toHaveBeenCalledTimes(1);
    expect(unhandled).toEqual([]);
    await expect(store.read('f'.repeat(64))).rejects.toBe(failure);
  } finally {
    process.off('unhandledRejection', recordUnhandled);
  }
});

it('waits for active work before concurrent closes release the native lock once', async () => {
  const fx = await queueFixture();
  const contender = fx.contender();
  const nativeClose = DatabaseSync.prototype.close;
  const release = vi.spyOn(DatabaseSync.prototype, 'close').mockImplementation(function (
    this: DatabaseSync,
  ) {
    return nativeClose.call(this);
  });
  await fx.runWithGates([], async () => {
    const read = fx.track(fx.store.read(fx.a.digest));
    await fx.waitForGate(fx.aGate, read);
    const first = fx.track(fx.store.close());
    const second = fx.track(fx.store.close());
    await expect(fx.open({ authority: contender })).rejects.toMatchObject(busy);
    const rejected = fx.track(fx.store.read(fx.b.digest));
    expect(fx.signals.read).toHaveLength(1);
    await expect(rejected).rejects.toMatchObject(closed);
    release.mockClear();
    fx.aGate.release.resolve();
    await expect(read).resolves.toEqual(fx.a);
    await Promise.all([first, second]);
    expect(release).toHaveBeenCalledTimes(1);
    expect(fx.observer).not.toHaveBeenCalled();
  });
  expect(
    (await fx.open({ authority: contender, initialBinding: 'require-bound' })).binding,
  ).toEqual(fx.store.binding);
});

it('shares a failed close attempt and retries release without reopening operations', async () => {
  const { ownerFile, open, contender, observer } = fixture();
  const native = captureLifetimeOwner(ownerFile);
  const store = await open();
  const authority = contender();
  const owner = native.owner();
  const rollback = new Error('rollback failure');
  const close = new Error('close failure');
  let rollbackCalls = 0;
  let closeCalls = 0;
  const nativeClose = DatabaseSync.prototype.close;
  const execSpy = vi.spyOn(DatabaseSync.prototype, 'exec').mockImplementation(function (
    this: DatabaseSync,
    sql,
  ) {
    if (this === owner && sql === 'ROLLBACK' && ++rollbackCalls === 1) throw rollback;
    native.exec.call(this, sql);
  });
  const closeSpy = vi.spyOn(DatabaseSync.prototype, 'close').mockImplementation(function (
    this: DatabaseSync,
  ) {
    if (this === owner && ++closeCalls === 1) throw close;
    nativeClose.call(this);
  });
  try {
    const outcomes = await Promise.allSettled([store.close(), store.close()]);
    expect(outcomes[0]).toMatchObject({
      status: 'rejected',
      reason: { code: 'plugin-store-storage' },
    });
    expect(outcomes[1]).toEqual(outcomes[0]);
    const failure = (outcomes[0] as PromiseRejectedResult).reason;
    expect(errorTree(failure)).toEqual(expect.arrayContaining([rollback, close]));
    expect(rollbackCalls).toBe(1);
    expect(closeCalls).toBe(1);
    expect(syncFailure(store.assertHeldSync)).toMatchObject(closed);
    await expect(store.read('f'.repeat(64))).rejects.toMatchObject(closed);
    await expect(open({ authority })).rejects.toMatchObject(busy);

    await store.close();
    await store.close();
    expect(rollbackCalls).toBe(2);
    expect(closeCalls).toBe(2);
    await expect(store.read('f'.repeat(64))).rejects.toMatchObject(closed);
    expect((await open({ authority, initialBinding: 'require-bound' })).binding).toEqual(
      store.binding,
    );
    expect(observer).not.toHaveBeenCalled();
  } finally {
    execSpy.mockRestore();
    closeSpy.mockRestore();
  }
});
