import {
  createServerRetrievalComposition,
  type ServerRetrievalComposition,
  type ServerRetrievalCompositionOptions,
} from './retrieval-composition.js';
import {
  createServerMemoryComposition,
  resolveMemoryBudgets,
  type ServerMemoryComposition,
  type ServerMemoryCompositionOptions,
  type ServerMemoryResource,
} from './memory-composition.js';
import { freezeExecutionInput } from './agent-execution-input.js';
import { createFileContextCapture } from './agent-file-context.js';
import {
  createAgentExecutionService,
  createAgentTaskService,
  createAgentTaskObserver,
  createAgentTaskTools,
  getBoundTaskExecutionPort,
  type AgentExecutionService,
  type AgentTaskService,
  type AgentTaskObserver,
} from '@weave/runtime';
import { createAgentTaskHost } from './agent-task-composition.js';
import { createPanelService } from './plugin-panel-service.js';
import type { PanelService } from './plugin-panel-types.js';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { serve, type ServerType } from '@hono/node-server';
import { ExplicitLocalAuthorityError } from '@weave/plugin-host';
import { createSqliteSessionEventStore, type SessionEventStore } from '@weave/session';
import type { WeavePlugin } from '@weave/plugin';
import { createSqliteProjectStore, type ProjectStore } from '@weave/workspace';
import { z } from 'zod';
import { resolveSkillsDirectory } from './skill-path.js';
import { createSkillCatalogService } from './skill-catalog.js';
import { createApp } from './app.js';
import { createAgentTaskWorkspaceBindings } from './agent-task-workspace.js';
import {
  createProjectFolderAuthority,
  type ProjectFolderAuthority,
} from './project-folder-authority.js';
import { createSessionService } from './session-service.js';
import { createWorkspaceRootResolver } from './workspace-root.js';
import { createServerLlmProviders } from './llm-providers.js';
import { serverHostVersion } from './host-version.js';
import {
  createPluginMarketplaceManager,
  type PluginMarketplaceManager,
} from './plugin-marketplace-manager.js';
import {
  createServerExtensionCoordinator,
  type ClosablePluginTrustStore,
  type ServerLocalPluginHost,
} from './local-plugin-host.js';
import type { ExtensionCoordinator } from './extension-coordinator.js';
import { assertManualPluginIdSync } from './local-extension-source.js';
import { createSqlitePluginHookConfirmationStore } from './plugin-hook-confirmation-store.js';
import type { ManagedPluginInstaller } from './managed-plugin-installer.js';
import { createManagedPluginUpdater } from './managed-plugin-updater.js';
import {
  acquireManagedPluginStartup,
  resolvePluginStartupOptions,
  type ManagedPluginStoreOptions,
} from './managed-plugin-startup.js';
import type { OwnedPluginArtifactStore } from './owned-plugin-artifact-store.js';
import type { PluginAuthorityDatabase } from './plugin-authority-types.js';
import type { PluginStoreOwnershipError } from './plugin-store-ownership-types.js';
import { createServerShutdown } from './server-shutdown.js';
import { createSqliteMcpAuthorityStore, type McpAuthorityStore } from './mcp-authority-store.js';
import type { connectMcp } from '@weave/mcp-client';
import type { ServerMcpManager } from './mcp-management-types.js';
import type { ProviderSecretCodec } from './provider-secret-codec.js';
import {
  createProviderSettingsManager,
  type ProviderSettingsManager,
} from './provider-settings-manager.js';
import {
  createSqliteProviderSettingsStore,
  type ProviderSettingsStore,
} from './provider-settings-store.js';
import {
  approvalBrokerService,
  createServerAgentRunner,
  createServerRuntime,
  disposeServerPlugins,
  getServerSessionStore,
  listServerCommands,
  listServerPlugins,
  registerServerPlugins,
  type ServerAgentRunnerOptions,
} from './runtime.js';

const portSchema = z.coerce.number().int().min(0).max(65535);
const persistenceOptionsSchema = z.object({
  dataDirectory: z.string().min(1).optional(),
  databaseFile: z.string().min(1).optional(),
});
const studioOriginSchema = z
  .string()
  .url()
  .transform((value) => new URL(value).origin)
  .optional();
const defaultPort = 4317;
const agentMaxStepsSchema = z.coerce.number().int().min(1).max(1000);

/**
 * Reads `WEAVE_AGENT_MAX_STEPS`, the model steps allowed per Agent turn.
 *
 * Returns `undefined` when unset so the Runtime default applies; an invalid
 * value stops startup instead of being ignored.
 */
