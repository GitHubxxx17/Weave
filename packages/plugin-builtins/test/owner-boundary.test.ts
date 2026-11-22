import { createLlmProviderRegistry, createMockLlmClient } from '@weave/llm';
import {
  createPluginEventRegistry,
  createPluginKernel,
  definePlugin,
  defineServiceRef,
  llmProviderRegistryRef,
  llmProvidersExtensionPoint,
  pluginEventsRef,
  sessionStoreRef,
  toolRegistryRef,
  toolsExtensionPoint,
  type PluginEventRegistry,
  type PluginManifest,
} from '@weave/plugin';
import {
  createToolRegistry,
  createUpdatePlanTool,
  updatePlanToolName,
  type SessionEventStore,
} from '@weave/runtime';
import { createInMemorySessionEventStore } from '@weave/session';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  createEventRegistryPlugin,
  createProviderRegistryPlugin,
  createToolRegistryPlugin,
  hostServicesPlugin,
} from '../src/index.js';

function manifest(id: string, overrides: Partial<PluginManifest> = {}): PluginManifest {
  return {
    id,
    name: id,
    version: '1.0.0',
    apiVersion: '1.0.0',
    capabilities: ['event'],
    ...overrides,
  };
}

type EventReader = Pick<PluginEventRegistry, 'get' | 'list' | 'parse' | 'project'>;

describe('builtin service consumer ownership', () => {
  it('rejects a session store without its associated event registry', () => {
    const sessionStore = createInMemorySessionEventStore();

    expect(() => hostServicesPlugin({ sessionStore })).toThrow(/event registry/i);
  });

  it.each(['direct', 'dependency'] as const)(
    'binds Session writes to the actual %s consumer and retains host lifetime',
    async (path) => {
      const sessionStore = createInMemorySessionEventStore();
      const pluginEvents = createPluginEventRegistry();
      const options = { sessionStore, pluginEvents };
      const kernel = createPluginKernel();
      const stores = new Map<string, () => Promise<SessionEventStore>>();
      await kernel.register(createEventRegistryPlugin({ registry: pluginEvents }));
      await kernel.register(hostServicesPlugin(options));
      for (const id of ['notes', 'journal']) {
        const ownStoreRef = defineServiceRef<SessionEventStore>({ id: `${id}.store` });
        await kernel.register(
          definePlugin({
            manifest: manifest(id, {
              contributes: {
                events: [`${id}/recorded`],
                services: path === 'dependency' ? [ownStoreRef.id] : [],
              },
              permissions: [`service:${sessionStoreRef.id}`],
            }),
            setup(env) {
              env.defineEvent('recorded', { schema: z.object({ text: z.string() }) });
              if (path === 'direct') {
                const store = env.use(sessionStoreRef);
                stores.set(id, () => store.get());
              } else {
                env.provide(ownStoreRef, {
                  deps: { store: sessionStoreRef },
                  factory: ({ store }) => store,
                });
              }
            },
          }),
        );
        if (path === 'dependency') {
          stores.set(id, async () => (await kernel.seal()).resolve(ownStoreRef));
        }
      }
      const generation = await kernel.seal();
      try {
        await generation.resolve(pluginEventsRef);
        expect(await generation.resolve(sessionStoreRef)).toBe(sessionStore);
        const notes = await stores.get('notes')!();
        const journal = await stores.get('journal')!();
        await notes.append('session', [
          { type: 'notes/recorded', payload: { text: 'one', extra: true } },
        ]);
        await journal.append('session', [{ type: 'journal/recorded', payload: { text: 'two' } }]);
        const accepted = await sessionStore.read('session');
        await expect(
          notes.append('session', [
            { type: 'notes/recorded', payload: { text: 'batch should not append' } },
            { type: 'journal/recorded', payload: { text: 'forged' } },
          ]),
        ).rejects.toMatchObject({ code: 'plugin-event-invalid' });
        await expect(
          journal.append('session', [{ type: 'notes/recorded', payload: { text: 'forged' } }]),
        ).rejects.toMatchObject({ code: 'plugin-event-invalid' });
        await expect(
          notes.append('session', [{ type: 'session.created', payload: {} }]),
        ).rejects.toThrow();
        await expect(
          notes.append('session', [{ type: 'notes/unknown', payload: {} }]),
        ).rejects.toMatchObject({ code: 'plugin-event-unknown' });
        expect(notes).not.toBe(sessionStore);
        expect(journal).not.toBe(notes);
        expect(accepted.map(({ type, payload }) => ({ type, payload }))).toEqual([
          { type: 'notes/recorded', payload: { text: 'one' } },
          { type: 'journal/recorded', payload: { text: 'two' } },
        ]);
        expect(await journal.read('session')).toEqual(accepted);
        await notes.close();
        await kernel.dispose();
        expect(await sessionStore.read('session')).toEqual(accepted);
        await sessionStore.append('session', [{ type: 'session.created', payload: {} }]);
        expect(await sessionStore.read('session')).toHaveLength(3);
      } finally {
        await kernel.dispose();
        await sessionStore.close();
      }
    },
  );

  it.each(['direct', 'dependency'] as const)(
    'supplies a frozen event reader without definition implementations to %s consumers',
    async (path) => {
      const registry = createPluginEventRegistry();
      const kernel = createPluginKernel();
      const readerRef = defineServiceRef<EventReader>({ id: 'notes.reader' });
      let getReader: (() => Promise<EventReader>) | undefined;
      await kernel.register(createEventRegistryPlugin({ registry }));
      await kernel.register(
        definePlugin({
          manifest: manifest('notes', {
            contributes: {
              events: ['notes/recorded'],
              services: path === 'dependency' ? [readerRef.id] : [],
            },
            permissions: [`service:${pluginEventsRef.id}`],
          }),
          setup(env) {
            env.defineEvent('recorded', { schema: z.object({ text: z.string() }) });
            if (path === 'direct') {
              const reader = env.use(pluginEventsRef);
              getReader = () => reader.get();
            } else {
              env.provide(readerRef, {
                deps: { reader: pluginEventsRef },
                factory: ({ reader }) => reader,
              });
            }
          },
        }),
      );
      const generation = await kernel.seal();
      try {
        expect(await generation.resolve(pluginEventsRef)).toBe(registry);
        const reader = path === 'direct' ? await getReader!() : await generation.resolve(readerRef);
        expect(Reflect.get(reader, 'define')).toBeUndefined();
        expect(Object.isFrozen(reader)).toBe(true);
        const metadata = reader.get('notes/recorded');
        expect(metadata).toEqual({ type: 'notes/recorded', hasProjection: false });
        expect(Object.isFrozen(metadata)).toBe(true);
        expect(Reflect.set(metadata!, 'type', 'journal/forged')).toBe(false);
        expect(reader.list()).toEqual([{ type: 'notes/recorded', hasProjection: false }]);
        expect(
          reader.parse({ type: 'notes/recorded', payload: { text: 'kept', extra: true } }),
        ).toEqual({ type: 'notes/recorded', payload: { text: 'kept' } });
        registry.define({ type: 'notes/host-only', schema: z.object({}) });
        expect(reader.get('notes/host-only')).toEqual({
          type: 'notes/host-only',
          hasProjection: false,
        });
      } finally {
        await kernel.dispose();
      }
    },
  );
});

