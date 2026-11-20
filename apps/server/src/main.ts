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
  listServerPlugins,
  registerServerPlugins,
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

  const providerSettingsStore =
    options.providerSettingsStore ??
    (options.providerSecretCodec === undefined
      ? undefined
      : createSqliteProviderSettingsStore({ filename: databaseFile }));
  const providerSettingsManager: ProviderSettingsManager | undefined =
    providerSettingsStore === undefined || options.providerSecretCodec === undefined
      ? undefined
      : createProviderSettingsManager({
          store: providerSettingsStore,
          registry: providerSettings.registry,
          secretCodec: options.providerSecretCodec,
          initialDefaultProvider: providerSettings.defaultProvider,
        });
  const projectStore = options.projectStore ?? createSqliteProjectStore({ filename: databaseFile });
  const sessionStoreFactory =
    options.sessionStoreFactory ??
    (() => createSqliteSessionEventStore({ filename: databaseFile }));
  const runtime = createServerRuntime({ sessionStoreFactory, providerSettings });
  let server: ServerType | undefined;

  try {
    if (providerSettingsManager !== undefined) {
      await providerSettingsManager.refresh();
    }
    await runtime.start();
    await registerServerPlugins(runtime, options.plugins);
    const sessionStore = getServerSessionStore(runtime);
    const sessionService = createSessionService({ projectStore, sessionStore });
    const agentRunner = await createServerAgentRunner(runtime, {
      resolveWorkspaceRoot: createWorkspaceRootResolver(projectStore),
      ...(maxSteps === undefined ? {} : { maxSteps }),
    });

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
          agentRunner,
          projectStore,
          sessionService,
          providerRegistry: providerSettings.registry,
          defaultProvider: providerSettings.defaultProvider,
          providerSettingsManager,
          canManageProviders: providerSettingsManager !== undefined,
          pluginCatalog: () => listServerPlugins(runtime),
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
    const stop = async (): Promise<void> => {
      if (stopPromise !== undefined) {
        return stopPromise;
      }

      process.removeListener('SIGINT', onSigint);
      process.removeListener('SIGTERM', onSigterm);

      stopPromise = (async () => {
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

        await cleanup(() => closeServer(createdServer));
        await cleanup(() => disposeServerPlugins(runtime));
        await cleanup(() => runtime.stop());
        await cleanup(() => closeProjectStore(projectStore));
        await cleanup(() => closeProviderSettingsStore(providerSettingsStore));

        if (hasError) {
          throw firstError;
        }
      })();
      return stopPromise;
    };

    process.on('SIGINT', onSigint);
    process.on('SIGTERM', onSigterm);

    return { port: address.port, runtime, server: createdServer, stop };
  } catch (error) {
    if (server !== undefined) {
      await closeServer(server).catch(() => undefined);
    }
    await disposeServerPlugins(runtime).catch(() => undefined);
    await runtime.stop().catch(() => undefined);
    await closeProjectStore(projectStore).catch(() => undefined);
    await closeProviderSettingsStore(providerSettingsStore).catch(() => undefined);
    throw error;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await startServer();
}
