import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { PluginHostError } from '@weave/plugin-host';
import type { ConnectMcpOptions } from '@weave/mcp-client';
import { createSqliteMcpAuthorityStore } from '../src/mcp-authority-store.js';
import { createMcpExtensionSource } from '../src/mcp-source.js';
import { createExtensionCoordinator } from '../src/extension-coordinator.js';
import {
  createServerRuntime,
  createServerAgentRunner,
  assembleServerGeneration,
  disposeServerPlugins,
} from '../src/runtime.js';

async function probe(other = false) {
  const directory = await mkdtemp(join(tmpdir(), 'weave-source-review-'));
  const cwd = join(directory, 'cwd');
  await mkdir(cwd);
  const store = createSqliteMcpAuthorityStore({ filename: join(directory, 'db.sqlite') });
  const runtime = createServerRuntime();
  await runtime.start();
  await createServerAgentRunner(runtime);
  const source = createMcpExtensionSource({
    store,
    connect: async () => ({
      tools: [],
      stderrBytes: 0,
      validateInput: () => ({ valid: true }),
      callTool: async () => ({ content: [] }),
      close: async () => {},
    }),
  });
  let breakPaths = false;
  const coordinator = createExtensionCoordinator({
    host: runtime.serverHost,
    sources: [
      source.register,
      ...(other
        ? [
            () => ({
              id: 'local-esm',
              snapshot: () => ({
                stamp: { revision: 0, trustSequence: 0 },
                eligible: [{ pluginId: 'bad-esm', identity: 'bad-esm' }],
              }),
              refresh: async () => {},
              close: async () => {},
              prepare: async (
                stamp: { revision: number; trustSequence: number },
                options: { excluded: ReadonlySet<string> },
              ) => ({
                stamp,
                items: [],
                failures: options.excluded.has('bad-esm')
                  ? []
                  : [
                      {
                        pluginId: 'bad-esm',
                        identity: 'bad-esm',
                        kind: 'load' as const,
                        error: new PluginHostError('plugin-load-failed', 'Bad ESM'),
                      },
                    ],
                recheck: async () => true,
                dispose: async () => {},
              }),
            }),
          ]
        : []),
    ],
    assemble: async (kernelPlugins) => {
      const result = await assembleServerGeneration(runtime, { kernelPlugins });
      if (breakPaths) await rm(cwd, { recursive: true });
      return result;
    },
  });
  const manager = source.facade(coordinator);
  await coordinator.reload();
  const created = await manager.configure(0, {
    schemaVersion: 1,
    id: 'fixture',
    label: 'Fixture',
    transport: 'stdio',
    command: await realpath(process.execPath),
    args: [],
    cwd: await realpath(cwd),
    env: {},
  });
  return {
    manager,
    created,
    breakPaths: () => {
      breakPaths = true;
    },
    async close() {
      await coordinator.dispose();
      await disposeServerPlugins(runtime);
      await runtime.stop();
      await store.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

it('probe path failure after durable trust remains a 200-style failed mutation', async () => {
  const f = await probe();
  try {
    f.breakPaths();
    await expect(
      f.manager.trust('fixture', 1, f.created.servers[0]!.configDigest),
    ).resolves.toMatchObject({
      authoritySequence: 2,
      result: { applied: false },
    });
  } finally {
    await f.close();
  }
});

it('probe unrelated source failure is reported in a complete MCP rebuild', async () => {
  const f = await probe(true);
  try {
    const result = await f.manager.reload(1);
    expect(result.result.applied).toBe(false);
    expect(result.result.failed).toContainEqual(expect.objectContaining({ id: 'bad-esm' }));
  } finally {
    await f.close();
  }
});

it('synchronously cancels an already prepared MCP candidate before waiting for another source', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'weave-source-cancel-'));
  const store = createSqliteMcpAuthorityStore({ filename: join(directory, 'db.sqlite') });
  const runtime = createServerRuntime();
  await runtime.start();
  await createServerAgentRunner(runtime);
  let preparedOptions: ConnectMcpOptions | undefined;
  const source = createMcpExtensionSource({
    store,
    connect: async (options) => {
      preparedOptions = options;
      return {
        tools: [],
        stderrBytes: 0,
        validateInput: () => ({ valid: true }),
        callTool: async () => ({ content: [] }),
        close: async () => {},
      };
    },
  });
  let hold = false;
  let entered!: () => void;
  const barrierEntered = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  const coordinator = createExtensionCoordinator({
    host: runtime.serverHost,
    sources: [
      source.register,
      () => ({
        id: 'barrier',
        snapshot: () => ({ stamp: { revision: 0, trustSequence: 0 }, eligible: [] }),
        refresh: async () => {},
        close: async () => {},
        prepare: async (stamp) => {
          if (hold) {
            entered();
            await barrier;
          }
          return {
            stamp,
            items: [],
            failures: [],
            recheck: async () => true,
            dispose: async () => {},
          };
        },
      }),
    ],
    assemble: (kernelPlugins) => assembleServerGeneration(runtime, { kernelPlugins }),
  });
  const manager = source.facade(coordinator);
  let mutation: Promise<unknown> | undefined;
  try {
    await coordinator.reload();
    const created = await manager.configure(0, {
      schemaVersion: 1,
      id: 'fixture',
      label: 'Fixture',
      transport: 'stdio',
      command: await realpath(process.execPath),
      args: [],
      cwd: await realpath(directory),
      env: {},
    });
    hold = true;
    mutation = manager
      .trust('fixture', 1, created.servers[0]!.configDigest)
      .catch((error: unknown) => error);
    await barrierEntered;
    const stopping = coordinator.dispose();
    expect(preparedOptions?.signal.aborted).toBe(true);
    release();
    await mutation;
    await stopping;
  } finally {
    release();
    await mutation;
    await coordinator.dispose();
    await disposeServerPlugins(runtime);
    await runtime.stop();
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
