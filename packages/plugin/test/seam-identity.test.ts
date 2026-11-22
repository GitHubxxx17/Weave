import { createLlmProviderRegistry, createMockLlmClient } from '@weave/llm';
import { createToolRegistry } from '@weave/runtime';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import type { ExtensionPoint } from '../src/extension-point.js';
import { createPluginKernel } from '../src/kernel.js';
import type { PluginCapability, PluginContributes } from '../src/manifest.js';
import { createPluginEventRegistry } from '../src/plugin-events.js';
import {
  eventsExtensionPoint,
  llmProvidersExtensionPoint,
  promptSectionsExtensionPoint,
  toolsExtensionPoint,
  type PromptSection,
} from '../src/seams.js';

async function contribution<T>(
  capability: PluginCapability,
  contributes: PluginContributes,
  point: ExtensionPoint<T>,
  contribute: (api: T) => void,
) {
  const kernel = createPluginKernel();
  await kernel.register({
    manifest: {
      id: 'notes',
      name: 'Notes',
      version: '1.0.0',
      apiVersion: '1.0.0',
      capabilities: [capability],
      contributes,
    },
    setup(env) {
      env.contribute(point, contribute);
    },
  });
  await kernel.seal();
  return kernel;
}

describe('stable governed seam identities', () => {
  it('rejects provider ids the registry would normalize to a different contribution identity', async () => {
    const kernel = await contribution(
      'llm-provider',
      { providers: [' declared '] },
      llmProvidersExtensionPoint,
      (api) => {
        api.addProvider({
          id: ' declared ',
          label: 'Provider',
          type: 'mock',
          client: createMockLlmClient([]),
        });
      },
    );
    const registry = createLlmProviderRegistry();
    try {
      expect(() =>
        kernel.extensions.collect(llmProvidersExtensionPoint, {
          addProvider: (entry) => registry.register(entry),
        }),
      ).toThrowError(
        expect.objectContaining({ code: 'plugin-invalid-definition', pluginId: 'notes' }),
      );
      expect(registry.list()).toEqual([]);
      expect(kernel.plugins()[0]?.contributed.providers).toEqual([]);
    } finally {
      await kernel.dispose();
    }
  });

  it('uses one event type for namespace checking, declaration and actual registration', async () => {
    let reads = 0;
    const definition = {
      get type() {
        return ++reads <= 2 ? ('notes/report' as const) : ('other/report' as const);
      },
      schema: z.object({ text: z.string() }),
    };
    const kernel = await contribution(
      'event',
      { events: ['notes/report'] },
      eventsExtensionPoint,
      (api) => {
        api.addEvent(definition);
      },
    );
    try {
      const registry = createPluginEventRegistry();
      kernel.extensions.collect(eventsExtensionPoint, {
        addEvent: (entry) => registry.define(entry),
      });
      expect(registry.list().map((info) => info.type)).toEqual(['notes/report']);
      expect(registry.parse({ type: 'notes/report', payload: { text: 'Own report' } })).toEqual({
        type: 'notes/report',
        payload: { text: 'Own report' },
      });
      expect(kernel.plugins()[0]?.contributed.events).toEqual(['notes/report']);
      expect(reads).toBe(1);
    } finally {
      await kernel.dispose();
    }
  });

  it('registers and accounts the same tool despite an author name getter', async () => {
    let reads = 0;
    const tool = {
      get name() {
        return ++reads === 1 ? 'declared' : 'undeclared';
      },
      description: 'A declared tool',
      parameters: { type: 'object' },
      inputSchema: z.object({}),
      execute: () => 'Done',
    };
    const kernel = await contribution(
      'tool',
      { tools: ['declared'] },
      toolsExtensionPoint,
      (api) => {
        api.addTool(tool);
      },
    );
    try {
      const registry = createToolRegistry();
      kernel.extensions.collect(toolsExtensionPoint, {
        addTool: (entry) => registry.register(entry),
      });
      expect(registry.list().map((entry) => entry.name)).toEqual(['declared']);
      expect(registry.get('undeclared')).toBeUndefined();
      expect(kernel.plugins()[0]?.contributed.tools).toEqual(['declared']);
      expect(reads).toBe(1);
      expect(registry.get('declared')).not.toBe(tool);
      expect(Object.isFrozen(registry.get('declared'))).toBe(true);
      expect(Object.isFrozen(tool)).toBe(false);
    } finally {
      await kernel.dispose();
    }
  });

  it('registers and accounts the same provider despite an author id getter', async () => {
    let reads = 0;
    const provider = {
      get id() {
        return ++reads === 1 ? 'declared' : 'undeclared';
      },
      label: 'Declared Provider',
      type: 'mock' as const,
      client: createMockLlmClient([]),
    };
    const kernel = await contribution(
      'llm-provider',
      { providers: ['declared'] },
      llmProvidersExtensionPoint,
      (api) => {
        api.addProvider(provider);
      },
    );
    try {
      const registry = createLlmProviderRegistry();
      kernel.extensions.collect(llmProvidersExtensionPoint, {
        addProvider: (entry) => registry.register(entry),
      });
      expect(registry.list().map((entry) => entry.id)).toEqual(['declared']);
      expect(registry.get('declared')).toBe(provider.client);
      expect(registry.get('undeclared')).toBeUndefined();
      expect(kernel.plugins()[0]?.contributed.providers).toEqual(['declared']);
      expect(reads).toBe(1);
      expect(Object.isFrozen(provider)).toBe(false);
    } finally {
      await kernel.dispose();
    }
  });

  it('gives the prompt owner the id that passed declaration checking', async () => {
    let reads = 0;
    const section = {
      get id() {
        return ++reads === 1 ? 'declared' : 'undeclared';
      },
      order: 1,
      text: 'Use the declared section.',
      pluginId: 'spoofed',
    };
    const kernel = await contribution(
      'prompt',
      { promptSections: ['declared'] },
      promptSectionsExtensionPoint,
      (api) => {
        api.addSection(section);
      },
    );
    try {
      const sections: PromptSection[] = [];
      kernel.extensions.collect(promptSectionsExtensionPoint, {
        addSection(entry) {
          sections.push(entry);
        },
      });
      expect(sections).toEqual([
        { id: 'declared', order: 1, text: 'Use the declared section.', pluginId: 'notes' },
      ]);
      expect(kernel.plugins()[0]?.contributed.promptSections).toEqual(['declared']);
      expect(reads).toBe(1);
      expect(Object.isFrozen(sections[0])).toBe(true);
      expect(Object.isFrozen(section)).toBe(false);
    } finally {
      await kernel.dispose();
    }
  });
});
