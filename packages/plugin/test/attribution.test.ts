import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { type ToolDefinition } from '@weave/runtime';

import { createPluginKernel, definePlugin, type KernelPlugin } from '../src/kernel.js';
import { type PluginManifest } from '../src/manifest.js';
import { attributePluginError, PluginError } from '../src/plugin-errors.js';
import { commandsExtensionPoint, toolsExtensionPoint } from '../src/seams.js';
import { defineServiceRef } from '../src/service.js';

function manifest(id: string, over: Partial<PluginManifest> = {}): PluginManifest {
  return { id, name: id, version: '0.1.0', apiVersion: '1.0.0', capabilities: ['tool'], ...over };
}

function tool(name: string): ToolDefinition<Record<string, never>, string> {
  return {
    name,
    description: name,
    parameters: { type: 'object', properties: {} },
    inputSchema: z.object({}),
    execute: () => 'ok',
  };
}

/** Awaits `action`, which must reject with a {@link PluginError}, and returns that error. */
async function failure(action: () => Promise<unknown>): Promise<PluginError> {
  try {
    await action();
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(PluginError);
    return error as PluginError;
  }
  throw new Error('Expected the action to throw');
}

describe('PluginError', () => {
  it('names no plugin unless it is given one', () => {
    expect(new PluginError('plugin-service-cycle', 'loop').pluginId).toBeUndefined();
    expect(new PluginError('plugin-service-cycle', 'loop', { pluginId: 'a' }).pluginId).toBe('a');
  });
});

describe('attributePluginError', () => {
  it('returns a plugin error that already names a plugin as it is', () => {
    const error = new PluginError('plugin-permission-denied', 'denied', { pluginId: 'a' });

    expect(attributePluginError(error, 'b', 'context')).toBe(error);
  });

  it('copies a plugin error that names nobody and adds the plugin', () => {
    const cause = new Error('inner');
    const error = new PluginError('plugin-invalid-definition', 'bad definition', { cause });

    const attributed = attributePluginError(error, 'b', 'context');

    expect(attributed).not.toBe(error);
    expect(attributed).toBeInstanceOf(PluginError);
    expect(attributed.code).toBe('plugin-invalid-definition');
    expect(attributed.message).toBe('bad definition');
    expect(attributed.cause).toBe(cause);
    expect(attributed.pluginId).toBe('b');
    expect(attributed.stack).toBe(error.stack);
    expect(error.pluginId).toBeUndefined();
  });

  it('copies a plugin error without inventing a cause', () => {
    const attributed = attributePluginError(
      new PluginError('plugin-service-cycle', 'loop'),
      'b',
      'context',
    );

    expect(attributed.cause).toBeUndefined();
    expect('cause' in attributed).toBe(false);
  });

  it('wraps any other error, keeping it as the cause and leading the message with the context', () => {
    const cause = new TypeError('no disk');

    const attributed = attributePluginError(cause, 'b', 'Plugin "b" failed');

    expect(attributed.code).toBe('plugin-contribution-failed');
    expect(attributed.message).toBe('Plugin "b" failed: no disk');
    expect(attributed.cause).toBe(cause);
    expect(attributed.pluginId).toBe('b');
  });

  it('wraps a thrown value that is not an error', () => {
    const attributed = attributePluginError('plain text', 'b', 'context');

    expect(attributed.code).toBe('plugin-contribution-failed');
    expect(attributed.message).toBe('context: plain text');
    expect(attributed.cause).toBe('plain text');
  });
});

