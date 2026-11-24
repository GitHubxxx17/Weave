import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { Dir } from 'node:fs';
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

async function reviewedSource(sourceDirectory: string): Promise<host.PluginArtifactSourceIdentity> {
  const { manifest } = host.parseDescriptor(
    await readFile(path.join(sourceDirectory, 'weave-plugin.json'), 'utf8'),
  );
  return { sourceDirectory, manifest, ...(await host.computeDirectoryDigest(sourceDirectory)) };
}

test('previews normalized data without creating the store or running the entry', async () => {
  const { root, managedRoot, sourceDirectory } = await fixture();
  const marker = path.join(root, 'executed');
  const entry = `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(marker)}, 'executed');\n`;
  await writeFile(path.join(sourceDirectory, 'index.mjs'), entry);
  await mkdir(path.join(sourceDirectory, '.git'));
  await writeFile(path.join(sourceDirectory, '.git', 'config'), 'ignored');
  const links = await makeTempDirectory();
  await symlink(root, path.join(links, 'linked'), 'junction');
  const requested = path.join(links, 'linked', 'sample');
  const store = host.createPluginArtifactStore({ directory: managedRoot });

  const preview = await store.preview({ sourceDirectory: requested });
  expect(preview).toEqual(await reviewedSource(sourceDirectory));
  expect(preview.files).toBe(2);
  expect(Object.isFrozen(preview)).toBe(true);
  expect(Object.isFrozen(preview.manifest)).toBe(true);
  expect(Object.isFrozen(preview.manifest.contributes)).toBe(true);
  expect(Object.isFrozen(preview.manifest.contributes?.commands)).toBe(true);
  expect(Object.isFrozen(preview.manifest.permissions)).toBe(true);
  await expect(access(managedRoot)).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(access(marker)).rejects.toMatchObject({ code: 'ENOENT' });
});

test('previews without recovering staging or consulting publication capacity', async () => {
  const { managedRoot, sourceDirectory } = await fixture();
  await seedOrphans(managedRoot, 64);
  const operation = path.join(managedRoot, 'staging', randomUUID());
  await mkdir(operation, { recursive: true });
  const opendir = fs.opendir;
  vi.spyOn(fs, 'opendir').mockImplementation((file, options) => {
    if (String(file).startsWith(managedRoot + path.sep)) throw new Error('Store traversed');
    return opendir(file, options);
  });
  const store = host.createPluginArtifactStore({ directory: managedRoot });

  await expect(store.preview({ sourceDirectory })).resolves.toMatchObject({ files: 2 });
  await expect(access(operation)).resolves.toBeUndefined();
});

test.each([
  ['malformed descriptor', 'plugin-artifact-invalid'],
  ['ignored entry', 'plugin-artifact-invalid'],
  ['unsupported engine', 'plugin-artifact-invalid'],
  ['reserved ID', 'plugin-artifact-invalid'],
  ['payload depth bound', 'plugin-artifact-too-large'],
  ['linked payload directory', 'plugin-artifact-unsupported-file'],
  ['overlap', 'plugin-artifact-invalid'],
])('preview validates the %s without writing', async (violation, code) => {
  const { root, managedRoot, sourceDirectory } = await fixture();
  let directory = managedRoot;
  if (violation === 'malformed descriptor') {
    await writeFile(path.join(sourceDirectory, 'weave-plugin.json'), '{');
  } else if (violation === 'ignored entry') {
    await writePlugin(root, 'sample', { entry: '.git/index.mjs' });
  } else if (violation === 'unsupported engine') {
    await writePlugin(root, 'sample', { manifest: { engines: { weave: '^2.0.0' } } });
  } else if (violation === 'payload depth bound') {
    await mkdir(path.join(sourceDirectory, ...Array<string>(65).fill('d')), { recursive: true });
  } else if (violation === 'linked payload directory') {
    await symlink(root, path.join(sourceDirectory, 'linked'), 'junction');
  } else if (violation === 'overlap') {
    directory = path.join(sourceDirectory, '.weave-store');
  }
  const store = host.createPluginArtifactStore({
    directory,
    hostVersion: '1.0.0',
    reservedIds: violation === 'reserved ID' ? ['sample'] : [],
  });

  await expect(store.preview({ sourceDirectory })).rejects.toMatchObject({ code });
  await expect(access(directory)).rejects.toMatchObject({ code: 'ENOENT' });
});

