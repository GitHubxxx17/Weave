import { mkdir, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { computeDirectoryDigest } from '../src/digest.js';
import {
  discoverLocalPlugins,
  type InvalidLocalPlugin,
  type LocalPluginCandidate,
} from '../src/discovery.js';
import {
  makeTempDirectory,
  manifestFor,
  removeTempDirectories,
  writeFileIn,
  writePlugin,
} from './support/fixtures.js';

afterEach(removeTempDirectories);

async function discover(
  pluginsDirectory: string,
  options: Partial<Parameters<typeof discoverLocalPlugins>[0]> = {},
) {
  return discoverLocalPlugins({ directory: pluginsDirectory, hostVersion: '1.4.2', ...options });
}

function only(candidates: readonly LocalPluginCandidate[]): LocalPluginCandidate {
  expect(candidates).toHaveLength(1);
  return candidates[0] as LocalPluginCandidate;
}

function invalid(candidate: LocalPluginCandidate): InvalidLocalPlugin {
  expect(candidate.status).toBe('invalid');
  return candidate as InvalidLocalPlugin;
}

describe('discoverLocalPlugins', () => {
  describe('a sound plugin', () => {
    it('is ready, with its manifest, entry, directory and digest', async () => {
      const root = await makeTempDirectory();
      const directory = await writePlugin(root, 'hello-commands');

      const result = await discover(root);

      expect(result.exists).toBe(true);
      expect(result.truncated).toBe(false);
      expect(result.directory).toBe(root);
      expect(only(result.candidates)).toEqual({
        status: 'ready',
        id: 'hello-commands',
        directory,
        manifest: manifestFor('hello-commands'),
        entry: path.join(directory, 'index.js'),
        digest: (await computeDirectoryDigest(directory)).digest,
      });
    });

    it('takes its id from the manifest, not from the directory name', async () => {
      const root = await makeTempDirectory();
      await writePlugin(root, 'any-folder-name', { manifest: { id: 'real-id' } });

      expect(only((await discover(root)).candidates)).toMatchObject({
        status: 'ready',
        id: 'real-id',
      });
    });

    it('finds an entry in a subdirectory', async () => {
      const root = await makeTempDirectory();
      const directory = await writePlugin(root, 'nested', { entry: 'dist/bundle.mjs' });

      expect(only((await discover(root)).candidates)).toMatchObject({
        status: 'ready',
        entry: path.join(directory, 'dist', 'bundle.mjs'),
      });
    });

    it('does not run the plugin: a module that throws on import is still ready', async () => {
      const root = await makeTempDirectory();
      await writePlugin(root, 'explosive', { source: 'throw new Error("must not run");' });

      expect(only((await discover(root)).candidates).status).toBe('ready');
    });

    it('is ready when its engines range holds', async () => {
      const root = await makeTempDirectory();
      await writePlugin(root, 'ranged', { manifest: { engines: { weave: '>=1.2.0 <2.0.0' } } });

      expect(only((await discover(root)).candidates).status).toBe('ready');
    });
  });

  describe('the plugins directory', () => {
    it('reports a missing directory without creating it', async () => {
      const missing = path.join(await makeTempDirectory(), 'plugins');

      const result = await discover(missing);

      expect(result).toEqual({
        directory: missing,
        exists: false,
        candidates: [],
        truncated: false,
      });
      await expect(discover(missing)).resolves.toMatchObject({ exists: false });
    });

    it('reports an empty directory as existing with no candidates', async () => {
      const root = await makeTempDirectory();

      expect(await discover(root)).toEqual({
        directory: root,
        exists: true,
        candidates: [],
        truncated: false,
      });
    });

    it('lists plugins in the byte order of their directory names', async () => {
      const root = await makeTempDirectory();
      for (const name of ['b-plugin', 'a-plugin', 'Z-plugin', 'c-plugin']) {
        await writePlugin(root, name);
      }

      const names = (await discover(root)).candidates.map((candidate) => candidate.id);

      expect(names).toEqual(['Z-plugin', 'a-plugin', 'b-plugin', 'c-plugin']);
    });

    it('skips hidden directories, plain files and directories without a descriptor', async () => {
      const root = await makeTempDirectory();
      await writePlugin(root, 'real');
      await writePlugin(root, '.hidden');
      await writeFile(path.join(root, 'README.md'), 'notes');
      await mkdir(path.join(root, 'just-a-folder'));
      await writeFileIn(path.join(root, 'just-a-folder'), 'index.js', 'export default 1;');

      expect((await discover(root)).candidates.map((candidate) => candidate.id)).toEqual(['real']);
    });

    it('looks only one level down', async () => {
      const root = await makeTempDirectory();
      await writePlugin(path.join(root, 'group'), 'inner');

      expect((await discover(root)).candidates).toEqual([]);
    });

    it('reads at most maxCandidates plugin directories and says so', async () => {
      const root = await makeTempDirectory();
      for (const name of ['p1', 'p2', 'p3', 'p4']) {
        await writePlugin(root, name);
      }

      const result = await discover(root, { maxCandidates: 3 });

      expect(result.truncated).toBe(true);
      expect(result.candidates.map((candidate) => candidate.id)).toEqual(['p1', 'p2', 'p3']);
      expect((await discover(root, { maxCandidates: 4 })).truncated).toBe(false);
    });

    it('does not count directories without a descriptor against maxCandidates', async () => {
      const root = await makeTempDirectory();
      await mkdir(path.join(root, 'a-empty'));
      await writePlugin(root, 'b-real');

      const result = await discover(root, { maxCandidates: 1 });

      expect(result.truncated).toBe(false);
      expect(result.candidates.map((candidate) => candidate.id)).toEqual(['b-real']);
    });

    it('reports a plugins directory that is a file as unreadable', async () => {
      const file = path.join(await makeTempDirectory(), 'plugins');
      await writeFile(file, 'not a directory');

      await expect(discover(file)).rejects.toMatchObject({ code: 'plugin-unreadable' });
    });

    it('reports a plugin directory that is a link, without following it', async () => {
      const root = await makeTempDirectory();
      const checkout = await makeTempDirectory();
      await writePlugin(checkout, 'dev-plugin');
      await symlink(path.join(checkout, 'dev-plugin'), path.join(root, 'dev-plugin'));
      await symlink(path.join(checkout, 'README'), path.join(root, 'broken-link'));

      const candidate = invalid(only((await discover(root)).candidates));

      expect(candidate.id).toBe('dev-plugin');
      expect(candidate.issue.code).toBe('plugin-unsupported-file');
      expect(candidate.issue.message).toContain('is a symbolic link');
    });
  });

  describe('an invalid plugin', () => {
    it('is reported with the directory name as its id when the descriptor cannot be read', async () => {
      const root = await makeTempDirectory();
      await writePlugin(root, 'broken-json', { descriptor: '{ nope' });

      const candidate = invalid(only((await discover(root)).candidates));

      expect(candidate).toMatchObject({
        id: 'broken-json',
        issue: { code: 'plugin-invalid-descriptor' },
      });
      expect(candidate.manifest).toBeUndefined();
    });

    it('is reported when the descriptor does not pass the schema', async () => {
      const root = await makeTempDirectory();
      await writePlugin(root, 'bad-manifest', {
        descriptor: { schemaVersion: 1, entry: 'index.js', manifest: { id: 'x' } },
      });

      expect(invalid(only((await discover(root)).candidates)).issue.code).toBe(
        'plugin-invalid-descriptor',
      );
    });

    it('uses the manifest id when only a local rule is broken', async () => {
      const root = await makeTempDirectory();
      const manifest = manifestFor('no-permissions');
      delete manifest.permissions;
      await writePlugin(root, 'folder', {
        descriptor: { schemaVersion: 1, entry: 'index.js', manifest },
      });

      const candidate = invalid(only((await discover(root)).candidates));

      expect(candidate.id).toBe('no-permissions');
      expect(candidate.issue.message).toContain('must declare permissions');
    });

    it('is reported when the descriptor is larger than 64 KB', async () => {
      const root = await makeTempDirectory();
      await writePlugin(root, 'huge', { descriptor: ' '.repeat(64 * 1024 + 1) });

      const candidate = invalid(only((await discover(root)).candidates));

      expect(candidate.issue.code).toBe('plugin-invalid-descriptor');
      expect(candidate.issue.message).toContain('larger than 64 KB');
    });

    it('is reported when the descriptor is not a regular file', async () => {
      const root = await makeTempDirectory();
      const directory = path.join(root, 'odd');
      await mkdir(path.join(directory, 'weave-plugin.json'), { recursive: true });

      const candidate = invalid(only((await discover(root)).candidates));

      expect(candidate.issue.code).toBe('plugin-invalid-descriptor');
      expect(candidate.issue.message).toContain('must be a regular file');
    });

    it('is reported when the entry file is missing, keeping the manifest', async () => {
      const root = await makeTempDirectory();
      await writePlugin(root, 'headless', {
        descriptor: { schemaVersion: 1, entry: 'missing.js', manifest: manifestFor('headless') },
      });

      const candidate = invalid(only((await discover(root)).candidates));

      expect(candidate.issue.code).toBe('plugin-entry-invalid');
      expect(candidate.issue.message).toContain('"missing.js" does not exist');
      expect(candidate.manifest?.id).toBe('headless');
    });

    it('is reported when the entry is a directory', async () => {
      const root = await makeTempDirectory();
      const directory = await writePlugin(root, 'dir-entry', {
        descriptor: { schemaVersion: 1, entry: 'folder.js', manifest: manifestFor('dir-entry') },
      });
      await mkdir(path.join(directory, 'folder.js'));

      const candidate = invalid(only((await discover(root)).candidates));

      expect(candidate.issue.code).toBe('plugin-entry-invalid');
      expect(candidate.issue.message).toContain('is not a regular file');
    });

    it('is reported when the entry is a link out of the directory', async () => {
      const root = await makeTempDirectory();
      const outside = await makeTempDirectory();
      await writeFile(path.join(outside, 'evil.js'), 'export default () => ({ setup() {} });');
      const directory = await writePlugin(root, 'escaping', {
        descriptor: { schemaVersion: 1, entry: 'linked.js', manifest: manifestFor('escaping') },
      });
      await symlink(path.join(outside, 'evil.js'), path.join(directory, 'linked.js'));

      const candidate = invalid(only((await discover(root)).candidates));

      // The link is refused first, because no link is allowed inside a plugin.
      expect(candidate.issue.code).toBe('plugin-unsupported-file');
    });

    it('is reported when the directory holds a symbolic link, with the plugin named', async () => {
      const root = await makeTempDirectory();
      const directory = await writePlugin(root, 'linked');
      await symlink(path.join(directory, 'index.js'), path.join(directory, 'alias.js'));

      const candidate = invalid(only((await discover(root)).candidates));

      expect(candidate).toMatchObject({ id: 'linked', issue: { code: 'plugin-unsupported-file' } });
      expect(candidate.manifest?.id).toBe('linked');
    });

    it('is reported when the directory has too many files', async () => {
      const root = await makeTempDirectory();
      await writePlugin(root, 'sprawling', {
        files: { 'a.js': '', 'b.js': '', 'c.js': '' },
      });

      const candidate = invalid(
        only((await discover(root, { limits: { maxFiles: 3 } })).candidates),
      );

      expect(candidate.issue.code).toBe('plugin-too-large');
    });

    it('is reported when the directory is too big', async () => {
      const root = await makeTempDirectory();
      await writePlugin(root, 'bulky', { files: { 'data.bin': 'x'.repeat(2000) } });

      const candidate = invalid(
        only((await discover(root, { limits: { maxBytes: 1000 } })).candidates),
      );

      expect(candidate.issue.code).toBe('plugin-too-large');
      expect(candidate.issue.message).toContain('bundle the plugin into a single file');
    });

    it('does not stop the others from being found', async () => {
      const root = await makeTempDirectory();
      await writePlugin(root, 'a-broken', { descriptor: 'nope' });
      await writePlugin(root, 'b-fine');

      const statuses = (await discover(root)).candidates.map((c) => [c.id, c.status]);

      expect(statuses).toEqual([
        ['a-broken', 'invalid'],
        ['b-fine', 'ready'],
      ]);
    });
  });

  describe('an incompatible plugin', () => {
    it('is reported for another API version, before its content is read', async () => {
      const root = await makeTempDirectory();
      // The entry is missing too, but compatibility comes first.
      const directory = await writePlugin(root, 'old', { manifest: { apiVersion: '0.9.0' } });
      await writeFile(path.join(directory, 'index.js'), '');

      const candidate = only((await discover(root)).candidates);

      expect(candidate).toMatchObject({
        status: 'incompatible',
        id: 'old',
        issue: { code: 'plugin-api-version-unsupported' },
      });
      expect(candidate).not.toHaveProperty('digest');
    });

    it.each(['mcp', 'subprocess'])('is reported for host %s', async (host) => {
      const root = await makeTempDirectory();
      await writePlugin(root, 'remote', { manifest: { host } });

      const candidate = only((await discover(root)).candidates);

      expect(candidate).toMatchObject({
        status: 'incompatible',
        issue: { code: 'plugin-host-unsupported' },
      });
      expect((candidate as { issue: { message: string } }).issue.message).toContain(
        `runs as "${host}"`,
      );
    });

    it('is reported for an engines range the host is outside of', async () => {
      const root = await makeTempDirectory();
      await writePlugin(root, 'future', { manifest: { engines: { weave: '>=2.0.0' } } });

      const candidate = only((await discover(root, { hostVersion: '1.4.2' })).candidates);

      expect(candidate).toMatchObject({
        status: 'incompatible',
        issue: { code: 'plugin-engine-unsupported' },
      });
      expect((candidate as { issue: { message: string } }).issue.message).toContain(
        'requires Weave ">=2.0.0", host is "1.4.2"',
      );
    });

    it('is reported for an engines range when the host did not say its version', async () => {
      const root = await makeTempDirectory();
      await writePlugin(root, 'ranged', { manifest: { engines: { weave: '*' } } });

      const candidate = only((await discoverLocalPlugins({ directory: root })).candidates);

      expect(candidate).toMatchObject({
        status: 'incompatible',
        issue: { code: 'plugin-engine-unsupported' },
      });
    });

    it('rejects a host version that is not a full x.y.z', async () => {
      await expect(
        discoverLocalPlugins({ directory: await makeTempDirectory(), hostVersion: '1.4' }),
      ).rejects.toThrowError(TypeError);
    });
  });

  describe('plugin ids', () => {
    it('marks every directory that declares the same id invalid, and names them', async () => {
      const root = await makeTempDirectory();
      await writePlugin(root, 'copy-a', { manifest: { id: 'shared' } });
      await writePlugin(root, 'copy-b', { manifest: { id: 'shared' } });
      await writePlugin(root, 'other');

      const result = await discover(root);

      expect(result.candidates.map((c) => [path.basename(c.directory), c.status])).toEqual([
        ['copy-a', 'invalid'],
        ['copy-b', 'invalid'],
        ['other', 'ready'],
      ]);
      const first = invalid(result.candidates[0] as LocalPluginCandidate);
      expect(first.issue.code).toBe('plugin-duplicate-id');
      expect(first.issue.message).toContain('copy-a, copy-b');
      expect(first.id).toBe('shared');
      expect(first.manifest?.id).toBe('shared');
    });

    it('marks a plugin that takes an id the host already uses invalid', async () => {
      const root = await makeTempDirectory();
      await writePlugin(root, 'impostor', { manifest: { id: 'tool-registry' } });
      await writePlugin(root, 'fine');

      const result = await discover(root, { reservedIds: ['tool-registry', 'host-services'] });

      expect(result.candidates.map((c) => [c.id, c.status])).toEqual([
        ['fine', 'ready'],
        ['tool-registry', 'invalid'],
      ]);
      expect(invalid(result.candidates[1] as LocalPluginCandidate).issue.code).toBe(
        'plugin-id-reserved',
      );
    });

    it('applies the same rules to an incompatible plugin', async () => {
      const root = await makeTempDirectory();
      await writePlugin(root, 'old-impostor', {
        manifest: { id: 'tool-registry', apiVersion: '0.9.0' },
      });

      const candidate = only((await discover(root, { reservedIds: ['tool-registry'] })).candidates);

      expect(candidate.status).toBe('invalid');
    });

    it('does not let an invalid directory spoil a plugin that shares its id', async () => {
      const root = await makeTempDirectory();
      await writePlugin(root, 'a-broken', { manifest: { id: 'shared' }, files: { x: '' } });
      await symlink(path.join(root, 'a-broken', 'x'), path.join(root, 'a-broken', 'y'));
      await writePlugin(root, 'b-fine', { manifest: { id: 'shared' } });

      const result = await discover(root);

      expect(result.candidates.map((c) => [path.basename(c.directory), c.status])).toEqual([
        ['a-broken', 'invalid'],
        ['b-fine', 'ready'],
      ]);
    });
  });
});
