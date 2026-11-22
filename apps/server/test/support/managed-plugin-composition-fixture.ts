import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { connectMcp } from '@weave/mcp-client';
import type { KernelPlugin, PluginManifest } from '@weave/plugin';
import {
  computeDirectoryDigest,
  type GithubPluginAcquirer,
  type PluginTrustStore,
  type RecordedPluginTrustEvent,
} from '@weave/plugin-host';
import { vi } from 'vitest';
import type { ExtensionCoordinator } from '../../src/extension-coordinator.js';
import type {
  ExtensionAuthorityObserver,
  ExtensionSourceFactory,
  ExtensionSourceSnapshot,
} from '../../src/extension-types.js';
import { createManagedAuthorityObserverBuffer } from '../../src/managed-plugin-composition.js';
import {
  createSqliteMcpAuthorityStore,
  McpAuthorityError,
  type McpAuthorityCommand,
} from '../../src/mcp-authority-store.js';
import type { createMcpExtensionSource } from '../../src/mcp-source.js';
import { createServerExtensionCoordinator } from '../../src/local-plugin-host.js';
import { normalizeMcpServerConfig } from '../../src/mcp-environment.js';
import { openOwnedPluginArtifactStore } from '../../src/owned-plugin-artifact-store.js';
import { createSqlitePluginAuthorityDatabase } from '../../src/plugin-authority-store.js';
import type { ValidatedArtifactIdentity } from '../../src/plugin-authority-types.js';
import type { PluginStoreOwnershipError } from '../../src/plugin-store-ownership-types.js';
import {
  createServerAgentRunner,
  createServerRuntime,
  disposeServerPlugins,
  getServerSessionStore,
  type ServerRuntime,
} from '../../src/runtime.js';
import { activateInput, importInput } from './plugin-authority-fixtures.js';

/** Supplies local authority directly while exercising the real MCP source and publication path. */
export function createManagedPluginCompositionFixture() {
  const localSourceId = 'local-esm';
  let sticky = new Set<string>();
  let localObserver: ExtensionAuthorityObserver;
  let localRevision = 0;
  let localDenied: readonly string[] = [];
  let coordinator: ExtensionCoordinator;
  let mcp: ReturnType<typeof createMcpExtensionSource>;
  const buffer = createManagedAuthorityObserverBuffer((changes) =>
    coordinator.observeAuthorityBatchSync(changes),
  );

  function localSnapshot(): ExtensionSourceSnapshot {
    return { stamp: { revision: localRevision, trustSequence: 0 }, eligible: [] };
  }

  const registerLocal: ExtensionSourceFactory = (observe) => {
    localObserver = observe;
    return {
      id: localSourceId,
      snapshot: localSnapshot,
      refresh: async () => {},
      close: async () => {},
      prepare: async (stamp) => ({
        stamp,
        items: [],
        failures: [],
        recheck: async () => true,
        dispose: async () => {},
      }),
    };
  };

  function reconcileSync(immediate: boolean): void {
    const denied = mcp.declaredPluginIds().filter((id) => sticky.has(id));
    if (localDenied.length !== denied.length || localDenied.some((id) => !denied.includes(id))) {
      const affectedIds = [...new Set([...localDenied, ...denied])];
      localDenied = denied;
      localRevision++;
      localObserver(localSourceId, { snapshot: localSnapshot(), affectedIds, immediate });
    }
    mcp.setDeniedPluginIdsSync(new Set(denied));
  }

  return {
    localSnapshot,
    registerLocal: buffer.wrapSource(registerLocal),
    wrapSource: buffer.wrapSource,
    attach(next: ExtensionCoordinator, source: typeof mcp) {
      coordinator = next;
      mcp = source;
    },
    adoptStickyIdsSync(ids: readonly string[], immediate = false) {
      buffer.runSync(() => {
        sticky = new Set(ids);
        reconcileSync(immediate);
      });
    },
    installAuthoritySync(apply: () => void) {
      buffer.runSync(() => {
        apply();
        reconcileSync(false);
      });
    },
    assertCreateAllowedSync(pluginId: string) {
      if (sticky.has(pluginId)) throw new McpAuthorityError('mcp-conflict');
    },
  };
}

export async function runFixtureTools(
  runtime: ServerRuntime,
  runner: Awaited<ReturnType<typeof createServerAgentRunner>>,
  tool: string | readonly string[],
  sessionId = 'managed-composition',
) {
  const store = getServerSessionStore(runtime);
  if (!(await store.read(sessionId)).length) {
    await store.append(sessionId, [{ type: 'session.created', payload: { title: sessionId } }]);
  }
  const events = [];
  for await (const event of runner.run({
    sessionId,
    provider: 'mock',
    model: 'test',
    permissionMode: 'yolo',
    userMessage: {
      role: 'user',
      content: [
        {
          type: 'text',
          text: (typeof tool === 'string' ? [tool] : tool)
            .map((name) => `/tool ${name} {}`)
            .join('\n'),
        },
      ],
    },
  })) {
    events.push(event);
  }
  return events;
}