test('rejects malformed review evidence before reading the filesystem', async () => {
  const { managedRoot, sourceDirectory } = await fixture();
  const expected = await reviewedSource(sourceDirectory);
  const store = host.createPluginArtifactStore({ directory: managedRoot });
  const candidates = [
    { ...expected, sourceDirectory: 'relative' },
    { ...expected, sourceDirectory: sourceDirectory + '\0' },
    { ...expected, digest: 'A'.repeat(64) },
    { ...expected, files: 0 },
    { ...expected, bytes: Number.MAX_SAFE_INTEGER + 1 },
    { ...expected, manifest: { ...expected.manifest, contributes: undefined } },
    { ...expected, manifest: { ...expected.manifest, permissions: undefined } },
    { ...expected, manifest: { ...expected.manifest, extra: true } },
    { ...expected, extra: true },
  ];
  const lstat = vi.spyOn(fs, 'lstat');
  for (const expectedSource of candidates) {
    expect(host.pluginArtifactSourceIdentitySchema?.safeParse(expectedSource).success).toBe(false);
    await expect(store.stage({ sourceDirectory, expectedSource })).rejects.toMatchObject({
      code: 'plugin-artifact-invalid',
    });
  }
  expect(lstat).not.toHaveBeenCalled();
});

test.each(['digest', 'files', 'bytes', 'manifest'] as const)(
  'rejects a changed pre-copy %s',
  async (field) => {
    const { managedRoot, sourceDirectory } = await fixture();
    const store = host.createPluginArtifactStore({ directory: managedRoot });
    const expectedSource = await reviewedSource(sourceDirectory);
    const mkdir = vi.spyOn(fs, 'mkdir');
    const changes = {
      digest: { digest: '1'.repeat(64) },
      files: { files: expectedSource.files + 1 },
      bytes: { bytes: expectedSource.bytes + 1 },
      manifest: { manifest: { ...expectedSource.manifest, name: 'Different name' } },
    };

    await expect(
      store.stage({
        sourceDirectory,
        expectedSource: { ...expectedSource, ...changes[field] },
      }),
    ).rejects.toMatchObject({ code: 'plugin-artifact-source-changed' });
    expect(
      mkdir.mock.calls.some(([directory]) =>
        String(directory).startsWith(path.join(managedRoot, 'staging') + path.sep),
      ),
    ).toBe(false);
    await expectNoPublication(managedRoot);
  },
);

test('cleans reviewed staging when source bytes change during copy', async () => {
  const { managedRoot, sourceDirectory } = await fixture();
  const store = host.createPluginArtifactStore({ directory: managedRoot });
  const expectedSource = await reviewedSource(sourceDirectory);
  const staging = path.join(managedRoot, 'staging');
  const open = fs.open;
  vi.spyOn(fs, 'open').mockImplementation(async (file, flags, mode) => {
    const handle = await open(file, flags, mode);
    if (
      String(file).startsWith(staging + path.sep) &&
      path.basename(String(file)) === 'index.mjs'
    ) {
      await writeFile(path.join(sourceDirectory, 'index.mjs'), 'edited while copying');
    }
    return handle;
  });

  await expect(store.stage({ sourceDirectory, expectedSource })).rejects.toMatchObject({
    code: 'plugin-artifact-source-changed',
  });
  expect(await readFile(path.join(sourceDirectory, 'index.mjs'), 'utf8')).toBe(
    'edited while copying',
  );
  expect(await readdir(staging)).toEqual([]);
  await expectNoPublication(managedRoot);
});

