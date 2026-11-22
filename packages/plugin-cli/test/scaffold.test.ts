import { execFile } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { inspectPluginPayload, parseDescriptor } from '@weave/plugin-host';
import { afterEach, describe, expect, test } from 'vitest';

import { createPluginProject } from '../src/scaffold.js';

const execute = promisify(execFile);
const require = createRequire(import.meta.url);
const compiler = require.resolve('typescript/lib/tsc.js');
const temporary: string[] = [];

async function freshDirectory(): Promise<string> {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'weave-scaffold-'));
  temporary.push(parent);
  return path.join(parent, 'project');
}

afterEach(async () => {
  await Promise.all(
    temporary.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('createPluginProject', () => {
  test.each(['tool', 'command'] as const)(
    'creates a real typed %s project in a clean external directory',
    async (template) => {
      const directory = await freshDirectory();
      const result = await createPluginProject({ template, id: 'hello-world', directory });

      expect(result).toMatchObject({
        command: 'create',
        projectDirectory: directory,
        variant: 'entry',
      });
      const descriptor = parseDescriptor(
        await readFile(path.join(directory, 'weave-plugin.json'), 'utf8'),
      );
      expect(descriptor).toMatchObject({
        schemaVersion: 1,
        entry: 'index.mjs',
        manifest: { id: 'hello-world', name: 'Hello World', version: '0.1.0', permissions: [] },
      });
      expect(descriptor.manifest.capabilities).toEqual([template]);
      expect(descriptor.manifest.contributes).toEqual(
        template === 'tool' ? { tools: ['hello-world'] } : { commands: ['hello-world'] },
      );
      await expect(stat(path.join(directory, 'index.mjs'))).rejects.toMatchObject({
        code: 'ENOENT',
      });
      await expect(stat(path.join(directory, 'node_modules'))).rejects.toMatchObject({
        code: 'ENOENT',
      });
      const packageJson: unknown = JSON.parse(
        await readFile(path.join(directory, 'package.json'), 'utf8'),
      );
      expect(packageJson).toEqual({ name: 'hello-world', private: true, type: 'module' });

      const checked = await execute(
        process.execPath,
        [compiler, '--project', path.join(directory, 'tsconfig.json')],
        { cwd: path.dirname(directory) },
      );
      expect(checked.stdout).toBe('');
      expect(checked.stderr).toBe('');
      expect((await readdir(directory)).sort()).toEqual([
        'README.md',
        'package.json',
        'src',
        'tsconfig.json',
        'weave-plugin.json',
      ]);
    },
    30_000,
  );

  test('generated editor config checks the actual SDK rather than a permissive type shim', async () => {
    const directory = await freshDirectory();
    await createPluginProject({ template: 'tool', id: 'typed-tool', directory });
    await writeFile(
      path.join(directory, 'src/index.ts'),
      [
        "import type { PluginFactory } from '@weave/plugin';",
        'export default ((sdk) => ({',
        '  setup() { sdk.thisMethodDoesNotExist(); },',
        '})) satisfies PluginFactory;',
      ].join('\n'),
    );

    const result = await execute(process.execPath, [
      compiler,
      '--project',
      path.join(directory, 'tsconfig.json'),
    ]).catch((error: unknown) => error);
    expect(result).toMatchObject({ code: 2 });
    expect((result as { stdout: string }).stdout).toContain('thisMethodDoesNotExist');
  }, 30_000);

  test('creates Skills as an already valid inert payload with a real referenced resource', async () => {
    const directory = await freshDirectory();
    const result = await createPluginProject({
      template: 'skills',
      id: 'review-work',
      name: 'Review Work',
      directory,
    });
    const artifact = await inspectPluginPayload(directory);

    expect(result.variant).toBe('skills');
    expect(artifact).toMatchObject({
      kind: 'skills',
      descriptor: {
        schemaVersion: 2,
        kind: 'skills',
        manifest: {
          id: 'review-work',
          name: 'Review Work',
          host: 'declarative',
          capabilities: ['skill'],
          contributes: { skills: ['review-work'] },
          permissions: [],
        },
      },
    });
    if (artifact.kind !== 'skills') throw new Error('Expected Skills payload');
    expect(artifact.skills[0]?.resources?.['references/checklist.md']).toContain('Verify');
    expect(artifact.skills[0]?.instructions).toContain('references/checklist.md');
    expect((await readdir(directory)).sort()).toEqual(['README.md', 'skills', 'weave-plugin.json']);
  });

  test('preserves existing project files when creation conflicts', async () => {
    const directory = await freshDirectory();
    await createPluginProject({ template: 'skills', id: 'keep-work', directory });
    await writeFile(path.join(directory, 'README.md'), 'Unrelated existing work');

    await expect(
      createPluginProject({ template: 'tool', id: 'new-work', directory }),
    ).rejects.toMatchObject({ code: 'plugin-cli-output-conflict' });
    expect(await readFile(path.join(directory, 'README.md'), 'utf8')).toBe(
      'Unrelated existing work',
    );
    await expect(stat(path.join(directory, 'src'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  test.each([
    { template: 'unknown', id: 'valid-id' },
    { template: 'tool', id: '../escape' },
    { template: 'command', id: 'Uppercase' },
    { template: 'skills', id: 'a'.repeat(65) },
    { template: 'skills', id: 'valid-id', sdkDirectory: '/unused-sdk' },
  ])('rejects invalid author options before allocating a directory: %j', async (options) => {
    const directory = await freshDirectory();
    await expect(
      createPluginProject({ ...options, directory } as Parameters<typeof createPluginProject>[0]),
    ).rejects.toMatchObject({ code: 'plugin-cli-invalid-project' });
    await expect(stat(directory)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  test('rejects an absent explicit SDK without creating any project', async () => {
    const directory = await freshDirectory();
    await expect(
      createPluginProject({
        template: 'tool',
        id: 'missing-sdk',
        directory,
        sdkDirectory: path.join(path.dirname(directory), 'missing'),
      }),
    ).rejects.toMatchObject({ code: 'plugin-cli-sdk-invalid' });
    await expect(stat(directory)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  test('does not create a project when already cancelled', async () => {
    const directory = await freshDirectory();
    const signal = AbortSignal.abort(new Error('cancelled'));
    await expect(
      createPluginProject({ template: 'skills', id: 'cancelled-work', directory, signal }),
    ).rejects.toThrow();
    await expect(stat(directory)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
