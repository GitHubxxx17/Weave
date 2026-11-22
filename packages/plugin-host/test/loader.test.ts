import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  commandsExtensionPoint,
  createPluginKernel,
  createPluginSdk,
  type KernelPlugin,
  type PluginCommand,
} from '@weave/plugin';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { discoverLocalPlugins, type ReadyLocalPlugin } from '../src/discovery.js';
import { PluginHostError } from '../src/errors.js';
import { loadLocalPlugin } from '../src/loader.js';
import {
  makeTempDirectory,
  manifestFor,
  removeTempDirectories,
  writePlugin,
  type PluginFiles,
} from './support/fixtures.js';

afterEach(removeTempDirectories);

/** Writes one plugin, discovers it and returns it, which must be ready. */
async function discovered(
  name: string,
  files: PluginFiles = {},
  root?: string,
): Promise<{ plugin: ReadyLocalPlugin; root: string }> {
  const parent = root ?? (await makeTempDirectory());
  await writePlugin(parent, name, files);
  const result = await discoverLocalPlugins({ directory: parent, hostVersion: '1.4.2' });
  const plugin = result.candidates.find((candidate) => candidate.id === name);
  if (plugin?.status !== 'ready') {
    throw new Error(`Expected "${name}" to be ready, found ${JSON.stringify(plugin)}`);
  }
  return { plugin, root: parent };
}

async function loadFailure(action: Promise<unknown>): Promise<PluginHostError> {
  try {
    await action;
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(PluginHostError);
    return error as PluginHostError;
  }
  throw new Error('Expected the load to fail');
}

/** The commands a kernel that holds `plugin` collects from `weave.commands`. */
async function commandsOf(plugin: KernelPlugin): Promise<PluginCommand[]> {
  const kernel = createPluginKernel({ hostVersion: '1.4.2' });
  await kernel.register(plugin);
  await kernel.seal();
  const commands: PluginCommand[] = [];
  kernel.extensions.collect(commandsExtensionPoint, {
    addCommand: (c) => {
      commands.push(c);
    },
  });
  await kernel.dispose();
  return commands;
}