test('preserves cancellation after the final requested-path check and cleans reviewed staging', async () => {
  const { root, managedRoot, sourceDirectory } = await fixture();
  const alias = path.join(await makeTempDirectory(), 'alias');
  await symlink(root, alias, 'junction');
  const requested = path.join(alias, 'sample');
  const store = host.createPluginArtifactStore({ directory: managedRoot });
  const expectedSource = await reviewedSource(sourceDirectory);
  const caller = new AbortController();
  const reason = Object.assign(new Error('cancel at publication'), { code: 'ENOENT' });
  const realpath = fs.realpath;
  let checks = 0;
  vi.spyOn(fs, 'realpath').mockImplementation(async (file, options) => {
    const result = await realpath(file, options);
    if (file === requested && ++checks === 2) caller.abort(reason);
    return result;
  });

  await expect(
    store.stage({ sourceDirectory: requested, expectedSource, signal: caller.signal }),
  ).rejects.toBe(reason);
  expect(checks).toBe(2);
  expect(await readdir(path.join(managedRoot, 'staging'))).toEqual([]);
  await expectNoPublication(managedRoot);
});

test.each(['staged snapshot', 'published object'])(
  'preserves corruption classification for a reviewed %s',
  async (target) => {
    const { managedRoot, sourceDirectory } = await fixture();
    const store = host.createPluginArtifactStore({ directory: managedRoot });
    const expectedSource = await reviewedSource(sourceDirectory);
    const artifacts = path.join(managedRoot, 'artifacts');
    const staging = path.join(managedRoot, 'staging');
    if (target === 'published object') {
      const artifact = await store.stage({ sourceDirectory });
      await writeFile(artifact.entry, 'tampered');
    } else {
      const opendir = fs.opendir;
      vi.spyOn(fs, 'opendir').mockImplementation(async (file, options) => {
        if (file === artifacts) {
          const [operation] = await readdir(staging);
          await writeFile(path.join(staging, operation!, 'payload', 'index.mjs'), 'tampered');
        }
        return opendir(file, options);
      });
    }

    await expect(store.stage({ sourceDirectory, expectedSource })).rejects.toMatchObject({
      code: target === 'published object' ? 'plugin-artifact-conflict' : 'plugin-artifact-corrupt',
    });
    expect(await readdir(staging)).toEqual([]);
    expect(await readdir(artifacts)).toEqual(
      target === 'published object' ? [expectedSource.digest] : [],
    );
  },
);

test.each(['missing', 'root link', 'malformed descriptor', 'payload bound'])(
  'invalidates a reviewed %s source before copying',
  async (change) => {
    const { root, managedRoot, sourceDirectory } = await fixture();
    const expectedSource = await reviewedSource(sourceDirectory);
    if (change === 'missing' || change === 'root link') {
      const moved = path.join(root, 'moved');
      await fs.rename(sourceDirectory, moved);
      if (change === 'root link') await symlink(moved, sourceDirectory, 'junction');
    } else if (change === 'malformed descriptor') {
      await writeFile(path.join(sourceDirectory, 'weave-plugin.json'), '{');
    } else {
      await mkdir(path.join(sourceDirectory, ...Array<string>(65).fill('d')), { recursive: true });
    }
    const store = host.createPluginArtifactStore({ directory: managedRoot });

    await expect(store.stage({ sourceDirectory, expectedSource })).rejects.toMatchObject({
      code: 'plugin-artifact-source-changed',
      ...(change === 'missing' ? { cause: { code: 'ENOENT' } } : {}),
    });
    await expectNoPublication(managedRoot);
  },
);

