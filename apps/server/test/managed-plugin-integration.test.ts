import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { connectMcp } from '@weave/mcp-client';
import * as pluginHost from '@weave/plugin-host';
import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { serverHostVersion } from '../src/host-version.js';
import { startServer } from '../src/main.js';
import { mcpMutationResultSchema } from '../src/mcp-management-types.js';
import { openOwnedPluginArtifactStore } from '../src/owned-plugin-artifact-store.js';
import { createSqlitePluginAuthorityDatabase } from '../src/plugin-authority-store.js';
import {
  commandListResponseSchema,
  pluginListResponseSchema,
  pluginMutationResponseSchema,
} from '../src/plugin-catalog.js';
import { PluginStoreOwnershipError } from '../src/plugin-store-ownership-types.js';
import { createSqlitePluginTrustStore } from '../src/plugin-trust-store.js';
import {
  createServerAgentRunner,
  getServerSessionStore,
  listServerCommands,
  listServerPlugins,
} from '../src/runtime.js';
import {
  createRealManagedCompositionFixture,
  runFixtureTools,
} from './support/managed-plugin-composition-fixture.js';
import { activateInput, decisionInput, importInput } from './support/plugin-authority-fixtures.js';

type Fixture = Awaited<ReturnType<typeof createRealManagedCompositionFixture>>;
type Composed = ReturnType<Fixture['compose']>;

function assertJointCatalog(
  list: ReturnType<typeof pluginListResponseSchema.parse>,
  commands: ReturnType<typeof commandListResponseSchema.parse>,
  manualDirectory: string,
  managedDigest: string,
) {
  expect(list.local?.generation.plugins.map(({ id }) => id)).toEqual(['manual-echo']);
  const managed = list.plugins.filter(({ id }) => id === 'managed-echo');
  expect(managed).toEqual([
    expect.objectContaining({
      origin: 'kernel',
      provides: expect.objectContaining({ tools: ['managed_echo'] }),
    }),
  ]);
  expect(managed[0]?.local).toBeUndefined();
  expect(JSON.stringify(list)).not.toContain(managedDigest);
  const remote = list.plugins.find(({ id }) => id === 'mcp-remote')!;
  expect(remote).toMatchObject({ origin: 'kernel', host: 'mcp' });
  expect(remote.local).toBeUndefined();
  expect(list.plugins.find(({ id }) => id === 'manual-echo')).toMatchObject({
    origin: 'local',
    local: { directory: manualDirectory },
    provides: { tools: ['manual_echo'], commands: ['manual-echo'] },
  });
  expect(commands.commands).toContainEqual(
    expect.objectContaining({ name: 'manual-echo', pluginId: 'manual-echo' }),
  );
  return remote;
}

function catalogApp(f: Fixture, host: Composed) {
  return createApp(f.runtime, {
    pluginCatalog: () => listServerPlugins(f.runtime),
    commandCatalog: () => listServerCommands(f.runtime),
    generationSnapshot: host.coordinator.generationSnapshot,
    pluginManager: host.pluginHost,
    mcpManager: host.mcpManager,
  });
}

