import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createMockLlmClient } from '@weave/llm';
import { type ToolDefinition } from '@weave/runtime';

import { type ExtensionPoint } from '../src/extension-point.js';
import { createPluginKernel, definePlugin } from '../src/kernel.js';
import { type PluginCapability, type PluginManifest } from '../src/manifest.js';
import { type PluginEnv } from '../src/plugin-env.js';
import { PluginError } from '../src/plugin-errors.js';
import {
  llmProvidersExtensionPoint,
  promptSectionsExtensionPoint,
  toolsExtensionPoint,
} from '../src/seams.js';
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

describe('engines', () => {
  const engineBound = (range: string) =>
    definePlugin({
      manifest: manifest('bound', { engines: { weave: range } }),
      setup: () => undefined,
    });

  it('registers a plugin whose range the host version satisfies', async () => {
    const kernel = createPluginKernel({ hostVersion: '1.4.2' });

    await kernel.register(engineBound('>=1.2.0 <2.0.0'));

    expect((await kernel.seal()).pluginIds).toEqual(['bound']);
  });

  it('rejects a plugin whose range the host version does not satisfy', async () => {
    const kernel = createPluginKernel({ hostVersion: '1.4.2' });

    await expect(kernel.register(engineBound('>=2.0.0'))).rejects.toMatchObject({
      code: 'plugin-engine-unsupported',
      message: expect.stringContaining('requires Weave ">=2.0.0", host is "1.4.2"'),
    });
    expect((await kernel.seal()).pluginIds).toEqual([]);
  });

  it('rejects a plugin that declares engines when the host declared no version', async () => {
    const kernel = createPluginKernel();

    await expect(kernel.register(engineBound('*'))).rejects.toMatchObject({
      code: 'plugin-engine-unsupported',
      message: expect.stringContaining('did not declare its Weave version'),
    });
  });

  it('does not require a host version for plugins without engines', async () => {
    const kernel = createPluginKernel();

    await kernel.register(definePlugin({ manifest: manifest('plain'), setup: () => undefined }));

    expect((await kernel.seal()).pluginIds).toEqual(['plain']);
  });

  it('rejects a host version that is not a full x.y.z', () => {
    expect(() => createPluginKernel({ hostVersion: '1.4' })).toThrowError(TypeError);
  });
});

describe('contributes.services', () => {
  const ref = defineServiceRef<number>({ id: 'example.answer' });

  it('provides a service the manifest lists', async () => {
    const kernel = createPluginKernel();
    await kernel.register(
      definePlugin({
        manifest: manifest('owner', { contributes: { services: ['example.answer'] } }),
        setup(env) {
          env.provide(ref, { factory: () => 42 });
        },
      }),
    );

    expect(await (await kernel.seal()).resolve(ref)).toBe(42);
  });

  it('rejects a service the manifest does not list and registers nothing', async () => {
    const kernel = createPluginKernel();

    await expect(
      kernel.register(
        definePlugin({
          manifest: manifest('owner', { contributes: { tools: ['x'] } }),
          setup(env) {
            env.provide(ref, { factory: () => 42 });
          },
        }),
      ),
    ).rejects.toMatchObject({ code: 'plugin-contributes-exceeds-manifest' });

    await expect((await kernel.seal()).resolve(ref)).rejects.toBeInstanceOf(PluginError);
  });
});

