import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createMockLlmClient } from '@weave/llm';
import { PluginError, type PluginManifest } from '../src/index.js';
import { createPluginContext, type StagedPluginContext } from '../src/plugin-types.js';

const echoTool = {
  name: 'echo',
  description: 'Echoes text',
  parameters: {
    type: 'object',
    properties: { text: { type: 'string' } },
    required: ['text'],
  },
  inputSchema: z.object({ text: z.string() }),
  execute: vi.fn(({ text }: { text: string }) => text),
};

const validManifest: PluginManifest = {
  id: 'example-tools',
  name: 'Example Tools',
  version: '1.0.0',
  apiVersion: '1.0.0',
  capabilities: ['tool', 'llm-provider'],
};

function createContext(capabilities: PluginManifest['capabilities']): StagedPluginContext {
  return createPluginContext({
    ...validManifest,
    capabilities,
  });
}

describe('Plugin Context', () => {
  it('stages a declared Tool without executing it', () => {
    const context = createContext(['tool']);

    context.registerTool(echoTool);

    expect(context.getTools()).toEqual([echoTool]);
    expect(echoTool.execute).not.toHaveBeenCalled();
  });

  it('rejects a Tool when the plugin did not declare tool capability', () => {
    const context = createContext(['llm-provider']);

    expect(() => context.registerTool(echoTool)).toThrowError(
      expect.objectContaining({ code: 'plugin-capability-not-declared' }),
    );
  });

  it('rejects malformed Tool definitions before setup completes', () => {
    const context = createContext(['tool']);

    expect(() => context.registerTool({ ...echoTool, name: '' })).toThrowError(
      expect.objectContaining({ code: 'plugin-invalid-definition' }),
    );
  });

  it('stages a declared Provider without invoking its client', () => {
    const stream = vi.fn();
    const client = {
      stream,
    };
    const context = createContext(['llm-provider']);

    context.registerProvider({
      id: 'local-model',
      label: 'Local Model',
      type: 'mock',
      client,
      defaultModel: 'local',
    });

    expect(context.getProviders()).toHaveLength(1);
    expect(context.getProviders()[0]?.client).toBe(client);
    expect(stream).not.toHaveBeenCalled();
  });

  it('rejects a Provider when the plugin did not declare llm-provider', () => {
    const context = createContext(['tool']);

    expect(() =>
      context.registerProvider({
        id: 'local-model',
        label: 'Local Model',
        type: 'mock',
        client: createMockLlmClient([]),
      }),
    ).toThrowError(expect.objectContaining({ code: 'plugin-capability-not-declared' }));
  });

  it('rejects duplicate Tool and Provider names within one plugin', () => {
    const context = createContext(['tool', 'llm-provider']);

    context.registerTool(echoTool);
    expect(() => context.registerTool(echoTool)).toThrowError(PluginError);

    const provider = {
      id: 'local-model',
      label: 'Local Model',
      type: 'mock' as const,
      client: createMockLlmClient([]),
    };
    context.registerProvider(provider);
    expect(() => context.registerProvider(provider)).toThrowError(PluginError);
  });

  it('returns immutable registration snapshots', () => {
    const context = createContext(['tool']);
    context.registerTool(echoTool);

    const tools = context.getTools();

    expect(Object.isFrozen(tools)).toBe(true);
    expect(() => (tools as unknown[]).push(echoTool)).toThrow();
  });
});