function post(body: unknown): RequestInit {
  return {
    method: 'POST',
    headers: { Host: '127.0.0.1', 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

const stickyTrustIssue = {
  code: 'plugin-trust-invalid',
  message: 'Managed plugin trust requires the combined managed API',
};

function ownershipLoss() {
  return new PluginStoreOwnershipError('plugin-store-ownership-lost', 'Private lease failure');
}

function echoConnection(
  callTool: Awaited<ReturnType<typeof connectMcp>>['callTool'] = async () => ({
    content: [{ type: 'text', text: 'MCP reply' }],
  }),
) {
  return {
    tools: [{ name: 'echo', description: 'Echo', inputSchema: { type: 'object' } }],
    stderrBytes: 0,
    validateInput: () => ({ valid: true as const }),
    callTool,
    close: vi.fn(async () => undefined),
  };
}

describe('joint managed, manual and MCP Generation', () => {
  it('serves cached manual-only local membership and published kernel rows', async () => {
    const f = await createRealManagedCompositionFixture();
    try {
      const managed = await f.seedManaged('managed-echo', 'managed result');
      const manual = await f.seedManual('manual-echo', 'manual result');
      await f.seedMcp('remote');
      const trustReads = vi.spyOn(f.authority.trust, 'events');
      const host = f.compose();
      await host.coordinator.reload();
      const app = catalogApp(f, host);
      const reads = [f.readOwned, f.readAuthoritySync, f.readMcp, f.assertHeldSync, trustReads];
      const counts = reads.map((read) => read.mock.calls.length);
      expect(counts.every((count) => count > 0)).toBe(true);
      const launches = await readFile(f.launchLog, 'utf8');
      const list = pluginListResponseSchema.parse(await (await app.request('/plugins')).json());

      const commands = commandListResponseSchema.parse(
        await (await app.request('/commands')).json(),
      );
      assertJointCatalog(list, commands, manual.directory, managed.digest);
      await f.seedManual('new-on-disk', 'not scanned', false);
      expect(await (await app.request('/plugins')).json()).toEqual(list);
      expect(await (await app.request('/commands')).json()).toEqual(commands);
      expect(reads.map((read) => read.mock.calls.length)).toEqual(counts);
      expect(await readFile(f.launchLog, 'utf8')).toBe(launches);
    } finally {
      await f.close();
    }
  });

  it('keeps a sticky collision diagnostic free of managed trust before any same-ID publication', async () => {
    const f = await createRealManagedCompositionFixture();
    try {
      const managed = await f.seedManaged('notes', 'managed result');
      const manual = await f.seedManual('notes', 'different manual result', false);
      expect(manual.digest).not.toBe(managed.digest);
      const host = f.compose();
      await host.coordinator.reload();
      const response = await catalogApp(f, host).request('/plugins');
      const list = pluginListResponseSchema.parse(await response.json());
      const row = list.plugins.find(({ id }) => id === 'notes');
      expect(row).toMatchObject({
        origin: 'local',
        state: 'invalid',
        error: {
          code: 'plugin-id-reserved',
          message: 'Plugin id "notes" is reserved by a managed plugin',
        },
        local: { directory: manual.directory, manifest: manual.manifest, enabled: false },
      });
      expect(row?.local?.trusted).toBeUndefined();
      expect(JSON.stringify(list)).not.toContain(managed.digest);
      expect(f.authority.snapshotSync().trustEvents).toContainEqual(
        expect.objectContaining({ pluginId: 'notes', digest: managed.digest }),
      );
    } finally {
      await f.close();
    }
  });

  it('rejects every legacy trust mutation for a freshly uninstalled sticky ID', async () => {
    const f = await createRealManagedCompositionFixture();
    try {
      const manual = await f.seedManual('notes', 'manual result');
      const host = f.compose();
      await host.coordinator.reload();
      await f.seedManaged('notes', 'managed result');
      f.authority.commitSync(
        decisionInput('uninstall', 'remove-notes', f.authority.snapshotSync()),
      );
      const before = f.authority.snapshotSync();
      const app = catalogApp(f, host);
      for (const [path, request] of [
        ['trust', post({ digest: manual.digest })],
        ['enable', post({})],
        ['disable?immediate=true', post({})],
        ['trust?immediate=true', { ...post({}), method: 'DELETE' }],
      ] as const) {
        const response = await app.request('/plugins/notes/' + path, request);
        expect({ status: response.status, body: await response.json() }).toEqual({
          status: 400,
          body: { error: stickyTrustIssue },
        });
      }
      expect(f.authority.snapshotSync()).toEqual(before);
    } finally {
      await f.close();
    }
  });

  it.each(['idempotent-trust', 'immediate-retry', 'cached-rejection'] as const)(
    'checks current sticky authority during %s after the initial dispatch',
    async (phase) => {
      const f = await createRealManagedCompositionFixture();
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      let mutation: Promise<unknown> | undefined;
      try {
        const manual = await f.seedManual('notes', 'manual result', phase !== 'immediate-retry');
        // Hold the old trust prefix for the in-flight package read.
        const read = vi.fn(f.authority.trust.events);
        const host = f.compose({
          localTrustStore: { events: read, append: f.authority.trust.append },
        });
        await host.coordinator.reload();
        const retry = vi.spyOn(host.coordinator, 'retryImmediateRevocation');
        read.mockImplementationOnce(async () => {
          const before = await f.authority.trust.events();
          entered.resolve();
          await release.promise;
          return before;
        });
        mutation = (
          phase === 'immediate-retry'
            ? host.pluginHost!.revoke('notes', { immediate: true })
            : host.pluginHost!.trust('notes', manual.digest)
        ).catch((failure: unknown) => failure);
        await Promise.race([
          entered.promise,
          mutation.then(() => {
            throw new Error('Expected gated manual trust read');
          }),
        ]);
        f.authority.commitSync(
          importInput('sticky-during-read', f.authority.snapshotSync().heads.installSequence),
        );
        if (phase === 'cached-rejection') host.managed!.adoptLatestAuthoritySync();
        release.resolve();
        expect(await mutation).toBeInstanceOf(Error);
        expect(await mutation).toMatchObject(stickyTrustIssue);
        expect(retry).not.toHaveBeenCalled();
      } finally {
        release.resolve();
        await mutation;
        await f.close();
      }
    },
  );

  it('checks the main authority synchronously before dispatching an override append', async () => {
    const f = await createRealManagedCompositionFixture();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const databaseFile = join(f.root, 'unbound.sqlite');
    const override = createSqlitePluginTrustStore({ filename: join(f.root, 'override.sqlite') });
    const events = vi.spyOn(override, 'events');
    const append = vi.spyOn(override, 'append');
    const authority = createSqlitePluginAuthorityDatabase({ filename: databaseFile });
    let server: Awaited<ReturnType<typeof startServer>> | undefined;
    let response: Promise<Response> | undefined;
    try {
      const previous = await f.seedManual('other', 'override prefix', false);
      await override.append({
        kind: 'trusted',
        pluginId: 'other',
        digest: previous.digest,
        manifest: previous.manifest,
      });
      const manual = await f.seedManual('notes', 'manual result', false);
      server = await startServer(0, {
        databaseFile,
        pluginsDirectory: f.pluginsDirectory,
        environment: {},
        pluginTrustStore: override,
      });
      const prior = await override.events();
      append.mockClear();
      events.mockImplementationOnce(async () => {
        entered.resolve();
        await release.promise;
        return prior;
      });
      const base = `http://127.0.0.1:${server.port}`;
      response = fetch(base + '/plugins/notes/trust', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ digest: manual.digest }),
      });
      await Promise.race([
        entered.promise,
        response.then(() => {
          throw new Error('Expected gated override read');
        }),
      ]);
      authority.commitSync(
        importInput('sticky-at-override', authority.snapshotSync().heads.installSequence),
      );
      release.resolve();
      const result = await response;
      expect({ status: result.status, body: await result.json() }).toEqual({
        status: 400,
        body: { error: stickyTrustIssue },
      });
      expect(append).not.toHaveBeenCalled();
      expect(await override.events()).toEqual(prior);
      expect(authority.snapshotSync().trustEvents).toEqual([]);
      const list = pluginListResponseSchema.parse(await (await fetch(base + '/plugins')).json());
      expect(list.local?.trustSequence).toBe(1);
      expect(list.plugins.find(({ id }) => id === 'other')).toMatchObject({
        origin: 'local',
        state: 'loaded',
      });
    } finally {
      release.resolve();
      await Promise.allSettled([response]);
      await server?.stop();
      await override.close();
      await authority.close();
      await f.close();
    }
  });

  it.each(['import', 'commit'] as const)(
    'keeps the private managed %s exception out of catalog and reload JSON',
    async (phase) => {
      const f = await createRealManagedCompositionFixture();
      const payload = join(f.root, 'private-managed-payload', phase, 'payload.txt');
      const original = new Error(payload);
      const createSource = pluginHost.createLocalPluginSource;
      let failImport = false;
      const inject = vi
        .spyOn(pluginHost, 'createLocalPluginSource')
        .mockImplementationOnce((options) =>
          createSource({
            ...options,
            async importModule(url) {
              if (failImport && url.includes(staged.digest)) throw original;
              return import(url);
            },
          }),
        );
      const commit = vi.spyOn(f.runtime.serverHost, 'commit');
      let staged: Awaited<ReturnType<Fixture['seedManaged']>>;
      try {
        staged = await f.seedManaged('notes', 'managed result', false);
        await f.seedManual('manual-echo', 'manual result');
        await f.seedMcp('remote');
        const host = f.compose();
        await host.coordinator.reload();
        if (phase === 'import') failImport = true;
        else
          commit.mockImplementation(() => {
            throw original;
          });
        const input = activateInput('private-failure', f.authority.snapshotSync(), {
          pluginId: 'notes',
          digest: staged.digest,
          manifest: staged.descriptor.manifest,
          files: staged.files,
          bytes: staged.bytes,
        });
        if (input.request.command.kind !== 'activate') throw new Error('Expected activation');
        const application = await host.applyManagedSelection!({
          ...input.request,
          command: input.request.command,
        });
        if (application.kind !== 'committed') throw new Error('Expected committed activation');
        expect(application.application.status).toBe('failed');
        expect(
          phase === 'import'
            ? (application.application.cause as Error).cause
            : application.application.cause,
        ).toBe(original);
        const app = catalogApp(f, host);
        const sequence = host.mcpManager!.snapshot().authoritySequence;
        const pluginResponse = await app.request('/plugins/reload', post({}));
        const catalogResponse = await app.request('/plugins');
        const mcpResponse = await app.request('/mcp/reload', post({ expectedSequence: sequence }));
        expect([pluginResponse.status, catalogResponse.status, mcpResponse.status]).toEqual([
          200, 200, 200,
        ]);
        const serialized = await Promise.all([
          pluginResponse.text(),
          catalogResponse.text(),
          mcpResponse.text(),
        ]);
        const projected = host.coordinator.snapshot();
        const plugin = pluginMutationResponseSchema.parse(JSON.parse(serialized[0]!));
        const catalog = pluginListResponseSchema.parse(JSON.parse(serialized[1]!));
        const mcp = mcpMutationResultSchema.parse(JSON.parse(serialized[2]!));
        expect(serialized.join('\n')).not.toContain(payload);
        expect(serialized.join('\n')).not.toContain('"notes"');
        expect(plugin.result.failed).toEqual([]);
        expect(mcp.result.failed).toEqual([]);
        expect(mcp.result.applied).toBe(false);
        expect(mcp.result.decisionSequence).toBe(sequence);
        expect(mcp.servers).toEqual(host.mcpManager!.snapshot().servers);
        if (phase === 'import') {
          expect(projected.failed).toMatchObject([
            {
              pluginId: 'notes',
              origin: 'managed',
              error: { code: 'plugin-load-failed', message: 'Managed plugin preparation failed' },
            },
          ]);
          expect(plugin.result.error).toBeUndefined();
        } else {
          const safe = {
            code: 'plugin-reload-failed',
            message: 'Extension generation could not be published',
          };
          expect(plugin.result.error).toEqual(safe);
          expect(catalog.local?.error).toEqual(safe);
          expect(mcp.result.error).toEqual(safe);
        }
      } finally {
        commit.mockRestore();
        inject.mockRestore();
        await f.close();
      }
    },
  );

  it('loads the registered selection through live startup and an option-less managed restart', async () => {
    const f = await createRealManagedCompositionFixture();
    let first: Awaited<ReturnType<typeof startServer>> | undefined;
    let restarted: typeof first;
    try {
      const registration = f.authority.readStartupAuthoritySync().registration!;
      const selected = await f.seedManaged('managed-echo', 'selected result');
      const unusedMarker = join(f.root, 'unselected-imported');
      await f.seedManaged('managed-echo', 'unused result', false, unusedMarker);
      const manual = await f.seedManual('manual-echo', 'manual result');
      await f.seedMcp('remote');
      await f.closeResources();
      const options = {
        databaseFile: f.databaseFile,
        pluginsDirectory: f.pluginsDirectory,
        environment: {},
      };
      first = await startServer(0, {
        ...options,
        managedPluginStore: { initialBinding: 'require-bound' },
      });
      async function observe(server: Awaited<ReturnType<typeof startServer>>) {
        const base = `http://127.0.0.1:${server.port}`;
        const list = pluginListResponseSchema.parse(await (await fetch(base + '/plugins')).json());
        const commands = commandListResponseSchema.parse(
          await (await fetch(base + '/commands')).json(),
        );
        const remote = assertJointCatalog(list, commands, manual.directory, selected.digest);
        const launches = await readFile(f.launchLog, 'utf8');
        expect(await (await fetch(base + '/plugins')).json()).toEqual(list);
        expect(await (await fetch(base + '/commands')).json()).toEqual(commands);
        expect(await readFile(f.launchLog, 'utf8')).toBe(launches);
        const stableRunner = await createServerAgentRunner(server.runtime);
        expect(server.pluginHost?.runner).toBe(stableRunner);
        const events = await runFixtureTools(server.runtime, stableRunner, [
          'managed_echo',
          'manual_echo',
          remote.provides.tools[0]!,
        ]);
        const results = events
          .filter(({ type }) => type === 'tool-result')
          .map((event) => JSON.stringify(event));
        expect(results).toEqual([
          expect.stringContaining('selected result'),
          expect.stringContaining('manual result'),
          expect.stringContaining('done'),
        ]);
        expect(await f.exists(unusedMarker)).toBe(false);
      }
      await observe(first);
      expect(first.pluginHost?.dispose).toBe(first.stop);
      await first.pluginHost!.dispose();
      restarted = await startServer(0, options);
      await observe(restarted);
      await restarted.stop();
      const authority = createSqlitePluginAuthorityDatabase({ filename: f.databaseFile });
      try {
        expect(authority.readStartupAuthoritySync().registration).toEqual(registration);
        const owned = await openOwnedPluginArtifactStore({
          authority,
          directory: registration.binding.storeDirectory,
          initialBinding: 'require-bound',
          hostVersion: serverHostVersion,
          onOwnershipLost: () => undefined,
        });
        try {
          expect(owned.binding).toEqual(registration.binding);
        } finally {
          await owned.close();
        }
      } finally {
        await authority.close();
      }
    } finally {
      try {
        await restarted?.stop();
        await first?.stop();
      } finally {
        await f.close();
      }
    }
  });

  it('runs all three tools on the stable runner and never reads the unselected digest', async () => {
    const f = await createRealManagedCompositionFixture();
    try {
      const managed = await f.seedManaged('managed-echo', 'managed result');
      const marker = join(f.root, 'unselected-imported');
      const unused = await f.seedManaged('managed-echo', 'unused result', false, marker);
      const manual = await f.seedManual('manual-echo', 'manual result');
      await f.seedMcp('remote');
      const controller = f.runtime.serverHost.controller()!;
      const before = controller.current();
      const commit = vi.spyOn(f.runtime.serverHost, 'commit');
      const host = f.compose();
      const result = await host.coordinator.reload();
      const activation = f.authority.snapshotSync().installations[0]!.selection!.activationSequence;
      const current = controller.current();

      expect(commit).toHaveBeenCalledOnce();
      expect(result.generation.id).toBeGreaterThan(before.id);
      expect(result.failed).toEqual([]);
      expect(result.members).toMatchObject([
        {
          sourceId: 'local-esm',
          pluginId: 'managed-echo',
          identity: JSON.stringify(['managed-echo', managed.digest, 'managed', activation]),
          origin: 'managed',
        },
        {
          sourceId: 'local-esm',
          pluginId: 'manual-echo',
          identity: JSON.stringify(['manual-echo', manual.digest]),
          origin: 'manual',
        },
        { sourceId: 'mcp', pluginId: 'mcp-remote' },
      ]);
      expect(host.coordinator.runner).toBe(f.runner);
      expect(host.pluginHost?.runner).toBe(f.runner);
      expect(await createServerAgentRunner(f.runtime)).toBe(f.runner);
      const mcpTool = listServerPlugins(f.runtime).find(({ id }) => id === 'mcp-remote')!
        .contributes!.tools![0]!;
      const turns = [
        ['managed_echo', 'managed result'],
        ['manual_echo', 'manual result'],
        [mcpTool, 'done'],
      ] as const;
      for (const [tool, resultText] of turns) {
        const events = await f.runTool(tool);
        const result = events.find((event) => event.type === 'tool-result');
        expect(result).toBeDefined();
        expect(JSON.stringify(result)).toContain(resultText);
        expect(controller.current()).toBe(current);
      }
      expect((await readFile(f.launchLog, 'utf8')).trim().split('\n')).toHaveLength(1);
      expect(f.readOwned.mock.calls.length).toBeGreaterThanOrEqual(3);
      expect(new Set(f.readOwned.mock.calls.map(([digest]) => digest))).toEqual(
        new Set([managed.digest]),
      );
      expect(f.readOwned.mock.calls.some(([digest]) => digest === unused.digest)).toBe(false);
      expect(await f.exists(marker)).toBe(false);
    } finally {
      await f.close();
    }
  });

  it('retries an MCP connection closed by the final synchronous managed authority read', async () => {
    const f = await createRealManagedCompositionFixture();
    try {
      await f.seedManaged('notes', 'ready');
      await f.seedMcp('remote');
      const connection = echoConnection();
      let onClosed: (() => void) | undefined;
      const host = f.compose({
        mcpConnect: async (options) => {
          onClosed = options.onClosed;
          return connection;
        },
      });
      const before = f.runtime.serverHost.controller()!.current();
      const commit = vi.spyOn(f.runtime.serverHost, 'commit');
      let authorityReadsAfterRecheck = 0;
      f.readAuthoritySync.mockImplementation(() => {
        if (f.readOwned.mock.calls.length === 3 && ++authorityReadsAfterRecheck === 3) {
          expect(f.runtime.serverHost.controller()!.current()).toBe(before);
          onClosed!();
        }
        return f.authority.snapshotSync();
      });

      const result = await host.coordinator.reload();
      expect(commit).toHaveBeenCalledOnce();
      expect(commit.mock.calls[0]![0].resources.plugins.map(({ id }) => id)).not.toContain(
        'mcp-remote',
      );
      expect(result.members).toMatchObject([{ pluginId: 'notes', origin: 'managed' }]);
      expect(result.failed).toMatchObject([
        { sourceId: 'mcp', pluginId: 'mcp-remote', error: { code: 'plugin-load-failed' } },
      ]);
      expect(connection.close).toHaveBeenCalledOnce();
    } finally {
      await f.close();
    }
  });

  it.each(['adoption', 'override trust read'] as const)(
    'signals a gated selected artifact verification even if the %s and fallback withdrawal both throw',
    async (phase) => {
      const f = await createRealManagedCompositionFixture();
      const entered = Promise.withResolvers<AbortSignal>();
      const release = Promise.withResolvers<void>();
      let reload: Promise<unknown> | undefined;
      try {
        await f.seedManaged('notes', 'pending');
        let failTrustRead = false;
        const primaryFailure = new Error(`Private ${phase} failure`);
        const host = f.compose(
          phase === 'adoption'
            ? {}
            : {
                readLocalTrustEventsSync() {
                  if (failTrustRead) throw primaryFailure;
                  return f.authority.snapshotSync().trustEvents;
                },
              },
        );
        const before = f.runtime.serverHost.controller()!.current();
        let reads = 0;
        f.readOwned.mockImplementation(async (digest, options) => {
          if (++reads !== 2) return f.owned.read(digest, options);
          entered.resolve(options!.signal!);
          await release.promise;
          throw new Error('Incidental verification cancellation');
        });
        reload = host.coordinator.reload();
        const signal = await Promise.race([
          entered.promise,
          reload.then(() => {
            throw new Error('Expected gated verification');
          }),
        ]);
        const loss = ownershipLoss();
        const withdrawal = new Error('Private fallback withdrawal failure');
        if (phase === 'adoption') {
          vi.spyOn(host.localSource!, 'adoptExplicitSelectionSync').mockImplementationOnce(() => {
            throw primaryFailure;
          });
        } else {
          failTrustRead = true;
        }
        vi.spyOn(host.localSource!, 'withdrawExplicitSelectionSync').mockImplementationOnce(() => {
          throw withdrawal;
        });
        f.loseOwnership(loss);
        expect(signal.aborted).toBe(true);
        release.resolve();
        const failure = await reload.catch((cause: unknown) => cause);
        expect(failure).toBeInstanceOf(pluginHost.ExplicitLocalAuthorityError);
        const aggregate = (failure as Error).cause as AggregateError;
        expect(aggregate.errors).toEqual([
          loss,
          expect.objectContaining({ errors: [primaryFailure, withdrawal] }),
        ]);
        expect(host.coordinator.snapshot().failed).toEqual([]);
        expect(f.runtime.serverHost.controller()!.current()).toBe(before);
        expect(host.coordinator.generationSnapshot().acceptingRuns).toBe(true);
      } finally {
        release.resolve();
        await Promise.allSettled([reload]);
        await f.close();
      }
    },
  );

  it.each(['import', 'factory', 'setup'] as const)(
    'rejects gated managed %s through the ownership marker without per-plugin exclusion',
    async (phase) => {
      const f = await createRealManagedCompositionFixture();
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      let reload: Promise<unknown> | undefined;
      let preparationSignal: AbortSignal | undefined;
      let gate = true;
      let disposeCount = 0;
      const stage = async (name: typeof phase) => {
        if (!gate || name !== phase) return;
        gate = false;
        entered.resolve();
        await release.promise;
        throw new Error('Incidental evaluation failure');
      };
      const createSource = pluginHost.createLocalPluginSource;
      const inject = vi
        .spyOn(pluginHost, 'createLocalPluginSource')
        .mockImplementationOnce((options) => {
          const source = createSource({
            ...options,
            async importModule() {
              await stage('import');
              return {
                async default() {
                  await stage('factory');
                  return {
                    setup: () => stage('setup'),
                    async dispose() {
                      disposeCount++;
                    },
                  };
                },
              };
            },
          });
          return {
            ...source,
            prepare(stamp, options) {
              preparationSignal = options.signal;
              return source.prepare(stamp, options);
            },
          };
        });
      try {
        await f.seedManaged('notes', 'pending');
        const host = f.compose({ mcp: false });
        const before = f.runtime.serverHost.controller()!.current();
        reload = host.coordinator.reload();
        await Promise.race([
          entered.promise,
          reload.then(() => {
            throw new Error('Expected gated evaluation');
          }),
        ]);
        const loss = ownershipLoss();
        f.loseOwnership(loss);
        expect(preparationSignal?.aborted).toBe(true);
        if (phase === 'setup') expect(disposeCount).toBe(0);
        release.resolve();
        const marker = {
          code: 'plugin-explicit-authority-failed',
          cause: loss,
        };
        await expect(reload).rejects.toMatchObject(
          phase === 'setup' ? { code: 'plugin-setup-failed', cause: marker } : marker,
        );
        if (phase === 'setup') expect(disposeCount).toBe(1);
        expect(host.coordinator.snapshot().failed).toEqual([]);
        expect(f.runtime.serverHost.controller()!.current()).toBe(before);
      } finally {
        release.resolve();
        await Promise.allSettled([reload]);
        await f.close();
        inject.mockRestore();
      }
    },
  );

  it.each(['candidate', 'unchanged'] as const)(
    'rejects ownership loss observed in the final %s guard',
    async (path) => {
      const f = await createRealManagedCompositionFixture();
      try {
        await f.seedManaged('notes', 'ready');
        const host = f.compose({ mcp: false });
        if (path === 'unchanged') await host.coordinator.reload();
        const before = f.runtime.serverHost.controller()!.current();
        const commit = vi.spyOn(f.runtime.serverHost, 'commit');
        const loss = ownershipLoss();
        let heldChecks = 0;
        const finalCheck = path === 'candidate' ? 10 : 3;
        f.assertHeldSync.mockImplementation(() => {
          if (++heldChecks === finalCheck) throw loss;
          f.owned.assertHeldSync();
        });
        await expect(host.coordinator.reload()).rejects.toMatchObject({
          code: 'plugin-explicit-authority-failed',
          cause: loss,
        });
        expect(f.readOwned).toHaveBeenCalledTimes(path === 'candidate' ? 3 : 4);
        expect(host.coordinator.snapshot().failed).toEqual([]);
        expect(commit).not.toHaveBeenCalled();
        expect(f.runtime.serverHost.controller()!.current()).toBe(before);
        expect(host.coordinator.generationSnapshot().acceptingRuns).toBe(path === 'candidate');
      } finally {
        await f.close();
      }
    },
  );

  it('denies the queued Session head and preserves MCP on exact current and retired pins', async () => {
    const f = await createRealManagedCompositionFixture();
    const entered = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
    const release = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
    const active: Promise<unknown>[] = [];
    let queued: Promise<unknown> | undefined;
    let returnQueued: (() => Promise<unknown>) | undefined;
    try {
      await f.seedManaged('notes', 'ready');
      await f.seedMcp('remote');
      const signals: AbortSignal[] = [];
      const connections: ReturnType<typeof echoConnection>[] = [];
      const host = f.compose({
        mcpConnect: async ({ signal }) => {
          const index = connections.length;
          const connection = echoConnection(async () => {
            entered[index]!.resolve();
            await release[index]!.promise;
            if (signal?.aborted) throw signal.reason;
            return { content: [{ type: 'text', text: `MCP pin ${index}` }] };
          });
          connections.push(connection);
          signals.push(signal!);
          return connection;
        },
      });
      const old = await host.coordinator.reload();
      const tool = old.members.find(({ sourceId }) => sourceId === 'mcp')!.manifest.contributes!
        .tools![0]!;
      for (const [index, sessionId] of ['retired', 'queued'].entries()) {
        if (index === 1) await host.coordinator.reload({ force: true });
        const turn = f.runTool(tool, sessionId);
        active.push(turn);
        await Promise.race([
          entered[index]!.promise,
          turn.then(() => {
            throw new Error('Expected a running MCP tool');
          }),
        ]);
      }
      const before = f.runtime.serverHost.controller()!.current();
      expect(host.coordinator.retainedGenerations()).toContainEqual(
        expect.objectContaining({ generationId: old.generation.id, current: false }),
      );
      f.readOwned.mockClear();
      f.readAuthoritySync.mockClear();
      f.assertHeldSync.mockClear();
      const queuedRun = f.runner.run({
        sessionId: 'queued',
        provider: 'mock',
        model: 'test',
        userMessage: { role: 'user', content: [{ type: 'text', text: 'second queued turn' }] },
      });
      const queuedTurn = queuedRun[Symbol.asyncIterator]();
      returnQueued = () => queuedTurn.return!();
      const next = queuedTurn.next();
      queued = next.catch((cause: unknown) => cause);
      expect(f.assertHeldSync).not.toHaveBeenCalled();
      const loss = ownershipLoss();
      f.assertHeldSync.mockImplementationOnce(() => {
        throw loss;
      });
      release[1]!.resolve();
      await expect(next).rejects.toMatchObject({
        code: 'plugin-explicit-authority-failed',
        cause: loss,
      });

      const events = await getServerSessionStore(f.runtime).read('queued');
      expect(events.filter(({ type }) => type === 'turn.started')).toHaveLength(1);
      expect(f.assertHeldSync).toHaveBeenCalledOnce();
      expect(f.readOwned).not.toHaveBeenCalled();
      expect(f.readAuthoritySync).not.toHaveBeenCalled();
      expect(f.runtime.serverHost.controller()!.current()).toBe(before);
      expect(host.coordinator.generationSnapshot().acceptingRuns).toBe(false);
      expect(signals.map(({ aborted }) => aborted)).toEqual([false, false]);
      expect(connections[0]!.close).not.toHaveBeenCalled();
      release[0]!.resolve();
      const replies = await Promise.all(active);
      for (const [index, reply] of replies.entries())
        expect(JSON.stringify(reply)).toContain(`MCP pin ${index}`);
      await expect.poll(() => connections[0]!.close.mock.calls.length).toBe(1);
      expect(connections[1]!.close).not.toHaveBeenCalled();

      await f.mutateMcp({ kind: 'remove', serverId: 'remote' });
      const replacement = await host.coordinator.reload();
      expect(replacement.members).toEqual([]);
      expect(replacement.generation.acceptingRuns).toBe(false);
      await expect(f.runTool(tool, 'after-loss')).rejects.toMatchObject({
        code: 'plugin-generation-blocked',
      });
    } finally {
      for (const gate of release) gate.resolve();
      await returnQueued?.();
      await Promise.allSettled([...active, queued]);
      await f.close();
    }
  });

  it('keeps an already-compliant unmanaged current open and preserves the retired artifact read', async () => {
    const f = await createRealManagedCompositionFixture();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let oldTurn: Promise<unknown> | undefined;
    try {
      await f.seedManaged('notes', 'old payload beside the entry', true, undefined, true);
      await f.seedMcp('remote');
      const first = echoConnection(async () => {
        entered.resolve();
        await release.promise;
        return { content: [{ type: 'text', text: 'Retired MCP reply' }] };
      });
      const signals: AbortSignal[] = [];
      const host = f.compose({
        mcpConnect: async ({ signal }) => {
          signals.push(signal!);
          return signals.length === 1 ? first : echoConnection();
        },
      });
      const original = await host.coordinator.reload();
      const tool = original.members.find(({ sourceId }) => sourceId === 'mcp')!.manifest
        .contributes!.tools![0]!;
      oldTurn = f.runTool([tool, 'notes'], 'old-payload');
      await Promise.race([
        entered.promise,
        oldTurn.then(() => {
          throw new Error('Expected a pinned turn');
        }),
      ]);
      f.authority.commitSync(decisionInput('disable', 'disable-notes', f.authority.snapshotSync()));
      const replacement = await host.coordinator.reload();
      expect(replacement.members.map(({ pluginId }) => pluginId)).toEqual(['mcp-remote']);
      expect(host.coordinator.retainedGenerations()).toContainEqual(
        expect.objectContaining({ generationId: original.generation.id, current: false }),
      );
      f.readOwned.mockClear();
      f.loseOwnership(ownershipLoss());
      expect(host.coordinator.generationSnapshot()).toEqual({
        id: replacement.generation.id,
        acceptingRuns: true,
      });
      expect(signals.map(({ aborted }) => aborted)).toEqual([false, false]);
      expect(JSON.stringify(await f.runTool(tool, 'unmanaged'))).toContain('MCP reply');
      expect((await host.coordinator.reload()).unchanged).toBe(true);
      expect(f.readOwned).not.toHaveBeenCalled();

      release.resolve();
      expect(await oldTurn).toContainEqual(
        expect.objectContaining({
          type: 'tool-result',
          result: expect.objectContaining({ content: 'old payload beside the entry' }),
        }),
      );
      await expect.poll(() => first.close.mock.calls.length).toBe(1);
    } finally {
      release.resolve();
      await Promise.allSettled([oldTurn]);
      await f.close();
    }
  });

  it('cancels a retired managed turn on a fresh immediate no-op and leaves replay cancellation-free', async () => {
    const f = await createRealManagedCompositionFixture();
    const entered = Promise.withResolvers<AbortSignal>();
    const release = Promise.withResolvers<void>();
    let oldTurn: Promise<unknown> | undefined;
    try {
      await f.seedManaged('notes', 'retained');
      await f.seedMcp('remote');
      const first = echoConnection(async (_name, _args, options) => {
        entered.resolve(options!.signal!);
        await release.promise;
        return { content: [{ type: 'text', text: 'Retired MCP reply' }] };
      });
      const connect = vi
        .fn<typeof connectMcp>()
        .mockResolvedValueOnce(first)
        .mockImplementation(async () => echoConnection());
      const host = f.compose({ mcpConnect: connect });
      const original = await host.coordinator.reload();
      const tool = original.members.find(({ sourceId }) => sourceId === 'mcp')!.manifest
        .contributes!.tools![0]!;
      oldTurn = f.runTool([tool, 'notes'], 'retired-managed');
      const signal = await Promise.race([
        entered.promise,
        oldTurn.then(() => {
          throw new Error('Expected a pinned turn');
        }),
      ]);
      const disable = decisionInput('disable', 'disable-notes', f.authority.snapshotSync()).request;
      if (disable.command.kind !== 'disable') throw new Error('Expected disable request');
      const disabled = await host.applyManagedSelection!({ ...disable, command: disable.command });
      if (disabled.kind !== 'committed') throw new Error('Expected committed disable');
      expect(disabled.application.status).toBe('applied');
      expect(signal.aborted).toBe(false);
      expect(host.coordinator.retainedGenerations()).toContainEqual(
        expect.objectContaining({
          generationId: original.generation.id,
          current: false,
          members: expect.arrayContaining([
            expect.objectContaining({ pluginId: 'notes', origin: 'managed' }),
          ]),
        }),
      );
      expect(host.coordinator.snapshot().members.map(({ pluginId }) => pluginId)).toEqual([
        'mcp-remote',
      ]);

      const noOp = decisionInput(
        'disable',
        'repeat-immediately',
        f.authority.snapshotSync(),
        true,
      ).request;
      if (noOp.command.kind !== 'disable') throw new Error('Expected disable request');
      const request = { ...noOp, command: noOp.command };
      const abort = vi.spyOn(f.runtime.serverHost.controller()!, 'abortActiveRuns');
      const retry = vi.spyOn(host.coordinator, 'retryImmediateRevocation');
      const repeated = await host.applyManagedSelection!(request);
      if (repeated.kind !== 'committed') throw new Error('Expected committed no-op');
      expect(repeated.operation.decision.changed).toBe(false);
      expect(repeated.application).toEqual(disabled.application);
      expect(retry).toHaveBeenCalledExactlyOnceWith('local-esm', 'notes', 'managed');
      expect(abort).toHaveBeenCalledOnce();
      expect(signal.aborted).toBe(true);
      await expect(host.applyManagedSelection!(request)).resolves.toEqual({
        kind: 'replayed',
        operation: repeated.operation,
        currentAuthority: repeated.savedAuthority,
      });
      expect(retry).toHaveBeenCalledOnce();
      expect(abort).toHaveBeenCalledOnce();
    } finally {
      release.resolve();
      await Promise.allSettled([oldTurn]);
      await f.close();
    }
  });

  it('detaches published MCP from ownership loss before awaiting retirement', async () => {
    const f = await createRealManagedCompositionFixture();
    const retiring = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    const releasePin = Promise.withResolvers<void>();
    let reload: Promise<unknown> | undefined;
    let pin: Promise<unknown> | undefined;
    try {
      await f.seedManaged('notes', 'ready');
      await f.seedMcp('remote');
      const signals: AbortSignal[] = [];
      const host = f.compose({
        mcpConnect: async ({ signal }) => {
          signals.push(signal!);
          if (signals.length === 1) {
            const connection = echoConnection();
            connection.close.mockImplementation(async () => {
              retiring.resolve();
              await release.promise;
            });
            return connection;
          }
          return echoConnection(async () => {
            entered.resolve();
            await releasePin.promise;
            if (signal?.aborted) throw signal.reason;
            return { content: [{ type: 'text', text: 'Published during retirement' }] };
          });
        },
      });
      const first = await host.coordinator.reload();
      const tool = first.members.find(({ sourceId }) => sourceId === 'mcp')!.manifest.contributes!
        .tools![0]!;
      reload = host.coordinator.reload({ force: true });
      await Promise.race([
        retiring.promise,
        reload.then(() => {
          throw new Error('Expected pending retirement');
        }),
      ]);
      const publishedId = host.coordinator.generationSnapshot().id;
      expect(publishedId).toBeGreaterThan(first.generation.id);
      pin = f.runTool(tool, 'published');
      await Promise.race([
        entered.promise,
        pin.then(() => {
          throw new Error('Expected a pin on the published Generation');
        }),
      ]);
      f.loseOwnership(ownershipLoss());
      expect(signals[1]!.aborted).toBe(false);
      expect(host.coordinator.generationSnapshot()).toMatchObject({
        id: publishedId,
        acceptingRuns: false,
      });
      releasePin.resolve();
      expect(JSON.stringify(await pin)).toContain('Published during retirement');
      release.resolve();
      await expect(reload).resolves.toMatchObject({
        generation: { id: publishedId, acceptingRuns: false },
      });
    } finally {
      release.resolve();
      releasePin.resolve();
      await Promise.allSettled([reload, pin]);
      await f.close();
    }
  });
});