describe('permissions', () => {
  const dataRef = defineServiceRef<string>({ id: 'example.data' });
  const otherRef = defineServiceRef<string>({ id: 'example.other' });

  async function withProvider(): Promise<ReturnType<typeof createPluginKernel>> {
    const kernel = createPluginKernel();
    await kernel.register(
      definePlugin({
        manifest: manifest('data'),
        setup(env) {
          env.provide(dataRef, { factory: () => 'data' });
          env.provide(otherRef, { factory: () => 'other' });
        },
      }),
    );
    return kernel;
  }

  it('lets a plugin use a service its permissions grant', async () => {
    const kernel = await withProvider();

    await kernel.register(
      definePlugin({
        manifest: manifest('reader', { permissions: ['service:example.data'] }),
        setup(env) {
          env.use(dataRef);
        },
      }),
    );

    expect((await kernel.seal()).pluginIds).toContain('reader');
  });

  it('denies a service its permissions do not grant and rolls the plugin back', async () => {
    const kernel = await withProvider();
    const reader = (permissions: PluginManifest['permissions']) =>
      definePlugin({
        manifest: manifest('reader', { permissions }),
        setup(env) {
          env.use(otherRef);
        },
      });

    await expect(kernel.register(reader(['service:example.data']))).rejects.toMatchObject({
      code: 'plugin-permission-denied',
      message: expect.stringContaining('"service:example.other"'),
    });

    // The failed plugin left nothing behind, so its id is free again.
    await kernel.register(reader(['service:example.other']));
    expect((await kernel.seal()).pluginIds).toContain('reader');
  });

  it('denies a dependency declared on a provided service', async () => {
    const kernel = await withProvider();
    const derivedRef = defineServiceRef<string>({ id: 'example.derived' });

    await expect(
      kernel.register(
        definePlugin({
          manifest: manifest('derive', {
            contributes: { services: ['example.derived'] },
            permissions: ['service:example.data'],
          }),
          setup(env) {
            env.provide(derivedRef, {
              deps: { other: otherRef },
              factory: ({ other }) => other,
            });
          },
        }),
      ),
    ).rejects.toMatchObject({ code: 'plugin-permission-denied' });
  });

  it('exempts services the plugin provides itself, whatever the order', async () => {
    const kernel = createPluginKernel();
    const baseRef = defineServiceRef<number>({ id: 'example.base' });
    const topRef = defineServiceRef<number>({ id: 'example.top' });

    await kernel.register(
      definePlugin({
        manifest: manifest('layers', { permissions: [] }),
        setup(env) {
          // The dependent is provided before the service it depends on.
          env.provide(topRef, { deps: { base: baseRef }, factory: ({ base }) => base + 1 });
          env.provide(baseRef, { factory: () => 1 });
        },
      }),
    );

    expect(await (await kernel.seal()).resolve(topRef)).toBe(2);
  });

  it('does not restrict a plugin that declared no permissions', async () => {
    const kernel = await withProvider();

    await kernel.register(
      definePlugin({
        manifest: manifest('free'),
        setup(env) {
          env.use(dataRef);
          env.use(otherRef);
        },
      }),
    );

    expect((await kernel.seal()).pluginIds).toContain('free');
  });

  it('does not treat non-service permissions as granting a service', async () => {
    const kernel = await withProvider();

    await expect(
      kernel.register(
        definePlugin({
          manifest: manifest('reader', { permissions: ['workspace:read', 'process:spawn'] }),
          setup(env) {
            env.use(dataRef);
          },
        }),
      ),
    ).rejects.toMatchObject({ code: 'plugin-permission-denied' });
  });

  it('checks a use that happens after setup immediately', async () => {
    const kernel = await withProvider();
    const retained: PluginEnv[] = [];
    await kernel.register(
      definePlugin({
        manifest: manifest('late', { permissions: ['service:example.data'] }),
        setup(env) {
          retained.push(env);
        },
      }),
    );

    expect(() => retained[0]?.use(dataRef)).not.toThrow();
    expect(() => retained[0]?.use(otherRef)).toThrowError(
      expect.objectContaining({ code: 'plugin-permission-denied' }),
    );
  });
});

