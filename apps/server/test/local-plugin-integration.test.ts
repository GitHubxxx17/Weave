import { randomUUID } from 'node:crypto';
import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  toolsExtensionPoint,
  type KernelPlugin,
  type PluginManifest,
  type WeavePlugin,
} from '@weave/plugin';
import { computeDirectoryDigest, createMemoryTrustStore } from '@weave/plugin-host';
import { createInMemorySessionEventStore, type SessionEventStore } from '@weave/session';
import { createInMemoryProjectStore, type ProjectStore } from '@weave/workspace';
import { startServer } from '../src/main.js';
import {
  approvalBrokerService,
  createServerAgentRunner,
  createServerRuntime,
  disposeServerPlugins,
  getServerSessionStore,
} from '../src/runtime.js';
import { createServerLocalPluginHost } from '../src/local-plugin-host.js';
import { serverHostVersion } from '../src/host-version.js';

interface Fixture {
  readonly root: string;
  readonly databaseFile: string;
  readonly pluginsDirectory: string;
}

async function fixture(): Promise<Fixture> {
  const root = join(tmpdir(), `weave-local-plugin-${randomUUID()}`);
  await mkdir(root, { recursive: true });
  return {
    root,
    databaseFile: join(root, 'weave.sqlite'),
    pluginsDirectory: join(root, 'plugins'),
  };
}

function manifest(id = 'local-command', overrides: Partial<PluginManifest> = {}): PluginManifest {
  return {
    id,
    name: id,
    version: '1.0.0',
    apiVersion: '1.0.0',
    capabilities: ['command'],
    contributes: { commands: ['hello'] },
    permissions: [],
    ...overrides,
  };
}

async function plugin(
  f: Fixture,
  metadata = manifest(),
  source = `export default (sdk) => ({ setup(env) {
    env.contribute(sdk.commandsExtensionPoint, (commands) => commands.addCommand({
      name: 'hello', title: 'Hello', prompt: 'Say hello'
    }));
  } });\n`,
): Promise<{ readonly directory: string; readonly digest: string }> {
  const directory = join(f.pluginsDirectory, metadata.id);
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, 'weave-plugin.json'),
    JSON.stringify({ schemaVersion: 1, entry: 'index.mjs', manifest: metadata }),
  );
  await writeFile(join(directory, 'index.mjs'), source);
  return { directory, digest: (await computeDirectoryDigest(directory)).digest };
}

async function json(
  server: { readonly port: number },
  path: string,
): Promise<Record<string, unknown>> {
  const response = await fetch(`http://127.0.0.1:${server.port}${path}`);
  expect(response.status).toBe(200);
  return (await response.json()) as Record<string, unknown>;
}

