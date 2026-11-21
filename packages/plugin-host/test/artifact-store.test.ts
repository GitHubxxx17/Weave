import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs, {
  access,
  mkdir,
  readFile,
  readdir,
  symlink,
  truncate,
  unlink,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';

import { afterEach, expect, test, vi } from 'vitest';

import * as host from '../src/index.js';
import {
  helloSource,
  makeTempDirectory,
  removeTempDirectories,
  writePlugin,
} from './support/fixtures.js';

afterEach(removeTempDirectories);
afterEach(() => vi.restoreAllMocks());

async function fixture() {
  const root = await makeTempDirectory();
  const managedRoot = path.join(root, '.weave-store');
  const sourceDirectory = await writePlugin(root, 'sample', { entry: 'index.mjs' });
  return { root, managedRoot, sourceDirectory };
}

async function expectNoPublication(managedRoot: string): Promise<void> {
  for (const name of ['staging', 'artifacts']) {
    const entries = await readdir(path.join(managedRoot, name)).catch((error: unknown) => {
      expect(error).toMatchObject({ code: 'ENOENT' });
      return [];
    });
    expect(entries).toEqual([]);
  }
}

test('publishes a fixed, data-only copy with the original directory digest', async () => {
  const root = await makeTempDirectory();
  const managedRoot = path.join(root, '.weave-store');
  const executionMarker = path.join(root, 'executed');
  const source = `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(executionMarker)}, 'executed');\n`;
  const largeFile = 'x'.repeat(64 * 1024) + 'last chunk';
  const sourceDirectory = await writePlugin(root, 'sample', {
    entry: 'index.mjs',
    source,
    files: {
      '.bundle': 'metadata',
      empty: '',
      large: largeFile,
      '.git/config': 'ignored',
      'nested/.DS_Store': 'ignored',
      'nested/Thumbs.db': 'ignored',
    },
  });
  const expected = await host.computeDirectoryDigest(sourceDirectory);

  expect(host.createPluginArtifactStore).toBeTypeOf('function');
  const store = host.createPluginArtifactStore({ directory: managedRoot, hostVersion: '0.0.0' });
  const artifact = await store.stage({ sourceDirectory });

  expect(artifact).toMatchObject(expected);
  expect(artifact.directory).toBe(path.join(managedRoot, 'artifacts', artifact.digest, 'payload'));
  expect(await host.computeDirectoryDigest(artifact.directory)).toEqual(expected);
  expect(await readFile(path.join(artifact.directory, '.bundle'), 'utf8')).toBe('metadata');
  expect(await readFile(path.join(artifact.directory, 'empty'), 'utf8')).toBe('');
  expect(await readFile(path.join(artifact.directory, 'large'), 'utf8')).toBe(largeFile);
  for (const ignored of ['.git', 'nested/.DS_Store', 'nested/Thumbs.db']) {
    await expect(access(path.join(artifact.directory, ignored))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  }
  await writeFile(path.join(sourceDirectory, 'index.mjs'), 'throw new Error("edited")');
  await writeFile(path.join(sourceDirectory, 'weave-plugin.json'), '{}');
  expect(await readFile(path.join(artifact.directory, 'index.mjs'), 'utf8')).toBe(source);
  expect(await store.read(artifact.digest)).toEqual(artifact);
  expect(artifact.descriptor.manifest).toMatchObject({ id: 'sample', version: '1.0.0' });
  expect(Object.isFrozen(artifact)).toBe(true);
  expect(Object.isFrozen(artifact.descriptor.manifest.contributes?.commands)).toBe(true);
  await expect(access(executionMarker)).rejects.toMatchObject({ code: 'ENOENT' });
});

test('returns the validated nested entry at its published path', async () => {
  const root = await makeTempDirectory();
  const managedRoot = path.join(root, '.weave-store');
  const sourceDirectory = await writePlugin(root, 'sample', { entry: 'nested/index.mjs' });
  const store = host.createPluginArtifactStore({ directory: managedRoot });
  const artifact = await store.stage({ sourceDirectory });

  expect(artifact.entry).toBe(path.join(artifact.directory, 'nested', 'index.mjs'));
  expect(await readFile(artifact.entry, 'utf8')).toBe(helloSource);
  expect((await store.read(artifact.digest)).entry).toBe(artifact.entry);
  expect((await store.stage({ sourceDirectory })).entry).toBe(artifact.entry);
});

test('rejects malformed options before creating the managed directory', async () => {
  const { managedRoot } = await fixture();
  const create = host.createPluginArtifactStore;
  expect(() => create({ directory: 'relative' })).toThrow(
    expect.objectContaining({
      code: 'plugin-artifact-invalid',
    }),
  );
  expect(() => create({ directory: managedRoot, hostVersion: 'latest' })).toThrow(
    expect.objectContaining({ code: 'plugin-artifact-invalid' }),
  );
  const store = create({ directory: managedRoot });
  await expect(store.stage({ sourceDirectory: 'relative' })).rejects.toMatchObject({
    code: 'plugin-artifact-invalid',
  });
  await expect(store.read('../outside')).rejects.toMatchObject({ code: 'plugin-artifact-invalid' });
  await expect(access(managedRoot)).rejects.toMatchObject({ code: 'ENOENT' });
});

test('rejects a pre-aborted stage with the supplied reason before creating files', async () => {
  const { managedRoot, sourceDirectory } = await fixture();
  const store = host.createPluginArtifactStore({ directory: managedRoot });
  const reason = new Error('cancel request');
  await expect(store.stage({ sourceDirectory, signal: AbortSignal.abort(reason) })).rejects.toBe(
    reason,
  );
  await expect(access(managedRoot)).rejects.toMatchObject({ code: 'ENOENT' });
});

test('cleans the actual staging directory when cancelled during copy', async () => {
  const { managedRoot, sourceDirectory } = await fixture();
  const store = host.createPluginArtifactStore({ directory: managedRoot });
  const controller = new AbortController();
  const reason = new Error('cancel during copy');
  const open = fs.open;
  vi.spyOn(fs, 'open').mockImplementation(async (file, flags, mode) => {
    const handle = await open(file, flags, mode);
    if (String(file).startsWith(path.join(managedRoot, 'staging') + path.sep)) {
      controller.abort(reason);
    }
    return handle;
  });
  await expect(store.stage({ sourceDirectory, signal: controller.signal })).rejects.toBe(reason);
  await expectNoPublication(managedRoot);
  expect(await readdir(path.join(managedRoot, 'staging'))).toEqual([]);
});

test.each([
  ['malformed JSON', '{ private payload', 'weave-plugin.json'],
  ['oversize descriptor', ' '.repeat(64 * 1024 + 1), 'weave-plugin.json'],
  ['missing descriptor', undefined, 'weave-plugin.json'],
  ['missing entry', undefined, 'index.mjs'],
])('rejects %s without publishing', async (_label, replacement, file) => {
  const { managedRoot, sourceDirectory } = await fixture();
  const target = path.join(sourceDirectory, file);
  if (replacement === undefined) await unlink(target);
  else await writeFile(target, replacement);
  const store = host.createPluginArtifactStore({ directory: managedRoot });
  await expect(store.stage({ sourceDirectory })).rejects.toMatchObject({
    code: 'plugin-artifact-invalid',
    message: expect.not.stringContaining('private payload'),
  });
  await expectNoPublication(managedRoot);
});

test.each([
  ['API version', { apiVersion: '2.0.0' }, []],
  ['plugin host', { host: 'subprocess' }, []],
  ['Weave engine', { engines: { weave: '^2.0.0' } }, []],
  ['reserved ID', {}, ['sample']],
])('rejects an incompatible %s', async (_label, manifest, reservedIds) => {
  const root = await makeTempDirectory();
  const directory = path.join(root, '.weave-store');
  const sourceDirectory = await writePlugin(root, 'sample', { manifest });
  const store = host.createPluginArtifactStore({ directory, reservedIds, hostVersion: '1.0.0' });
  await expect(store.stage({ sourceDirectory })).rejects.toMatchObject({
    code: 'plugin-artifact-invalid',
  });
  await expectNoPublication(directory);
});

test('normalizes a linked source ancestor while refusing a linked source directory', async () => {
  const { root, managedRoot, sourceDirectory } = await fixture();
  const store = host.createPluginArtifactStore({ directory: managedRoot });
  const symlinks = await makeTempDirectory();
  const linkedSource = path.join(symlinks, 'linked-source');
  const linkedAncestor = path.join(symlinks, 'linked-ancestor');
  await symlink(sourceDirectory, linkedSource, 'junction');
  await symlink(root, linkedAncestor, 'junction');
  await expect(store.stage({ sourceDirectory: linkedSource })).rejects.toMatchObject({
    code: 'plugin-artifact-unsupported-file',
  });
  await expect(
    store.stage({ sourceDirectory: path.join(linkedAncestor, 'sample') }),
  ).resolves.toMatchObject(await host.computeDirectoryDigest(sourceDirectory));
});

test.skipIf(process.platform === 'win32').each(['index.mjs', 'linked-child'])(
  'rejects a linked payload file at %s',
  async (name) => {
    const { root, managedRoot, sourceDirectory } = await fixture();
    const target = path.join(root, 'outside.mjs');
    const link = path.join(sourceDirectory, name);
    await writeFile(target, 'outside bytes');
    if (name === 'index.mjs') await unlink(link);
    await symlink(target, link);
    const store = host.createPluginArtifactStore({ directory: managedRoot });
    await expect(store.stage({ sourceDirectory })).rejects.toMatchObject({
      code: 'plugin-artifact-unsupported-file',
    });
    await expectNoPublication(managedRoot);
    expect(await readFile(target, 'utf8')).toBe('outside bytes');
  },
);

test.skipIf(process.platform === 'win32')('rejects a special file without opening it', async () => {
  const { managedRoot, sourceDirectory } = await fixture();
  execFileSync('mkfifo', [path.join(sourceDirectory, 'fifo')]);
  const store = host.createPluginArtifactStore({ directory: managedRoot });
  await expect(store.stage({ sourceDirectory })).rejects.toMatchObject({
    code: 'plugin-artifact-unsupported-file',
  });
  await expectNoPublication(managedRoot);
});

test('rejects source and store overlap in either direction before creating store directories', async () => {
  const { root, managedRoot, sourceDirectory } = await fixture();
  const nestedStore = path.join(sourceDirectory, '.weave-store');
  const nested = host.createPluginArtifactStore({ directory: nestedStore });
  await expect(nested.stage({ sourceDirectory })).rejects.toMatchObject({
    code: 'plugin-artifact-invalid',
  });
  await expect(access(nestedStore)).rejects.toMatchObject({ code: 'ENOENT' });

  await mkdir(managedRoot);
  const sourceInsideStore = await writePlugin(managedRoot, 'sample');
  const store = host.createPluginArtifactStore({ directory: managedRoot });
  await expect(store.stage({ sourceDirectory: sourceInsideStore })).rejects.toMatchObject({
    code: 'plugin-artifact-invalid',
  });
  await expect(store.stage({ sourceDirectory: root })).rejects.toMatchObject({
    code: 'plugin-artifact-invalid',
  });
  expect(await readdir(managedRoot)).toEqual(['sample']);
});

test.each([
  [
    '65 directory levels',
    async (directory: string) => {
      await mkdir(path.join(directory, ...Array<string>(65).fill('d')), { recursive: true });
    },
  ],
  [
    '2,001 entries',
    async (directory: string) => {
      for (let index = 0; index < 1999; index += 1) await mkdir(path.join(directory, `d${index}`));
    },
  ],
  [
    '1,001 files',
    async (directory: string) => {
      for (let index = 0; index < 999; index += 1)
        await writeFile(path.join(directory, `f${index}`), '');
    },
  ],
  [
    'over 20 MiB',
    async (directory: string) => {
      const target = path.join(directory, 'large');
      await writeFile(target, '');
      await truncate(target, 20 * 1024 * 1024);
    },
  ],
])('rejects a source with %s', async (_label, createFiles) => {
  const { managedRoot, sourceDirectory } = await fixture();
  await createFiles(sourceDirectory);
  const store = host.createPluginArtifactStore({ directory: managedRoot });
  await expect(store.stage({ sourceDirectory })).rejects.toMatchObject({
    code: 'plugin-artifact-too-large',
  });
  await expectNoPublication(managedRoot);
});

test('rejects a source edited while the staging copy is in progress', async () => {
  const { managedRoot, sourceDirectory } = await fixture();
  const store = host.createPluginArtifactStore({ directory: managedRoot });
  const edited = 'edited while staging'.repeat(4 * 1024);
  const open = fs.open;
  vi.spyOn(fs, 'open').mockImplementation(async (file, flags, mode) => {
    const handle = await open(file, flags, mode);
    if (
      String(file).startsWith(path.join(managedRoot, 'staging') + path.sep) &&
      String(file).endsWith(path.sep + 'index.mjs')
    ) {
      await writeFile(path.join(sourceDirectory, 'index.mjs'), edited);
    }
    return handle;
  });
  await expect(store.stage({ sourceDirectory })).rejects.toMatchObject({
    code: 'plugin-artifact-source-changed',
  });
  await expectNoPublication(managedRoot);
  expect(await readFile(path.join(sourceDirectory, 'index.mjs'), 'utf8')).toBe(edited);
});

test('reports a source file removed during the initial digest as source-changed', async () => {
  const { managedRoot, sourceDirectory } = await fixture();
  const store = host.createPluginArtifactStore({ directory: managedRoot });
  const entry = path.join(sourceDirectory, 'index.mjs');
  const lstat = fs.lstat;
  vi.spyOn(fs, 'lstat').mockImplementation(async (file, options) => {
    if (file === entry) await unlink(entry);
    return lstat(file, options);
  });

  await expect(store.stage({ sourceDirectory })).rejects.toMatchObject({
    code: 'plugin-artifact-source-changed',
    cause: { code: 'ENOENT' },
  });
  await expect(access(entry)).rejects.toMatchObject({ code: 'ENOENT' });
  await expectNoPublication(managedRoot);
});

test('reuses identical bytes and retains older versions at their concrete paths', async () => {
  const { root, managedRoot, sourceDirectory } = await fixture();
  const store = host.createPluginArtifactStore({ directory: managedRoot });
  const first = await store.stage({ sourceDirectory });
  const repeated = await store.stage({ sourceDirectory });
  expect(repeated).toEqual(first);
  const newVersion = await writePlugin(root, 'sample', {
    entry: 'index.mjs',
    manifest: { version: '2.0.0' },
    source: 'export const second = true;',
  });
  const second = await store.stage({ sourceDirectory: newVersion });
  expect(second.directory).not.toBe(first.directory);
  expect((await store.read(first.digest)).descriptor.manifest.version).toBe('1.0.0');
  expect((await store.read(second.digest)).descriptor.manifest.version).toBe('2.0.0');
  expect(await readdir(path.join(managedRoot, 'staging'))).toEqual([]);

  await fs.rm(sourceDirectory, { recursive: true });
  const discovery = await host.discoverLocalPlugins({ directory: root });
  expect(discovery.candidates).toEqual([]);
});

test('rejects corrupt published bytes without repairing or overwriting the object', async () => {
  const { managedRoot, sourceDirectory } = await fixture();
  const store = host.createPluginArtifactStore({ directory: managedRoot });
  const artifact = await store.stage({ sourceDirectory });
  const entry = path.join(artifact.directory, 'index.mjs');
  await writeFile(entry, 'tampered');
  await expect(store.read(artifact.digest)).rejects.toMatchObject({
    code: 'plugin-artifact-corrupt',
  });
  await expect(store.stage({ sourceDirectory })).rejects.toMatchObject({
    code: 'plugin-artifact-conflict',
  });
  expect(await readFile(entry, 'utf8')).toBe('tampered');
  expect(await readdir(path.join(managedRoot, 'staging'))).toEqual([]);
});

test('rejects a published payload that exceeds the directory-depth bound', async () => {
  const { managedRoot, sourceDirectory } = await fixture();
  const store = host.createPluginArtifactStore({ directory: managedRoot });
  const artifact = await store.stage({ sourceDirectory });
  const deep = path.join(artifact.directory, ...Array<string>(65).fill('d'));
  await mkdir(deep, { recursive: true });
  await expect(store.read(artifact.digest)).rejects.toMatchObject({
    code: 'plugin-artifact-corrupt',
  });
  await expect(store.stage({ sourceDirectory })).rejects.toMatchObject({
    code: 'plugin-artifact-conflict',
  });
  await expect(access(deep)).resolves.toBeUndefined();
});

test('retains an occupied digest path introduced before the final staging check', async () => {
  const { managedRoot, sourceDirectory } = await fixture();
  const store = host.createPluginArtifactStore({ directory: managedRoot });
  const { digest } = await host.computeDirectoryDigest(sourceDirectory);
  const artifacts = path.join(managedRoot, 'artifacts');
  const object = path.join(artifacts, digest);
  const opendir = fs.opendir;
  vi.spyOn(fs, 'opendir').mockImplementation(async (file, options) => {
    if (file === artifacts) {
      const handle = await opendir(file, options);
      await handle.read();
      await mkdir(object);
      return handle;
    }
    return opendir(file, options);
  });
  await expect(store.stage({ sourceDirectory })).rejects.toMatchObject({
    code: 'plugin-artifact-conflict',
  });
  expect(await readdir(object)).toEqual([]);
  expect(await readdir(path.join(managedRoot, 'staging'))).toEqual([]);
});

test('distinguishes digest syntax, absent artifacts and directories under the wrong digest', async () => {
  const { managedRoot, sourceDirectory } = await fixture();
  const store = host.createPluginArtifactStore({ directory: managedRoot });
  const absent = 'a'.repeat(64);
  await expect(store.read(absent.toUpperCase())).rejects.toMatchObject({
    code: 'plugin-artifact-invalid',
  });
  await expect(store.read(absent)).rejects.toMatchObject({ code: 'plugin-artifact-not-found' });
  const artifact = await store.stage({ sourceDirectory });
  await fs.rename(path.dirname(artifact.directory), path.join(managedRoot, 'artifacts', absent));
  await expect(store.read(artifact.digest)).rejects.toMatchObject({
    code: 'plugin-artifact-not-found',
  });
  await expect(store.read(absent)).rejects.toMatchObject({ code: 'plugin-artifact-corrupt' });
});

async function seedOrphans(managedRoot: string, count: number): Promise<string[]> {
  const names = Array.from({ length: count }, (_, index) => index.toString(16).padStart(64, '0'));
  for (const name of names) {
    await mkdir(path.join(managedRoot, 'artifacts', name), { recursive: true });
  }
  return names;
}

test('counts orphan objects at capacity and still reuses identical published bytes', async () => {
  const { managedRoot, sourceDirectory } = await fixture();
  const store = host.createPluginArtifactStore({ directory: managedRoot });
  const artifact = await store.stage({ sourceDirectory });
  const orphans = await seedOrphans(managedRoot, 63);
  await expect(store.stage({ sourceDirectory })).resolves.toEqual(artifact);
  await writeFile(path.join(sourceDirectory, 'index.mjs'), 'export const different = true;');
  await expect(store.stage({ sourceDirectory })).rejects.toMatchObject({
    code: 'plugin-artifact-capacity',
    message: expect.stringContaining('64'),
  });
  expect((await readdir(path.join(managedRoot, 'artifacts'))).sort()).toEqual(
    [...orphans, artifact.digest].sort(),
  );
  expect(await store.read(artifact.digest)).toEqual(artifact);
  expect(await readdir(path.join(managedRoot, 'staging'))).toEqual([]);
});

test('serializes concurrent stages competing for the last artifact slot', async () => {
  const { root, managedRoot, sourceDirectory } = await fixture();
  const candidate = await writePlugin(root, 'second');
  const store = host.createPluginArtifactStore({ directory: managedRoot });
  await seedOrphans(managedRoot, 63);
  const first = store.stage({ sourceDirectory });
  const second = store.stage({ sourceDirectory: candidate });
  const firstDigest = (await host.computeDirectoryDigest(sourceDirectory)).digest;
  const pendingRead = store.read(firstDigest);
  const [winner, loser, read] = await Promise.allSettled([first, second, pendingRead]);
  expect(winner).toMatchObject({ status: 'fulfilled', value: { digest: firstDigest } });
  expect(loser).toMatchObject({ status: 'rejected', reason: { code: 'plugin-artifact-capacity' } });
  expect(read).toMatchObject({ status: 'fulfilled', value: { digest: firstDigest } });
  expect(await readdir(path.join(managedRoot, 'artifacts'))).toHaveLength(64);
});

test('recovers an abandoned staging operation without touching artifacts', async () => {
  const { managedRoot, sourceDirectory } = await fixture();
  const orphan = path.join(managedRoot, 'staging', randomUUID());
  await mkdir(path.join(orphan, 'payload'), { recursive: true });
  await writeFile(path.join(orphan, 'payload', 'partial'), 'partial bytes');
  const [orphanDigest] = await seedOrphans(managedRoot, 1);
  const store = host.createPluginArtifactStore({ directory: managedRoot });
  const artifact = await store.stage({ sourceDirectory });
  expect(await readdir(path.join(managedRoot, 'staging'))).toEqual([]);
  expect(await readdir(path.join(managedRoot, 'artifacts'))).toEqual(
    [orphanDigest, artifact.digest].sort(),
  );
});

test('preserves unknown staging entries and rejects tampered deep abandoned operations', async () => {
  const { managedRoot, sourceDirectory } = await fixture();
  const staging = path.join(managedRoot, 'staging');
  await mkdir(staging, { recursive: true });
  const unknown = path.join(staging, 'personal');
  await writeFile(unknown, 'retain these bytes');
  const store = host.createPluginArtifactStore({ directory: managedRoot });
  await expect(store.stage({ sourceDirectory })).rejects.toMatchObject({
    code: 'plugin-artifact-conflict',
  });
  expect(await readFile(unknown, 'utf8')).toBe('retain these bytes');
  await unlink(unknown);
  const deep = path.join(staging, randomUUID(), 'payload', ...Array<string>(65).fill('d'));
  await mkdir(deep, { recursive: true });
  await expect(store.stage({ sourceDirectory })).rejects.toMatchObject({
    code: 'plugin-artifact-conflict',
  });
  await expect(access(deep)).resolves.toBeUndefined();
});

test('refuses to clean a staging operation that links outside the store', async () => {
  const { root, managedRoot, sourceDirectory } = await fixture();
  const outside = path.join(root, 'outside');
  await mkdir(outside);
  await writeFile(path.join(outside, 'marker'), 'external bytes');
  const staging = path.join(managedRoot, 'staging');
  await mkdir(staging, { recursive: true });
  await symlink(outside, path.join(staging, randomUUID()), 'junction');
  const store = host.createPluginArtifactStore({ directory: managedRoot });
  await expect(store.stage({ sourceDirectory })).rejects.toMatchObject({
    code: 'plugin-artifact-conflict',
  });
  expect(await readFile(path.join(outside, 'marker'), 'utf8')).toBe('external bytes');
});

test('preserves both the cancellation reason and a failed cleanup', async () => {
  const { managedRoot, sourceDirectory } = await fixture();
  const store = host.createPluginArtifactStore({ directory: managedRoot });
  const controller = new AbortController();
  const reason = new Error('cancel during copy');
  const cleanup = new Error('staging cannot be removed');
  const staging = path.join(managedRoot, 'staging');
  const open = fs.open;
  vi.spyOn(fs, 'open').mockImplementation(async (file, flags, mode) => {
    const handle = await open(file, flags, mode);
    if (String(file).startsWith(staging + path.sep)) controller.abort(reason);
    return handle;
  });
  const rmdir = fs.rmdir;
  vi.spyOn(fs, 'rmdir').mockImplementation(async (file, options) => {
    if (path.dirname(String(file)) === staging) throw cleanup;
    return rmdir(file, options);
  });
  await expect(store.stage({ sourceDirectory, signal: controller.signal })).rejects.toMatchObject({
    code: 'plugin-artifact-io',
    cause: { errors: [reason, cleanup] },
  });
  expect(await readdir(staging)).toHaveLength(1);
  expect(await readdir(path.join(managedRoot, 'artifacts'))).toEqual([]);
});

test('late cancellation retains the published artifact at its fixed path', async () => {
  const { managedRoot, sourceDirectory } = await fixture();
  const store = host.createPluginArtifactStore({ directory: managedRoot });
  const controller = new AbortController();
  const reason = new Error('cancel after publication');
  const rename = fs.rename;
  vi.spyOn(fs, 'rename').mockImplementation(async (oldPath, newPath) => {
    await rename(oldPath, newPath);
    controller.abort(reason);
  });
  const { digest } = await host.computeDirectoryDigest(sourceDirectory);
  await expect(store.stage({ sourceDirectory, signal: controller.signal })).rejects.toBe(reason);
  await expect(store.read(digest)).resolves.toMatchObject({ digest });
  expect(await readdir(path.join(managedRoot, 'staging'))).toEqual([]);
});