export async function writeFixturePlugin(
  directory: string,
  id: string,
  text: string,
  options: {
    readonly marker?: string | undefined;
    readonly relativePayload?: boolean;
    readonly command?: string;
    readonly version?: string;
    readonly setupError?: string;
  } = {},
) {
  const { marker, relativePayload, command, version = '1.0.0', setupError } = options;
  const tool = id.replaceAll('-', '_');
  const manifest: PluginManifest = {
    id,
    name: id,
    version,
    apiVersion: '1.0.0',
    capabilities: command === undefined ? ['tool'] : ['tool', 'command'],
    contributes: { tools: [tool], ...(command === undefined ? {} : { commands: [command] }) },
    permissions: [],
  };
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, 'weave-plugin.json'),
    JSON.stringify({ schemaVersion: 1, entry: 'index.mjs', manifest }),
  );
  if (relativePayload) await writeFile(join(directory, 'payload.txt'), text);
  await writeFile(
    join(directory, 'index.mjs'),
    `${marker === undefined ? '' : `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'imported');`}
    ${relativePayload ? `import { readFile } from 'node:fs/promises';` : ''}
    export default (sdk) => ({ setup(env) {
      ${setupError === undefined ? '' : `throw new Error(${JSON.stringify(setupError)});`}
      env.contribute(sdk.toolsExtensionPoint, (tools) => tools.addTool({
        name: ${JSON.stringify(tool)}, description: 'Read the fixture value',
        parameters: { type: 'object' }, inputSchema: sdk.z.object({}),
        execute: async () => ${relativePayload ? `readFile(new URL('./payload.txt', import.meta.url), 'utf8')` : JSON.stringify(text)}
      }));
      ${
        command === undefined
          ? ''
          : `
      env.contribute(sdk.commandsExtensionPoint, (commands) => commands.addCommand({
        name: ${JSON.stringify(command)}, title: ${JSON.stringify(id)}, prompt: 'Run the fixture command'
      }));`
      }
    } });`,
  );
  return manifest;
}

export function createFixtureMcpConfig(id: string, root: string, launchLog: string) {
  return normalizeMcpServerConfig({
    schemaVersion: 1,
    id,
    label: id,
    transport: 'stdio',
    command: process.execPath,
    cwd: root,
    args: [fileURLToPath(new URL('../fixtures/mcp-server.mjs', import.meta.url)), launchLog],
    env: {},
  });
}

