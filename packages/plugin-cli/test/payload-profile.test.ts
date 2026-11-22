import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { captureSnapshot } from '../src/snapshot.js';
import { assertSourceProfile, inspectCliArtifact } from '../src/payload-profile.js';
import { inspectPluginPayload } from '@weave/plugin-host';

const roots: string[] = [];
async function fixture(kind: 'source' | 'entry' | 'skills' = 'entry') {
  const directory = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'weave-cli-profile-')),
  );
  roots.push(directory);
  const manifest = {
    id: 'example',
    name: 'Example',
    version: '1.0.0',
    apiVersion: '1.0.0',
    capabilities: kind === 'skills' ? ['skill'] : ['tool'],
    contributes: kind === 'skills' ? { skills: ['review'] } : { tools: ['echo'] },
    permissions: [],
    ...(kind === 'skills' ? { host: 'declarative' } : {}),
  };
  const descriptor =
    kind === 'skills'
      ? { schemaVersion: 2, kind: 'skills', manifest }
      : { schemaVersion: 1, entry: 'index.mjs', manifest };
  await fs.writeFile(path.join(directory, 'weave-plugin.json'), JSON.stringify(descriptor));
  if (kind === 'skills') {
    await put(
      directory,
      'skills/review/SKILL.md',
      '---\nname: review\ndescription: Review\n---\nRead scripts/example.js as text.',
    );
    await put(directory, 'skills/review/scripts/example.js', 'console.log("inert")');
  } else if (kind === 'source') {
    await put(directory, 'package.json', '{"type":"module"}');
    await put(directory, 'src/index.ts', 'export default () => ({ setup() {} });');
  } else await put(directory, 'index.mjs', 'export default () => ({ setup() {} });');
  return directory;
}
async function put(directory: string, relative: string, value = 'text') {
  await fs.mkdir(path.dirname(path.join(directory, relative)), { recursive: true });
  await fs.writeFile(path.join(directory, relative), value);
}
afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

describe('CLI positive payload profiles', () => {
  it('accepts actual TypeScript source roots without pretending source is installable', async () => {
    const directory = await fixture('source');
    await put(directory, 'tsconfig.json', '{}');
    await put(directory, 'src/helpers/read.ts', 'export const value = 1;');
    await put(directory, 'README.md');
    const snapshot = await captureSnapshot(directory);
    expect(() => assertSourceProfile(snapshot)).not.toThrow();
    await expect(inspectCliArtifact(directory)).rejects.toThrow();
  });
  it.each([
    'index.mjs',
    'extra.json',
    'src/shim.d.ts',
    'src/a.js',
    'node_modules/x/index.ts',
    'src/.env',
  ])('rejects unsupported source %s', async (relative) => {
    const directory = await fixture('source');
    await put(directory, relative);
    const snapshot = await captureSnapshot(directory);
    expect(() => assertSourceProfile(snapshot)).toThrowError(
      expect.objectContaining({ code: 'plugin-cli-source-policy' }),
    );
  });
  it.each([
    'src/node_modules',
    'src/coverage',
    'src/.env.production',
    'src/' + Array.from({ length: 17 }, (_, i) => `d${i}`).join('/'),
  ])('rejects unsupported empty source directory %s', async (relative) => {
    const directory = await fixture('source');
    await fs.mkdir(path.join(directory, relative), { recursive: true });
    const snapshot = await captureSnapshot(directory);
    expect(() => assertSourceProfile(snapshot)).toThrowError(
      expect.objectContaining({ code: 'plugin-cli-source-policy' }),
    );
  });
  it('enforces source file and root documentation limits', async () => {
    const directory = await fixture('source');
    await put(directory, 'README.md', 'x'.repeat(64 * 1024 + 1));
    const snapshot = await captureSnapshot(directory);
    expect(() => assertSourceProfile(snapshot)).toThrowError(
      expect.objectContaining({ code: 'plugin-cli-source-policy' }),
    );
  });
  it('accepts actual entry and Skills payloads and preserves their Host identity', async () => {
    for (const kind of ['entry', 'skills'] as const) {
      const directory = await fixture(kind);
      expect(await inspectCliArtifact(directory)).toEqual(await inspectPluginPayload(directory));
    }
  });
  it.each(['extra.json', '.env', 'index.mjs.map', 'node_modules/package.json'])(
    'rejects Host-valid but non-CLI ESM payload %s',
    async (relative) => {
      const directory = await fixture();
      await put(directory, relative);
      await expect(inspectPluginPayload(directory)).resolves.toBeDefined();
      await expect(inspectCliArtifact(directory)).rejects.toMatchObject({
        code: 'plugin-cli-source-policy',
      });
    },
  );
  it.each([
    '.env',
    '.env.production',
    'references/a.map',
    'node_modules/readme.txt',
    'coverage/report.txt',
  ])('rejects publish hygiene resource %s without silently dropping it', async (relative) => {
    const directory = await fixture('skills');
    await put(directory, `skills/review/${relative}`);
    await expect(inspectPluginPayload(directory)).resolves.toBeDefined();
    await expect(inspectCliArtifact(directory)).rejects.toMatchObject({
      code: 'plugin-cli-source-policy',
    });
  });
  it('rejects nonliteral executable imports without running module code', async () => {
    const directory = await fixture();
    const marker = path.join(directory, 'marker');
    await put(
      directory,
      'index.mjs',
      `const target = 'node:fs'; import(target); throw new Error(${JSON.stringify(marker)}); export default () => ({setup(){}});`,
    );
    await expect(inspectCliArtifact(directory)).rejects.toMatchObject({
      code: 'plugin-cli-source-policy',
    });
    await expect(fs.stat(marker)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