describe('registering a plugin', () => {
  it('names the plugin whose setup threw, and keeps what it threw', async () => {
    const boom = new Error('boom');
    const kernel = createPluginKernel();

    const error = await failure(() =>
      kernel.register(
        definePlugin({
          manifest: manifest('flaky'),
          setup() {
            throw boom;
          },
        }),
      ),
    );

    expect(error.code).toBe('plugin-setup-failed');
    expect(error.pluginId).toBe('flaky');
    expect(error.cause).toBe(boom);
  });

  it('names the plugin whose setup raised a plugin error that named nobody, and keeps its code', async () => {
    const kernel = createPluginKernel();

    const error = await failure(() =>
      kernel.register(
        definePlugin({
          manifest: manifest('careless'),
          setup() {
            throw new PluginError('plugin-invalid-definition', 'not a valid definition');
          },
        }),
      ),
    );

    expect(error.code).toBe('plugin-invalid-definition');
    expect(error.message).toBe('not a valid definition');
    expect(error.pluginId).toBe('careless');
  });

  it('names the plugin when the event it defined has a bad name', async () => {
    const kernel = createPluginKernel();

    const error = await failure(() =>
      kernel.register(
        definePlugin({
          manifest: manifest('noisy', { capabilities: ['event'] }),
          setup(env) {
            env.defineEvent('Not Valid', { schema: z.object({ text: z.string() }) });
          },
        }),
      ),
    );

    expect(error.code).toBe('plugin-event-invalid');
    expect(error.pluginId).toBe('noisy');
  });

  it.each([
    ['an unsupported API version', manifest('old', { apiVersion: '0.9.0' }), 'old'],
    [
      'an engine range the host does not satisfy',
      manifest('new', { engines: { weave: '>=9.0.0' } }),
      'new',
    ],
  ])('names the plugin refused for %s', async (_label, refused, id) => {
    const kernel = createPluginKernel({ hostVersion: '1.0.0' });

    const error = await failure(() =>
      kernel.register(definePlugin({ manifest: refused, setup: () => undefined })),
    );

    expect(error.pluginId).toBe(id);
  });

  it('names the plugin whose id is already taken', async () => {
    const kernel = createPluginKernel();
    await kernel.register(definePlugin({ manifest: manifest('twin'), setup: () => undefined }));

    const error = await failure(() =>
      kernel.register(definePlugin({ manifest: manifest('twin'), setup: () => undefined })),
    );

    expect(error.code).toBe('plugin-duplicate-id');
    expect(error.pluginId).toBe('twin');
  });

  it('names no plugin when the manifest is invalid, because its id cannot be trusted', async () => {
    const kernel = createPluginKernel();

    const error = await failure(() =>
      kernel.register(
        definePlugin({ manifest: manifest('Not A Valid Id'), setup: () => undefined }),
      ),
    );

    expect(error.code).toBe('plugin-invalid-manifest');
    expect(error.pluginId).toBeUndefined();
  });

  it('names the plugin that contributed without the capability', async () => {
    const kernel = createPluginKernel();

    const error = await failure(() =>
      kernel.register(
        definePlugin({
          manifest: manifest('quiet', { capabilities: ['tool'] }),
          setup(env) {
            env.contribute(commandsExtensionPoint, () => undefined);
          },
        }),
      ),
    );

    expect(error.code).toBe('plugin-capability-not-declared');
    expect(error.pluginId).toBe('quiet');
  });

  it('names the plugin that used a service its permissions do not grant', async () => {
    const ref = defineServiceRef<number>({ id: 'example.number' });
    const kernel = createPluginKernel();

    const error = await failure(() =>
      kernel.register(
        definePlugin({
          manifest: manifest('nosy', { permissions: [] }),
          setup(env) {
            env.use(ref);
          },
        }),
      ),
    );

    expect(error.code).toBe('plugin-permission-denied');
    expect(error.pluginId).toBe('nosy');
  });
});