export function parseAgentMaxSteps(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === '') {
    return undefined;
  }
  const parsed = agentMaxStepsSchema.safeParse(value.trim());
  if (!parsed.success) {
    throw new Error('WEAVE_AGENT_MAX_STEPS must be an integer between 1 and 1000');
  }
  return parsed.data;
}

export interface StartServerOptions {
  readonly memory?: ServerMemoryCompositionOptions['budgets'];
  readonly embeddingFetch?: typeof globalThis.fetch;
  readonly retrievalIndexFactory?: ServerRetrievalCompositionOptions['indexFactory'];
  readonly memoryStoreFactory?: ServerMemoryCompositionOptions['storeFactory'];
  readonly databaseFile?: string;
  readonly dataDirectory?: string;
  readonly skillsDirectory?: string | false;
  readonly studioOrigin?: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly fetch?: typeof globalThis.fetch;
  readonly providerSettingsStore?: ProviderSettingsStore;
  readonly providerSecretCodec?: ProviderSecretCodec;
  readonly projectStore?: ProjectStore;
  readonly sessionStoreFactory?: () => SessionEventStore | Promise<SessionEventStore>;
  readonly plugins?: readonly WeavePlugin[];
  /** `false` disables the local ESM source while preserving managed ID reservations. */
  readonly pluginsDirectory?: string | false;
  readonly managedPluginStore?: ManagedPluginStoreOptions;
  /** Operator-owned discovery snapshot; false ignores environment configuration. */
  readonly pluginMarketplaceCatalogFile?: string | false;
  /** Anonymous index transport override; independent of model provider fetch. */
  readonly pluginMarketplaceFetch?: typeof globalThis.fetch;
  /** Optional trust persistence override, owned by the Server once accepted. */
  readonly pluginTrustStore?: ClosablePluginTrustStore;
  /** MCP persistence remains enabled independently of ESM discovery and is Server-owned. */
  readonly mcpAuthorityStore?: McpAuthorityStore;
  /** Optional transport seam for embedded Servers and integration tests. */
  readonly mcpConnect?: typeof connectMcp;
}

/**
 * Starts the local HTTP control plane and its Runtime.
 *
 * The function resolves only after the TCP server is listening. If startup
 * fails, the Server attempts to close acquired resources. Successful cleanup
 * preserves the original error. An AggregateError includes the original error
 * first, followed by any cleanup failures.
 *
 * @param portInput Port number or string value validated by the server boundary.
 * @param options Persistence configuration and optional test Store overrides.
 * @returns Server handles and a coordinated stop function.
 */
