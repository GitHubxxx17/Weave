import { createLlmProviderRegistry } from '@weave/llm';
import { createApprovalBroker, createToolPipeline, createToolRegistry } from '@weave/runtime';
import { describe, expect, it } from 'vitest';

import { createPluginKernel, definePlugin } from '../src/kernel.js';
import { type PluginManifest } from '../src/manifest.js';
import {
  approvalBrokerRef,
  llmProviderRegistryRef,
  sessionStoreRef,
  toolPipelineRef,
  toolPolicyHook,
  toolRegistryRef,
  toolResultHook,
  toolsExtensionPoint,
  turnStartHook,
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
    expect(toolResultHook.mode).toBe('observe');
    expect(turnStartHook.mode).toBe('observe');
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