export async function createRealManagedCompositionFixture(
  options: { readonly onKernelSetup?: () => void | Promise<void> } = {},
) {
  const root = await mkdtemp(join(tmpdir(), 'weave-managed-composition-'));
  const pluginsDirectory = join(root, 'plugins');
  const databaseFile = join(root, 'authority.sqlite');
  const launchLog = join(root, 'mcp-launches.jsonl');
  const authority = createSqlitePluginAuthorityDatabase({ filename: databaseFile });
  const mcpStore = createSqliteMcpAuthorityStore({ filename: databaseFile });
  const runtime = createServerRuntime();
  let extensions: ReturnType<typeof createServerExtensionCoordinator> | undefined;
  const runnerOptions = { hostVersion: '1.0.0' };
  const kernelPluginFactories =
    options.onKernelSetup === undefined
      ? []
      : [
          (): KernelPlugin => ({
            manifest: {
              id: 'fixture-assembly',
              name: 'Fixture assembly',
              version: '1.0.0',
              apiVersion: '1.0.0',
              capabilities: ['tool'],
            },
            setup: options.onKernelSetup!,
          }),
        ];
  await mkdir(pluginsDirectory);
  await runtime.start();
  const runner = await createServerAgentRunner(runtime, {
    ...runnerOptions,
    kernelPlugins: kernelPluginFactories.map((create) => create()),
  });
  const owned = await openOwnedPluginArtifactStore({
    authority,
    directory: join(pluginsDirectory, '.weave-store'),
    initialBinding: 'allow-unbound',
    hostVersion: runnerOptions.hostVersion,
    reservedIds: kernelPluginFactories.map((create) => create().manifest.id),
    onOwnershipLost: (error) => extensions?.managed?.onOwnershipLostSync?.(error),
  });
  const readOwned = vi.fn(owned.read);
  const readAuthoritySync = vi.fn(authority.snapshotSync);
  const readMcp = vi.fn(mcpStore.read);
  const assertHeldSync = vi.fn(owned.assertHeldSync);
  let sequence = 0;
  let closing: Promise<void> | undefined;

  function closeResources() {
    closing ??= (async () => {
      try {
        extensions?.installer?.closeSync();
        await extensions?.coordinator.dispose();
      } finally {
        await disposeServerPlugins(runtime);
        await runtime.stop();
        await owned.close();
        await mcpStore.close();
        await authority.close();
      }
    })();
    return closing;
  }

  async function mutateMcp(command: McpAuthorityCommand) {
    const known = await mcpStore.read();
    return mcpStore.mutate(command, {
      expectedSequence: known.sequence,
      knownPrefix: known.events,
    });
  }

  return {
    root,
    databaseFile,
    pluginsDirectory,
    authority,
    owned,
    mcpStore,
    runtime,
    runner,
    launchLog,
    readOwned,
    readAuthoritySync,
    readMcp,
    assertHeldSync,
    loseOwnership(error: PluginStoreOwnershipError) {
      return extensions?.managed?.onOwnershipLostSync?.(error);
    },
    mutateMcp,
    createMcpConfig: (id: string) => createFixtureMcpConfig(id, root, launchLog),
    async seedMcp(id: string, trusted = true) {
      const config = await createFixtureMcpConfig(id, root, launchLog);
      const created = await mutateMcp({ kind: 'create', config });
      if (trusted) {
        await mutateMcp({
          kind: 'trust',
          serverId: id,
          configDigest: created.records.find((record) => record.config.id === id)!.configDigest,
        });
      }
      return config;
    },
    async seedManual(id: string, text: string, trusted = true, marker?: string) {
      const directory = join(pluginsDirectory, id);
      const manifest = await writeFixturePlugin(directory, id, text, { marker, command: id });
      const { digest } = await computeDirectoryDigest(directory);
      if (trusted)
        await authority.trust.append({ kind: 'trusted', pluginId: id, digest, manifest });
      return { directory, manifest, digest };
    },
    async writeSource(id: string, text = 'source', marker?: string) {
      const directory = join(root, `source-${++sequence}-private`);
      const manifest = await writeFixturePlugin(directory, id, text, { marker });
      return { directory, manifest };
    },
    async seedManaged(
      id: string,
      text: string,
      selected = true,
      marker?: string,
      relativePayload = false,
    ) {
      const sourceDirectory = join(root, `import-${++sequence}`);
      await writeFixturePlugin(sourceDirectory, id, text, { marker, relativePayload });
      const staged = await owned.stage({ sourceDirectory });
      const identity: ValidatedArtifactIdentity = {
        pluginId: staged.descriptor.manifest.id,
        digest: staged.digest,
        manifest: staged.descriptor.manifest,
        files: staged.files,
        bytes: staged.bytes,
      };
      const imported = importInput(
        `import-${sequence}`,
        authority.snapshotSync().heads.installSequence,
        identity,
      );
      if (imported.prepared.kind !== 'import') throw new Error('Expected an import');
      authority.commitSync({
        ...imported,
        prepared: {
          ...imported.prepared,
          provenance: { kind: 'local-directory', sourceDirectory },
        },
      });
      if (selected)
        authority.commitSync(
          activateInput(`activate-${sequence}`, authority.snapshotSync(), identity),
        );
      return staged;
    },
    compose(
      options: {
        readonly execution?: boolean;
        readonly installer?: boolean;
        readonly githubAcquirer?: GithubPluginAcquirer;
        readonly local?: boolean;
        readonly localTrustStore?: PluginTrustStore;
        readonly mcp?: boolean;
        readonly mcpConnect?: typeof connectMcp;
        readonly readLocalTrustEventsSync?: () => readonly RecordedPluginTrustEvent[] | undefined;
      } = {},
    ) {
      extensions = createServerExtensionCoordinator(runtime, {
        runnerOptions,
        kernelPluginFactories,
        ...(options.githubAcquirer === undefined ? {} : { githubAcquirer: options.githubAcquirer }),
        ...(options.installer === true && options.execution !== false
          ? { installerStore: owned }
          : {}),
        ...(options.local === false
          ? {}
          : {
              local: {
                directory: pluginsDirectory,
                trustStore: options.localTrustStore ?? authority.trust,
              },
            }),
        ...(options.mcp === false
          ? {}
          : {
              mcp: {
                store: {
                  ...mcpStore,
                  read: readMcp,
                  mutate: (command, options) => mcpStore.mutate(command, options),
                },
                ...(options.mcpConnect === undefined ? {} : { connect: options.mcpConnect }),
              },
            }),
        managed: {
          initialAuthority: authority.snapshotSync(),
          readAuthoritySync,
          ...(options.execution === false
            ? {}
            : {
                executionStore: { binding: owned.binding, assertHeldSync, read: readOwned },
                selectionAuthority: authority,
              }),
          ...(options.readLocalTrustEventsSync === undefined
            ? {}
            : { readLocalTrustEventsSync: options.readLocalTrustEventsSync }),
        },
      });
      extensions.adoptInitialAuthoritySync?.();
      return extensions;
    },
    runTool(tool: string | readonly string[], sessionId?: string) {
      return runFixtureTools(runtime, runner, tool, sessionId);
    },
    async exists(path: string) {
      return access(path).then(
        () => true,
        () => false,
      );
    },
    closeResources,
    async close() {
      try {
        await closeResources();
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  };
}
