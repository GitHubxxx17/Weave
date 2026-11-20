import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createProviderSettingsManager } from '../src/provider-settings-manager.js';
import type { ProviderSettingsRecord } from '../src/provider-settings-types.js';
import { createMockLlmClient } from '@weave/llm';
import type { LlmRequest } from '@weave/protocol';
import {
  commandsExtensionPoint,
  definePlugin,
  llmProvidersExtensionPoint,
  toolsExtensionPoint,
} from '@weave/plugin';
import {
  assembleServerGeneration,
  createServerAgentRunner,
  createServerRuntime,
  disposeServerPlugins,
  getServerGeneration,
  getServerSessionStore,
  listServerCommands,
  listServerPlugins,
  registerServerPlugins,
  replaceServerGeneration,
} from '../src/runtime.js';

function contribution(id: string, name = id, dispose = vi.fn()) {
  return definePlugin({
    manifest: {
      id,
      name: id,
      version: '1.0.0',
      apiVersion: '1.0.0',
      capabilities: ['tool', 'llm-provider', 'command'],
    },
    setup(env) {
      env.contribute(toolsExtensionPoint, (api) =>
        api.addTool({
          name,
          description: name,
          parameters: { type: 'object' },
          inputSchema: z.object({}),
          execute: () => name,
        }),
      );
      env.contribute(llmProvidersExtensionPoint, (api) =>
        api.addProvider({ id: name, label: name, type: 'mock', client: createMockLlmClient([]) }),
      );
      env.contribute(commandsExtensionPoint, (api) =>
        api.addCommand({ name, title: name, prompt: name }),
      );
    },
    dispose,
  });
}

async function started() {
  const runtime = createServerRuntime();
  await runtime.start();
  return runtime;
}