describe('governed seams', () => {
  function contributesTo<T>(id: string, capability: PluginCapability, point: ExtensionPoint<T>) {
    return definePlugin({
      manifest: manifest(id, { capabilities: [capability] }),
      setup(env) {
        env.contribute(point, () => undefined);
      },
    });
  }

  it('requires the capability behind each seam when a plugin contributes', async () => {
    const kernel = createPluginKernel();

    await expect(
      kernel.register(contributesTo('a', 'prompt', toolsExtensionPoint)),
    ).rejects.toMatchObject({ code: 'plugin-capability-not-declared' });
    await expect(
      kernel.register(contributesTo('b', 'tool', promptSectionsExtensionPoint)),
    ).rejects.toMatchObject({ code: 'plugin-capability-not-declared' });
    await expect(
      kernel.register(contributesTo('c', 'tool', llmProvidersExtensionPoint)),
    ).rejects.toMatchObject({ code: 'plugin-capability-not-declared' });
    await kernel.register(contributesTo('d', 'tool', toolsExtensionPoint));
    await kernel.register(contributesTo('e', 'prompt', promptSectionsExtensionPoint));
    await kernel.register(contributesTo('f', 'llm-provider', llmProvidersExtensionPoint));

    expect((await kernel.seal()).pluginIds).toEqual(['d', 'e', 'f']);
  });

  it('limits a plugin to the tools its manifest lists', async () => {
    const kernel = createPluginKernel();
    await kernel.register(
      definePlugin({
        manifest: manifest('tools', { contributes: { tools: ['listed'] } }),
        setup(env) {
          env.contribute(toolsExtensionPoint, (api) => {
            api.addTool(tool('listed'));
            api.addTool(tool('sneaky'));
          });
        },
      }),
    );
    await kernel.seal();
    const added: string[] = [];

    expect(() =>
      kernel.extensions.collect(toolsExtensionPoint, {
        addTool: (definition) => added.push(definition.name),
      }),
    ).toThrowError(expect.objectContaining({ code: 'plugin-contributes-exceeds-manifest' }));
    expect(added).toEqual(['listed']);
  });

  it('limits a plugin to the providers its manifest lists', async () => {
    const kernel = createPluginKernel();
    const provider = (id: string) => ({
      id,
      label: id,
      type: 'mock' as const,
      client: createMockLlmClient([]),
    });
    await kernel.register(
      definePlugin({
        manifest: manifest('providers', {
          capabilities: ['llm-provider'],
          contributes: { providers: ['listed'] },
        }),
        setup(env) {
          env.contribute(llmProvidersExtensionPoint, (api) => {
            api.addProvider(provider('listed'));
            api.addProvider(provider('sneaky'));
          });
        },
      }),
    );
    await kernel.seal();
    const added: string[] = [];

    expect(() =>
      kernel.extensions.collect(llmProvidersExtensionPoint, {
        addProvider: (registration) => added.push(registration.id),
      }),
    ).toThrowError(expect.objectContaining({ code: 'plugin-contributes-exceeds-manifest' }));
    expect(added).toEqual(['listed']);
  });

  it('limits a plugin to the prompt sections its manifest lists', async () => {
    const kernel = createPluginKernel();
    await kernel.register(
      definePlugin({
        manifest: manifest('prompts', {
          capabilities: ['prompt'],
          contributes: { promptSections: ['listed'] },
        }),
        setup(env) {
          env.contribute(promptSectionsExtensionPoint, (api) => {
            api.addSection({ id: 'listed', order: 1, text: 'one' });
            api.addSection({ id: 'sneaky', order: 2, text: 'two' });
          });
        },
      }),
    );
    await kernel.seal();
    const added: string[] = [];

    expect(() =>
      kernel.extensions.collect(promptSectionsExtensionPoint, {
        addSection: (section) => added.push(section.id),
      }),
    ).toThrowError(expect.objectContaining({ code: 'plugin-contributes-exceeds-manifest' }));
    expect(added).toEqual(['listed']);
  });

  it('collects everything from a plugin that declared no contributes', async () => {
    const kernel = createPluginKernel();
    await kernel.register(
      definePlugin({
        manifest: manifest('open'),
        setup(env) {
          env.contribute(toolsExtensionPoint, (api) => {
            api.addTool(tool('one'));
            api.addTool(tool('two'));
          });
        },
      }),
    );
    await kernel.seal();
    const added: string[] = [];

    kernel.extensions.collect(toolsExtensionPoint, {
      addTool: (definition) => added.push(definition.name),
    });

    expect(added).toEqual(['one', 'two']);
  });
});
