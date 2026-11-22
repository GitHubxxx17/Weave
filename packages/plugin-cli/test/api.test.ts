import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createPluginArtifactStore, inspectPluginPayload } from '@weave/plugin-host';
import { buildPlugin, packPlugin, validatePlugin } from '../src/api.js';

const roots: string[] = [];
async function root() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'weave-cli-api-'));
  roots.push(directory);
  return directory;
}
async function skills(directory: string) {
  await fs.mkdir(path.join(directory, 'skills', 'check'), { recursive: true });
  await fs.writeFile(
    path.join(directory, 'weave-plugin.json'),
    JSON.stringify({
      schemaVersion: 2,
      kind: 'skills',
      manifest: {
        id: 'check-skills',
        name: 'Check Skills',
        version: '0.1.0',
        apiVersion: '1.0.0',
        host: 'declarative',
        capabilities: ['skill'],
        contributes: { skills: ['check'] },
        permissions: [],
      },
    }),
  );
  await fs.writeFile(
    path.join(directory, 'skills', 'check', 'SKILL.md'),
    '---\nname: check\ndescription: Check requirements\n---\nRead references/list.md.\n',
  );
  await fs.mkdir(path.join(directory, 'skills', 'check', 'references'));
  await fs.writeFile(
    path.join(directory, 'skills', 'check', 'references', 'list.md'),
    'Check actual evidence.\n',
  );
}
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

describe('author API artifact handoff', () => {
  it('builds and packs raw data with an external receipt and installer-identical identity', async () => {
    const directory = await root();
    const source = path.join(directory, 'source');
    await skills(source);
    const validated = await validatePlugin({ sourceDirectory: source });
    expect(validated.mode).toBe('artifact');
    const built = await buildPlugin({
      sourceDirectory: source,
      outputDirectory: path.join(directory, 'build'),
    });
    expect(built.payloadDirectory).toBe(
      await fs.realpath(path.join(directory, 'build', 'payload')),
    );
    expect(built.artifact.kind).toBe('skills');
    const packed = await packPlugin({
      artifactDirectory: built.payloadDirectory,
      outputDirectory: path.join(directory, 'release'),
    });
    expect(packed.receiptPath).toBe(
      await fs.realpath(path.join(directory, 'release', 'receipt.json')),
    );
    expect(await fs.readdir(packed.payloadDirectory)).toEqual(['skills', 'weave-plugin.json']);
    const actual = await inspectPluginPayload(packed.payloadDirectory);
    expect(actual.digest).toBe(built.artifact.digest);
    expect(packed.receipt).toMatchObject({
      schemaVersion: 1,
      variant: 'skills',
      digest: actual.digest,
      files: actual.files,
      bytes: actual.bytes,
      outputPath: packed.payloadDirectory,
    });
    expect(JSON.parse(await fs.readFile(packed.receiptPath, 'utf8'))).toEqual(packed.receipt);
    const store = createPluginArtifactStore({ directory: path.join(directory, 'store') });
    expect(await store.preview({ sourceDirectory: packed.payloadDirectory })).toMatchObject({
      digest: actual.digest,
      files: actual.files,
      bytes: actual.bytes,
    });
    await fs.writeFile(packed.receiptPath, '{}');
    expect((await inspectPluginPayload(packed.payloadDirectory)).digest).toBe(actual.digest);
  });

  it('distinguishes typed source from payload without executing author code or build configuration', async () => {
    const directory = await root();
    const source = path.join(directory, 'source');
    await fs.mkdir(path.join(source, 'src'), { recursive: true });
    await fs.writeFile(
      path.join(source, 'package.json'),
      JSON.stringify({ type: 'module', scripts: { build: 'throw never' } }),
    );
    await fs.writeFile(
      path.join(source, 'tsconfig.json'),
      JSON.stringify({ extends: './does-not-exist.json' }),
    );
    await fs.writeFile(
      path.join(source, 'weave-plugin.json'),
      JSON.stringify({
        schemaVersion: 1,
        entry: 'index.mjs',
        manifest: {
          id: 'typed-command',
          name: 'Typed command',
          version: '0.1.0',
          apiVersion: '1.0.0',
          capabilities: ['command'],
          contributes: { commands: ['hello'] },
          permissions: [],
        },
      }),
    );
    await fs.writeFile(
      path.join(source, 'src', 'index.ts'),
      "import type { PluginFactory } from '@weave/plugin';\nthrow new Error('author must not execute');\nexport default ((sdk) => ({setup(env) { env.contribute(sdk.commandsExtensionPoint, api => api.addCommand({name:'hello',title:'Hello',prompt:'Hello $ARGUMENTS'})); }})) satisfies PluginFactory;\n",
    );
    expect(await validatePlugin({ sourceDirectory: source })).toMatchObject({
      mode: 'source',
      variant: 'entry',
    });
    await expect(fs.stat(path.join(source, 'index.mjs'))).rejects.toMatchObject({ code: 'ENOENT' });
    const built = await buildPlugin({
      sourceDirectory: source,
      outputDirectory: path.join(directory, 'build'),
    });
    expect(built.artifact.kind).toBe('entry');
    expect(await fs.readdir(built.payloadDirectory)).toEqual(['index.mjs', 'weave-plugin.json']);
    expect(await validatePlugin({ artifactDirectory: built.payloadDirectory })).toMatchObject({
      mode: 'artifact',
      artifact: { digest: built.artifact.digest },
    });
  }, 30_000);

  it('rejects ambiguous options and irrelevant SDK overrides before output writes', async () => {
    const directory = await root();
    const source = path.join(directory, 'source');
    await skills(source);
    await expect(
      validatePlugin({ sourceDirectory: source, artifactDirectory: source } as never),
    ).rejects.toMatchObject({ code: 'plugin-cli-usage' });
    await expect(
      validatePlugin({ sourceDirectory: source, sdkDirectory: directory }),
    ).rejects.toMatchObject({ code: 'plugin-cli-usage' });
    await expect(
      buildPlugin({
        sourceDirectory: source,
        outputDirectory: path.join(directory, 'never'),
        sdkDirectory: directory,
      }),
    ).rejects.toMatchObject({ code: 'plugin-cli-usage' });
    await expect(fs.stat(path.join(directory, 'never'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