describe('builtin registry skip ownership', () => {
  it('does not report a skipped tool as the new plugin contribution', async () => {
    const registry = createToolRegistry();
    const existing = createUpdatePlanTool();
    registry.register(existing);
    const kernel = createPluginKernel();
    await kernel.register(createToolRegistryPlugin({ registry, existing: 'skip' }));
    await kernel.register(
      definePlugin({
        manifest: manifest('attempted-tools', { capabilities: ['tool'] }),
        setup(env) {
          env.contribute(toolsExtensionPoint, (api) => {
            api.addTool(createUpdatePlanTool());
            api.addTool({ ...createUpdatePlanTool(), name: 'secondary_plan' });
          });
        },
      }),
    );
    try {
      await (await kernel.seal()).resolve(toolRegistryRef);
      expect(registry.get(updatePlanToolName)).toBe(existing);
      expect(registry.get('secondary_plan')).toBeDefined();
      expect(
        kernel.plugins().find(({ manifest }) => manifest.id === 'attempted-tools')?.contributed
          .tools,
      ).toEqual(['secondary_plan']);
    } finally {
      await kernel.dispose();
    }
  });

  it('does not report a skipped provider as the new plugin contribution', async () => {
    const registry = createLlmProviderRegistry();
    const existing = createMockLlmClient([]);
    registry.register({ id: 'mock', label: 'Existing', type: 'mock', client: existing });
    const kernel = createPluginKernel();
    await kernel.register(createProviderRegistryPlugin({ registry, existing: 'skip' }));
    await kernel.register(
      definePlugin({
        manifest: manifest('attempted-providers', { capabilities: ['llm-provider'] }),
        setup(env) {
          env.contribute(llmProvidersExtensionPoint, (api) => {
            api.addProvider({
              id: 'mock',
              label: 'New',
              type: 'mock',
              client: createMockLlmClient([]),
            });
            api.addProvider({
              id: 'new',
              label: 'New',
              type: 'mock',
              client: createMockLlmClient([]),
            });
          });
        },
      }),
    );
    try {
      await (await kernel.seal()).resolve(llmProviderRegistryRef);
      expect(registry.getDescriptor('mock')?.label).toBe('Existing');
      expect(registry.getDescriptor('new')?.label).toBe('New');
      expect(
        kernel.plugins().find(({ manifest }) => manifest.id === 'attempted-providers')?.contributed
          .providers,
      ).toEqual(['new']);
    } finally {
      await kernel.dispose();
    }
  });
});