test.each([
  ['new object', 'bytes'],
  ['new object', 'ancestor'],
  ['new object', 'root directory'],
  ['reuse', 'bytes'],
  ['reuse', 'ancestor'],
])('rechecks reviewed %s source %s after destination checks', async (publication, change) => {
  const { root, managedRoot, sourceDirectory } = await fixture();
  const expectedSource = await reviewedSource(sourceDirectory);
  const store = host.createPluginArtifactStore({ directory: managedRoot });
  const anotherRoot = await makeTempDirectory();
  const replacement = await writePlugin(anotherRoot, 'sample', { entry: 'index.mjs' });
  const alias = path.join(await makeTempDirectory(), 'alias');
  await symlink(root, alias, 'junction');
  const requested = path.join(alias, 'sample');
  const artifacts = path.join(managedRoot, 'artifacts');
  const object = path.join(artifacts, expectedSource.digest);
  if (publication === 'reuse') await store.stage({ sourceDirectory });

  let changed = false;
  async function changeSource() {
    changed = true;
    if (change === 'bytes') {
      await writeFile(path.join(sourceDirectory, 'index.mjs'), 'export default "edited"');
    } else if (change === 'ancestor') {
      await fs.rmdir(alias).catch((error: unknown) => {
        expect(error).toMatchObject({ code: 'ENOTDIR' });
        return unlink(alias);
      });
      await symlink(anotherRoot, alias, 'junction');
    } else {
      await fs.rename(sourceDirectory, path.join(root, 'moved'));
      await fs.rename(replacement, sourceDirectory);
      await writeFile(path.join(sourceDirectory, 'index.mjs'), 'export default "replacement"');
    }
  }

  const lstat = fs.lstat;
  const boundary = publication === 'reuse' ? path.join(object, 'payload', 'index.mjs') : object;
  const occurrence = publication === 'reuse' ? 1 : 2;
  let checks = 0;
  vi.spyOn(fs, 'lstat').mockImplementation(async (file, options) => {
    if (file === boundary && ++checks === occurrence) await changeSource();
    return lstat(file, options);
  });

  await expect(store.stage({ sourceDirectory: requested, expectedSource })).rejects.toMatchObject({
    code: 'plugin-artifact-source-changed',
  });
  expect(changed).toBe(true);
  expect(await readdir(artifacts)).toEqual(publication === 'reuse' ? [expectedSource.digest] : []);
  expect(await readdir(path.join(managedRoot, 'staging'))).toEqual([]);
});

test('reuses a reviewed artifact at capacity with equivalent manifest key order', async () => {
  const { managedRoot, sourceDirectory } = await fixture();
  const store = host.createPluginArtifactStore({ directory: managedRoot });
  const original = await reviewedSource(sourceDirectory);
  const { id, name, ...rest } = original.manifest;
  const expectedSource = { ...original, manifest: { name, id, ...rest } };
  const existing = await store.stage({ sourceDirectory });
  await seedOrphans(managedRoot, 63);

  await expect(store.stage({ sourceDirectory, expectedSource })).resolves.toEqual(existing);
  expect(await readdir(path.join(managedRoot, 'staging'))).toEqual([]);
});

test.each([
  ['source', 'ENOENT', 'plugin-artifact-source-changed'],
  ['source', 'EIO', 'plugin-artifact-io'],
  ['destination', 'ENOENT', 'plugin-artifact-io'],
  ['destination', 'ENOTDIR', 'plugin-artifact-io'],
])('classifies a reviewed copy %s failure of %s', async (side, code, expectedCode) => {
  const { managedRoot, sourceDirectory } = await fixture();
  const store = host.createPluginArtifactStore({ directory: managedRoot });
  const expectedSource = await reviewedSource(sourceDirectory);
  const cause = Object.assign(new Error('copy filesystem failure'), { code });
  const staging = path.join(managedRoot, 'staging');
  const open = fs.open;
  let sourceOpens = 0;
  vi.spyOn(fs, 'open').mockImplementation((file, flags, mode) => {
    if (
      (side === 'source' &&
        file === path.join(sourceDirectory, 'index.mjs') &&
        ++sourceOpens === 2) ||
      (side === 'destination' && String(file).startsWith(staging + path.sep))
    ) {
      throw cause;
    }
    return open(file, flags, mode);
  });

  await expect(store.stage({ sourceDirectory, expectedSource })).rejects.toMatchObject({
    code: expectedCode,
    cause,
  });
  expect(await readdir(staging)).toEqual([]);
  await expectNoPublication(managedRoot);
});