export async function startServer(
  portInput: string | number = process.env.PORT ?? defaultPort,
  options: StartServerOptions = {},
) {
  const port = portSchema.parse(portInput);
  persistenceOptionsSchema.parse(options);
  const studioOrigin = studioOriginSchema.parse(options.studioOrigin);
  const maxSteps = parseAgentMaxSteps((options.environment ?? process.env).WEAVE_AGENT_MAX_STEPS);
  const pluginStartup = resolvePluginStartupOptions(options);
  const { databaseFile, pluginsDirectory } = pluginStartup;
  await mkdir(dirname(databaseFile), { recursive: true });
  const providerSettings = createServerLlmProviders({
    ...(options.environment === undefined ? {} : { environment: options.environment }),
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  });

  const sessionStoreFactory =
    options.sessionStoreFactory ??
    (() => createSqliteSessionEventStore({ filename: databaseFile }));
  const runtime = createServerRuntime({ sessionStoreFactory, providerSettings });
  let providerSettingsStore: ProviderSettingsStore | undefined;
  let projectStore: ProjectStore | undefined;
  let projectFolderAuthority: ProjectFolderAuthority | undefined;
  let manualTrustStore: ClosablePluginTrustStore | undefined;
  let authority: PluginAuthorityDatabase | undefined;
  let owned: OwnedPluginArtifactStore | undefined;
  let ownershipLoss: PluginStoreOwnershipError | undefined;
  let ownershipReceiverFailure: AggregateError | undefined;
  let receiveOwnershipLoss: ((error: PluginStoreOwnershipError) => void) | undefined;
  let mcpAuthorityStore: McpAuthorityStore | undefined;
  let mcpManager: ServerMcpManager | undefined;
  let pluginHost: ServerLocalPluginHost | undefined;
  let coordinator: ExtensionCoordinator | undefined;
  let panelService: PanelService | undefined;
  let installer: ManagedPluginInstaller | undefined;
  let pluginMarketplaceManager: PluginMarketplaceManager | undefined;
  let server: ServerType | undefined;
  let agentExecutionService: AgentExecutionService | undefined;
  let agentTaskService: AgentTaskService | undefined;
  let agentTaskObserver: AgentTaskObserver | undefined;
  let memory: ServerMemoryComposition | undefined;
  let memoryResource: ServerMemoryResource | undefined;
  let retrieval: ServerRetrievalComposition | undefined;
  let retrievalResource: ServerMemoryResource | undefined;
  const shutdown = createServerShutdown({
    resources: () => ({
      server,
      coordinator,
      panelService,
      authority,
      owned,
      installer,
      pluginMarketplaceManager,
      agentExecutionService,
      agentTaskService,
      memory: memoryResource,
      retrieval: retrievalResource,
    }),
    disposeHost: () => {
      agentTaskObserver?.close();
      return disposeServerPlugins(runtime);
    },
    stopRuntime: () => runtime.stop(),
    closeProjectStore: async () => {
      projectFolderAuthority?.closeSync();
      await projectStore?.close();
    },
    closeProviderSettingsStore: () => providerSettingsStore?.close(),
    closeManualTrustStore: () => manualTrustStore?.close(),
    closeMcpAuthorityStore: () => mcpAuthorityStore?.close(),
  });
  const onSignal = (): void => {
    void stop().catch(() => undefined);
  };
  const stop = (): Promise<void> => {
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
    return shutdown.stop();
  };

  function assertStartupOwnership(): void {
    if (ownershipLoss !== undefined) throw ownershipLoss;
    owned?.assertHeldSync();
  }

  try {
    mcpAuthorityStore =
      options.mcpAuthorityStore ?? createSqliteMcpAuthorityStore({ filename: databaseFile });
    providerSettingsStore =
      options.providerSettingsStore ??
      (options.providerSecretCodec === undefined
        ? undefined
        : createSqliteProviderSettingsStore({ filename: databaseFile }));
    const projects = options.projectStore ?? createSqliteProjectStore({ filename: databaseFile });
    projectStore = projects;
    projectFolderAuthority = createProjectFolderAuthority(projects);
    const resolveWorkspaceRoot = createWorkspaceRootResolver(projects);
    const agentTaskWorkspace = createAgentTaskWorkspaceBindings(
      projectFolderAuthority,
      resolveWorkspaceRoot,
    );
    const providerSettingsManager: ProviderSettingsManager | undefined =
      providerSettingsStore === undefined || options.providerSecretCodec === undefined
        ? undefined
        : createProviderSettingsManager({
            store: providerSettingsStore,
            registry: runtime.serverHost.hostProviderRegistry,
            catalog: () => runtime.serverHost.providerRegistry,
            reserveProvider: (id) => runtime.serverHost.reserveProvider(id),
            claimProvider: (id) => runtime.serverHost.claimProvider(id),
            releaseProviderClaim: (id) => runtime.serverHost.releaseProviderClaim(id),
            secretCodec: options.providerSecretCodec,
            initialDefaultProvider: providerSettings.defaultProvider,
          });
    if (providerSettingsManager !== undefined) {
      await providerSettingsManager.refresh();
    }
    await runtime.start();
    await registerServerPlugins(runtime, options.plugins);
    const sessionStore = getServerSessionStore(runtime);
    const memoryBudgets = resolveMemoryBudgets(options.memory);
    memory = await createServerMemoryComposition({
      registerResource(resource) {
        memoryResource = resource;
      },
      databaseFile,
      projectStore: projects,
      sessionStore,
      budgets: memoryBudgets,
      beforeMemoryCommit: (change) => retrieval?.service.beforeMemoryCommit(change),
      ...(options.memoryStoreFactory === undefined
        ? {}
        : { storeFactory: options.memoryStoreFactory }),
    });
    retrieval = await createServerRetrievalComposition({
      databaseFile,
      projectFolders: projectFolderAuthority,
      agentTaskWorkspace,
      memory,
      registerResource(resource) {
        retrievalResource = resource;
      },
      environment: options.environment ?? process.env,
      ...(options.embeddingFetch ? { embeddingFetch: options.embeddingFetch } : {}),
      ...(options.retrievalIndexFactory ? { indexFactory: options.retrievalIndexFactory } : {}),
    });
    const sessionService = createSessionService({
      projectStore: projects,
      sessionStore,
      withMemoryMembershipMutation: memory.scopes.withMemoryMembershipMutation,
      withSessionIdle: (sessionId, operation) =>
        agentTaskService === undefined
          ? agentExecutionService === undefined
            ? operation()
            : agentExecutionService.withSessionIdle(sessionId, operation)
          : agentTaskService.withTaskSessionsIdle(sessionId, () =>
              agentExecutionService!.withSessionIdle(sessionId, operation),
            ),
    });
    const taskTools = createAgentTaskTools({
      service: {
        spawn: (input, context) => agentTaskService!.spawn(input, context),
        requestCancel: (...args) => agentTaskService!.requestCancel(...args),
      },
      observer: {
        status: (...args) => agentTaskObserver!.status(...args),
        wait: (...args) => agentTaskObserver!.wait(...args),
      },
    });
    for (const tool of Object.values(taskTools)) runtime.serverHost.hostTools().register(tool);
    const runnerOptions = Object.freeze({
      hostVersion: serverHostVersion,
      skillsDirectory: resolveSkillsDirectory({ ...options, databaseFile }),
      agentTaskWorkspace,
      memory,
      retrieval,
      toolResultMaxBytes: memoryBudgets.maxBytes,
      context: { maxToolResultTokens: memoryBudgets.maxToolResultTokens },
      ...(maxSteps === undefined ? {} : { maxSteps }),
    }) satisfies ServerAgentRunnerOptions;
    await createServerAgentRunner(runtime, runnerOptions);
    const baseline = runtime.serverHost.controller()!.current();
    pluginMarketplaceManager = await createPluginMarketplaceManager({
      settingsFile: `${databaseFile}.plugin-marketplace-sources.json`,
      legacySettingsFile: `${databaseFile}.plugin-marketplace-sources.jsonl`,
      operatorCatalogFile:
        options.pluginMarketplaceCatalogFile ??
        (options.environment ?? process.env).WEAVE_PLUGIN_MARKETPLACE_CATALOG,
      reservedIds: baseline.resources.plugins.map(({ id }) => id),
      ...(options.pluginMarketplaceFetch === undefined
        ? {}
        : { fetch: options.pluginMarketplaceFetch }),
    });
    const startup = await acquireManagedPluginStartup(pluginStartup, {
      baselinePluginIds: baseline.resources.plugins.map(({ id }) => id),
      registerAuthority(value) {
        authority = value;
        return undefined;
      },
      registerManualTrustStore(value) {
        manualTrustStore = value;
        return undefined;
      },
      registerOwnedStore(value) {
        owned = value;
        return undefined;
      },
      onOwnershipLost(error) {
        if (ownershipLoss === undefined) {
          ownershipLoss = error;
          receiveOwnershipLoss?.(error);
        }
        return undefined;
      },
    });
    const { localTrust } = startup;
    const hookConfirmations = createSqlitePluginHookConfirmationStore({ filename: databaseFile });
    const extensions = createServerExtensionCoordinator(runtime, {
      runnerOptions,
      hookConfirmations,
      ...(startup.owned === undefined ? {} : { installerStore: startup.owned }),
      managed: {
        initialAuthority: startup.snapshot,
        readAuthoritySync: startup.authority.snapshotSync,
        ...(startup.owned === undefined
          ? {}
          : { executionStore: startup.owned, selectionAuthority: startup.authority }),
        ...(localTrust?.kind === 'override'
          ? { readLocalTrustEventsSync: localTrust.readTrustEventsSync }
          : {}),
      },
      mcp: {
        store: mcpAuthorityStore,
        readHostVariable: (name) => (options.environment ?? process.env)[name],
        ...(options.mcpConnect === undefined ? {} : { connect: options.mcpConnect }),
      },
      ...(pluginsDirectory === false || localTrust === undefined
        ? {}
        : {
            local: {
              directory: pluginsDirectory,
              trustStore: localTrust.store,
              ...(startup.owned === undefined ? {} : { dispose: stop }),
            },
          }),
    });
    coordinator = extensions.coordinator;
    installer = extensions.installer;
    const managed = extensions.managed!;
    receiveOwnershipLoss = (error) => {
      managed.onOwnershipLostSync(error);
      const marker: unknown = managed.managedAuthority.ownershipLossSignal.reason;
      if (marker instanceof ExplicitLocalAuthorityError && marker.cause instanceof AggregateError) {
        ownershipReceiverFailure = marker.cause;
      }
    };
    if (ownershipLoss !== undefined) receiveOwnershipLoss(ownershipLoss);
    managed.adoptInitialAuthoritySync();
    assertStartupOwnership();
    pluginHost = extensions.pluginHost;
    mcpManager = extensions.mcpManager;
    await coordinator.reload();
    // Startup sweep: removes retired and orphaned managed artifacts left by earlier versions.
    installer?.requestReclaim();
    panelService = createPanelService({
      host: runtime.serverHost,
      authority: coordinator,
      sessionStore: runtime.get(runtime.serverHost.sessionStoreService),
    });
    assertStartupOwnership();

    agentExecutionService = createAgentExecutionService({
      runner: coordinator.runner,
      sessionStore,
      captureFiles: createFileContextCapture(projects),
      resolveInput: async (_sessionId, input) =>
        freezeExecutionInput(
          input,
          runtime.serverHost.providerRegistry.getDescriptor(input.provider),
        ),
      admit: async (sessionId) => {
        await sessionService.assertRunnable(sessionId);
        const allProjects = await projects.listProjects();
        for (const project of allProjects) {
          if (
            (await projects.listSessionRefs(project.id)).some((ref) => ref.sessionId === sessionId)
          )
            return;
        }
        throw new Error('Execution Session is no longer attached to a Project');
      },
    });
    agentTaskService = createAgentTaskService({
      sessionStore,
      execution: getBoundTaskExecutionPort(agentExecutionService),
      host: createAgentTaskHost({
        sessionStore,
        projectStore: projects,
        projectFolders: projectFolderAuthority,
        workspace: agentTaskWorkspace,
        withMemoryMembershipMutation: memory.scopes.withMemoryMembershipMutation,
      }),
    });
    agentTaskObserver = createAgentTaskObserver({
      service: agentTaskService,
      approvalBroker: runtime.get(approvalBrokerService),
    });
    const knownSessionIds = new Set<string>();
    for (const project of await projects.listProjects()) {
      for (const ref of await projects.listSessionRefs(project.id))
        knownSessionIds.add(ref.sessionId);
    }
    await agentTaskService.recover([...knownSessionIds], (sessionIds) =>
      agentExecutionService!.recover(sessionIds),
    );

    let resolveListening!: () => void;
    let rejectListening!: (error: unknown) => void;
    const listening = new Promise<void>((resolve, reject) => {
      resolveListening = resolve;
      rejectListening = reject;
    });
    const createdServer = serve(
      {
        fetch: createApp(runtime, {
          approvalBrokerService,
          panelService,
          agentExecutionService,
          agentTaskService,
          agentTaskObserver,
          projectStore: projects,
          projectFolderAuthority,
          sessionService,
          memoryService: memory.service,
          retrievalService: retrieval.service,
          retrievalEmbedding: retrieval.embedding,
          skillCatalogService: createSkillCatalogService({
            current: () => runtime.serverHost.controller()?.current(),
          }),
          providerRegistry: runtime.serverHost.providerRegistry,
          defaultProvider: providerSettings.defaultProvider,
          providerSettingsManager,
          canManageProviders: providerSettingsManager !== undefined,
          pluginCatalog: () => listServerPlugins(runtime),
          pluginMarketplaceManager,
          hookConfirmations,
          generationSnapshot: coordinator.generationSnapshot,
          commandCatalog: () => listServerCommands(runtime),
          ...(pluginHost === undefined ? {} : { pluginManager: pluginHost }),
          ...(installer === undefined
            ? {}
            : {
                managedPluginInstaller: installer,
                managedPluginUpdater: createManagedPluginUpdater({
                  installer,
                  marketplace: pluginMarketplaceManager && {
                    catalogs: () =>
                      pluginMarketplaceManager!
                        .listSources()
                        .sources.filter(({ status }) => status === 'ready')
                        .map(({ id }) => pluginMarketplaceManager!.catalog(id).catalog),
                  },
                }),
              }),
          assertManualPluginIdSync: (id) =>
            assertManualPluginIdSync(startup.authority.snapshotSync, id),
          ...(mcpManager === undefined ? {} : { mcpManager }),
          ...(studioOrigin === undefined ? {} : { studioOrigin }),
        }).fetch,
        hostname: '127.0.0.1',
        port,
      },
      () => {
        resolveListening();
      },
    );
    server = createdServer;
    const onError = (error: unknown): void => {
      rejectListening(error);
    };
    createdServer.once('error', onError);

    await listening;
    createdServer.off('error', onError);
    const address = createdServer.address();
    if (address === null || typeof address === 'string') {
      throw new Error('Expected the server to have a TCP address after listening');
    }

    process.on('SIGINT', onSignal);
    process.on('SIGTERM', onSignal);

    return {
      port: address.port,
      runtime,
      pluginHost,
      mcpManager,
      memory,
      retrieval,
      server: createdServer,
      stop,
    };
  } catch (error) {
    return shutdown.failStartup(ownershipReceiverFailure ?? ownershipLoss ?? error);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await startServer();
}
