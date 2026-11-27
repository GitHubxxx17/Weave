import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRuntime } from '@weave/runtime';
import { createApp } from '../src/app.js';
import { createStorageConfig, isLoopbackAddress, type StorageConfig } from '../src/storage-api.js';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'weave-storage-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function appFor(
  storage: StorageConfig | undefined,
  remote: string | undefined = '127.0.0.1',
  storageEntryLimit?: number,
) {
  return createApp(createRuntime(), {
    ...(storage === undefined ? {} : { storage }),
    storageRemoteAddress: () => remote,
    ...(storageEntryLimit === undefined ? {} : { storageEntryLimit }),
  });
}

describe('GET /settings/storage', () => {
  it('reports the real locations of a temporary data directory', async () => {
    const databaseFile = join(root, 'weave.sqlite');
    const pluginsDirectory = join(root, 'plugins');
    await writeFile(databaseFile, Buffer.alloc(100));
    await writeFile(`${databaseFile}-wal`, Buffer.alloc(30));
    await writeFile(`${databaseFile}-shm`, Buffer.alloc(5));
    await mkdir(join(pluginsDirectory, 'nested'), { recursive: true });
    await writeFile(join(pluginsDirectory, 'a.js'), Buffer.alloc(10));
    await writeFile(join(pluginsDirectory, 'nested', 'b.js'), Buffer.alloc(20));
    const storage = await createStorageConfig({
      databaseFile,
      pluginsDirectory,
      skillsDirectory: false,
    });

    const response = await appFor(storage).request('/settings/storage');

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    const body = (await response.json()) as {
      dataDirectory: string;
      locations: { id: string; path: string; exists: boolean; sizeBytes: number | null }[];
    };
    expect(body.dataDirectory).toBe(root);
    const byId = new Map(body.locations.map((entry) => [entry.id, entry]));
    expect([...byId.keys()]).toEqual([
      'database',
      'memory',
      'retrieval',
      'pluginMarketplaceSources',
      'plugins',
    ]);
    expect(byId.get('database')).toMatchObject({
      kind: 'file',
      path: databaseFile,
      exists: true,
      sizeBytes: 135,
      truncated: false,
    });
    expect(byId.get('memory')).toMatchObject({ exists: false, sizeBytes: null });
    expect(byId.get('memory')!.path.endsWith('weave.sqlite.memory.sqlite')).toBe(true);
    expect(byId.get('retrieval')!.path.endsWith('weave.sqlite.retrieval.sqlite')).toBe(true);
    expect(byId.get('plugins')).toMatchObject({ kind: 'directory', exists: true, sizeBytes: 30 });
  });

  it('omits disabled directories and includes enabled skills', async () => {
    const skillsDirectory = join(root, 'skills');
    const without = await createStorageConfig({
      databaseFile: join(root, 'weave.sqlite'),
      pluginsDirectory: false,
      skillsDirectory: false,
    });
    expect(without.locations.map(({ id }) => id)).not.toContain('plugins');
    expect(without.locations.map(({ id }) => id)).not.toContain('skills');
    const withSkills = await createStorageConfig({
      databaseFile: join(root, 'weave.sqlite'),
      pluginsDirectory: false,
      skillsDirectory,
    });
    expect(withSkills.locations.find(({ id }) => id === 'skills')).toMatchObject({
      kind: 'directory',
      path: skillsDirectory,
    });
  });

  it('marks missing locations as not existing', async () => {
    const storage: StorageConfig = {
      dataDirectory: root,
      locations: [{ id: 'skills', kind: 'directory', path: join(root, 'missing') }],
    };
    const body = await (await appFor(storage).request('/settings/storage')).json();
    expect(body.locations[0]).toMatchObject({ exists: false, sizeBytes: null, truncated: false });
  });

  it('does not follow symbolic links while measuring a directory', async () => {
    const outside = join(root, 'outside');
    const inside = join(root, 'inside');
    await mkdir(outside);
    await mkdir(inside);
    await writeFile(join(outside, 'big.bin'), Buffer.alloc(10_000));
    await writeFile(join(inside, 'small.bin'), Buffer.alloc(7));
    await symlink(outside, join(inside, 'link'));
    const storage: StorageConfig = {
      dataDirectory: root,
      locations: [{ id: 'plugins', kind: 'directory', path: inside }],
    };
    const body = await (await appFor(storage).request('/settings/storage')).json();
    expect(body.locations[0].sizeBytes).toBeLessThan(1_000);
    expect(body.locations[0].sizeBytes).toBeGreaterThanOrEqual(7);
  });

  it('reports a lower bound when the entry limit is reached', async () => {
    const directory = join(root, 'many');
    await mkdir(directory);
    for (let index = 0; index < 5; index += 1) {
      await writeFile(join(directory, `f${index}`), Buffer.alloc(10));
    }
    const storage: StorageConfig = {
      dataDirectory: root,
      locations: [{ id: 'plugins', kind: 'directory', path: directory }],
    };
    const body = await (await appFor(storage, '127.0.0.1', 3).request('/settings/storage')).json();
    expect(body.locations[0]).toMatchObject({ truncated: true, sizeBytes: 30 });
  });

  it('reports a per-location error without failing the request', async () => {
    const file = join(root, 'plain.txt');
    await writeFile(file, 'x');
    const storage: StorageConfig = {
      dataDirectory: root,
      locations: [
        { id: 'plugins', kind: 'directory', path: file },
        { id: 'database', kind: 'file', path: file },
      ],
    };
    const response = await appFor(storage).request('/settings/storage');
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.locations[0]).toMatchObject({ error: 'kind-mismatch', sizeBytes: null });
    expect(body.locations[1]).toMatchObject({ sizeBytes: 1 });
    expect(body.locations[1].error).toBeUndefined();
  });

  it.each(['127.0.0.1', '127.8.9.10', '::1', '::ffff:127.0.0.1'])(
    'admits loopback peer %s',
    async (remote) => {
      const storage: StorageConfig = { dataDirectory: root, locations: [] };
      const response = await appFor(storage, remote).request('/settings/storage');
      expect(response.status).toBe(200);
    },
  );

  it.each([
    '192.168.1.20',
    '10.0.0.5',
    '::ffff:192.168.1.20',
    '2001:db8::1',
    'not-an-ip',
    '',
    undefined,
  ])('rejects peer %s with 403', async (remote) => {
    const storage: StorageConfig = { dataDirectory: root, locations: [] };
    const response = await createApp(createRuntime(), {
      storage,
      storageRemoteAddress: () => remote,
    }).request('/settings/storage');
    expect(response.status).toBe(403);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect((await response.json()).error.code).toBe('storage-local-only');
  });

  it('rejects requests when the peer cannot be determined (in-memory request)', async () => {
    const storage: StorageConfig = { dataDirectory: root, locations: [] };
    const response = await createApp(createRuntime(), { storage }).request('/settings/storage');
    expect(response.status).toBe(403);
  });

  it('answers 503 when storage is not configured', async () => {
    const response = await appFor(undefined).request('/settings/storage');
    expect(response.status).toBe(503);
  });
});

describe('isLoopbackAddress', () => {
  it('accepts only loopback forms', () => {
    expect(isLoopbackAddress('127.0.0.1')).toBe(true);
    expect(isLoopbackAddress('::1')).toBe(true);
    expect(isLoopbackAddress('::ffff:127.1.2.3')).toBe(true);
    expect(isLoopbackAddress('::ffff:7f00:1')).toBe(true);
    expect(isLoopbackAddress('128.0.0.1')).toBe(false);
    expect(isLoopbackAddress('::')).toBe(false);
    expect(isLoopbackAddress('0.0.0.0')).toBe(false);
  });
});