describe('sealing the kernel', () => {
  it('names the plugin whose service needs one nobody provides', async () => {
    const missing = defineServiceRef<number>({ id: 'example.missing' });
    const needy = defineServiceRef<number>({ id: 'example.needy' });
    const kernel = createPluginKernel();
    await kernel.register(definePlugin({ manifest: manifest('fine'), setup: () => undefined }));
    await kernel.register(
      definePlugin({
        manifest: manifest('needs-it'),
        setup(env) {
          env.provide(needy, { deps: { missing }, factory: ({ missing: value }) => value });
        },
      }),
    );

    const error = await failure(() => kernel.seal());

    expect(error.code).toBe('plugin-service-missing-dependency');
    expect(error.pluginId).toBe('needs-it');
  });

  it('names the plugin that registered a single-implementation service second', async () => {
    const ref = defineServiceRef<number>({ id: 'example.single' });
    const provides = (id: string): KernelPlugin =>
      definePlugin({
        manifest: manifest(id),
        setup(env) {
          env.provide(ref, { factory: () => 1 });
        },
      });
    const kernel = createPluginKernel();
    await kernel.register(provides('first'));
    await kernel.register(provides('second'));

    const error = await failure(() => kernel.seal());

    expect(error.code).toBe('plugin-service-duplicate');
    expect(error.pluginId).toBe('second');
  });

  it('names the plugin whose service depends on a finer scope', async () => {
    const sessionRef = defineServiceRef<number>({ id: 'example.session', scope: 'session' });
    const rootRef = defineServiceRef<number>({ id: 'example.root' });
    const kernel = createPluginKernel();
    await kernel.register(
      definePlugin({
        manifest: manifest('fine'),
        setup(env) {
          env.provide(sessionRef, { factory: () => 1 });
        },
      }),
    );
    await kernel.register(
      definePlugin({
        manifest: manifest('too-coarse'),
        setup(env) {
          env.provide(rootRef, {
            deps: { session: sessionRef },
            factory: ({ session }) => session,
          });
        },
      }),
    );

    const error = await failure(() => kernel.seal());

    expect(error.code).toBe('plugin-service-scope-violation');
    expect(error.pluginId).toBe('too-coarse');
  });

  it('names no plugin for a cycle, because no single plugin caused it', async () => {
    const aRef = defineServiceRef<number>({ id: 'example.a' });
    const bRef = defineServiceRef<number>({ id: 'example.b' });
    const kernel = createPluginKernel();
    await kernel.register(
      definePlugin({
        manifest: manifest('pa'),
        setup(env) {
          env.provide(aRef, { deps: { b: bRef }, factory: ({ b }) => b });
        },
      }),
    );
    await kernel.register(
      definePlugin({
        manifest: manifest('pb'),
        setup(env) {
          env.provide(bRef, { deps: { a: aRef }, factory: ({ a }) => a });
        },
      }),
    );

    const error = await failure(() => kernel.seal());

    expect(error.code).toBe('plugin-service-cycle');
    expect(error.pluginId).toBeUndefined();
  });
});

describe('resolving a service', () => {
  it('names the plugin whose factory threw, and keeps what it threw', async () => {
    const ref = defineServiceRef<number>({ id: 'example.broken' });
    const noDisk = new Error('no disk');
    const kernel = createPluginKernel();
    await kernel.register(
      definePlugin({
        manifest: manifest('maker'),
        setup(env) {
          env.provide(ref, {
            factory: () => {
              throw noDisk;
            },
          });
        },
      }),
    );
    const generation = await kernel.seal();

    const error = await failure(() => generation.resolve(ref));

    expect(error.code).toBe('plugin-contribution-failed');
    expect(error.pluginId).toBe('maker');
    expect(error.message).toBe(
      'Service "example.broken" from plugin "maker" failed to initialise: no disk',
    );
    expect(error.cause).toBe(noDisk);
  });

  it('names the plugin behind a dependency that failed, not the one that asked', async () => {
    const base = defineServiceRef<number>({ id: 'example.base' });
    const top = defineServiceRef<number>({ id: 'example.top' });
    const kernel = createPluginKernel();
    await kernel.register(
      definePlugin({
        manifest: manifest('base-maker'),
        setup(env) {
          env.provide(base, {
            factory: () => {
              throw new Error('base failed');
            },
          });
        },
      }),
    );
    await kernel.register(
      definePlugin({
        manifest: manifest('top-maker'),
        setup(env) {
          env.provide(top, { deps: { base }, factory: ({ base: value }) => value });
        },
      }),
    );
    const generation = await kernel.seal();

    const error = await failure(() => generation.resolve(top));

    expect(error.pluginId).toBe('base-maker');
  });
});

