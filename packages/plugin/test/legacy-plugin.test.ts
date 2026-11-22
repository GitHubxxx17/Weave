import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createMockLlmClient, type LlmProviderRegistration } from '@weave/llm';
import { type ToolDefinition } from '@weave/runtime';

import {
  adaptLegacyPlugin,
  createPluginKernel,
  llmProvidersExtensionPoint,
  toolsExtensionPoint,
  type PluginManifest,
  type WeavePlugin,
} from '../src/index.js';

const manifest: PluginManifest = {
  id: 'example-tools',
  name: 'Example Tools',
  version: '1.0.0',
  apiVersion: '1.0.0',
  capabilities: ['tool', 'llm-provider'],
};

const echoTool: ToolDefinition<{ text: string }, string> = {
  name: 'echo',
  description: 'Echoes text',
  parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
  inputSchema: z.object({ text: z.string() }),
  execute: ({ text }) => text,
};

const provider: LlmProviderRegistration = {
  id: 'local-model',
  label: 'Local Model',
  type: 'mock',
  client: createMockLlmClient([]),
};

function plugin(over: Partial<WeavePlugin> = {}): WeavePlugin {
  return {
    manifest,
    setup(context) {
      context.registerTool(echoTool);
      context.registerProvider(provider);
    },
    ...over,
  };
}

async function collectNames(
  kernel: ReturnType<typeof createPluginKernel>,
): Promise<{ tools: string[]; providers: string[] }> {
  await kernel.seal();
  const tools: string[] = [];
  const providers: string[] = [];
  kernel.extensions.collect(toolsExtensionPoint, {
    addTool: (tool) => {
      tools.push(tool.name);
    },
  });
  kernel.extensions.collect(llmProvidersExtensionPoint, {
    addProvider: (registration) => {
      providers.push(registration.id);
    },
  });
  return { tools, providers };
}

describe('adaptLegacyPlugin', () => {
  it('contributes the staged tools and providers through the kernel extension points', async () => {
    const adapted = await adaptLegacyPlugin(plugin());
    const kernel = createPluginKernel();

    await kernel.register(adapted.plugin);

    expect(await collectNames(kernel)).toEqual({ tools: ['echo'], providers: ['local-model'] });
  });

  it('returns the snapshot the legacy registry would have returned', async () => {
    const { snapshot } = await adaptLegacyPlugin(plugin());

    expect(snapshot).toEqual({ ...manifest, tools: ['echo'], providers: ['local-model'] });
    expect(Object.isFrozen(snapshot)).toBe(true);
  });

  it('runs the legacy setup once however many kernels register the plugin', async () => {
    const setup = vi.fn((context: Parameters<WeavePlugin['setup']>[0]) => {
      context.registerTool(echoTool);
    });
    const adapted = await adaptLegacyPlugin(plugin({ setup }));

    for (let kernels = 0; kernels < 2; kernels += 1) {
      const kernel = createPluginKernel();
      await kernel.register(adapted.plugin);
      expect((await collectNames(kernel)).tools).toEqual(['echo']);
    }

    expect(setup).toHaveBeenCalledOnce();
  });

  it('disposes the legacy plugin at most once across kernels', async () => {
    const dispose = vi.fn();
    const adapted = await adaptLegacyPlugin(plugin({ dispose }));
    const first = createPluginKernel();
    const second = createPluginKernel();
    await first.register(adapted.plugin);
    await second.register(adapted.plugin);

    await first.dispose();
    await second.dispose();

    expect(dispose).toHaveBeenCalledOnce();
  });

  it('adds nothing to the kernel for a plugin that registered nothing', async () => {
    const adapted = await adaptLegacyPlugin(plugin({ setup: () => undefined }));
    const kernel = createPluginKernel();

    await kernel.register(adapted.plugin);

    expect(await collectNames(kernel)).toEqual({ tools: [], providers: [] });
    expect(adapted.snapshot).toMatchObject({ tools: [], providers: [] });
  });

  it('keeps the legacy registration errors, raised before the kernel is involved', async () => {
    await expect(
      adaptLegacyPlugin({ manifest, setup: 'nope' } as unknown as WeavePlugin),
    ).rejects.toMatchObject({ code: 'plugin-invalid-definition' });
    await expect(
      adaptLegacyPlugin(plugin({ manifest: { ...manifest, id: 'Bad Id' } })),
    ).rejects.toMatchObject({ code: 'plugin-invalid-manifest' });
    await expect(
      adaptLegacyPlugin(plugin({ manifest: { ...manifest, apiVersion: '2.0.0' } })),
    ).rejects.toMatchObject({ code: 'plugin-api-version-unsupported' });
    await expect(
      adaptLegacyPlugin(plugin({ manifest: { ...manifest, engines: { weave: '*' } } })),
    ).rejects.toMatchObject({ code: 'plugin-engine-unsupported' });
    await expect(
      adaptLegacyPlugin(
        plugin({
          manifest: { ...manifest, engines: { weave: '>=2.0.0' } },
        }),
        { hostVersion: '1.0.0' },
      ),
    ).rejects.toMatchObject({ code: 'plugin-engine-unsupported' });
  });

  it('reports setup failures like the legacy registry does', async () => {
    await expect(
      adaptLegacyPlugin(
        plugin({
          setup() {
            throw new Error('boom');
          },
        }),
      ),
    ).rejects.toMatchObject({ code: 'plugin-setup-failed' });
    await expect(
      adaptLegacyPlugin(plugin({ manifest: { ...manifest, capabilities: ['llm-provider'] } })),
    ).rejects.toMatchObject({ code: 'plugin-capability-not-declared' });
    await expect(
      adaptLegacyPlugin(
        plugin({ manifest: { ...manifest, contributes: { tools: ['other'], providers: [] } } }),
      ),
    ).rejects.toMatchObject({ code: 'plugin-contributes-exceeds-manifest' });
  });

  it('lets the host reject a plugin before its setup runs', async () => {
    const setup = vi.fn();

    await expect(
      adaptLegacyPlugin(plugin({ setup }), {
        beforeSetup: (checked) => {
          throw new Error(`taken: ${checked.id}`);
        },
      }),
    ).rejects.toThrowError('taken: example-tools');

    expect(setup).not.toHaveBeenCalled();
  });
});