describe('Server generation assembly', () => {
  it('publishes all catalogs together and never mutates the shared provider source', async () => {
    const runtime = await started();
    try {
      const runner = await createServerAgentRunner(runtime, {
        kernelPlugins: [contribution('first')],
      });
      const candidate = await assembleServerGeneration(runtime, {
        kernelPlugins: [contribution('second')],
      });
      expect(runtime.serverHost.providerRegistry.get('first')).toBeDefined();
      expect(runtime.serverHost.providerRegistry.get('second')).toBeUndefined();
      expect(runtime.serverHost.hostProviderRegistry.get('first')).toBeUndefined();
      expect(runtime.serverHost.toolRegistry.get('second')).toBeUndefined();
      expect(listServerCommands(runtime).map((c) => c.name)).toEqual(['first']);
      expect(listServerPlugins(runtime).some((p) => p.id === 'second')).toBe(false);
      await replaceServerGeneration(runtime, candidate);
      expect(getServerGeneration(runtime)).toBe(candidate);
      expect(
        await createServerAgentRunner(runtime, { kernelPlugins: [contribution('second')] }),
      ).toBe(runner);
      expect(runtime.serverHost.toolRegistry.get('first')).toBeUndefined();
      expect(runtime.serverHost.toolRegistry.get('second')).toBeDefined();
      expect(runtime.serverHost.providerRegistry.get('first')).toBeUndefined();
      expect(runtime.serverHost.providerRegistry.get('second')).toBeDefined();
      expect(listServerCommands(runtime).map((c) => c.name)).toEqual(['second']);
    } finally {
      await disposeServerPlugins(runtime);
      await runtime.stop();
    }
  });

  it('keeps current resources after candidate failure and attributes duplicate tools/providers', async () => {
    const runtime = await started();
    try {
      await createServerAgentRunner(runtime, { kernelPlugins: [contribution('current')] });
      const current = getServerGeneration(runtime);
      await expect(
        assembleServerGeneration(runtime, {
          kernelPlugins: [contribution('a', 'same'), contribution('b', 'same')],
        }),
      ).rejects.toMatchObject({ pluginId: 'b' });
      await expect(
        assembleServerGeneration(runtime, { kernelPlugins: [contribution('bad', 'mock')] }),
      ).rejects.toMatchObject({ pluginId: 'bad' });
      expect(getServerGeneration(runtime)).toBe(current);
      expect(runtime.serverHost.toolRegistry.get('current')).toBeDefined();
    } finally {
      await disposeServerPlugins(runtime);
      await runtime.stop();
    }
  });

  it('borrows legacy contributions across generations and disposes only at host close', async () => {
    const runtime = await started();
    const setup = vi.fn();
    const dispose = vi.fn();
    try {
      await registerServerPlugins(runtime, [
        {
          manifest: {
            id: 'legacy',
            name: 'Legacy',
            version: '1.0.0',
            apiVersion: '1.0.0',
            capabilities: ['tool'],
          },
          setup(context) {
            setup();
            context.registerTool({
              name: 'legacy',
              description: 'legacy',
              parameters: { type: 'object' },
              inputSchema: z.object({}),
              execute: () => 'legacy',
            });
          },
          dispose,
        },
      ]);
      await createServerAgentRunner(runtime);
      await replaceServerGeneration(
        runtime,
        await assembleServerGeneration(runtime, { kernelPlugins: [contribution('next')] }),
      );
      expect(runtime.serverHost.toolRegistry.get('legacy')).toBeDefined();
      expect(setup).toHaveBeenCalledOnce();
      expect(dispose).not.toHaveBeenCalled();
    } finally {
      await disposeServerPlugins(runtime);
      await runtime.stop();
    }
    expect(dispose).toHaveBeenCalledOnce();
  });

  it('revalidates asynchronous candidate provider conflicts at publication', async () => {
    const runtime = await started();
    try {
      await createServerAgentRunner(runtime);
      const current = getServerGeneration(runtime);
      const candidate = await assembleServerGeneration(runtime, {
        kernelPlugins: [contribution('candidate')],
      });
      runtime.serverHost.hostProviderRegistry.register({
        id: 'candidate',
        label: 'Settings',
        type: 'mock',
        client: createMockLlmClient([]),
      });
      await expect(replaceServerGeneration(runtime, candidate)).rejects.toMatchObject({
        code: 'plugin-registration-conflict',
        pluginId: 'candidate',
      });
      expect(getServerGeneration(runtime)).toBe(current);
      await candidate.dispose();
    } finally {
      await disposeServerPlugins(runtime);
      await runtime.stop();
    }
  });
  it('keeps the same provider id alive after retiring the previous generation', async () => {
    const runtime = await started();
    const oldDispose = vi.fn();
    try {
      await createServerAgentRunner(runtime, {
        kernelPlugins: [contribution('old', 'same', oldDispose)],
      });
      await replaceServerGeneration(
        runtime,
        await assembleServerGeneration(runtime, { kernelPlugins: [contribution('new', 'same')] }),
      );
      expect(oldDispose).toHaveBeenCalledOnce();
      expect(runtime.serverHost.providerRegistry.get('same')).toBeDefined();
    } finally {
      await disposeServerPlugins(runtime);
      await runtime.stop();
    }
  });

  it('uses live settings CRUD on the next turn and protects plugin provider ids', async () => {
    const runtime = await started();
    const records = new Map<string, ProviderSettingsRecord>();
    const seen: Array<{ key: string; request: LlmRequest }> = [];
    const manager = createProviderSettingsManager({
      registry: runtime.serverHost.hostProviderRegistry,
      catalog: () => runtime.serverHost.providerRegistry,
      claimProvider: (id) => runtime.serverHost.claimProvider(id),
      releaseProviderClaim: (id) => runtime.serverHost.releaseProviderClaim(id),
      store: {
        async list() {
          return [...records.values()];
        },
        async get(id) {
          return records.get(id);
        },
        async create(record) {
          records.set(record.id, record);
        },
        async update(record) {
          records.set(record.id, record);
        },
        async delete(id) {
          records.delete(id);
        },
        async close() {},
      },
      secretCodec: {
        isAvailable: () => true,
        encrypt: (value) => value,
        decrypt: (value) => value,
      },
      createClient: ({ apiKey }) => ({
        async *stream(request) {
          seen.push({ key: apiKey, request });
          yield { type: 'finish', reason: 'stop' };
        },
      }),
    });
    const input = {
      id: 'settings',
      label: 'Settings',
      type: 'openai-compatible' as const,
      baseUrl: 'https://provider.example/v1',
      apiKey: 'first',
      defaultModel: 'test',
      makeDefault: true,
    };
    try {
      const runner = await createServerAgentRunner(runtime, {
        kernelPlugins: [contribution('plugin-provider')],
      });
      await expect(manager.create({ ...input, id: 'plugin-provider' })).rejects.toMatchObject({
        code: 'provider-settings-protected',
      });
      expect((await manager.list()).some((provider) => provider.id === 'plugin-provider')).toBe(
        true,
      );
      await manager.create(input);
      const run = async () => {
        for await (const event of runner.run({
          sessionId: 'settings-session',
          provider: 'settings',
          model: 'test',
          userMessage: { role: 'user', content: [{ type: 'text', text: 'hello' }] },
        })) {
          void event;
        }
      };
      await run();
      await manager.update('settings', { apiKey: 'second' });
      await run();
      expect(seen.map((call) => call.key)).toEqual(['first', 'second']);
      const beforeClear = await assembleServerGeneration(runtime, {
        kernelPlugins: [contribution('settings-plugin', 'settings-reclaimed')],
      });
      await beforeClear.dispose();
      await manager.update('settings', { clearApiKey: true });
      await expect(
        assembleServerGeneration(runtime, {
          kernelPlugins: [contribution('settings-plugin', 'settings')],
        }),
      ).rejects.toMatchObject({ pluginId: 'settings-plugin' });
      await manager.refresh();
      await expect(
        assembleServerGeneration(runtime, {
          kernelPlugins: [contribution('settings-plugin', 'settings')],
        }),
      ).rejects.toMatchObject({ pluginId: 'settings-plugin' });
      await manager.remove('settings');
      const releasedCandidate = await assembleServerGeneration(runtime, {
        kernelPlugins: [contribution('settings-plugin', 'settings')],
      });
      await releasedCandidate.dispose();
      await expect(run()).rejects.toMatchObject({ code: 'agent-provider-unavailable' });
      await manager.setDefault('plugin-provider');
      expect(manager.getDefaultProvider()).toBe('plugin-provider');
      await replaceServerGeneration(runtime, await assembleServerGeneration(runtime));
      expect(manager.getDefaultProvider()).toBe('mock');
    } finally {
      await disposeServerPlugins(runtime);
      await runtime.stop();
    }
  });

  it('reserves a settings id across its asynchronous durable write before candidate publication', async () => {
    const runtime = await started();
    let finishWrite!: () => void;
    let enteredWrite!: () => void;
    const writing = new Promise<void>((resolve) => {
      enteredWrite = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      finishWrite = resolve;
    });
    const manager = createProviderSettingsManager({
      registry: runtime.serverHost.hostProviderRegistry,
      catalog: () => runtime.serverHost.providerRegistry,
      reserveProvider: (id) => runtime.serverHost.reserveProvider(id),
      claimProvider: (id) => runtime.serverHost.claimProvider(id),
      releaseProviderClaim: (id) => runtime.serverHost.releaseProviderClaim(id),
      store: {
        async list() {
          return [];
        },
        async get() {
          return undefined;
        },
        async create() {
          enteredWrite();
          await gate;
        },
        async update() {},
        async delete() {},
        async close() {},
      },
      secretCodec: {
        isAvailable: () => true,
        encrypt: (value) => value,
        decrypt: (value) => value,
      },
      createClient: () => createMockLlmClient([]),
    });
    try {
      await createServerAgentRunner(runtime);
      const candidate = await assembleServerGeneration(runtime, {
        kernelPlugins: [contribution('raced')],
      });
      const save = manager
        .create({
          id: 'raced',
          label: 'Settings',
          type: 'openai-compatible',
          baseUrl: 'https://provider.example',
          apiKey: 'key',
          defaultModel: 'test',
          makeDefault: false,
        })
        .then(
          (value) => ({ value }),
          (error: unknown) => ({ error }),
        );
      await writing;
      const publication = replaceServerGeneration(runtime, candidate);
      finishWrite();
      await expect(publication).rejects.toMatchObject({
        code: 'plugin-registration-conflict',
        pluginId: 'raced',
      });
      expect(await save).toHaveProperty('value');
      expect(runtime.serverHost.hostProviderRegistry.get('raced')).toBeDefined();
      await candidate.dispose();
    } finally {
      finishWrite();
      await disposeServerPlugins(runtime);
      await runtime.stop();
    }
  });

  it('sends only the selected generation tools through the real Agent Runner', async () => {
    const runtime = await started();
    const tools: string[][] = [];
    runtime.serverHost.hostProviderRegistry.register({
      id: 'capture',
      label: 'Capture',
      type: 'mock',
      client: {
        async *stream(request) {
          tools.push((request.tools ?? []).map((tool) => tool.name));
          yield { type: 'finish', reason: 'stop' };
        },
      },
    });
    runtime.serverHost.toolRegistry.register({
      name: 'host-tool',
      description: 'Host',
      parameters: { type: 'object' },
      inputSchema: z.object({}),
      execute: () => 'host',
    });
    try {
      const runner = await createServerAgentRunner(runtime, {
        kernelPlugins: [contribution('g-one')],
      });
      const run = async () => {
        for await (const event of runner.run({
          sessionId: 'tool-generations',
          provider: 'capture',
          model: 'test',
          userMessage: { role: 'user', content: [{ type: 'text', text: 'hello' }] },
        })) {
          void event;
        }
      };
      await run();
      await replaceServerGeneration(
        runtime,
        await assembleServerGeneration(runtime, { kernelPlugins: [contribution('g-two')] }),
      );
      await run();
      expect(tools[0]).toContain('g-one');
      expect(tools[0]).not.toContain('g-two');
      expect(tools[1]).toContain('g-two');
      expect(tools[1]).not.toContain('g-one');
      expect(tools.every((names) => names.includes('host-tool'))).toBe(true);
    } finally {
      await disposeServerPlugins(runtime);
      await runtime.stop();
    }
  });

  it('attributes duplicate provider ids even when the tool names differ', async () => {
    const runtime = await started();
    const provider = (id: string) =>
      definePlugin({
        manifest: {
          id,
          name: id,
          version: '1.0.0',
          apiVersion: '1.0.0',
          capabilities: ['llm-provider'],
        },
        setup(env) {
          env.contribute(llmProvidersExtensionPoint, (api) =>
            api.addProvider({
              id: 'duplicate-provider',
              label: id,
              type: 'mock',
              client: createMockLlmClient([]),
            }),
          );
        },
      });
    try {
      await expect(
        assembleServerGeneration(runtime, {
          kernelPlugins: [provider('provider-one'), provider('provider-two')],
        }),
      ).rejects.toMatchObject({ pluginId: 'provider-two' });
    } finally {
      await disposeServerPlugins(runtime);
      await runtime.stop();
    }
  });
  it('releases provider reservations on persistence failure and repeated release', async () => {
    const runtime = await started();
    const manager = createProviderSettingsManager({
      registry: runtime.serverHost.hostProviderRegistry,
      catalog: () => runtime.serverHost.providerRegistry,
      reserveProvider: (id) => runtime.serverHost.reserveProvider(id),
      claimProvider: (id) => runtime.serverHost.claimProvider(id),
      releaseProviderClaim: (id) => runtime.serverHost.releaseProviderClaim(id),
      store: {
        async list() {
          return [];
        },
        async get() {
          return undefined;
        },
        async create() {
          throw new Error('disk full');
        },
        async update() {},
        async delete() {},
        async close() {},
      },
      secretCodec: {
        isAvailable: () => true,
        encrypt: (value) => value,
        decrypt: (value) => value,
      },
      createClient: () => createMockLlmClient([]),
    });
    try {
      await createServerAgentRunner(runtime);
      const release = runtime.serverHost.reserveProvider('temporary');
      expect(() => runtime.serverHost.reserveProvider('temporary')).toThrow();
      release();
      const nextRelease = runtime.serverHost.reserveProvider('temporary');
      release();
      expect(() => runtime.serverHost.reserveProvider('temporary')).toThrow();
      nextRelease();
      await expect(
        manager.create({
          id: 'failed-save',
          label: 'Settings',
          type: 'openai-compatible',
          baseUrl: 'https://provider.example',
          apiKey: 'key',
          defaultModel: 'test',
          makeDefault: false,
        }),
      ).rejects.toThrow('disk full');
      await replaceServerGeneration(
        runtime,
        await assembleServerGeneration(runtime, { kernelPlugins: [contribution('failed-save')] }),
      );
      expect(runtime.serverHost.providerRegistry.get('failed-save')).toBeDefined();
    } finally {
      await disposeServerPlugins(runtime);
      await runtime.stop();
    }
  });
  it('pins an active real turn and starts its queued Session successor on the new generation', async () => {
    const runtime = await started();
    const modelCalls: string[][] = [];
    const oldDispose = vi.fn();
    let enterFirst!: () => void;
    let releaseFirst!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      enterFirst = resolve;
    });
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    runtime.serverHost.hostProviderRegistry.register({
      id: 'gated',
      label: 'Gated',
      type: 'mock',
      client: {
        async *stream(request) {
          modelCalls.push((request.tools ?? []).map((tool) => tool.name));
          if (modelCalls.length === 1) {
            enterFirst();
            await firstGate;
          }
          yield { type: 'text-delta', text: 'finished' };
          yield { type: 'finish', reason: 'stop' };
        },
      },
    });
    try {
      const runner = await createServerAgentRunner(runtime, {
        kernelPlugins: [contribution('turn-one', 'turn-one', oldDispose)],
      });
      const request = {
        sessionId: 'ordered-session',
        provider: 'gated',
        model: 'test',
        userMessage: { role: 'user' as const, content: [{ type: 'text' as const, text: 'hello' }] },
      };
      const first = runner.run(request)[Symbol.asyncIterator]();
      const firstNext = first.next();
      await firstStarted;
      const second = runner.run(request)[Symbol.asyncIterator]();
      const secondNext = second.next();
      await replaceServerGeneration(
        runtime,
        await assembleServerGeneration(runtime, { kernelPlugins: [contribution('turn-two')] }),
      );
      expect(modelCalls).toHaveLength(1);
      expect(oldDispose).not.toHaveBeenCalled();
      releaseFirst();
      await firstNext;
      await secondNext;
      for (;;) {
        if ((await second.next()).done) break;
      }
      // The first consumer has left buffered events unread. Production completion
      // still retires its generation and releases the cross-generation queue.
      expect(oldDispose).toHaveBeenCalledOnce();
      expect(modelCalls[0]).toContain('turn-one');
      expect(modelCalls[0]).not.toContain('turn-two');
      expect(modelCalls[1]).toContain('turn-two');
      expect(modelCalls[1]).not.toContain('turn-one');
      const events = await getServerSessionStore(runtime).read('ordered-session');
      expect(events.filter((event) => event.type === 'session.created')).toHaveLength(1);
      expect(events.filter((event) => event.type === 'turn.completed')).toHaveLength(2);
      await first.return?.();
    } finally {
      releaseFirst();
      await disposeServerPlugins(runtime);
      await runtime.stop();
    }
  });
  it('cleans a candidate kernel when assembly fails before publication', async () => {
    const runtime = await started();
    const dispose = vi.fn();
    try {
      await createServerAgentRunner(runtime);
      const current = getServerGeneration(runtime);
      const plugin = Object.freeze(
        definePlugin({
          manifest: {
            id: 'partial',
            name: 'Partial',
            version: '1.0.0',
            apiVersion: '1.0.0',
            capabilities: ['tool'],
          },
          setup() {
            throw new Error('partial setup failed');
          },
          dispose,
        }),
      );
      await expect(
        assembleServerGeneration(runtime, { kernelPlugins: [plugin] }),
      ).rejects.toMatchObject({ code: 'plugin-setup-failed', pluginId: 'partial' });
      expect(dispose).toHaveBeenCalledOnce();
      expect(getServerGeneration(runtime)).toBe(current);
    } finally {
      await disposeServerPlugins(runtime);
      await runtime.stop();
    }
  });
  it('returns the existing facade and preserves its generation when creation repeats', async () => {
    const runtime = await started();
    const ignoredSetup = vi.fn();
    try {
      const runner = await createServerAgentRunner(runtime, {
        kernelPlugins: [contribution('kept')],
      });
      const generation = getServerGeneration(runtime);
      expect(await createServerAgentRunner(runtime)).toBe(runner);
      expect(
        await createServerAgentRunner(runtime, {
          kernelPlugins: [{ ...contribution('ignored'), setup: ignoredSetup }],
        }),
      ).toBe(runner);
      expect(getServerGeneration(runtime)).toBe(generation);
      expect(runtime.serverHost.toolRegistry.get('kept')).toBeDefined();
      expect(ignoredSetup).not.toHaveBeenCalled();
    } finally {
      await disposeServerPlugins(runtime);
      await runtime.stop();
    }
  });

  it('keeps a durable new provider id claimed when clearing the old default fails', async () => {
    const runtime = await started();
    const records = new Map<string, ProviderSettingsRecord>();
    const manager = createProviderSettingsManager({
      registry: runtime.serverHost.hostProviderRegistry,
      catalog: () => runtime.serverHost.providerRegistry,
      reserveProvider: (id) => runtime.serverHost.reserveProvider(id),
      claimProvider: (id) => runtime.serverHost.claimProvider(id),
      releaseProviderClaim: (id) => runtime.serverHost.releaseProviderClaim(id),
      store: {
        async list() {
          return [...records.values()];
        },
        async get(id) {
          return records.get(id);
        },
        async create(record) {
          records.set(record.id, record);
        },
        async update() {
          throw new Error('default write failed');
        },
        async delete(id) {
          records.delete(id);
        },
        async close() {},
      },
      secretCodec: {
        isAvailable: () => true,
        encrypt: (value) => value,
        decrypt: (value) => value,
      },
      createClient: () => createMockLlmClient([]),
    });
    const input = {
      id: 'old-default',
      label: 'Settings',
      type: 'openai-compatible' as const,
      baseUrl: 'https://provider.example',
      apiKey: 'key',
      defaultModel: 'test',
      makeDefault: true,
    };
    try {
      await createServerAgentRunner(runtime);
      await manager.create(input);
      await expect(manager.create({ ...input, id: 'new-default' })).rejects.toThrow(
        'default write failed',
      );
      expect(records.has('new-default')).toBe(true);
      expect(runtime.serverHost.hasProviderClaim('new-default')).toBe(true);
      await expect(
        assembleServerGeneration(runtime, {
          kernelPlugins: [contribution('new-owner', 'new-default')],
        }),
      ).rejects.toMatchObject({ pluginId: 'new-owner' });
      await manager.remove('new-default');
      const candidate = await assembleServerGeneration(runtime, {
        kernelPlugins: [contribution('new-owner', 'new-default')],
      });
      await candidate.dispose();
    } finally {
      await disposeServerPlugins(runtime);
      await runtime.stop();
    }
  });
  it('shares initial assembly across concurrent callers and keeps the first options', async () => {
    const runtime = await started();
    const setup = vi.fn();
    const otherSetup = vi.fn();
    let entered!: () => void;
    let release!: () => void;
    const startedSetup = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const original = contribution('initial');
    try {
      const first = createServerAgentRunner(runtime, {
        kernelPlugins: [
          {
            ...original,
            async setup(env) {
              setup();
              entered();
              await gate;
              original.setup(env);
            },
          },
        ],
      });
      await startedSetup;
      const second = createServerAgentRunner(runtime, {
        kernelPlugins: [{ ...contribution('ignored'), setup: otherSetup }],
      });
      release();
      const [one, two] = await Promise.all([first, second]);
      expect(one).toBe(two);
      expect(setup).toHaveBeenCalledOnce();
      expect(otherSetup).not.toHaveBeenCalled();
      expect(runtime.serverHost.toolRegistry.get('initial')).toBeDefined();
    } finally {
      release();
      await disposeServerPlugins(runtime);
      await runtime.stop();
    }
  });

  it('clears a failed initial assembly so later creation can retry', async () => {
    const runtime = await started();
    try {
      await expect(
        createServerAgentRunner(runtime, {
          kernelPlugins: [
            {
              ...contribution('broken'),
              setup() {
                throw new Error('initial failed');
              },
            },
          ],
        }),
      ).rejects.toMatchObject({ code: 'plugin-setup-failed' });
      const runner = await createServerAgentRunner(runtime, {
        kernelPlugins: [contribution('retry')],
      });
      expect(await createServerAgentRunner(runtime)).toBe(runner);
      expect(runtime.serverHost.toolRegistry.get('retry')).toBeDefined();
    } finally {
      await disposeServerPlugins(runtime);
      await runtime.stop();
    }
  });
});