test.each(['source', 'published object'])(
  'preserves a file close failure for a reviewed %s',
  async (target) => {
    const { managedRoot, sourceDirectory } = await fixture();
    const store = host.createPluginArtifactStore({ directory: managedRoot });
    const expectedSource = await reviewedSource(sourceDirectory);
    const existing =
      target === 'published object' ? await store.stage({ sourceDirectory }) : undefined;
    const entry = existing?.entry ?? path.join(sourceDirectory, 'index.mjs');
    const cause = Object.assign(new Error('close failed'), { code: 'ENOENT' });
    const open = fs.open;
    vi.spyOn(fs, 'open').mockImplementation(async (file, flags, mode) => {
      const handle = await open(file, flags, mode);
      if (file === entry) {
        const close = handle.close;
        vi.spyOn(handle, 'close').mockImplementation(async () => {
          await close.call(handle);
          throw cause;
        });
      }
      return handle;
    });

    await expect(store.stage({ sourceDirectory, expectedSource })).rejects.toMatchObject({
      code: 'plugin-artifact-io',
      cause,
    });
    expect(await readdir(path.join(managedRoot, 'staging'))).toEqual([]);
    expect(await readdir(path.join(managedRoot, 'artifacts'))).toEqual(
      existing ? [existing.digest] : [],
    );
  },
);

function failDirectoryClose(
  shouldFail: (directory: string) => boolean,
  cause: NodeJS.ErrnoException,
) {
  const close = Dir.prototype.close;
  vi.spyOn(Dir.prototype, 'close').mockImplementation(function (
    this: Dir,
    callback?: Parameters<Dir['close']>[0],
  ) {
    // Node binds the callback overload inside the native directory iterator.
    const fail = shouldFail(this.path);
    if (callback !== undefined) {
      return close.call(this, (error) => callback(error ?? (fail ? cause : null)));
    }
    return new Promise<void>((resolve, reject) => {
      close.call(this, (error) => {
        if (error !== null) reject(error);
        else if (fail) reject(cause);
        else resolve();
      });
    });
  });
}

test.each([
  ['source', 'ENOENT'],
  ['source during copy', 'ENOTDIR'],
  ['published object', 'ELOOP'],
])('preserves directory close %s failure with errno %s', async (target, code) => {
  const { managedRoot, sourceDirectory } = await fixture();
  const store = host.createPluginArtifactStore({ directory: managedRoot });
  const expectedSource = await store.preview({ sourceDirectory });
  const existing =
    target === 'published object' ? await store.stage({ sourceDirectory }) : undefined;
  const directory = existing?.directory ?? sourceDirectory;
  const cause = Object.assign(new Error('directory close failed'), { code });
  let closes = 0;
  failDirectoryClose(
    (candidate) =>
      candidate === directory && ++closes === (target === 'source during copy' ? 2 : 1),
    cause,
  );

  await expect(store.stage({ sourceDirectory, expectedSource })).rejects.toMatchObject({
    code: 'plugin-artifact-io',
    cause,
  });
  expect(await readdir(path.join(managedRoot, 'staging'))).toEqual([]);
  expect(await readdir(path.join(managedRoot, 'artifacts'))).toEqual(
    existing ? [existing.digest] : [],
  );
});

test.each(['filesystem failure', 'caller cancellation'])(
  'preserves reviewed directory %s together with failed cleanup',
  async (failure) => {
    const { managedRoot, sourceDirectory } = await fixture();
    const store = host.createPluginArtifactStore({ directory: managedRoot });
    const expectedSource = await store.preview({ sourceDirectory });
    const caller = new AbortController();
    const primary =
      failure === 'caller cancellation'
        ? 'operation cancelled while traversing'
        : Object.assign(new Error('directory entry check failed'), { code: 'EIO' });
    const cleanup = Object.assign(new Error('directory close failed'), { code: 'ENOENT' });
    failDirectoryClose((directory) => directory === sourceDirectory, cleanup);
    const lstat = fs.lstat;
    vi.spyOn(fs, 'lstat').mockImplementation((file, options) => {
      if (file === path.join(sourceDirectory, 'index.mjs')) {
        if (failure === 'caller cancellation') caller.abort(primary);
        throw primary;
      }
      return lstat(file, options);
    });

    await expect(
      store.stage({ sourceDirectory, expectedSource, signal: caller.signal }),
    ).rejects.toMatchObject({
      code: 'plugin-artifact-io',
      cause: { errors: [primary, cleanup] },
    });
    await expectNoPublication(managedRoot);
  },
);

