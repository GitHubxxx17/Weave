import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { serve, type ServerType } from '@hono/node-server';
import { ExplicitLocalAuthorityError } from '@weave/plugin-host';
import { createSqliteSessionEventStore, type SessionEventStore } from '@weave/session';
import type { WeavePlugin } from '@weave/plugin';
import { createSqliteProjectStore, type ProjectStore } from '@weave/workspace';
import { z } from 'zod';
import { createApp } from './app.js';
import { createSessionService } from './session-service.js';
import { createWorkspaceRootResolver } from './workspace-root.js';
import { createServerLlmProviders } from './llm-providers.js';
import { serverHostVersion } from './host-version.js';
import {
  createServerExtensionCoordinator,
  type ClosablePluginTrustStore,
  type ServerLocalPluginHost,
} from './local-plugin-host.js';
import type { ExtensionCoordinator } from './extension-coordinator.js';
import type { ManagedPluginInstaller } from './managed-plugin-installer.js';
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
  readonly databaseFile?: string;
  readonly dataDirectory?: string;
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
  let installer: ManagedPluginInstaller | undefined;
  let server: ServerType | undefined;
  const shutdown = createServerShutdown({
    resources: () => ({ server, coordinator, authority, owned, installer }),
    disposeHost: () => disposeServerPlugins(runtime),
    stopRuntime: () => runtime.stop(),
    closeProjectStore: () => projectStore?.close(),
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
    const sessionService = createSessionService({ projectStore: projects, sessionStore });
    const runnerOptions = Object.freeze({
      hostVersion: serverHostVersion,
      resolveWorkspaceRoot: createWorkspaceRootResolver(projects),
      ...(maxSteps === undefined ? {} : { maxSteps }),
    }) satisfies ServerAgentRunnerOptions;
    await createServerAgentRunner(runtime, runnerOptions);
    const baseline = runtime.serverHost.controller()!.current();
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
    const extensions = createServerExtensionCoordinator(runtime, {
      runnerOptions,
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
    assertStartupOwnership();

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
          agentRunner: coordinator.runner,
          projectStore: projects,
          sessionService,
          providerRegistry: runtime.serverHost.providerRegistry,
          defaultProvider: providerSettings.defaultProvider,
          providerSettingsManager,
          canManageProviders: providerSettingsManager !== undefined,
          pluginCatalog: () => listServerPlugins(runtime),
          generationSnapshot: coordinator.generationSnapshot,
          commandCatalog: () => listServerCommands(runtime),
          ...(pluginHost === undefined ? {} : { pluginManager: pluginHost }),
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

    return { port: address.port, runtime, pluginHost, mcpManager, server: createdServer, stop };
  } catch (error) {
    return shutdown.failStartup(ownershipReceiverFailure ?? ownershipLoss ?? error);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await startServer();
}
