import { chmod, mkdir, mkdtemp, rm, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { McpClientError, type ConnectMcpOptions, type McpConnection } from '@weave/mcp-client';
import { createSqliteMcpAuthorityStore } from '../src/mcp-authority-store.js';
import { normalizeMcpServerConfig } from '../src/mcp-environment.js';
import { createMcpExtensionSource, type McpExtensionSourceOptions } from '../src/mcp-source.js';
import { createExtensionCoordinator } from '../src/extension-coordinator.js';
import type { ExtensionSource } from '../src/extension-types.js';
import {
  createServerRuntime,
  createServerAgentRunner,
  assembleServerGeneration,
  disposeServerPlugins,
} from '../src/runtime.js';
import { createManagedPluginCompositionFixture } from './support/managed-plugin-composition-fixture.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
function connection(options: ConnectMcpOptions) {
  const close = vi.fn(async () => {
    options.onClosed?.();
  });
  return {
    tools: [{ name: 'echo', description: 'echo', inputSchema: { type: 'object' } }],
    stderrBytes: 0,
    validateInput: () => ({ valid: true }),
    callTool: async () => ({ content: [{ type: 'text', text: 'ok' }] }),
    close,
  } satisfies McpConnection;
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function fixture(
  connectOverride?: (options: ConnectMcpOptions) => Promise<McpConnection>,
  sourceOptions: Partial<Omit<McpExtensionSourceOptions, 'store' | 'connect'>> = {},
  paired?: ReturnType<typeof createManagedPluginCompositionFixture>,
) {
  const directory = await mkdtemp(join(tmpdir(), 'weave-mcp-source-'));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const store = createSqliteMcpAuthorityStore({ filename: join(directory, 'authority.sqlite') });
  cleanups.push(() => store.close());
  const launches: ConnectMcpOptions[] = [];
  const connections: ReturnType<typeof connection>[] = [];
  const connect = vi.fn(async (options: ConnectMcpOptions) => {
    launches.push(options);
    if (connectOverride) return connectOverride(options);
    const value = connection(options);
    connections.push(value);
    return value;
  });
  const runtime = createServerRuntime();
  await runtime.start();
  await createServerAgentRunner(runtime);
  cleanups.push(async () => {
    await disposeServerPlugins(runtime);
    await runtime.stop();
  });
  let failAssembly = false;
  const source = createMcpExtensionSource({
    store,
    connect,
    readHostVariable: (name) => (name === 'TEST_SECRET' ? 'source-secret' : undefined),
    ...sourceOptions,
    ...(paired === undefined
      ? {}
      : {
          installAuthoritySync: paired.installAuthoritySync,
          assertCreateAllowedSync: paired.assertCreateAllowedSync,
        }),
  });
  let registered!: ExtensionSource;
  const register = paired?.wrapSource(source.register) ?? source.register;
  const coordinator = createExtensionCoordinator({
    host: runtime.serverHost,
    sources: [
      ...(paired === undefined ? [] : [paired.registerLocal]),
      (observe) => {
        registered = register(observe);
        return registered;
      },
    ],
    assemble: (kernelPlugins) => {
      if (failAssembly) throw new Error('private assembly error');
      return assembleServerGeneration(runtime, { kernelPlugins });
    },
  });
  paired?.attach(coordinator, source);
  cleanups.push(() => coordinator.dispose());
  const manager = source.facade(coordinator);
  await coordinator.reload();
  const config = {
    schemaVersion: 1 as const,
    id: 'fixture',
    label: 'Fixture',
    transport: 'stdio' as const,
    command: await realpath(process.execPath),
    args: [],
    cwd: await realpath(directory),
    env: { TOKEN: { fromHostEnv: 'TEST_SECRET' } },
  };
  return {
    directory,
    store,
    launches,
    connections,
    connect,
    coordinator,
    manager,
    source,
    registered,
    config,
    runtime,
    failAssembly: (value: boolean) => {
      failAssembly = value;
    },
  };
}

async function runTool(f: Awaited<ReturnType<typeof fixture>>, tool: string, sessionId: string) {
  for await (const event of f.coordinator.runner.run({
    sessionId,
    provider: 'mock',
    model: 'test',
    permissionMode: 'yolo',
    userMessage: { role: 'user', content: [{ type: 'text', text: `/tool ${tool} {}` }] },
  })) {
    void event;
  }
}

describe('MCP source authority and generation ownership', () => {
  it('publishes the local reservation and MCP eligibility before synchronously aborting a run', async () => {
    const paired = createManagedPluginCompositionFixture();
    const started = deferred();
    const observed: unknown[] = [];
    const f = await fixture(
      async (options) => ({
        ...connection(options),
        callTool: async (_name, _input, callOptions) => {
          started.resolve();
          return new Promise((_resolve, reject) => {
            callOptions.signal.addEventListener(
              'abort',
              () => {
                observed.push({
                  local: paired.localSnapshot(),
                  mcp: f.registered.snapshot(),
                  acceptingRuns: f.coordinator.generationSnapshot().acceptingRuns,
                });
                reject(new McpClientError('mcp-cancelled'));
              },
              { once: true },
            );
          });
        },
      }),
      {},
      paired,
    );
    const configured = await f.manager.configure(0, f.config);
    const trusted = await f.manager.trust('fixture', 1, configured.servers[0]!.configDigest);
    const turn = runTool(f, trusted.servers[0]!.tools[0]!.toolName, 'paired');
    await started.promise;
    const abort = vi.spyOn(f.runtime.serverHost.controller()!, 'abortActiveRuns');
    try {
      const before = f.registered.snapshot();
      paired.adoptStickyIdsSync(['mcp-fixture'], true);
      expect(observed).toEqual([
        {
          local: { stamp: { revision: 1, trustSequence: 0 }, eligible: [] },
          mcp: {
            stamp: { revision: before.stamp.revision + 1, trustSequence: 2 },
            eligible: [],
          },
          acceptingRuns: false,
        },
      ]);
      expect(abort).toHaveBeenCalledOnce();
      await turn;
    } finally {
      abort.mockRestore();
    }
  });

  it('excludes a denied trusted declaration from both snapshot and preparation', async () => {
    const f = await fixture();
    const added = await f.manager.configure(0, f.config);
    await f.manager.trust('fixture', 1, added.servers[0]!.configDigest);
    const before = f.registered.snapshot();
    f.source.setDeniedPluginIdsSync(new Set(['mcp-fixture']));
    const denied = f.registered.snapshot();
    expect(denied.eligible).toEqual([]);
    expect(denied.stamp.revision).toBeGreaterThan(before.stamp.revision);
    expect(denied.stamp.trustSequence).toBe(2);
    const prepared = await f.registered.prepare(denied.stamp, {
      signal: new AbortController().signal,
      excluded: new Set(),
    });
    try {
      expect(prepared.items).toEqual([]);
      expect(f.launches).toHaveLength(1);
      expect(f.coordinator.generationSnapshot().acceptingRuns).toBe(false);
      expect(f.connections[0]!.close).not.toHaveBeenCalled();
    } finally {
      await prepared.dispose();
    }
  });

  it('keeps disabled, untrusted, and broken declarations in the namespace', async () => {
    const f = await fixture(async (options) => {
      if (options.args.includes('--broken')) throw new McpClientError('mcp-connect-failed');
      return connection(options);
    });
    await f.manager.configure(0, { ...f.config, id: 'untrusted' });
    const disabled = await f.manager.configure(1, { ...f.config, id: 'disabled' });
    await f.manager.trust('disabled', 2, disabled.servers[1]!.configDigest);
    await f.manager.disable('disabled', 3);
    const broken = await f.manager.configure(4, {
      ...f.config,
      id: 'broken',
      args: ['--broken'],
    });
    const result = await f.manager.trust('broken', 5, broken.servers[2]!.configDigest);
    expect(result.servers.map(({ state }) => state)).toEqual(['untrusted', 'disabled', 'failed']);
    expect(f.source.declaredPluginIds()).toEqual(['mcp-untrusted', 'mcp-disabled', 'mcp-broken']);
  });

  it('reads newer persisted declarations without installing or publishing MCP authority', async () => {
    const install = vi.fn((apply: () => void) => apply());
    const f = await fixture(undefined, { installAuthoritySync: install });
    await f.manager.configure(0, f.config);
    const before = f.registered.snapshot();
    const generation = f.coordinator.snapshot();
    const cached = await f.store.read();
    const draft = await normalizeMcpServerConfig({ ...f.config, id: 'draft' });
    const newer = await f.store.mutate(
      { kind: 'create', config: draft },
      {
        expectedSequence: cached.sequence,
        knownPrefix: cached.events,
      },
    );
    await f.store.mutate(
      { kind: 'remove', serverId: 'fixture' },
      {
        expectedSequence: newer.sequence,
        knownPrefix: newer.events,
      },
    );
    install.mockClear();
    const read = vi.spyOn(f.store, 'read');
    try {
      await expect(
        f.source.inspectDeclaredPluginIds(new AbortController().signal),
      ).resolves.toEqual(['mcp-draft']);
      expect(read).toHaveBeenCalledExactlyOnceWith({ knownPrefix: cached.events });
      expect(f.source.declaredPluginIds()).toEqual(['mcp-fixture']);
      expect(f.registered.snapshot()).toEqual(before);
      expect(f.coordinator.snapshot()).toEqual(generation);
      expect(install).not.toHaveBeenCalled();
      expect(f.connect).not.toHaveBeenCalled();
    } finally {
      read.mockRestore();
    }
  });

  it('rejects malformed and rewritten logs without invoking live authority failure hooks', async () => {
    const install = vi.fn((apply: () => void) => apply());
    const failure = vi.fn((cause: unknown): never => {
      throw cause;
    });
    const f = await fixture(undefined, {
      installAuthoritySync: install,
      onAuthorityFailureSync: failure,
    });
    await f.manager.configure(0, f.config);
    const valid = await f.store.read();
    const before = f.registered.snapshot();
    const generation = f.coordinator.snapshot();
    const read = vi.spyOn(f.store, 'read');
    install.mockClear();
    try {
      for (const invalid of [
        { ...valid, records: [] },
        { sequence: 0, records: [], events: [] },
        {
          ...valid,
          events: valid.events.map((event) => ({
            ...event,
            occurredAt: '2010-01-01T00:00:00.000Z',
          })),
        },
      ]) {
        read.mockResolvedValueOnce(invalid);
        await expect(
          f.source.inspectDeclaredPluginIds(new AbortController().signal),
        ).rejects.toMatchObject({ code: 'mcp-authority-protocol' });
      }
      expect(f.source.declaredPluginIds()).toEqual(['mcp-fixture']);
      expect(f.registered.snapshot()).toEqual(before);
      expect(f.coordinator.snapshot()).toEqual(generation);
      expect(install).not.toHaveBeenCalled();
      expect(failure).not.toHaveBeenCalled();
      expect(f.connect).not.toHaveBeenCalled();
    } finally {
      read.mockRestore();
    }
  });

  it('uses the same cached prefix across a detached read even if live authority advances', async () => {
    const f = await fixture();
    await f.manager.configure(0, f.config);
    const prior = await f.store.read();
    const release = deferred();
    const read = vi.spyOn(f.store, 'read').mockImplementationOnce(async () => {
      await release.promise;
      return prior;
    });
    try {
      const result = f.source.inspectDeclaredPluginIds(new AbortController().signal);
      expect(read).toHaveBeenCalledExactlyOnceWith({ knownPrefix: prior.events });
      await f.manager.configure(1, { ...f.config, id: 'newer' });
      release.resolve();
      await expect(result).resolves.toEqual(['mcp-fixture']);
      expect(f.source.declaredPluginIds()).toEqual(['mcp-fixture', 'mcp-newer']);
    } finally {
      release.resolve();
      read.mockRestore();
    }
  });

  it.each(['abort', 'close'] as const)(
    'checks %s before and after a detached store read',
    async (stop) => {
      const f = await fixture();
      const before = await f.store.read();
      const release = deferred();
      const controller = new AbortController();
      const reason = new Error('cancel detached read');
      const read = vi.spyOn(f.store, 'read').mockImplementationOnce(async () => {
        await release.promise;
        return before;
      });
      try {
        const result = f.source.inspectDeclaredPluginIds(controller.signal);
        if (stop === 'abort') controller.abort(reason);
        else await f.source.close();
        release.resolve();
        for (const operation of [result, f.source.inspectDeclaredPluginIds(controller.signal)]) {
          if (stop === 'abort') await expect(operation).rejects.toBe(reason);
          else await expect(operation).rejects.toMatchObject({ code: 'mcp-closed' });
        }
        expect(read).toHaveBeenCalledOnce();
      } finally {
        release.resolve();
        read.mockRestore();
      }
    },
  );

  it('releases a removed declaration while its pinned allocation drains', async () => {
    const started = deferred();
    const release = deferred();
    const close = vi.fn(async () => {});
    const f = await fixture(async (options) => ({
      ...connection(options),
      close,
      async callTool() {
        started.resolve();
        await release.promise;
        return { content: [{ type: 'text', text: 'drained' }] };
      },
    }));
    const configured = await f.manager.configure(0, f.config);
    const trusted = await f.manager.trust('fixture', 1, configured.servers[0]!.configDigest);
    const turn = runTool(f, trusted.servers[0]!.tools[0]!.toolName, 'pinned-removal');
    await started.promise;
    try {
      const removed = await f.manager.remove('fixture', 2);
      expect(f.source.declaredPluginIds()).toEqual([]);
      expect(f.registered.snapshot().eligible).toEqual([]);
      expect(f.launches).toHaveLength(1);
      expect(removed.servers[0]).toMatchObject({
        state: 'removed',
        drainingGenerations: [{ generation: trusted.generation.id }],
      });
      expect(close).not.toHaveBeenCalled();
    } finally {
      release.resolve();
      await turn;
    }
    await vi.waitFor(() => expect(f.manager.snapshot().servers).toEqual([]));
    expect(close).toHaveBeenCalledOnce();
  });

  it('runs the install hook for equal validated logs and rejects invalid prefixes before the hook', async () => {
    let installs = 0;
    const hooks = {
      installAuthoritySync(apply: () => void) {
        installs++;
        apply();
      },
    };
    const f = await fixture(undefined, hooks);
    await f.manager.configure(0, f.config);
    const valid = await f.store.read();
    const beforeEqual = installs;
    await f.source.refresh();
    expect(installs).toBe(beforeEqual + 1);
    const beforeInvalid = installs;
    const read = vi.spyOn(f.store, 'read');
    try {
      read.mockResolvedValueOnce({ ...valid, sequence: valid.sequence + 1 });
      await expect(f.registered.refresh()).rejects.toMatchObject({
        code: 'mcp-authority-protocol',
      });
      read.mockResolvedValueOnce({
        ...valid,
        events: valid.events.map((event) => ({
          ...event,
          occurredAt: '2010-01-01T00:00:00.000Z',
        })),
      });
      await expect(f.registered.refresh()).rejects.toMatchObject({
        code: 'mcp-authority-protocol',
      });
      expect(installs).toBe(beforeInvalid);
      expect(f.registered.snapshot().stamp.trustSequence).toBe(1);
    } finally {
      read.mockRestore();
    }
  });

  it('rejects a sticky declaration added while configuration is suspended', async () => {
    const entered = deferred();
    const release = deferred();
    const paired = createManagedPluginCompositionFixture();
    const f = await fixture(
      undefined,
      {
        async reservedPluginIds() {
          entered.resolve();
          await release.promise;
          return [];
        },
      },
      paired,
    );
    const configuring = f.manager.configure(0, f.config);
    const settled = expect(configuring).rejects.toMatchObject({ code: 'mcp-conflict' });
    await entered.promise;
    paired.adoptStickyIdsSync(['mcp-fixture']);
    release.resolve();
    await settled;
    expect((await f.store.read()).sequence).toBe(0);
  });

  it('rejects store dispatch when administration closes while configuration is suspended', async () => {
    const entered = deferred();
    const release = deferred();
    const f = await fixture(undefined, {
      async reservedPluginIds() {
        entered.resolve();
        await release.promise;
        return [];
      },
    });
    const configuring = f.manager.configure(0, f.config);
    const settled = expect(configuring).rejects.toMatchObject({ code: 'plugin-host-disposed' });
    await entered.promise;
    f.coordinator.beginOwnedDrainSync();
    release.resolve();
    await settled;
    expect((await f.store.read()).sequence).toBe(0);
  });

  it('preserves nested annotation arrays while redacting without mutating connection metadata', async () => {
    const annotations = {
      groups: [[{ note: 'source-secret', flags: [true, null, 'source-secret'] }], []],
    };
    const f = await fixture(async (options) => ({
      ...connection(options),
      tools: [{ name: 'echo', description: 'echo', inputSchema: { type: 'object' }, annotations }],
    }));
    const added = await f.manager.configure(0, f.config);
    const trusted = await f.manager.trust('fixture', 1, added.servers[0]!.configDigest);
    expect(trusted.servers[0]!.tools[0]!.annotations).toEqual({
      groups: [[{ note: '[REDACTED]', flags: [true, null, '[REDACTED]'] }], []],
    });
    expect(annotations.groups[0]![0]!.note).toBe('source-secret');
    expect(JSON.stringify(f.manager.snapshot())).not.toContain('source-secret');
  });

  it('uses the last annotation value when redacted keys collide without failing the management response', async () => {
    const annotations = { 'source-secret': 'first', '[REDACTED]': 'source-secret last' };
    const f = await fixture(async (options) => ({
      ...connection(options),
      tools: [{ name: 'echo', description: 'echo', inputSchema: { type: 'object' }, annotations }],
    }));
    const added = await f.manager.configure(0, f.config);
    const trusted = await f.manager.trust('fixture', 1, added.servers[0]!.configDigest);
    expect(trusted.result.applied).toBe(true);
    expect(trusted.servers[0]!.tools[0]!.annotations).toEqual({ '[REDACTED]': '[REDACTED] last' });
    expect(annotations).toEqual({ 'source-secret': 'first', '[REDACTED]': 'source-secret last' });
    expect(JSON.stringify(f.manager.snapshot())).not.toContain('source-secret');
  });

  it('does not launch before exact trust; freezes env, rebuilds explicitly, and tracks stale/EOF per instance', async () => {
    const f = await fixture();
    const configured = await f.manager.configure(0, f.config);
    expect(configured.authoritySequence).toBe(1);
    expect(configured.servers[0]?.state).toBe('untrusted');
    expect(f.connect).not.toHaveBeenCalled();
    expect(f.manager.snapshot().authoritySequence).toBe(1);
    expect(f.connect).not.toHaveBeenCalled();
    await expect(
      f.manager.trust('fixture', 0, configured.servers[0]!.configDigest),
    ).rejects.toMatchObject({ code: 'mcp-conflict' });
    const trusted = await f.manager.trust('fixture', 1, configured.servers[0]!.configDigest);
    expect(trusted.servers[0]?.state).toBe('loaded');
    expect(f.launches).toHaveLength(1);
    expect(f.launches[0]?.env).toEqual({ TOKEN: 'source-secret' });
    expect(Object.isFrozen(f.launches[0]?.env)).toBe(true);
    expect(JSON.stringify(trusted)).not.toContain('source-secret');
    f.launches[0]!.onStale?.();
    expect(f.manager.snapshot().servers[0]?.stale).toBe(true);
    expect(f.launches).toHaveLength(1);
    const reloaded = await f.manager.reload(2);
    expect(f.launches).toHaveLength(2);
    expect(reloaded.servers[0]?.stale).toBe(false);
    f.launches[0]!.onStale?.();
    f.launches[0]!.onClosed?.();
    expect(f.manager.snapshot().servers[0]?.state).toBe('loaded');
    f.launches[1]!.onClosed?.();
    expect(f.manager.snapshot().servers[0]?.state).toBe('failed');
    expect(f.manager.snapshot().servers[0]?.active?.generation).toBe(reloaded.generation.id);
    expect(f.manager.snapshot().authoritySequence).toBe(2);
  });
  it('keeps durable revoke authoritative through failed rebuild and later reload', async () => {
    const f = await fixture();
    const added = await f.manager.configure(0, f.config);
    await f.manager.trust('fixture', 1, added.servers[0]!.configDigest);
    const revoked = await f.manager.revoke('fixture', 2);
    expect(revoked.authoritySequence).toBe(3);
    expect(revoked.servers[0]?.state).toBe('untrusted');
    expect(revoked.servers[0]?.active).toBeUndefined();
    await f.manager.reload(3);
    expect(f.launches).toHaveLength(1);
  });
  it('isolates safe startup failures and allows explicit retry without changing trust', async () => {
    let fail = true;
    const f = await fixture(async (options) => {
      if (fail) throw new McpClientError('mcp-connect-failed');
      return connection(options);
    });
    const added = await f.manager.configure(0, f.config);
    const trusted = await f.manager.trust('fixture', 1, added.servers[0]!.configDigest);
    expect(trusted.servers[0]?.state).toBe('failed');
    expect(trusted.result.applied).toBe(false);
    expect(trusted.servers[0]?.enabled).toBe(true);
    expect(trusted.servers[0]?.trustedDigest).toBe(added.servers[0]!.configDigest);
    fail = false;
    expect((await f.manager.reload(2)).servers[0]?.state).toBe('loaded');
  });
  it('rejects stale reload CAS and colliding IDs before an authority append or launch', async () => {
    const f = await fixture();
    const added = await f.manager.configure(0, f.config);
    await expect(f.manager.reload(0)).rejects.toMatchObject({ code: 'mcp-conflict' });
    await expect(f.manager.update('another', 1, f.config)).rejects.toMatchObject({
      code: 'mcp-invalid',
    });
    expect(added.authoritySequence).toBe(1);
    expect(f.launches).toHaveLength(0);
  });
  it('reserves the entire candidate before spawning and quarantines failed cleanup allocations', async () => {
    let closing = false;
    const f = await fixture(async (options) => {
      const value = connection(options);
      value.close = vi.fn(async () => {
        options.onClosed?.();
        if (closing) throw new Error('private cleanup text');
      });
      return value;
    });
    const added = await f.manager.configure(0, f.config);
    await f.manager.trust('fixture', 1, added.servers[0]!.configDigest);
    closing = true;
    for (let index = 0; index < 31; index++) await f.manager.reload(2);
    expect(f.launches).toHaveLength(32);
    const before = f.manager.snapshot().generation.id;
    const rejected = await f.manager.reload(2);
    expect(rejected.result.applied).toBe(false);
    expect(rejected.generation.id).toBe(before);
    expect(f.launches).toHaveLength(32);
    expect(JSON.stringify(rejected)).not.toContain('private cleanup text');
    // These intentional quarantines are reported at shutdown; cleanup the test explicitly.
    await expect(f.coordinator.dispose()).rejects.toThrow();
    cleanups.pop();
  });
  it('keeps failed initialization cleanup reservations instead of reclaiming them at onClosed', async () => {
    const f = await fixture(async (options) => {
      options.onClosed?.();
      throw new McpClientError('mcp-connect-failed', { cleanupFailed: true });
    });
    const added = await f.manager.configure(0, f.config);
    await f.manager.trust('fixture', 1, added.servers[0]!.configDigest);
    for (let index = 0; index < 31; index++) await f.manager.reload(2);
    expect(f.launches).toHaveLength(32);
    const before = f.manager.snapshot().generation.id;
    const rejected = await f.manager.reload(2);
    expect(rejected.result.applied).toBe(false);
    expect(rejected.generation.id).toBe(before);
    expect(f.launches).toHaveLength(32);
    await expect(f.coordinator.dispose()).rejects.toThrow();
    cleanups.pop();
  });
  it('retains old pinned connections, uses a fresh next-turn connection, and immediate revoke aborts every generation', async () => {
    const ready: Promise<void>[] = [];
    const f = await fixture(async (options) => {
      const value = connection(options);
      let notify!: () => void;
      ready.push(
        new Promise<void>((done) => {
          notify = done;
        }),
      );
      value.callTool = async (_name, _input, callOptions) => {
        notify();
        return new Promise((_resolve, reject) => {
          callOptions.signal.addEventListener(
            'abort',
            () => reject(new McpClientError('mcp-cancelled')),
            { once: true },
          );
        });
      };
      return value;
    });
    const added = await f.manager.configure(0, f.config);
    const first = await f.manager.trust('fixture', 1, added.servers[0]!.configDigest);
    const tool = first.servers[0]!.tools[0]!.toolName;
    const run = (id: string) => {
      const iterator = f.coordinator.runner.run({
        sessionId: id,
        provider: 'mock',
        model: 'test',
        permissionMode: 'yolo',
        userMessage: { role: 'user', content: [{ type: 'text', text: `/tool ${tool} {}` }] },
      });
      return (async () => {
        for await (const _event of iterator) {
          void _event;
        }
      })().catch(() => undefined);
    };
    const old = run('pinned-old');
    await ready[0];
    const second = await f.manager.reload(2);
    expect(second.servers[0]?.drainingGenerations).toEqual([
      { generation: first.generation.id, configDigest: added.servers[0]!.configDigest },
    ]);
    const current = run('pinned-current');
    await ready[1];
    const abort = vi.spyOn(f.runtime.serverHost.controller()!, 'abortActiveRuns');
    try {
      await f.manager.revoke('fixture', 2, { immediate: true });
      expect(abort).toHaveBeenCalledOnce();
    } finally {
      abort.mockRestore();
    }
    await Promise.all([old, current]);
    expect(f.manager.snapshot().servers[0]?.state).toBe('untrusted');
    expect(f.manager.snapshot().servers[0]?.drainingGenerations).toEqual([]);
  });
  it('retries immediate cancellation when a previous decision left membership retained', async () => {
    const f = await fixture();
    const added = await f.manager.configure(0, f.config);
    const trusted = await f.manager.trust('fixture', 1, added.servers[0]!.configDigest);
    f.failAssembly(true);
    await f.manager.disable('fixture', 2);
    const abort = vi.spyOn(f.runtime.serverHost.controller()!, 'abortActiveRuns');
    try {
      const replayed = await f.manager.disable('fixture', 3, { immediate: true });
      expect(replayed.authoritySequence).toBe(3);
      expect(replayed.generation.id).toBe(trusted.generation.id);
      expect(abort).toHaveBeenCalledOnce();
    } finally {
      abort.mockRestore();
    }
  });
  it('keeps append failures inert and blocks durable revoke through assembly failure and subsequent reload', async () => {
    const f = await fixture();
    const added = await f.manager.configure(0, f.config);
    await f.manager.trust('fixture', 1, added.servers[0]!.configDigest);
    const before = f.manager.snapshot().generation.id;
    const mutate = vi.spyOn(f.store, 'mutate').mockRejectedValueOnce(new Error('disk failed'));
    await expect(f.manager.revoke('fixture', 2)).rejects.toThrow('disk failed');
    expect(f.manager.snapshot().generation).toEqual({ id: before, acceptingRuns: true });
    expect(f.manager.snapshot().servers[0]?.state).toBe('loaded');
    mutate.mockRestore();
    f.failAssembly(true);
    const revoked = await f.manager.revoke('fixture', 2);
    expect(JSON.stringify(revoked)).not.toContain('private assembly error');
    expect(revoked.result.applied).toBe(false);
    expect(revoked.authoritySequence).toBe(3);
    expect(revoked.generation.acceptingRuns).toBe(false);
    const failed = await f.manager.reload(3);
    expect(failed.generation.acceptingRuns).toBe(false);
    expect(f.launches).toHaveLength(1);
    f.failAssembly(false);
    expect((await f.manager.reload(3)).generation.acceptingRuns).toBe(true);
    expect(f.launches).toHaveLength(1);
  });
  describe('content digest binding', () => {
    async function script(directory: string, body = 'exit 0') {
      const file = join(await realpath(directory), 'server.sh');
      await writeFile(file, `#!/bin/sh\n${body}\n`);
      await chmod(file, 0o755);
      return file;
    }

    it('refuses to launch after the command file changes and recovers after re-saving and re-trusting', async () => {
      const f = await fixture();
      const config = { ...f.config, command: await script(f.directory) };
      const configured = await f.manager.configure(0, config);
      const trusted = await f.manager.trust('fixture', 1, configured.servers[0]!.configDigest);
      expect(trusted.servers[0]?.state).toBe('loaded');
      expect(f.launches).toHaveLength(1);

      await script(f.directory, 'exit 1');
      const reloaded = await f.manager.reload(2);
      expect(f.launches).toHaveLength(1);
      expect(reloaded.servers[0]?.state).toBe('changed');
      expect(reloaded.servers[0]?.issue).toMatchObject({ code: 'mcp-content-changed' });
      expect(reloaded.servers[0]?.issue?.message).toContain('内容已变更，需要重新信任');
      await expect(
        f.manager.trust('fixture', 2, reloaded.servers[0]!.configDigest),
      ).rejects.toMatchObject({ code: 'mcp-content-changed' });

      const updated = await f.manager.update('fixture', 2, config);
      expect(updated.servers[0]?.state).toBe('changed');
      expect(updated.servers[0]?.configDigest).not.toBe(configured.servers[0]!.configDigest);
      const retrusted = await f.manager.trust(
        'fixture',
        updated.authoritySequence,
        updated.servers[0]!.configDigest,
      );
      expect(retrusted.servers[0]?.state).toBe('loaded');
      expect(f.launches).toHaveLength(2);
    });

    it('binds contentPaths directories and rejects directories over the limits', async () => {
      const f = await fixture();
      const bound = join(await realpath(f.directory), 'bound');
      await mkdir(bound);
      await writeFile(join(bound, 'server.js'), 'one');
      const config = { ...f.config, contentPaths: [bound] };
      const configured = await f.manager.configure(0, config);
      expect(configured.servers[0]?.config.contentPaths).toEqual([bound]);
      await f.manager.trust('fixture', 1, configured.servers[0]!.configDigest);
      expect(f.launches).toHaveLength(1);

      await writeFile(join(bound, 'server.js'), 'two');
      const reloaded = await f.manager.reload(2);
      expect(f.launches).toHaveLength(1);
      expect(reloaded.servers[0]?.state).toBe('changed');

      const huge = join(await realpath(f.directory), 'huge');
      await mkdir(huge);
      await Promise.all(
        Array.from({ length: 1001 }, (_, index) => writeFile(join(huge, `${index}.txt`), 'x')),
      );
      await expect(
        f.manager.update('fixture', 2, { ...f.config, contentPaths: [huge] }),
      ).rejects.toMatchObject({ code: 'mcp-content-too-large' });
    });

    it('treats a policy 1 trust record as changed and requires one fresh trust', async () => {
      const f = await fixture();
      const config = await normalizeMcpServerConfig(f.config);
      const read = () => f.store.read();
      let log = await read();
      log = await f.store.mutate(
        { kind: 'create', config },
        { expectedSequence: log.sequence, knownPrefix: log.events },
      );
      const digest = log.records[0]!.configDigest;
      expect(log.records[0]?.policyVersion).toBe(1);
      await f.store.mutate(
        { kind: 'trust', serverId: 'fixture', configDigest: digest },
        { expectedSequence: log.sequence, knownPrefix: log.events },
      );
      const reloaded = await f.manager.reload(2);
      expect(f.launches).toHaveLength(0);
      expect(reloaded.servers[0]?.state).toBe('changed');
      expect(reloaded.servers[0]?.issue).toMatchObject({ code: 'mcp-policy-outdated' });
      await expect(
        f.manager.trust('fixture', reloaded.authoritySequence, digest),
      ).rejects.toMatchObject({ code: 'mcp-conflict' });

      const updated = await f.manager.update('fixture', reloaded.authoritySequence, f.config);
      expect(updated.servers[0]?.state).toBe('changed');
      const trusted = await f.manager.trust(
        'fixture',
        updated.authoritySequence,
        updated.servers[0]!.configDigest,
      );
      expect(trusted.servers[0]?.state).toBe('loaded');
      expect(f.launches).toHaveLength(1);
    });
  });
});