test('keeps a published artifact when reviewed reuse hits a transient filesystem failure', async () => {
  const { managedRoot, sourceDirectory } = await fixture();
  const store = host.createPluginArtifactStore({ directory: managedRoot });
  const expectedSource = await store.preview({ sourceDirectory });
  const existing = await store.stage({ sourceDirectory, expectedSource });
  const cause = Object.assign(new Error('file descriptor limit reached'), { code: 'EMFILE' });
  const open = fs.open;
  const spy = vi.spyOn(fs, 'open').mockImplementation((file, flags, mode) => {
    if (file === existing.entry) throw cause;
    return open(file, flags, mode);
  });

  await expect(store.stage({ sourceDirectory, expectedSource })).rejects.toMatchObject({
    code: 'plugin-artifact-io',
    cause,
  });
  expect(await readdir(path.join(managedRoot, 'staging'))).toEqual([]);
  spy.mockRestore();
  await expect(store.read(existing.digest)).resolves.toEqual(existing);
});

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

test.each(['store root', 'artifacts container'] as const)(
  'classifies a non-directory installed %s as corrupt',
  async (target) => {
    const { managedRoot, sourceDirectory } = await fixture();
    const store = host.createPluginArtifactStore({ directory: managedRoot });
    const artifact = await store.stage({ sourceDirectory });
    const directory = target === 'store root' ? managedRoot : path.join(managedRoot, 'artifacts');
    await fs.rm(directory, { recursive: true });
    await writeFile(directory, 'unexpected file');

    await expect(store.read(artifact.digest)).rejects.toMatchObject({
      code: 'plugin-artifact-corrupt',
    });
    await expect(readFile(directory, 'utf8')).resolves.toBe('unexpected file');
  },
);

test.each(['store root normalization', 'payload open', 'entry resolution'] as const)(
  'preserves installed %s filesystem failures as I/O',
  async (target) => {
    const { managedRoot, sourceDirectory } = await fixture();
    const store = host.createPluginArtifactStore({ directory: managedRoot });
    const artifact = await store.stage({ sourceDirectory });
    const cause = Object.assign(new Error('file descriptor limit reached'), { code: 'EMFILE' });
    const { realpath, open, lstat } = fs;
    if (target === 'store root normalization') {
      vi.spyOn(fs, 'realpath').mockImplementation((file, options) => {
        if (file === managedRoot) throw cause;
        return realpath(file, options);
      });
    } else if (target === 'payload open') {
      vi.spyOn(fs, 'open').mockImplementation((file, flags, mode) => {
        if (file === artifact.entry) throw cause;
        return open(file, flags, mode);
      });
    } else {
      vi.spyOn(fs, 'lstat').mockImplementation((file, options) => {
        if (file === artifact.entry && options === undefined) throw cause;
        return lstat(file, options);
      });
    }

    await expect(store.read(artifact.digest)).rejects.toMatchObject({
      code: 'plugin-artifact-io',
      cause,
    });
  },
);

test.each(['payload file', 'payload directory'] as const)(
  'preserves primary and cleanup I/O failures in order for an installed %s',
  async (target) => {
    const { managedRoot, sourceDirectory } = await fixture();
    const store = host.createPluginArtifactStore({ directory: managedRoot });
    const artifact = await store.stage({ sourceDirectory });
    const primary = Object.assign(new Error('installed payload read failed'), { code: 'EIO' });
    const cleanup = Object.assign(new Error('installed handle close failed'), { code: 'EIO' });
    if (target === 'payload file') {
      const open = fs.open;
      vi.spyOn(fs, 'open').mockImplementation(async (file, flags, mode) => {
        const handle = await open(file, flags, mode);
        if (file === artifact.entry) {
          const close = handle.close.bind(handle);
          vi.spyOn(handle, 'read').mockRejectedValue(primary);
          vi.spyOn(handle, 'close').mockImplementation(async () => {
            await close();
            throw cleanup;
          });
        }
        return handle;
      });
    } else {
      failDirectoryClose((directory) => directory === artifact.directory, cleanup);
      const lstat = fs.lstat;
      vi.spyOn(fs, 'lstat').mockImplementation((file, options) => {
        if (file === artifact.entry) throw primary;
        return lstat(file, options);
      });
    }

    await expect(store.read(artifact.digest)).rejects.toMatchObject({
      code: 'plugin-artifact-io',
      cause: { errors: [primary, cleanup] },
    });
  },
);

