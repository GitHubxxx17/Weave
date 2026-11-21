import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { serve, type ServerType } from '@hono/node-server';
import { createSqliteSessionEventStore, type SessionEventStore } from '@weave/session';
import type { WeavePlugin } from '@weave/plugin';
import { createSqliteProjectStore, type ProjectStore } from '@weave/workspace';
import { z } from 'zod';
import { createApp } from './app.js';
import { createSessionService } from './session-service.js';
import { createWorkspaceRootResolver } from './workspace-root.js';
import { createServerLlmProviders } from './llm-providers.js';
import { resolveDatabaseFile } from './persistence-path.js';
import { resolvePluginsDirectory } from './plugin-path.js';
import { serverHostVersion } from './host-version.js';
import { createSqlitePluginTrustStore } from './plugin-trust-store.js';
import {
  createServerExtensionCoordinator,
  type ClosablePluginTrustStore,
  type ServerLocalPluginHost,
} from './local-plugin-host.js';
import type { ExtensionCoordinator } from './extension-coordinator.js';
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
  /** `false` disables local discovery and trust persistence. */
  readonly pluginsDirectory?: string | false;
  /** Optional trust persistence override, owned and closed by this Server. */
  readonly pluginTrustStore?: ClosablePluginTrustStore;
  /** MCP persistence remains enabled independently of ESM discovery and is Server-owned. */
  readonly mcpAuthorityStore?: McpAuthorityStore;
  /** Optional transport seam for embedded Servers and integration tests. */
  readonly mcpConnect?: typeof connectMcp;
}

async function closeServer(server: ServerType): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    try {
      server.close((error?: Error) => {
        if (
          error === undefined ||
          (error as NodeJS.ErrnoException).code === 'ERR_SERVER_NOT_RUNNING'
        ) {
          resolve();
          return;
        }
        reject(error);
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ERR_SERVER_NOT_RUNNING') {
        resolve();
        return;
      }
      reject(error);
    }
  });
}

async function closeProjectStore(projectStore: ProjectStore | undefined): Promise<void> {
  if (projectStore === undefined) {
    return;
  }
  await projectStore.close();
}

async function closeProviderSettingsStore(
  providerSettingsStore: ProviderSettingsStore | undefined,
): Promise<void> {
  if (providerSettingsStore === undefined) {
    return;
  }
  await providerSettingsStore.close();
}

/**
 * Starts the local HTTP control plane and its Runtime.
 *
 * The function resolves only after the TCP server is listening. If binding
 * fails, it closes any partially-created server and stops the Runtime before
 * rethrowing the original error.
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
  const persistence = persistenceOptionsSchema.parse(options);
  const studioOrigin = studioOriginSchema.parse(options.studioOrigin);
  const maxSteps = parseAgentMaxSteps((options.environment ?? process.env).WEAVE_AGENT_MAX_STEPS);
  const pluginsDirectory = resolvePluginsDirectory(options);
  const databaseFile = resolveDatabaseFile({
    ...(persistence.databaseFile === undefined ? {} : { databaseFile: persistence.databaseFile }),
    ...(persistence.dataDirectory === undefined
      ? {}
      : { dataDirectory: persistence.dataDirectory }),
    ...(options.environment === undefined ? {} : { environment: options.environment }),
  });
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
  let pluginTrustStore: ClosablePluginTrustStore | undefined;
  let mcpAuthorityStore: McpAuthorityStore | undefined;
  let mcpManager: ServerMcpManager | undefined;
  let pluginHost: ServerLocalPluginHost | undefined;
  let coordinator: ExtensionCoordinator | undefined;
  let server: ServerType | undefined;

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
    if (pluginsDirectory !== false) {
      pluginTrustStore =
        options.pluginTrustStore ?? createSqlitePluginTrustStore({ filename: databaseFile });
    }
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
    const extensions = createServerExtensionCoordinator(runtime, {
      runnerOptions,
      mcp: {
        store: mcpAuthorityStore,
        readHostVariable: (name) => (options.environment ?? process.env)[name],
        ...(options.mcpConnect === undefined ? {} : { connect: options.mcpConnect }),
      },
      ...(pluginsDirectory === false || pluginTrustStore === undefined
        ? {}
        : { local: { directory: pluginsDirectory, trustStore: pluginTrustStore } }),
    });
    coordinator = extensions.coordinator;
    pluginHost = extensions.pluginHost;
    mcpManager = extensions.mcpManager;
    await coordinator.reload();

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

    let stopPromise: Promise<void> | undefined;
    const onSigint = (): void => {
      void stop();
    };
    const onSigterm = (): void => {
      void stop();
    };
    const stop = (): Promise<void> => {
      if (stopPromise !== undefined) {
        return stopPromise;
      }

      process.removeListener('SIGINT', onSigint);
      process.removeListener('SIGTERM', onSigterm);

      let resolveStop!: () => void;
      let rejectStop!: (error: unknown) => void;
      stopPromise = new Promise<void>((resolve, reject) => {
        resolveStop = resolve;
        rejectStop = reject;
      });
      void (async () => {
        let firstError: unknown;
        let hasError = false;
        const cleanup = async (operation: () => Promise<void>): Promise<void> => {
          try {
            await operation();
          } catch (error: unknown) {
            if (!hasError) {
              hasError = true;
              firstError = error;
            }
          }
        };

        // Stop accepting connections now, then cancel/drain Agent streams while
        // their durable Session store is still open. Awaiting HTTP first would
        // deadlock on an SSE stream blocked in Approval.
        const closed = closeServer(createdServer);
        // Attach rejection handling immediately while generation cancellation runs.
        const closeOutcome = closed.then(
          () => undefined,
          (error: unknown) => error,
        );
        await cleanup(async () => coordinator?.dispose());
        await cleanup(() => disposeServerPlugins(runtime));
        // Approval SSE and other idle streams do not belong to an Agent iterator.
        // Their sockets can close once Agent terminal writes have settled.
        if ('closeAllConnections' in createdServer) createdServer.closeAllConnections();
        await cleanup(async () => {
          const error = await closeOutcome;
          if (error !== undefined) throw error;
        });
        await cleanup(() => runtime.stop());
        await cleanup(() => closeProjectStore(projectStore));
        await cleanup(() => closeProviderSettingsStore(providerSettingsStore));
        await cleanup(async () => pluginTrustStore?.close());
        await cleanup(async () => mcpAuthorityStore?.close());

        if (hasError) {
          throw firstError;
        }
      })().then(resolveStop, rejectStop);
      return stopPromise;
    };

    process.on('SIGINT', onSigint);
    process.on('SIGTERM', onSigterm);

    return { port: address.port, runtime, pluginHost, mcpManager, server: createdServer, stop };
  } catch (error) {
    // Begin closing HTTP, then cancel generations before awaiting SSE sockets.
    const closed = server === undefined ? undefined : closeServer(server).catch(() => undefined);
    await coordinator?.dispose().catch(() => undefined);
    await disposeServerPlugins(runtime).catch(() => undefined);
    if (server !== undefined && 'closeAllConnections' in server) server.closeAllConnections();
    await closed;
    await runtime.stop().catch(() => undefined);
    await closeProjectStore(projectStore).catch(() => undefined);
    await closeProviderSettingsStore(providerSettingsStore).catch(() => undefined);
    await pluginTrustStore?.close().catch(() => undefined);
    await mcpAuthorityStore?.close().catch(() => undefined);
    throw error;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await startServer();
}
