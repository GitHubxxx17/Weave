import { createLlmProviderRegistry } from '@weave/llm';
import { createApprovalBroker, createToolPipeline, createToolRegistry } from '@weave/runtime';
import { describe, expect, it } from 'vitest';

import { createPluginKernel, definePlugin } from '../src/kernel.js';
import { type PluginManifest } from '../src/manifest.js';
import {
  approvalBrokerRef,
  llmProviderRegistryRef,
  llmRequestHook,
  promptSectionsExtensionPoint,
  sessionStoreRef,
  toolAroundHook,
  toolPipelineRef,
  toolPolicyHook,
  toolRegistryRef,
  toolResultHook,
  toolsExtensionPoint,
  turnEndHook,
  turnStartHook,
  type PromptSection,
} from '../src/seams.js';

function manifest(id: string): PluginManifest {
  return { id, name: id, version: '0.1.0', apiVersion: '1.0.0', capabilities: ['tool'] };
}

/**
 * A plugin that provides the core service seams from the real libraries the
 * plugin layer may depend on (llm + runtime). The session store is provided by
 * a builtin plugin in `@weave/session` in a later stage; this test stays within
 * the plugin layer's allowed dependencies.
 */
const coreServicesPlugin = definePlugin({
  manifest: manifest('core-services'),
  setup(env) {
    env.provide(approvalBrokerRef, { factory: () => createApprovalBroker() });
    env.provide(llmProviderRegistryRef, { factory: () => createLlmProviderRegistry() });
    env.provide(toolRegistryRef, { factory: () => createToolRegistry() });
    env.provide(toolPipelineRef, {
      deps: { registry: toolRegistryRef, approvalBroker: approvalBrokerRef },
      factory: ({ registry, approvalBroker }) =>
        createToolPipeline({ registry, approvalBroker, timeoutMs: 1000 }),
    });
  },
});

describe('seams', () => {
  it('declares stable ids, scopes and hook modes', () => {
    expect(toolRegistryRef.id).toBe('weave.tools.registry');
    expect(toolRegistryRef.scope).toBe('root');
    expect(toolPipelineRef.scope).toBe('root');
    expect(sessionStoreRef.id).toBe('weave.session.store');
    expect(toolPolicyHook.mode).toBe('decide');
    expect(toolAroundHook.mode).toBe('wrap');
    expect(llmRequestHook.mode).toBe('wrap');
    expect(toolResultHook.mode).toBe('observe');
    expect(turnStartHook.mode).toBe('observe');
    expect(turnEndHook.mode).toBe('observe');
    expect(toolsExtensionPoint.id).toBe('weave.tools');
  });

  it('assembles a kernel from the real service implementations', async () => {
    const kernel = createPluginKernel();
    await kernel.register(coreServicesPlugin);
    const generation = await kernel.seal();

    const providerRegistry = await generation.resolve(llmProviderRegistryRef);
    const toolRegistry = await generation.resolve(toolRegistryRef);
    const pipeline = await generation.resolve(toolPipelineRef);
    const approvalBroker = await generation.resolve(approvalBrokerRef);

    expect(typeof providerRegistry.getDescriptor).toBe('function');
    expect(typeof toolRegistry.list).toBe('function');
    expect(typeof pipeline.execute).toBe('function');
    expect(approvalBroker).toBeDefined();

    await kernel.dispose();
  });

  it('shares one tool registry instance between a direct resolve and the pipeline dep', async () => {
    const kernel = createPluginKernel();
    await kernel.register(coreServicesPlugin);
    const generation = await kernel.seal();
    const first = await generation.resolve(toolRegistryRef);
    const second = await generation.resolve(toolRegistryRef);
    expect(first).toBe(second);
    await kernel.dispose();
  });
});

describe('weave.prompt.sections', () => {
  const sectionPlugin = (id: string, sections: readonly PromptSection[]) =>
    definePlugin({
      manifest: { id, name: id, version: '0.1.0', apiVersion: '1.0.0', capabilities: ['prompt'] },
      setup(env) {
        env.contribute(promptSectionsExtensionPoint, (api) => {
          for (const section of sections) {
            api.addSection(section);
          }
        });
      },
    });

  async function collect(...plugins: ReturnType<typeof sectionPlugin>[]) {
    const kernel = createPluginKernel();
    for (const plugin of plugins) {
      await kernel.register(plugin);
    }
    await kernel.seal();
    const sections: PromptSection[] = [];
    kernel.extensions.collect(promptSectionsExtensionPoint, {
      addSection: (section) => {
        sections.push(section);
      },
    });
    return sections;
  }

  it('hands the owner each section with the plugin that contributed it', async () => {
    const sections = await collect(
      sectionPlugin('style-kit', [{ id: 'tone', order: 10, text: 'Be brief.' }]),
      sectionPlugin('safety-kit', [{ id: 'care', order: 20, text: 'Ask first.' }]),
    );

    expect(sections).toEqual([
      { id: 'tone', order: 10, text: 'Be brief.', pluginId: 'style-kit' },
      { id: 'care', order: 20, text: 'Ask first.', pluginId: 'safety-kit' },
    ]);
  });

  it('replaces a plugin id the contributor wrote, so a plugin cannot sign as another', async () => {
    const sections = await collect(
      sectionPlugin('style-kit', [
        { id: 'tone', order: 10, text: 'Be brief.', pluginId: 'safety-kit' },
      ]),
    );

    expect(sections[0]?.pluginId).toBe('style-kit');
  });

  it('hands the owner a copy, so changing the original afterwards changes nothing', async () => {
    const original = { id: 'tone', order: 10, text: 'Be brief.' };
    const sections = await collect(sectionPlugin('style-kit', [original]));

    (original as { text: string }).text = 'Changed after the fact.';

    expect(sections[0]?.text).toBe('Be brief.');
    expect(Object.isFrozen(sections[0])).toBe(true);
  });
});