test('keeps an installed payload close failure as I/O when its errno resembles damage', async () => {
  const { managedRoot, sourceDirectory } = await fixture();
  const store = host.createPluginArtifactStore({ directory: managedRoot });
  const artifact = await store.stage({ sourceDirectory });
  const cause = Object.assign(new Error('installed directory close failed'), { code: 'ENOENT' });
  failDirectoryClose((directory) => directory === artifact.directory, cause);

  await expect(store.read(artifact.digest)).rejects.toMatchObject({
    code: 'plugin-artifact-io',
    cause,
  });
});

test('preserves the exact cancellation reason during installed entry resolution', async () => {
  const { managedRoot, sourceDirectory } = await fixture();
  const store = host.createPluginArtifactStore({ directory: managedRoot });
  const artifact = await store.stage({ sourceDirectory });
  const controller = new AbortController();
  const reason = Object.assign(new Error('cancel installed read'), { code: 'ELOOP' });
  const lstat = fs.lstat;
  vi.spyOn(fs, 'lstat').mockImplementation((file, options) => {
    if (file === artifact.entry && options === undefined) controller.abort(reason);
    return lstat(file, options);
  });

  await expect(store.read(artifact.digest, { signal: controller.signal })).rejects.toBe(reason);
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
  await fs.rm(path.join(managedRoot, 'artifacts'), { recursive: true });
  await expect(store.read(absent)).rejects.toMatchObject({ code: 'plugin-artifact-not-found' });
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

test('lists published artifacts and removes one by digest without touching others', async () => {
  const { root, managedRoot, sourceDirectory } = await fixture();
  const store = host.createPluginArtifactStore({ directory: managedRoot });
  await expect(store.list()).resolves.toEqual([]);
  const first = await store.stage({ sourceDirectory });
  const secondSource = await writePlugin(root, 'second', { entry: 'index.mjs' });
  const second = await store.stage({ sourceDirectory: secondSource });
  expect(first.digest).not.toBe(second.digest);
  await expect(store.list()).resolves.toEqual([first.digest, second.digest].sort());

  await expect(store.remove(first.digest)).resolves.toBe(true);
  await expect(store.list()).resolves.toEqual([second.digest]);
  await expect(store.read(first.digest)).rejects.toMatchObject({
    code: 'plugin-artifact-not-found',
  });
  await expect(store.read(second.digest)).resolves.toMatchObject({ digest: second.digest });
  expect(await readdir(path.join(managedRoot, 'staging'))).toEqual([]);
});

test('removing an absent artifact reports false and invalid digests are rejected', async () => {
  const { managedRoot } = await fixture();
  const store = host.createPluginArtifactStore({ directory: managedRoot });
  await expect(store.remove('d'.repeat(64))).resolves.toBe(false);
  await expect(store.remove('../escape')).rejects.toMatchObject({
    code: 'plugin-artifact-invalid',
  });
});

test('removal frees capacity so a new artifact can be staged at the limit', async () => {
  const { managedRoot, sourceDirectory } = await fixture();
  await seedOrphans(managedRoot, 63);
  const store = host.createPluginArtifactStore({ directory: managedRoot });
  const staged = await store.stage({ sourceDirectory });
  await expect(store.list()).resolves.toHaveLength(64);
  await expect(store.remove(staged.digest)).resolves.toBe(true);
  await expect(store.list()).resolves.toHaveLength(63);
});

test('listing rejects an unexpected entry instead of ignoring it', async () => {
  const { managedRoot } = await fixture();
  await mkdir(path.join(managedRoot, 'artifacts', 'not-a-digest'), { recursive: true });
  const store = host.createPluginArtifactStore({ directory: managedRoot });
  await expect(store.list()).rejects.toMatchObject({ code: 'plugin-artifact-conflict' });
});