describe('loadLocalPlugin', () => {
  describe('a trusted plugin', () => {
    it('imports the entry module, calls its factory with the SDK and returns a kernel plugin', async () => {
      const { plugin } = await discovered('hello-commands');

      const loaded = await loadLocalPlugin(plugin, { trustedDigest: plugin.digest });

      expect(loaded.manifest).toEqual(plugin.manifest);
      expect(await commandsOf(loaded)).toEqual([
        { name: 'hello', title: 'Hello', prompt: 'Say hello to $ARGUMENTS' },
      ]);
    });

    it('takes the manifest from the descriptor, so what the kernel enforces is what the user saw', async () => {
      const { plugin } = await discovered('sneaky', {
        // The module adds a command the descriptor does not list.
        source: `export default (sdk) => ({
          setup(env) {
            env.contribute(sdk.commandsExtensionPoint, (api) => {
              api.addCommand({ name: 'hello', title: 'Hello', prompt: 'hi' });
              api.addCommand({ name: 'extra', title: 'Extra', prompt: 'not declared' });
            });
          },
        });`,
      });
      const loaded = await loadLocalPlugin(plugin, { trustedDigest: plugin.digest });

      await expect(commandsOf(loaded)).rejects.toMatchObject({
        code: 'plugin-contributes-exceeds-manifest',
        pluginId: 'sneaky',
      });
    });

    it('waits for an asynchronous factory', async () => {
      const { plugin } = await discovered('slow', {
        source: `export default async (sdk) => {
          await new Promise((resolve) => setTimeout(resolve, 5));
          return {
            setup(env) {
              env.contribute(sdk.commandsExtensionPoint, (api) =>
                api.addCommand({ name: 'hello', title: 'Slow', prompt: 'hi' }),
              );
            },
          };
        };`,
      });

      const loaded = await loadLocalPlugin(plugin, { trustedDigest: plugin.digest });

      expect((await commandsOf(loaded)).map((command) => command.title)).toEqual(['Slow']);
    });

    it('finds an entry in a folder whose name has spaces and non-ASCII characters', async () => {
      const root = await makeTempDirectory();
      const { plugin } = await discovered('odd', { entry: 'my dist/入口.mjs' }, root);

      const loaded = await loadLocalPlugin(plugin, { trustedDigest: plugin.digest });

      expect((await commandsOf(loaded)).map((command) => command.name)).toEqual(['hello']);
    });

    it('imports a file URL that carries the digest, so changed content is a new module', async () => {
      const { plugin } = await discovered('probe');
      const importModule = vi.fn(async () => ({ default: () => ({ setup: () => undefined }) }));

      await loadLocalPlugin(plugin, { trustedDigest: plugin.digest, importModule });

      expect(importModule).toHaveBeenCalledOnce();
      const url = new URL((importModule.mock.calls[0] as unknown as [string])[0]);
      expect(url.protocol).toBe('file:');
      expect(url.searchParams.get('digest')).toBe(plugin.digest);
      url.search = '';
      expect(url.href).toBe(pathToFileURL(plugin.entry).href);
    });

    it('hands the factory the SDK it was given, or a fresh one', async () => {
      const { plugin } = await discovered('probe');
      const seen: unknown[] = [];
      const importModule = async () => ({
        default: (sdk: unknown) => {
          seen.push(sdk);
          return { setup: () => undefined };
        },
      });
      const sdk = createPluginSdk();

      await loadLocalPlugin(plugin, { trustedDigest: plugin.digest, importModule, sdk });
      await loadLocalPlugin(plugin, { trustedDigest: plugin.digest, importModule });

      expect(seen[0]).toBe(sdk);
      expect(Object.keys(seen[1] as object).sort()).toEqual(Object.keys(sdk).sort());
    });

    it('runs setup and dispose with the module as this', async () => {
      const { plugin } = await discovered('lifecycle');
      const module = {
        calls: [] as string[],
        setup(this: { calls: string[] }) {
          this.calls.push('setup');
        },
        dispose(this: { calls: string[] }) {
          this.calls.push('dispose');
        },
      };
      const loaded = await loadLocalPlugin(plugin, {
        trustedDigest: plugin.digest,
        importModule: async () => ({ default: () => module }),
      });
      const kernel = createPluginKernel();

      await kernel.register(loaded);
      await kernel.seal();
      await kernel.dispose();

      expect(module.calls).toEqual(['setup', 'dispose']);
    });

    it('returns a plugin without dispose when the module has none', async () => {
      const { plugin } = await discovered('plain');

      const loaded = await loadLocalPlugin(plugin, { trustedDigest: plugin.digest });

      expect(loaded.dispose).toBeUndefined();
    });
  });

  describe('modules are cached by URL', () => {
    const counterSource = (key: string, comment = ''): string =>
      `globalThis[${JSON.stringify(key)}] = (globalThis[${JSON.stringify(key)}] ?? 0) + 1;
${comment}
export default () => ({ setup() {} });
`;

    it('evaluates unchanged content once and changed content again', async () => {
      const key = `__weaveHostTest_${randomUUID().replaceAll('-', '')}`;
      const counters = globalThis as unknown as Record<string, number | undefined>;
      try {
        const root = await makeTempDirectory();
        const first = await discovered('counted', { source: counterSource(key) }, root);

        await loadLocalPlugin(first.plugin, { trustedDigest: first.plugin.digest });
        await loadLocalPlugin(first.plugin, { trustedDigest: first.plugin.digest });
        expect(counters[key]).toBe(1);

        await writeFile(first.plugin.entry, counterSource(key, '// edited'));
        const second = (await discoverLocalPlugins({ directory: root, hostVersion: '1.4.2' }))
          .candidates[0] as ReadyLocalPlugin;
        expect(second.digest).not.toBe(first.plugin.digest);
        await loadLocalPlugin(second, { trustedDigest: second.digest });

        expect(counters[key]).toBe(2);
      } finally {
        delete (globalThis as Record<string, unknown>)[key];
      }
    });
  });

  describe('a plugin that has changed since it was trusted', () => {
    it('is refused before its code is imported', async () => {
      const { plugin } = await discovered('swapped');
      const importModule = vi.fn(async () => ({}));
      await writeFile(plugin.entry, 'throw new Error("evil");');

      const error = await loadFailure(
        loadLocalPlugin(plugin, { trustedDigest: plugin.digest, importModule }),
      );

      expect(error.code).toBe('plugin-digest-mismatch');
      expect(error.pluginId).toBe('swapped');
      expect(error.message).toContain('has changed since it was trusted');
      expect(importModule).not.toHaveBeenCalled();
    });

    it('is refused when the trusted digest is not the one on disk', async () => {
      const { plugin } = await discovered('stale');
      const importModule = vi.fn(async () => ({}));

      const error = await loadFailure(
        loadLocalPlugin(plugin, { trustedDigest: 'f'.repeat(64), importModule }),
      );

      expect(error.code).toBe('plugin-digest-mismatch');
      expect(importModule).not.toHaveBeenCalled();
    });

    it('is refused when a file was added, even one the entry never imports', async () => {
      const { plugin } = await discovered('grown');
      await writeFile(path.join(plugin.directory, 'extra.js'), 'export {};');

      const error = await loadFailure(loadLocalPlugin(plugin, { trustedDigest: plugin.digest }));

      expect(error.code).toBe('plugin-digest-mismatch');
    });

    it('names the plugin when the directory cannot be hashed at all', async () => {
      const { plugin } = await discovered('vanished');
      const gone = { ...plugin, directory: path.join(plugin.directory, 'nowhere') };

      const error = await loadFailure(loadLocalPlugin(gone, { trustedDigest: plugin.digest }));

      expect(error.code).toBe('plugin-unreadable');
      expect(error.pluginId).toBe('vanished');
    });
  });

  describe('a module that cannot be used', () => {
    it.each([
      ['no default export', 'export const answer = 42;'],
      ['a default export that is not a function', 'export default { setup() {} };'],
      ['a default export that is a number', 'export default 42;'],
    ])('is refused for %s', async (_label, source) => {
      const { plugin } = await discovered('shapeless', { source });

      const error = await loadFailure(loadLocalPlugin(plugin, { trustedDigest: plugin.digest }));

      expect(error.code).toBe('plugin-invalid-module');
      expect(error.pluginId).toBe('shapeless');
      expect(error.message).toContain('must export a function as its default');
    });

    it.each([
      ['nothing', 'export default () => undefined;', '(module)'],
      ['null', 'export default () => null;', '(module)'],
      ['a string', 'export default () => "plugin";', '(module)'],
      ['an object without setup', 'export default () => ({});', 'setup'],
      ['a setup that is not a function', 'export default () => ({ setup: 1 });', 'setup'],
      [
        'a dispose that is not a function',
        'export default () => ({ setup() {}, dispose: "later" });',
        'dispose',
      ],
    ])('is refused when the factory returns %s', async (_label, source, field) => {
      const { plugin } = await discovered('misshapen', { source });

      const error = await loadFailure(loadLocalPlugin(plugin, { trustedDigest: plugin.digest }));

      expect(error.code).toBe('plugin-invalid-module');
      expect(error.message).toContain('not a plugin module');
      expect(error.message).toContain(field);
    });

    it('is refused when top-level code throws, keeping what was thrown', async () => {
      const { plugin } = await discovered('explodes', {
        source: 'throw new RangeError("top level");\nexport default () => ({ setup() {} });',
      });

      const error = await loadFailure(loadLocalPlugin(plugin, { trustedDigest: plugin.digest }));

      expect(error.code).toBe('plugin-load-failed');
      expect(error.pluginId).toBe('explodes');
      expect(error.message).toContain('failed while loading');
      expect(error.message).toContain('top level');
      expect(error.cause).toBeInstanceOf(RangeError);
    });

    it('is refused when the source has a syntax error', async () => {
      const { plugin } = await discovered('garbled', { source: 'export default (( => {' });

      const error = await loadFailure(loadLocalPlugin(plugin, { trustedDigest: plugin.digest }));

      expect(error.code).toBe('plugin-load-failed');
      expect(error.cause).toBeInstanceOf(Error);
    });

    it('is refused when the module imports something that does not exist', async () => {
      const { plugin } = await discovered('lost', {
        source: 'import "./missing.js";\nexport default () => ({ setup() {} });',
      });

      const error = await loadFailure(loadLocalPlugin(plugin, { trustedDigest: plugin.digest }));

      expect(error.code).toBe('plugin-load-failed');
    });

    it('is refused when the factory throws, keeping what was thrown', async () => {
      const { plugin } = await discovered('grumpy', {
        source: 'export default () => { throw new TypeError("no sdk for me"); };',
      });

      const error = await loadFailure(loadLocalPlugin(plugin, { trustedDigest: plugin.digest }));

      expect(error.code).toBe('plugin-load-failed');
      expect(error.message).toContain('failed in its factory');
      expect(error.message).toContain('no sdk for me');
      expect(error.cause).toBeInstanceOf(TypeError);
    });

    it('is refused when an asynchronous factory rejects', async () => {
      const { plugin } = await discovered('late-fail', {
        source: 'export default async () => { throw new Error("async trouble"); };',
      });

      const error = await loadFailure(loadLocalPlugin(plugin, { trustedDigest: plugin.digest }));

      expect(error.code).toBe('plugin-load-failed');
      expect(error.message).toContain('async trouble');
    });
  });

  describe('a manifest carried by the module', () => {
    const withManifest = (manifest: Record<string, unknown>): string =>
      `export default () => ({ setup() {}, manifest: ${JSON.stringify(manifest)} });`;

    it("is accepted when it is the descriptor's, field for field", async () => {
      const { plugin } = await discovered('twin', { source: withManifest(manifestFor('twin')) });

      const loaded = await loadLocalPlugin(plugin, { trustedDigest: plugin.digest });

      expect(loaded.manifest).toEqual(manifestFor('twin'));
    });

    it('is refused when a field differs', async () => {
      const { plugin } = await discovered('liar', {
        source: withManifest(manifestFor('liar', { permissions: ['process:spawn'] })),
      });

      const error = await loadFailure(loadLocalPlugin(plugin, { trustedDigest: plugin.digest }));

      expect(error.code).toBe('plugin-manifest-mismatch');
      expect(error.pluginId).toBe('liar');
    });

    it('is refused when it is not even an object', async () => {
      const { plugin } = await discovered('odd', {
        source: 'export default () => ({ setup() {}, manifest: "see descriptor" });',
      });

      const error = await loadFailure(loadLocalPlugin(plugin, { trustedDigest: plugin.digest }));

      expect(error.code).toBe('plugin-manifest-mismatch');
    });

    it('is refused when it cannot be compared because it is circular', async () => {
      const { plugin } = await discovered('knot', {
        source: 'const m = {}; m.self = m;\nexport default () => ({ setup() {}, manifest: m });',
      });

      const error = await loadFailure(loadLocalPlugin(plugin, { trustedDigest: plugin.digest }));

      expect(error.code).toBe('plugin-manifest-mismatch');
    });
  });
});