describe('collecting contributions', () => {
  const namesRef = defineServiceRef<string[]>({ id: 'example.tool-names' });

  /** Owns `weave.tools`: a service that collects through `add`, which may refuse a tool. */
  function owner(add: (name: string) => void): KernelPlugin {
    return definePlugin({
      manifest: manifest('owner'),
      setup(env) {
        env.provide(namesRef, {
          factory: (_deps, context) => {
            const names: string[] = [];
            context.collect(toolsExtensionPoint, {
              addTool: (definition) => {
                add(definition.name);
                names.push(definition.name);
              },
            });
            return names;
          },
        });
      },
    });
  }

  function adds(id: string, names: readonly string[], over: Partial<PluginManifest> = {}) {
    return definePlugin({
      manifest: manifest(id, over),
      setup(env) {
        env.contribute(toolsExtensionPoint, (api) => {
          for (const name of names) {
            api.addTool(tool(name));
          }
        });
      },
    });
  }

  async function resolveNames(plugins: readonly KernelPlugin[]): Promise<PluginError> {
    const kernel = createPluginKernel();
    for (const plugin of plugins) {
      await kernel.register(plugin);
    }
    const generation = await kernel.seal();
    return failure(() => generation.resolve(namesRef));
  }

  it('names the plugin that added a name its manifest does not list', async () => {
    const error = await resolveNames([
      owner(() => undefined),
      adds('greedy', ['listed', 'sneaky'], { contributes: { tools: ['listed'] } }),
    ]);

    expect(error.code).toBe('plugin-contributes-exceeds-manifest');
    expect(error.pluginId).toBe('greedy');
  });

  it("names the plugin whose tool the owner refused, and keeps the owner's code", async () => {
    const taken = new Set<string>();
    const error = await resolveNames([
      owner((name) => {
        if (taken.has(name)) {
          throw new PluginError('plugin-registration-conflict', `Tool "${name}" is already taken`);
        }
        taken.add(name);
      }),
      adds('first', ['shared']),
      adds('second', ['shared']),
    ]);

    expect(error.code).toBe('plugin-registration-conflict');
    expect(error.message).toBe('Tool "shared" is already taken');
    expect(error.pluginId).toBe('second');
  });

  it('names the plugin whose tool made the owner throw an error of its own', async () => {
    const registryFull = new Error('registry is full');
    const error = await resolveNames([
      owner(() => {
        throw registryFull;
      }),
      adds('adder', ['one']),
    ]);

    expect(error.code).toBe('plugin-contribution-failed');
    expect(error.pluginId).toBe('adder');
    expect(error.message).toBe(
      'Plugin "adder" failed while contributing to "weave.tools": registry is full',
    );
    expect(error.cause).toBe(registryFull);
  });

  it('names the plugin whose own contribution threw', async () => {
    const bug = new RangeError('off by one');
    const error = await resolveNames([
      owner(() => undefined),
      definePlugin({
        manifest: manifest('buggy'),
        setup(env) {
          env.contribute(toolsExtensionPoint, () => {
            throw bug;
          });
        },
      }),
    ]);

    expect(error.code).toBe('plugin-contribution-failed');
    expect(error.pluginId).toBe('buggy');
    expect(error.cause).toBe(bug);
  });

  it('keeps the plugin that added the tool, not the owner, as the one to blame', async () => {
    const error = await resolveNames([
      owner(() => {
        throw new Error('nope');
      }),
      adds('adder', ['one']),
    ]);

    expect(error.pluginId).not.toBe('owner');
  });

  it('collects what the plugins before the failing one added', async () => {
    const kernel = createPluginKernel();
    const added: string[] = [];
    await kernel.register(adds('good', ['one']));
    await kernel.register(
      definePlugin({
        manifest: manifest('bad'),
        setup(env) {
          env.contribute(toolsExtensionPoint, () => {
            throw new Error('boom');
          });
        },
      }),
    );
    await kernel.register(adds('later', ['two']));
    await kernel.seal();

    expect(() =>
      kernel.extensions.collect(toolsExtensionPoint, { addTool: (t) => added.push(t.name) }),
    ).toThrowError(expect.objectContaining({ pluginId: 'bad' }));
    expect(added).toEqual(['one']);
  });
});

describe('disposing the kernel', () => {
  it('names the plugin whose dispose threw', async () => {
    const boom = new Error('boom');
    const kernel = createPluginKernel();
    await kernel.register(
      definePlugin({
        manifest: manifest('leaky'),
        setup: () => undefined,
        dispose() {
          throw boom;
        },
      }),
    );
    await kernel.seal();

    const error = await failure(() => kernel.dispose());

    expect(error.code).toBe('plugin-dispose-failed');
    expect(error.pluginId).toBe('leaky');
    expect(error.cause).toBe(boom);
  });
});
