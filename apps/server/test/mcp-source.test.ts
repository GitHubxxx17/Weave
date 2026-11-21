import { mkdtemp, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { McpClientError, type ConnectMcpOptions, type McpConnection } from '@weave/mcp-client';
import { createSqliteMcpAuthorityStore } from '../src/mcp-authority-store.js';
import { createMcpExtensionSource } from '../src/mcp-source.js';
import { createExtensionCoordinator } from '../src/extension-coordinator.js';
import {
  createServerRuntime,
  createServerAgentRunner,
  assembleServerGeneration,
  disposeServerPlugins,
} from '../src/runtime.js';

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
async function fixture(connectOverride?: (options: ConnectMcpOptions) => Promise<McpConnection>) {
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
  });
  const coordinator = createExtensionCoordinator({
    host: runtime.serverHost,
    sources: [source.register],
    assemble: (kernelPlugins) => {
      if (failAssembly) throw new Error('private assembly error');
      return assembleServerGeneration(runtime, { kernelPlugins });
    },
  });
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
    config,
    runtime,
    failAssembly: (value: boolean) => {
      failAssembly = value;
    },
  };
}

describe('MCP source authority and generation ownership', () => {
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
    await f.manager.revoke('fixture', 2, { immediate: true });
    await Promise.all([old, current]);
    expect(f.manager.snapshot().servers[0]?.state).toBe('untrusted');
    expect(f.manager.snapshot().servers[0]?.drainingGenerations).toEqual([]);
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
});
