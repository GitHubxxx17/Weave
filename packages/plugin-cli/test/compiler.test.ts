import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { mkdtemp, mkdir, writeFile, rm, symlink, readFile, open } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

import { resolvePluginSdk } from '../src/sdk.js';
import { checkPluginSource } from '../src/compiler.js';
import { bundlePluginSource, validateEsmArtifact } from '../src/bundle.js';
import type { DirectorySnapshot } from '../src/types.js';

const roots: string[] = [];
const encoder = new TextEncoder();
const source = `import type { PluginFactory } from '@weave/plugin';
import { basename } from 'node:path';
import { value } from './value.js';
const factory: PluginFactory = sdk => ({ setup(env) {
 const inputSchema = sdk.z.object({ text:sdk.z.string() });
 env.contribute(sdk.toolsExtensionPoint, api => api.addTool({
  name:'echo', description:'Echo', parameters:sdk.z.toJSONSchema(inputSchema), inputSchema,
  readOnly:true, execute(input,context) { context.signal.throwIfAborted(); return basename(input.text); }
 }));
 env.contribute(sdk.commandsExtensionPoint, api => api.addCommand({name:'hello',title:value,prompt:'Hi $ARGUMENTS'}));
}});
export default factory;`;
async function snapshot(
  entry = source,
  additional: Record<string, string> = {},
): Promise<DirectorySnapshot> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'weave-cli-compiler-'));
  roots.push(directory);
  // Deliberately place different source/config on disk. The compiler must use captured bytes.
  await mkdir(path.join(directory, 'src'));
  await writeFile(
    path.join(directory, 'src/index.ts'),
    'throw new Error("disk source must never run or compile");',
  );
  return {
    directory,
    directories: ['src'],
    files: new Map(
      Object.entries({
        'package.json': '{"private":true,"type":"module"}',
        'src/index.ts': entry,
        'src/value.ts': 'export const value = "Hello";',
        'tsconfig.json':
          '{"extends":"./execute-me.js","compilerOptions":{"plugins":[{"name":"must-not-run"}]}}',
        ...additional,
      }).map(([name, text]) => [name, encoder.encode(text)]),
    ),
  };
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('real public SDK compiler and single ESM', () => {
  // Real SDK declaration graphs are compiled by these cases; keep their local
  // budgets independent of lightweight syntax and bounded-metadata checks.
  it('checks actual SDK Tool and Command contracts from snapshots without author node_modules', async () => {
    const sdk = await resolvePluginSdk();
    const input = await snapshot();
    await expect(checkPluginSource(input, sdk)).resolves.toBeUndefined();
    const bytes = await bundlePluginSource(input, sdk);
    const code = new TextDecoder().decode(bytes);
    expect(code).toContain('node:path');
    expect(code).not.toContain('@weave/plugin');
    expect(code).not.toContain('disk source');
    expect(() => validateEsmArtifact(bytes)).not.toThrow();
  }, 60_000);
  it('rejects an actual SDK type error and invalid default factory without executing source', async () => {
    const sdk = await resolvePluginSdk();
    for (const text of [
      source.replace("prompt:'Hi $ARGUMENTS'", 'prompt:42'),
      'export const noDefault = 1;',
      'export default 42;',
      'export default () => ({ setup:42 });',
    ]) {
      await expect(checkPluginSource(await snapshot(text), sdk)).rejects.toMatchObject({
        code: 'plugin-cli-typecheck',
      });
    }
  }, 60_000);
  it('accepts a real SDK alias and rejects non-SDK, unbuilt or relative SDK directories', async () => {
    const sdk = await resolvePluginSdk();
    const root = (await snapshot()).directory;
    const alias = path.join(root, 'sdk');
    await symlink(sdk.directory, alias);
    expect(await resolvePluginSdk(alias)).toEqual(sdk);
    await expect(resolvePluginSdk('relative/sdk')).rejects.toMatchObject({
      code: 'plugin-cli-sdk-invalid',
    });
    const fake = path.join(root, 'fake-sdk');
    await mkdir(fake);
    await writeFile(
      path.join(fake, 'package.json'),
      JSON.stringify({ name: 'wrong-package', exports: { '.': { types: './dist/index.d.ts' } } }),
    );
    await expect(resolvePluginSdk(fake)).rejects.toMatchObject({ code: 'plugin-cli-sdk-invalid' });
    const metadata = JSON.parse(await readFile(path.join(sdk.directory, 'package.json'), 'utf8'));
    await writeFile(path.join(fake, 'package.json'), JSON.stringify(metadata));
    await expect(resolvePluginSdk(fake)).rejects.toMatchObject({ code: 'plugin-cli-sdk-invalid' });
  }, 30_000);
  it('allows erased SDK named types and static local dynamic imports while preserving top-level code inertly', async () => {
    const sdk = await resolvePluginSdk();
    const input = await snapshot(
      source.replace('import type { PluginFactory }', 'import { type PluginFactory }') +
        "\nthrow new Error('author top-level code was bundled without executing');\nvoid import('./value.js');",
    );
    const code = new TextDecoder().decode(await bundlePluginSource(input, sdk));
    expect(code).toContain('author top-level code');
    expect(code).not.toContain("import('./value.js')");
  }, 30_000);
  it('preserves cancellation before SDK, compiler and bundler work', async () => {
    const sdk = await resolvePluginSdk();
    const input = await snapshot();
    const abort = new AbortController();
    const reason = new Error('cancel compiler');
    abort.abort(reason);
    await expect(resolvePluginSdk(undefined, abort.signal)).rejects.toBe(reason);
    await expect(checkPluginSource(input, sdk, abort.signal)).rejects.toBe(reason);
    await expect(bundlePluginSource(input, sdk, abort.signal)).rejects.toBe(reason);
  }, 30_000);
  it('rejects oversized SDK metadata and a package.json directory before unbounded reads', async () => {
    const root = (await snapshot()).directory;
    const large = path.join(root, 'large');
    await mkdir(large);
    await writeFile(path.join(large, 'package.json'), ' '.repeat(64 * 1024 + 1));
    await expect(resolvePluginSdk(large)).rejects.toMatchObject({ code: 'plugin-cli-sdk-invalid' });
    const notFile = path.join(root, 'not-file');
    await mkdir(path.join(notFile, 'package.json'), { recursive: true });
    await expect(resolvePluginSdk(notFile)).rejects.toMatchObject({
      code: 'plugin-cli-sdk-invalid',
    });
  });
  it('rejects SDK metadata FIFOs without waiting for a writer and rejects metadata symlinks', async () => {
    const root = (await snapshot()).directory;
    const fifoSdk = path.join(root, 'fifo-sdk');
    await mkdir(fifoSdk);
    const fifo = path.join(fifoSdk, 'package.json');
    await promisify(execFile)('mkfifo', [fifo]);
    const attempt = resolvePluginSdk(fifoSdk).catch((error: unknown) => error);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let completed: boolean;
    try {
      completed = await Promise.race([
        attempt.then(() => true),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(false), 250);
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      // Unblock an old blocking reader before asserting, so RED cannot hang the test worker.
      const writer = await open(fifo, constants.O_RDWR | constants.O_NONBLOCK);
      try {
        await attempt;
      } finally {
        await writer.close();
      }
    }
    expect(completed).toBe(true);
    expect(await attempt).toMatchObject({ code: 'plugin-cli-sdk-invalid' });
    const sdk = await resolvePluginSdk();
    const linkedSdk = path.join(root, 'linked-sdk');
    await mkdir(linkedSdk);
    await symlink(path.join(sdk.directory, 'package.json'), path.join(linkedSdk, 'package.json'));
    await symlink(path.join(sdk.directory, 'dist'), path.join(linkedSdk, 'dist'));
    await expect(resolvePluginSdk(linkedSdk)).rejects.toMatchObject({
      code: 'plugin-cli-sdk-invalid',
      cause: { code: 'ELOOP' },
    });
  }, 30_000);
  it('requires resolvable public PluginFactory, PluginSdk and PluginManifest declarations', async () => {
    const sdk = await resolvePluginSdk();
    const root = (await snapshot()).directory;
    const fake = path.join(root, 'missing-public-types');
    await mkdir(path.join(fake, 'dist'), { recursive: true });
    await writeFile(
      path.join(fake, 'package.json'),
      await readFile(path.join(sdk.directory, 'package.json')),
    );
    for (const declarations of [
      'export {};',
      "export type { PluginFactory, PluginSdk, PluginManifest } from './missing.js';",
    ]) {
      await writeFile(path.join(fake, 'dist/index.d.ts'), declarations);
      await expect(resolvePluginSdk(fake)).rejects.toMatchObject({
        code: 'plugin-cli-sdk-invalid',
      });
    }
  }, 30_000);
  it('rejects SDK module and global augmentation in captured .ts files', async () => {
    const sdk = await resolvePluginSdk();
    const forged = source.replace(
      'const inputSchema =',
      'sdk.notARealSdkMethod(); const inputSchema =',
    );
    for (const extra of [
      "import type { PluginSdk } from '@weave/plugin'; declare module '@weave/plugin' { interface PluginSdk { notARealSdkMethod(): void } }",
      'export {}; declare global { interface Array<T> { notARealArrayMethod(): void } }',
    ]) {
      const input = await snapshot(extra.includes('PluginSdk') ? forged : source, {
        'src/augment.ts': extra,
      });
      await expect(checkPluginSource(input, sdk)).rejects.toMatchObject({
        code: 'plugin-cli-source-policy',
      });
      await expect(bundlePluginSource(input, sdk)).rejects.toMatchObject({
        code: 'plugin-cli-source-policy',
      });
    }
  }, 30_000);
  it('keeps ordinary runtime TypeScript namespaces supported', async () => {
    const sdk = await resolvePluginSdk();
    const input = await snapshot(
      source + '\nnamespace Helpers { export const value = "runtime"; } void Helpers.value;',
    );
    await expect(checkPluginSource(input, sdk)).resolves.toBeUndefined();
    await expect(bundlePluginSource(input, sdk)).resolves.toBeInstanceOf(Uint8Array);
  }, 30_000);
  it('checks unused captured source and refuses declaration shims', async () => {
    const sdk = await resolvePluginSdk();
    for (const extra of [
      { 'src/unused.ts': "import value from 'hidden-package'; export {value};" },
      { 'src/ambient.d.ts': "declare module 'hidden-package';" },
    ]) {
      await expect(checkPluginSource(await snapshot(source, extra), sdk)).rejects.toMatchObject({
        code: 'plugin-cli-source-policy',
      });
    }
  }, 30_000);
  it.each([
    "import fs from 'made-up-package';",
    "import { createPluginSdk } from '@weave/plugin';",
    "import x from 'node:not-a-builtin';",
    "import x from '/outside.ts';",
    "import x from 'https://example.test/x.ts';",
    "import x from '../../outside.js';",
    "import x from './missing.js';",
    'const commonjs = require;',
    "import * as mod from 'node:module'; void mod['createRequire'];",
    "import x = require('node:path');",
    "require('node:fs');",
    "require.resolve('node:fs');",
    "import {createRequire as loader} from 'node:module';",
    "const name = './value.js'; import(name);",
    "import('./value.js', {with:{type:'json'}});",
    "/// <reference path='../shim.d.ts' />\n",
    "import type {Anything} from 'foreign-types';",
    "import fs from 'node:fs' with {type:'json'};",
  ])(
    'rejects unsupported source syntax before tree shaking: %s',
    async (prefix) => {
      const sdk = await resolvePluginSdk();
      await expect(
        bundlePluginSource(await snapshot(`${prefix}\n${source}`), sdk),
      ).rejects.toMatchObject({ code: 'plugin-cli-source-policy' });
    },
    30_000,
  );
  it.each([
    "export default () => import('./chunk.mjs');",
    'export default () => import(process.env.SOURCE);',
    "import value from 'unbundled-package'; export default value;",
    "const fs = require('node:fs'); export default fs;",
    "import {createRequire} from 'node:module'; export default createRequire(import.meta.url);",
    'export default (value:string) => value;',
    'interface Fake {value:string}; export default Fake;',
  ])('rejects unsupported imported artifact ESM: %s', (code) => {
    expect(() => validateEsmArtifact(encoder.encode(code))).toThrow();
  });
});
