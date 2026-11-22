import { afterEach, describe, expect, it, vi } from 'vitest';
import fs, { mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import path from 'node:path';
import {
  createPluginKernel,
  skillsExtensionPoint,
  type AttributedSkillContribution,
} from '@weave/plugin';
import {
  createPluginArtifactStore,
  discoverLocalPlugins,
  inspectPluginPayload,
  loadLocalPlugin,
  parseDescriptor,
} from '../src/index.js';
import {
  makeTempDirectory,
  removeTempDirectories,
  writeFileIn,
  writePlugin,
} from './support/fixtures.js';

const manifest = {
  id: 'review-skills',
  name: 'Review Skills',
  version: '1.0.0',
  apiVersion: '1.0.0',
  host: 'declarative',
  capabilities: ['skill'],
  contributes: { skills: ['review'] },
  permissions: [],
};
const descriptor = { schemaVersion: 2, kind: 'skills', manifest };
const document =
  '---\nname: review\ndescription: Review changes\n---\nRead references/check.md before reviewing.\n';
async function payload() {
  const root = await makeTempDirectory();
  const directory = path.join(root, 'package');
  await mkdir(directory);
  await writeFileIn(directory, 'weave-plugin.json', JSON.stringify(descriptor));
  await writeFileIn(directory, 'skills/review/SKILL.md', document);
  await writeFileIn(directory, 'skills/review/references/check.md', 'Check the tests.');
  return { root, directory };
}
afterEach(removeTempDirectories);

describe('declarative Skill packages', () => {
  it('accepts the strict no-entry descriptor without changing its manifest', () => {
    expect(parseDescriptor(JSON.stringify(descriptor))).toEqual(descriptor);
  });
  it.each([
    { ...descriptor, entry: 'index.mjs' },
    { ...descriptor, manifest: { ...manifest, host: 'in-process' } },
    { ...descriptor, manifest: { ...manifest, capabilities: ['skill', 'tool'] } },
    { ...descriptor, manifest: { ...manifest, permissions: ['network:request'] } },
    { ...descriptor, manifest: { ...manifest, contributes: { skills: ['review'], tools: [] } } },
    { ...descriptor, manifest: { ...manifest, contributes: { skills: [] } } },
    { schemaVersion: 1, entry: 'index.mjs', manifest },
  ])('rejects incompatible or executable declarations %#', (value) => {
    expect(() => parseDescriptor(JSON.stringify(value))).toThrow();
  });
  it('inspects immutable Skill data without creating a store or executing author code', async () => {
    const f = await payload();
    const artifact = await inspectPluginPayload(f.directory);
    expect(artifact).toMatchObject({ kind: 'skills', directory: f.directory, files: 3 });
    expect(artifact).not.toHaveProperty('entry');
    if (artifact.kind !== 'skills') throw new Error('Expected Skill payload');
    expect(artifact.skills).toEqual([
      {
        name: 'review',
        description: 'Review changes',
        instructions: 'Read references/check.md before reviewing.\n',
        invocation: { user: true, model: true },
        resources: { 'references/check.md': 'Check the tests.' },
      },
    ]);
    expect(Object.isFrozen(artifact.skills[0]?.resources)).toBe(true);
    const store = createPluginArtifactStore({ directory: path.join(f.root, 'store') });
    const reviewed = await store.preview({ sourceDirectory: f.directory });
    const staged = await store.stage({ sourceDirectory: f.directory, expectedSource: reviewed });
    expect(staged.kind).toBe('skills');
    expect((await store.read(staged.digest)).kind).toBe('skills');
    const importModule = vi.fn(() => {
      throw new Error('must never import');
    });
    const plugin = await loadLocalPlugin(
      { id: manifest.id, manifest: staged.descriptor.manifest, ...staged },
      {
        trustedDigest: staged.digest,
        importModule,
      },
    );
    const kernel = createPluginKernel();
    await kernel.register(plugin);
    await kernel.seal();
    expect(importModule).not.toHaveBeenCalled();
    const collected: AttributedSkillContribution[] = [];
    kernel.extensions.collect(skillsExtensionPoint, {
      addSkill: (skill) => {
        collected.push(skill);
      },
    });
    expect(collected).toMatchObject([{ pluginId: manifest.id, name: 'review' }]);
    await kernel.dispose();
  });

  it('discovers data in the ordinary manual namespace and isolates invalid packages', async () => {
    const f = await payload();
    const other = path.join(f.root, 'broken');
    await mkdir(other);
    await writeFileIn(
      other,
      'weave-plugin.json',
      JSON.stringify({ ...descriptor, manifest: { ...manifest, id: 'broken' } }),
    );
    const result = await discoverLocalPlugins({ directory: f.root });
    expect(result.candidates).toMatchObject([
      { id: 'broken', status: 'invalid' },
      { id: manifest.id, status: 'ready', kind: 'skills' },
    ]);
  });
  it('rejects discovery evidence when the descriptor changes after its declaration read', async () => {
    const f = await payload();
    const original = fs.open.bind(fs);
    let edited = false;
    const spy = vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
      const handle = await original(...args);
      if (!edited && String(args[0]).endsWith('weave-plugin.json')) {
        const close = handle.close.bind(handle);
        vi.spyOn(handle, 'close').mockImplementation(async () => {
          await close();
          if (edited) return;
          edited = true;
          await writeFile(
            path.join(f.directory, 'weave-plugin.json'),
            JSON.stringify({
              ...descriptor,
              manifest: { ...manifest, name: 'Changed after observation' },
            }),
          );
        });
      }
      return handle;
    });
    try {
      const result = await discoverLocalPlugins({ directory: f.root });
      expect(result.candidates).toMatchObject([{ status: 'invalid' }]);
    } finally {
      spy.mockRestore();
    }
  });

  it.each([
    ['undeclared executable', 'index.mjs', 'throw new Error("never run");'],
    ['undeclared Skill', 'skills/extra/SKILL.md', document],
    [
      'wrong document name',
      'skills/review/SKILL.md',
      document.replace('name: review', 'name: other'),
    ],
    ['invalid YAML', 'skills/review/SKILL.md', document.replace('name: review', 'name: &x review')],
    ['oversize document', 'skills/review/SKILL.md', document + 'x'.repeat(64 * 1024)],
    ['oversize resource', 'skills/review/big.txt', 'x'.repeat(256 * 1024 + 1)],
    ['oversize README', 'README.md', 'x'.repeat(64 * 1024 + 1)],
    ['reserved device name', 'skills/review/CON.txt', 'device'],
    ['unsafe trailing space', 'skills/review/name ', 'space'],
    ...['<', '>', '|', '"', '?', '*', String.fromCharCode(127)].map(
      (character) => ['nonportable resource', `skills/review/bad${character}.txt`, 'bad'] as const,
    ),
    ['NUL resource', 'skills/review/nul.txt', 'bad\0text'],
  ])('rejects %s', async (_label, relative, text) => {
    const f = await payload();
    await writeFileIn(f.directory, relative, text);
    await expect(inspectPluginPayload(f.directory)).rejects.toMatchObject({
      code: 'plugin-artifact-invalid',
    });
  });
  it('rejects portable root name collisions on case-sensitive and insensitive filesystems', async () => {
    const f = await payload();
    await writeFileIn(f.directory, 'README.md', 'Read');
    await writeFileIn(f.directory, 'readme.md', 'Read');
    // A case-insensitive filesystem retains one name, so rename it explicitly.
    await fs.rename(path.join(f.directory, 'README.md'), path.join(f.directory, 'ReadMe.md'));
    await expect(inspectPluginPayload(f.directory)).rejects.toMatchObject({
      code: 'plugin-artifact-invalid',
    });
  });
  it('normalizes linked ancestors for ESM while rejecting a linked payload root', async () => {
    const root = await makeTempDirectory();
    const directory = await writePlugin(root, 'esm');
    const alias = path.join(root, 'alias');
    await symlink(root, alias);
    expect(await inspectPluginPayload(path.join(alias, 'esm'))).toMatchObject({
      directory,
      kind: 'entry',
    });
    const linkedRoot = path.join(root, 'linked');
    await symlink(directory, linkedRoot);
    await expect(inspectPluginPayload(linkedRoot)).rejects.toMatchObject({
      code: 'plugin-artifact-unsupported-file',
    });
  });
  it('inspects offline and loads admitted Skill packages with engine ranges without guessing a host version', async () => {
    const f = await payload();
    const withEngines = { ...descriptor, manifest: { ...manifest, engines: { weave: '^1.0.0' } } };
    await writeFileIn(f.directory, 'weave-plugin.json', JSON.stringify(withEngines));
    expect((await inspectPluginPayload(f.directory)).descriptor).toEqual(withEngines);
    await expect(inspectPluginPayload(f.directory, { hostVersion: '2.0.0' })).rejects.toMatchObject(
      { code: 'plugin-artifact-invalid' },
    );
    const discovered = await discoverLocalPlugins({ directory: f.root, hostVersion: '1.4.2' });
    const candidate = discovered.candidates[0]!;
    if (candidate.status !== 'ready') throw new Error('Expected compatible discovered data');
    await expect(
      loadLocalPlugin(candidate, { trustedDigest: candidate.digest }),
    ).resolves.toBeDefined();
    const legacyStore = createPluginArtifactStore({ directory: path.join(f.root, 'store') });
    await expect(legacyStore.preview({ sourceDirectory: f.directory })).rejects.toMatchObject({
      code: 'plugin-artifact-invalid',
    });
  });

  it('rejects missing declared document, malformed UTF-8 and symlinks', async () => {
    const f = await payload();
    const file = path.join(f.directory, 'skills/review/SKILL.md');
    await rm(file);
    await expect(inspectPluginPayload(f.directory)).rejects.toMatchObject({
      code: 'plugin-artifact-invalid',
    });
    await writeFile(file, document);
    await writeFile(path.join(f.directory, 'skills/review/bad.txt'), Buffer.from([0xc3, 0x28]));
    await expect(inspectPluginPayload(f.directory)).rejects.toMatchObject({
      code: 'plugin-artifact-invalid',
    });
    await rm(path.join(f.directory, 'skills/review/bad.txt'));
    await symlink(file, path.join(f.directory, 'skills/review/linked.txt'));
    await expect(inspectPluginPayload(f.directory)).rejects.toMatchObject({
      code: 'plugin-artifact-unsupported-file',
    });
  });

  it.each(['count', 'bytes'] as const)(
    'enforces aggregate resource %s across Skills',
    async (bound) => {
      const f = await payload();
      const names = ['review', 'extra'];
      await writeFileIn(
        f.directory,
        'weave-plugin.json',
        JSON.stringify({
          ...descriptor,
          manifest: { ...manifest, contributes: { skills: names } },
        }),
      );
      await writeFileIn(
        f.directory,
        'skills/extra/SKILL.md',
        document.replace('name: review', 'name: extra'),
      );
      const count = bound === 'count' ? 64 : 9;
      const data = bound === 'count' ? 'a' : 'x'.repeat(256 * 1024);
      for (let i = 0; i < count; i++)
        await writeFileIn(f.directory, `skills/${names[i % 2]}/r-${i}.txt`, data);
      await expect(inspectPluginPayload(f.directory)).rejects.toMatchObject({
        code: 'plugin-artifact-invalid',
      });
    },
  );

  it('retains pinned data after source changes and rejects changed bytes before load', async () => {
    const f = await payload();
    const artifact = await inspectPluginPayload(f.directory);
    const source = { id: manifest.id, manifest: artifact.descriptor.manifest, ...artifact };
    const loaded = await loadLocalPlugin(source, { trustedDigest: artifact.digest });
    await writeFileIn(f.directory, 'skills/review/references/check.md', 'Changed.');
    await expect(loadLocalPlugin(source, { trustedDigest: artifact.digest })).rejects.toMatchObject(
      { code: 'plugin-digest-mismatch', pluginId: manifest.id },
    );
    const kernel = createPluginKernel();
    await kernel.register(loaded);
    await kernel.seal();
    const collected: AttributedSkillContribution[] = [];
    kernel.extensions.collect(skillsExtensionPoint, {
      addSkill: (skill) => {
        collected.push(skill);
      },
    });
    expect(collected[0]?.resources?.['references/check.md']).toBe('Check the tests.');
    await kernel.dispose();
  });

  it('checks managed authority before data reads and setup, never importing an entry', async () => {
    const f = await payload();
    const artifact = await inspectPluginPayload(f.directory);
    const source = { id: manifest.id, manifest: artifact.descriptor.manifest, ...artifact };
    const abort = new AbortController();
    let allowed = true;
    const importModule = vi.fn();
    const verify = vi.fn(async () => {
      if (artifact.kind !== 'skills') throw new Error('Expected data');
      return { kind: 'skills' as const, skills: artifact.skills, digest: artifact.digest };
    });
    const assertReadySync = () => {
      if (!allowed) throw new Error('revoked');
    };
    const loaded = await loadLocalPlugin(source, {
      trustedDigest: artifact.digest,
      signal: abort.signal,
      explicitChecks: { verify, assertReadySync },
      importModule,
    });
    expect(verify).toHaveBeenCalledWith(abort.signal);
    allowed = false;
    const kernel = createPluginKernel();
    await expect(kernel.register(loaded)).rejects.toThrow();
    expect(importModule).not.toHaveBeenCalled();
    await kernel.dispose();
    await expect(
      loadLocalPlugin(source, {
        trustedDigest: artifact.digest,
        signal: abort.signal,
        explicitChecks: { verify, assertReadySync },
        importModule,
      }),
    ).rejects.toMatchObject({ code: 'plugin-explicit-authority-failed' });
  });
  it('keeps registered immutable data collectible after its admission authority retires', async () => {
    const f = await payload();
    const artifact = await inspectPluginPayload(f.directory);
    if (artifact.kind !== 'skills') throw new Error('Expected data');
    let allowed = true;
    const abort = new AbortController();
    const loaded = await loadLocalPlugin(
      { id: manifest.id, manifest: artifact.descriptor.manifest, ...artifact },
      {
        trustedDigest: artifact.digest,
        signal: abort.signal,
        explicitChecks: {
          verify: async () => ({
            kind: 'skills',
            skills: artifact.skills,
            digest: artifact.digest,
          }),
          assertReadySync: () => {
            if (!allowed) throw new Error('retired');
          },
        },
      },
    );
    const kernel = createPluginKernel();
    await kernel.register(loaded);
    await kernel.seal();
    allowed = false;
    abort.abort();
    const collected: AttributedSkillContribution[] = [];
    kernel.extensions.collect(skillsExtensionPoint, {
      addSkill: (skill) => {
        collected.push(skill);
      },
    });
    expect(collected).toMatchObject([{ pluginId: manifest.id, name: 'review' }]);
    await kernel.dispose();
  });

  it('rejects malformed data verification evidence before accepting or registering data', async () => {
    const f = await payload();
    const artifact = await inspectPluginPayload(f.directory);
    if (artifact.kind !== 'skills') throw new Error('Expected data');
    const valid = { kind: 'skills' as const, skills: artifact.skills, digest: artifact.digest };
    for (const verified of [
      { ...valid, entry: '/invented/index.mjs' },
      { ...valid, extra: true },
      { ...valid, skills: [] },
      { ...valid, kind: 'entry', entry: '/invented/index.mjs' },
      { ...valid, digest: '0'.repeat(64) },
    ]) {
      await expect(
        loadLocalPlugin(
          { id: manifest.id, manifest: artifact.descriptor.manifest, ...artifact },
          {
            trustedDigest: artifact.digest,
            signal: new AbortController().signal,
            explicitChecks: {
              verify: async () => verified as never,
              assertReadySync: () => undefined,
            },
          },
        ),
      ).rejects.toMatchObject({ code: 'plugin-digest-mismatch', pluginId: manifest.id });
    }
  });

  it('preserves cancellation during actual data reads and closes accepted handles', async () => {
    const f = await payload();
    const abort = new AbortController();
    const reason = new Error('cancel inspection');
    const original = fs.open.bind(fs);
    let closed = false;
    const spy = vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
      const handle = await original(...args);
      if (String(args[0]).endsWith('check.md')) {
        const read = handle.read.bind(handle);
        vi.spyOn(handle, 'read').mockImplementation(async (...readArgs) => {
          const result = await Reflect.apply(read, handle, readArgs);
          abort.abort(reason);
          return result;
        });
        const close = handle.close.bind(handle);
        vi.spyOn(handle, 'close').mockImplementation(async () => {
          await close();
          closed = true;
        });
      }
      return handle;
    });
    try {
      await expect(inspectPluginPayload(f.directory, { signal: abort.signal })).rejects.toBe(
        reason,
      );
      expect(closed).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });
});