async function mutate(
  server: { readonly port: number },
  path: string,
  body?: unknown,
  method = 'POST',
) {
  const response = await fetch(`http://127.0.0.1:${server.port}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  expect(response.status).toBe(200);
  return (await response.json()) as Record<string, unknown>;
}

function records(body: Record<string, unknown>): Array<Record<string, unknown>> {
  return body.plugins as Array<Record<string, unknown>>;
}

function localRecord(body: Record<string, unknown>, id = 'local-command') {
  return records(body).find((item) => item.id === id && item.origin === 'local');
}

async function runTurn(
  server: Awaited<ReturnType<typeof startServer>>,
  text: string,
  provider = 'mock',
) {
  const runner = await createServerAgentRunner(server.runtime);
  const events = [];
  for await (const event of runner.run({
    sessionId: 'local-session',
    provider,
    model: 'test-model',
    userMessage: { role: 'user', content: [{ type: 'text', text }] },
  }))
    events.push(event);
  return events;
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const emptyLegacy = (id: string, dispose = () => {}): WeavePlugin => ({
  manifest: manifest(id, { capabilities: ['tool'], contributes: {} }),
  setup() {},
  dispose,
});

describe('local plugin startup integration', () => {
  it('keeps entry code pending until trust, reloads tools and prompt on the stable runner, and restores trust after restart', async () => {
    const f = await fixture();
    const marker = join(f.root, 'imported.txt');
    const metadata = manifest('local-command', {
      capabilities: ['command', 'tool', 'prompt'],
      engines: { weave: '>=0.0.0 <0.0.1' },
      contributes: {
        commands: ['hello'],
        tools: ['local_echo'],
        promptSections: ['local-instructions'],
      },
    });
    const local = await plugin(
      f,
      metadata,
      `
      import { writeFileSync } from 'node:fs';
      writeFileSync(${JSON.stringify(marker)}, 'imported');
      export default (sdk) => ({ setup(env) {
        env.contribute(sdk.commandsExtensionPoint, (api) => api.addCommand({ name: 'hello', title: 'Hello', prompt: 'Say hello' }));
        env.contribute(sdk.toolsExtensionPoint, (api) => api.addTool({ name: 'local_echo', description: 'Echo local input', parameters: { type: 'object' }, inputSchema: sdk.z.object({}), execute: () => 'from-local-plugin' }));
        env.contribute(sdk.promptSectionsExtensionPoint, (api) => api.addSection({ id: 'local-instructions', order: 10, text: 'Follow the local plugin instructions.' }));
      } });
    `,
    );
    const requests: unknown[] = [];
    const providerFetch: typeof fetch = async (_input, init) => {
      requests.push(JSON.parse(String(init?.body)) as unknown);
      return new Response(
        'data: {"choices":[{"delta":{"content":"done"}}]}\n\ndata: {"choices":[{"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
        { headers: { 'content-type': 'text/event-stream' } },
      );
    };
    const options = {
      dataDirectory: f.root,
      environment: {
        WEAVE_LLM_PROVIDERS: JSON.stringify([
          {
            id: 'capture',
            label: 'Capture',
            type: 'openai-compatible',
            baseUrl: 'https://local.invalid/v1',
            apiKey: 'test',
            defaultModel: 'test-model',
          },
        ]),
      },
      fetch: providerFetch,
    };
    try {
      const server = await startServer(0, options);
      try {
        const stable = await createServerAgentRunner(server.runtime);
        expect(server.pluginHost?.runner).toBe(stable);
        const pending = await json(server, '/plugins');
        expect(localRecord(pending)).toMatchObject({
          state: 'pending-trust',
          local: { digest: local.digest },
        });
        await expect(access(marker)).rejects.toMatchObject({ code: 'ENOENT' });
        await getServerSessionStore(server.runtime).append('local-session', [
          { type: 'session.created', payload: { title: 'Local integration' } },
        ]);
        await mutate(server, '/plugins/local-command/trust', { digest: local.digest });
        expect(await readFile(marker, 'utf8')).toBe('imported');
        expect(localRecord(await json(server, '/plugins'))).toMatchObject({
          state: 'loaded',
          local: { active: { digest: local.digest } },
        });
        expect(await json(server, '/commands')).toMatchObject({
          commands: [expect.objectContaining({ name: 'hello', pluginId: 'local-command' })],
        });
        expect(await createServerAgentRunner(server.runtime)).toBe(stable);
        expect(await runTurn(server, '/tool local_echo {}')).toContainEqual(
          expect.objectContaining({
            type: 'tool-result',
            result: expect.objectContaining({ content: 'from-local-plugin' }),
          }),
        );
        await runTurn(server, 'Inspect prompt', 'capture');
        expect(JSON.stringify(requests.at(-1))).toContain('Follow the local plugin instructions.');
        expect(JSON.stringify(requests.at(-1))).toContain('local_echo');
        await mutate(server, '/plugins/local-command/disable');
        expect(localRecord(await json(server, '/plugins'))).toMatchObject({ state: 'disabled' });
        expect(await json(server, '/commands')).toEqual({ commands: [] });
        await runTurn(server, 'Inspect disabled prompt', 'capture');
        expect(JSON.stringify(requests.at(-1))).not.toContain(
          'Follow the local plugin instructions.',
        );
        expect((requests.at(-1) as { tools: unknown[] }).tools).not.toEqual(
          expect.arrayContaining([
            expect.objectContaining({ function: expect.objectContaining({ name: 'local_echo' }) }),
          ]),
        );
        await mutate(server, '/plugins/local-command/enable');
        await mutate(server, '/plugins/local-command/trust', undefined, 'DELETE');
        expect(localRecord(await json(server, '/plugins'))).toMatchObject({
          state: 'pending-trust',
        });
        expect(await json(server, '/commands')).toEqual({ commands: [] });
        await mutate(server, '/plugins/local-command/trust', { digest: local.digest });
        await mutate(server, '/plugins/reload');
        expect(await createServerAgentRunner(server.runtime)).toBe(stable);
      } finally {
        await server.stop();
      }
      const restarted = await startServer(0, options);
      try {
        expect(localRecord(await json(restarted, '/plugins'))).toMatchObject({
          state: 'loaded',
          local: { trusted: { digest: local.digest, manifest: metadata } },
        });
        expect(await json(restarted, '/commands')).toMatchObject({
          commands: [expect.objectContaining({ name: 'hello' })],
        });
      } finally {
        await restarted.stop();
      }
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  }, 15_000);

  it.each([
    {
      label: 'explicit database only',
      options: (f: Fixture) => ({ databaseFile: f.databaseFile }),
    },
    {
      label: 'false overrides environment',
      options: (f: Fixture) => ({
        databaseFile: f.databaseFile,
        pluginsDirectory: false as const,
        environment: { WEAVE_PLUGINS_DIR: f.pluginsDirectory },
      }),
    },
  ])('keeps local trust persistence off for $label', async ({ options }) => {
    const f = await fixture();
    try {
      const server = await startServer(0, {
        ...options(f),
        environment: { ...options(f).environment },
      });
      try {
        expect(server.pluginHost).toBeUndefined();
        expect(await json(server, '/plugins')).not.toHaveProperty('local');
      } finally {
        await server.stop();
      }
      await expect(access(f.pluginsDirectory)).rejects.toMatchObject({ code: 'ENOENT' });
      const database = new DatabaseSync(f.databaseFile);
      try {
        expect(
          database
            .prepare("SELECT name FROM sqlite_master WHERE name = 'plugin_trust_events'")
            .all(),
        ).toEqual([]);
      } finally {
        database.close();
      }
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

  it.each([
    {
      label: 'explicit database and data directory',
      options: (f: Fixture) => ({ databaseFile: f.databaseFile, dataDirectory: f.root }),
    },
    {
      label: 'environment plugin override',
      options: (f: Fixture) => ({
        databaseFile: f.databaseFile,
        environment: { WEAVE_PLUGINS_DIR: f.pluginsDirectory },
      }),
    },
  ])('reports a missing directory without creating it for $label', async ({ options }) => {
    const f = await fixture();
    try {
      const server = await startServer(0, {
        ...options(f),
        environment: { ...options(f).environment },
      });
      try {
        expect(await json(server, '/plugins')).toMatchObject({
          local: {
            directory: f.pluginsDirectory,
            exists: false,
            generation: { acceptingRuns: true },
          },
        });
        expect(server.pluginHost).toBeDefined();
      } finally {
        await server.stop();
      }
      await expect(access(f.pluginsDirectory)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

  it('isolates malformed and incompatible plugins, rejects reserved empty host IDs, and keeps healthy plugins loadable', async () => {
    const f = await fixture();
    const good = await plugin(f);
    await plugin(f, manifest('too-new', { engines: { weave: '>=1.0.0' } }));
    for (const id of [
      'tool-registry',
      'provider-registry',
      'event-registry',
      'host-services',
      'server-tool-host',
      'empty-host',
    ]) {
      await plugin(f, manifest(id));
    }
    const malformed = join(f.pluginsDirectory, 'malformed');
    await mkdir(malformed);
    await writeFile(join(malformed, 'weave-plugin.json'), '{');
    const bad = await plugin(
      f,
      manifest('bad-factory'),
      'export default () => { throw new Error("broken factory"); };',
    );
    try {
      const server = await startServer(0, {
        dataDirectory: f.root,
        environment: {},
        plugins: [emptyLegacy('empty-host')],
      });
      try {
        const snapshot = await json(server, '/plugins');
        expect(localRecord(snapshot, 'too-new')).toMatchObject({
          state: 'incompatible',
          error: { code: 'plugin-engine-unsupported' },
        });
        expect(localRecord(snapshot, 'malformed')).toMatchObject({ state: 'invalid' });
        for (const id of [
          'tool-registry',
          'provider-registry',
          'event-registry',
          'host-services',
          'server-tool-host',
          'empty-host',
        ]) {
          expect(localRecord(snapshot, id)).toMatchObject({
            state: 'invalid',
            error: { code: 'plugin-id-reserved' },
          });
        }
        await mutate(server, '/plugins/bad-factory/trust', { digest: bad.digest });
        expect(localRecord(await json(server, '/plugins'), 'bad-factory')).toMatchObject({
          state: 'failed',
        });
        await mutate(server, '/plugins/local-command/trust', { digest: good.digest });
        expect(localRecord(await json(server, '/plugins'))).toMatchObject({ state: 'loaded' });
        expect(await json(server, '/commands')).toMatchObject({
          commands: [expect.objectContaining({ name: 'hello' })],
        });
      } finally {
        await server.stop();
      }
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

  it('rejects invalid plugin configuration before opening persistence', async () => {
    const f = await fixture();
    const store = createInMemoryProjectStore();
    const close = vi.spyOn(store, 'close');
    try {
      await expect(
        startServer(0, {
          databaseFile: f.databaseFile,
          pluginsDirectory: '',
          projectStore: store,
          environment: {},
        }),
      ).rejects.toThrow();
      expect(close).not.toHaveBeenCalled();
      await expect(access(f.databaseFile)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await store.close();
      await rm(f.root, { recursive: true, force: true });
    }
  });

  it('cleans up the baseline and stores while preserving an initial trust read failure', async () => {
    const f = await fixture();
    const sessionStore = createInMemorySessionEventStore();
    const projectStore = createInMemoryProjectStore();
    const sessionClose = vi.spyOn(sessionStore, 'close');
    const projectClose = vi.spyOn(projectStore, 'close');
    const dispose = vi.fn();
    const failure = new Error('Cannot read trust log');
    const close = vi.fn(async () => {});
    try {
      await expect(
        startServer(0, {
          dataDirectory: f.root,
          environment: {},
          projectStore,
          sessionStoreFactory: () => sessionStore,
          plugins: [emptyLegacy('empty-host', dispose)],
          pluginTrustStore: {
            append: createMemoryTrustStore().append,
            events: async () => {
              throw failure;
            },
            close,
          },
        }),
      ).rejects.toBe(failure);
      expect(dispose).toHaveBeenCalledOnce();
      expect(sessionClose).toHaveBeenCalledOnce();
      expect(projectClose).toHaveBeenCalledOnce();
      expect(close).toHaveBeenCalledOnce();
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

  it('drains pending administration before closing trust persistence and still closes every store after cleanup failure', async () => {
    const f = await fixture();
    const local = await plugin(f);
    const memory = createMemoryTrustStore();
    const appendEntered = deferred();
    const appendRelease = deferred();
    const calls: string[] = [];
    const trustClosed = vi.fn(async () => {
      calls.push('trust-close');
      throw new Error('trust close failed');
    });
    const projectBase = createInMemoryProjectStore();
    const projects: ProjectStore = {
      ...projectBase,
      close: async () => {
        calls.push('project-close');
        await projectBase.close();
      },
    };
    const sessionBase = createInMemorySessionEventStore();
    const sessions: SessionEventStore = {
      ...sessionBase,
      close: async () => {
        calls.push('session-close');
        await sessionBase.close();
      },
    };
    const server = await startServer(0, {
      dataDirectory: f.root,
      environment: {},
      projectStore: projects,
      sessionStoreFactory: () => sessions,
      pluginTrustStore: {
        events: memory.events,
        async append(event) {
          calls.push('append-enter');
          appendEntered.resolve();
          await appendRelease.promise;
          const recorded = await memory.append(event);
          calls.push('append-settled');
          return recorded;
        },
        close: trustClosed,
      },
    });
    try {
      const trustOutcome = server
        .pluginHost!.trust('local-command', local.digest)
        .catch((error: unknown) => error);
      await appendEntered.promise;
      const stopping = server.stop();
      const secondStop = server.stop();
      expect(trustClosed).not.toHaveBeenCalled();
      appendRelease.resolve();
      await expect(trustOutcome).resolves.toMatchObject({ code: 'plugin-host-disposed' });
      await expect(stopping).rejects.toThrow('trust close failed');
      await expect(secondStop).rejects.toThrow('trust close failed');
      expect(calls).toEqual([
        'append-enter',
        'append-settled',
        'session-close',
        'project-close',
        'trust-close',
      ]);
      expect(trustClosed).toHaveBeenCalledOnce();
    } finally {
      appendRelease.resolve();
      await server.stop().catch(() => {});
      await rm(f.root, { recursive: true, force: true });
    }
  });

  it('waits for an in-flight candidate assembly and disposes it before closing trust persistence', async () => {
    const f = await fixture();
    const key = `__weaveLocalAssembly_${randomUUID().replaceAll('-', '')}`;
    const setupEntered = deferred();
    const setupRelease = deferred();
    const calls: string[] = [];
    const gate = {
      entered: setupEntered.resolve,
      wait: setupRelease.promise,
      dispose: () => calls.push('candidate-dispose'),
    };
    (globalThis as Record<string, unknown>)[key] = gate;
    const local = await plugin(
      f,
      manifest(),
      `export default (sdk) => ({
      async setup(env) {
        const gate = globalThis[${JSON.stringify(key)}];
        gate.entered();
        await gate.wait;
        env.contribute(sdk.commandsExtensionPoint, (api) => api.addCommand({ name: 'hello', title: 'Hello', prompt: 'Say hello' }));
      },
      dispose() { globalThis[${JSON.stringify(key)}].dispose(); }
    });`,
    );
    const memory = createMemoryTrustStore();
    const close = vi.fn(async () => {
      calls.push('trust-close');
    });
    const server = await startServer(0, {
      dataDirectory: f.root,
      environment: {},
      pluginTrustStore: { ...memory, close },
    });
    try {
      const trust = server
        .pluginHost!.trust('local-command', local.digest)
        .catch((error: unknown) => error);
      await setupEntered.promise;
      const stop = server.stop();
      expect(close).not.toHaveBeenCalled();
      setupRelease.resolve();
      await expect(trust).resolves.toMatchObject({ code: 'plugin-host-disposed' });
      await stop;
      expect(calls).toEqual(['candidate-dispose', 'trust-close']);
      expect(server.runtime.serverHost.commands()).toEqual([]);
    } finally {
      setupRelease.resolve();
      await server.stop();
      delete (globalThis as Record<string, unknown>)[key];
      await rm(f.root, { recursive: true, force: true });
    }
  });

  it('uses the product version for direct kernel assembly and reserves configured kernel plugins without contributions', async () => {
    const f = await fixture();
    await plugin(f, manifest('empty-kernel'));
    const runtime = createServerRuntime();
    await runtime.start();
    const empty = (): KernelPlugin => ({
      manifest: manifest('empty-kernel', { engines: { weave: '>=0.0.0 <0.0.1' }, contributes: {} }),
      setup() {},
    });
    try {
      const runnerOptions = { hostVersion: serverHostVersion };
      const runner = await createServerAgentRunner(runtime, { kernelPlugins: [empty()] });
      const host = await createServerLocalPluginHost(runtime, {
        directory: f.pluginsDirectory,
        trustStore: createMemoryTrustStore(),
        runnerOptions,
        kernelPluginFactories: [empty],
      });
      try {
        expect(host.runner).toBe(runner);
        expect(host.snapshot().plugins[0]).toMatchObject({
          id: 'empty-kernel',
          state: 'invalid',
          candidate: { issue: { code: 'plugin-id-reserved' } },
        });
      } finally {
        await host.dispose();
      }
    } finally {
      await disposeServerPlugins(runtime);
      await runtime.stop();
      await rm(f.root, { recursive: true, force: true });
    }
  });

  it('gives every configured candidate independent resources, including retries, and disposes each instance once', async () => {
    const f = await fixture();
    const healthy = await plugin(f);
    const rejected = await plugin(
      f,
      manifest('rejected-local'),
      'export default () => ({ setup() { throw new Error("reject this local setup"); } });',
    );
    const instances: Array<{ readonly id: number; closed: boolean; disposals: number }> = [];
    const configuredPlugin = (): KernelPlugin => {
      const resource = { id: instances.length + 1, closed: false, disposals: 0 };
      instances.push(resource);
      return {
        manifest: manifest('configured-resource', {
          capabilities: ['tool'],
          contributes: { tools: ['configured_read'] },
        }),
        setup(env) {
          env.contribute(toolsExtensionPoint, (api) =>
            api.addTool({
              name: 'configured_read',
              description: 'Read the generation resource',
              parameters: { type: 'object' },
              inputSchema: z.object({}),
              execute() {
                if (resource.closed) throw new Error('The configured resource was already closed');
                return `resource-${resource.id}`;
              },
            }),
          );
        },
        dispose() {
          resource.closed = true;
          resource.disposals += 1;
        },
      };
    };
    const baselinePlugin = configuredPlugin();
    const runtime = createServerRuntime();
    await runtime.start();
    try {
      const runnerOptions = { hostVersion: serverHostVersion, kernelPlugins: [baselinePlugin] };
      const runner = await createServerAgentRunner(runtime, runnerOptions);
      await getServerSessionStore(runtime).append('configured-session', [
        { type: 'session.created', payload: { title: 'Configured resources' } },
      ]);
      const hostOptions = {
        directory: f.pluginsDirectory,
        trustStore: createMemoryTrustStore(),
        runnerOptions,
        kernelPluginFactories: [configuredPlugin],
      };
      const host = await createServerLocalPluginHost(runtime, hostOptions);
      const read = async () => {
        const events = [];
        for await (const event of runner.run({
          sessionId: 'configured-session',
          provider: 'mock',
          model: 'test',
          userMessage: {
            role: 'user',
            content: [{ type: 'text', text: '/tool configured_read {}' }],
          },
        }))
          events.push(event);
        return events;
      };
      try {
        await host.trust('local-command', healthy.digest);
        expect(instances[0]).toMatchObject({ closed: true, disposals: 1 });
        expect(await read()).toContainEqual(
          expect.objectContaining({
            type: 'tool-result',
            result: expect.objectContaining({ content: 'resource-2' }),
          }),
        );
        const result = await host.trust('rejected-local', rejected.digest);
        expect(result.failed).toHaveLength(1);
        expect(instances.map(({ closed, disposals }) => ({ closed, disposals }))).toEqual([
          { closed: true, disposals: 1 },
          { closed: true, disposals: 1 },
          { closed: true, disposals: 1 },
          { closed: false, disposals: 0 },
        ]);
        expect(await read()).toContainEqual(
          expect.objectContaining({
            type: 'tool-result',
            result: expect.objectContaining({ content: 'resource-4' }),
          }),
        );
        expect(host.runner).toBe(runner);
      } finally {
        await host.dispose();
      }
      expect(instances.every(({ closed, disposals }) => closed && disposals === 1)).toBe(true);
    } finally {
      await disposeServerPlugins(runtime);
      await runtime.stop();
      await rm(f.root, { recursive: true, force: true });
    }
  });

  it.each(['factory', 'assembly', 'identity'] as const)(
    'cleans every allocated configured resource after %s failure and retries with fresh instances',
    async (failure) => {
      const f = await fixture();
      const local = await plugin(f);
      const resources: Array<{ closed: boolean; disposals: number }> = [];
      let failing = false;
      const factory =
        (id: string, index: number): (() => KernelPlugin) =>
        () => {
          if (failing && failure === 'factory' && index === 1)
            throw new Error('Configured factory failed');
          const resource = { closed: false, disposals: 0 };
          resources.push(resource);
          return {
            manifest: manifest(
              failing && failure === 'identity' && index === 1 ? 'changed-id' : id,
              { capabilities: ['tool'], contributes: {} },
            ),
            setup() {
              if (failing && failure === 'assembly' && index === 0)
                throw new Error('Configured setup failed before the later plugin registered');
            },
            dispose() {
              resource.closed = true;
              resource.disposals += 1;
            },
          };
        };
      const factories = [factory('configured-first', 0), factory('configured-second', 1)];
      const runtime = createServerRuntime();
      await runtime.start();
      try {
        await createServerAgentRunner(runtime, {
          kernelPlugins: factories.map((create) => create()),
        });
        const baseline = runtime.serverHost.controller()!.current();
        const host = await createServerLocalPluginHost(runtime, {
          directory: f.pluginsDirectory,
          trustStore: createMemoryTrustStore(),
          runnerOptions: { hostVersion: serverHostVersion },
          kernelPluginFactories: factories,
        });
        try {
          failing = true;
          const result = await host.trust('local-command', local.digest);
          expect(result.error).toMatchObject({ code: 'plugin-reload-failed' });
          expect(runtime.serverHost.controller()!.current()).toBe(baseline);
          expect(resources.slice(0, 2)).toEqual([
            { closed: false, disposals: 0 },
            { closed: false, disposals: 0 },
          ]);
          expect(resources.slice(2)).toHaveLength(failure === 'factory' ? 1 : 2);
          expect(
            resources.slice(2).every(({ closed, disposals }) => closed && disposals === 1),
          ).toBe(true);
          failing = false;
          expect((await host.reload()).error).toBeUndefined();
          expect(runtime.serverHost.controller()!.current()).not.toBe(baseline);
          expect(
            resources.slice(0, -2).every(({ closed, disposals }) => closed && disposals === 1),
          ).toBe(true);
          expect(resources.slice(-2)).toEqual([
            { closed: false, disposals: 0 },
            { closed: false, disposals: 0 },
          ]);
        } finally {
          await host.dispose();
        }
        expect(resources.every(({ closed, disposals }) => closed && disposals === 1)).toBe(true);
      } finally {
        await disposeServerPlugins(runtime);
        await runtime.stop();
        await rm(f.root, { recursive: true, force: true });
      }
    },
  );

  it('rejects missing configured factories before changing the baseline', async () => {
    const f = await fixture();
    const runtime = createServerRuntime();
    await runtime.start();
    try {
      await createServerAgentRunner(runtime, {
        kernelPlugins: [
          { manifest: manifest('configured-empty', { contributes: {} }), setup() {} },
        ],
      });
      const baseline = runtime.serverHost.controller()!.current();
      expect(() =>
        createServerLocalPluginHost(runtime, {
          directory: f.pluginsDirectory,
          trustStore: createMemoryTrustStore(),
          runnerOptions: { hostVersion: serverHostVersion },
        }),
      ).toThrow('factories must match the baseline');
      expect(runtime.serverHost.controller()!.current()).toBe(baseline);
    } finally {
      await disposeServerPlugins(runtime);
      await runtime.stop();
      await rm(f.root, { recursive: true, force: true });
    }
  });

  it('cancels a local-enabled Approval SSE and queued same-session turn before durable stores close', async () => {
    const f = await fixture();
    const baseStore = createInMemorySessionEventStore();
    let closed = false;
    const terminalStatuses: string[] = [];
    let statusesAtClose: readonly string[] = [];
    const sessionStore: SessionEventStore = {
      ...baseStore,
      async append(id, events) {
        if (closed) throw new Error('Session store closed before terminal persistence');
        for (const event of events) {
          if (event.type === 'turn.completed') terminalStatuses.push(event.payload.status);
        }
        return baseStore.append(id, events);
      },
      async close() {
        statusesAtClose = [...terminalStatuses];
        closed = true;
        await baseStore.close();
      },
    };
    const projectStore = createInMemoryProjectStore();
    const project = await projectStore.createProject({
      name: 'Local shutdown',
      folderName: 'local-shutdown',
    });
    await baseStore.append('local-session', [
      { type: 'session.created', payload: { title: 'Shutdown' } },
    ]);
    await projectStore.attachSession(project.id, 'local-session');
    const server = await startServer(0, {
      dataDirectory: f.root,
      environment: {},
      projectStore,
      sessionStoreFactory: () => sessionStore,
      plugins: [
        {
          manifest: manifest('protected-tool', {
            capabilities: ['tool'],
            contributes: { tools: ['protected'] },
          }),
          setup(context) {
            context.registerTool({
              name: 'protected',
              description: 'Protected',
              parameters: { type: 'object' },
              inputSchema: z.object({}),
              approval: {
                operation: 'test.protected',
                risk: 'high',
                summarize: () => ({ summary: 'Protected', inputSummary: {} }),
              },
              execute: () => 'done',
            });
          },
        },
      ],
    });
    const broker = server.runtime.get(approvalBrokerService);
    const pending = deferred();
    const unsubscribe = broker.subscribe((event) => {
      if (event.request.status === 'pending') pending.resolve();
    });
    let response: Response | undefined;
    try {
      expect(server.pluginHost).toBeDefined();
      response = await fetch(`http://127.0.0.1:${server.port}/agent/runs/stream`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          sessionId: 'local-session',
          provider: 'mock',
          model: 'test',
          userMessage: { role: 'user', content: [{ type: 'text', text: '/tool protected {}' }] },
        }),
      });
      expect(response.status).toBe(200);
      const body = response.text();
      await pending.promise;
      const queuedIterator = (
        server.pluginHost!.runner.run({
          sessionId: 'local-session',
          provider: 'mock',
          model: 'test',
          userMessage: { role: 'user', content: [{ type: 'text', text: 'Queued request' }] },
        }) as AsyncIterableIterator<unknown>
      )[Symbol.asyncIterator]();
      const queued = queuedIterator.next().catch((error: unknown) => error);
      await Promise.all([server.stop(), server.stop()]);
      await body;
      expect(await queued).toEqual({ done: true, value: undefined });
      expect(broker.list()[0]?.status).toBe('cancelled');
      expect(terminalStatuses).toEqual(['cancelled']);
      expect(statusesAtClose).toEqual(['cancelled']);
      expect(closed).toBe(true);
    } finally {
      unsubscribe();
      await response?.body?.cancel().catch(() => {});
      await server.stop();
      await rm(f.root, { recursive: true, force: true });
    }
  }, 5000);
});
