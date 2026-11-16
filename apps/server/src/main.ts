import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { serve, type ServerType } from '@hono/node-server';
import { createSqliteSessionEventStore, type SessionEventStore } from '@weave/session';
import { createSqliteProjectStore, type ProjectStore } from '@weave/workspace';
import { z } from 'zod';
import { createApp } from './app.js';
import { createSessionService } from './session-service.js';
import { createServerLlmProviders } from './llm-providers.js';
import {
  approvalBrokerService,
  createServerAgentRunner,
  createServerRuntime,
  getServerSessionStore,
} from './runtime.js';

const portSchema = z.coerce.number().int().min(1).max(65535);
const persistenceOptionsSchema = z.object({
  dataDirectory: z.string().min(1).default('.weave'),
  databaseFile: z.string().min(1).optional(),
});
const defaultPort = 4317;

export interface StartServerOptions {
  readonly databaseFile?: string;
  readonly dataDirectory?: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly fetch?: typeof globalThis.fetch;
  readonly projectStore?: ProjectStore;
  readonly sessionStoreFactory?: () => SessionEventStore | Promise<SessionEventStore>;
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
  const databaseFile = persistence.databaseFile ?? join(persistence.dataDirectory, 'weave.sqlite');
  await mkdir(dirname(databaseFile), { recursive: true });
  const providerSettings = createServerLlmProviders({
    ...(options.environment === undefined ? {} : { environment: options.environment }),
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  });

  const projectStore = options.projectStore ?? createSqliteProjectStore({ filename: databaseFile });
  const sessionStoreFactory =
    options.sessionStoreFactory ??
    (() => createSqliteSessionEventStore({ filename: databaseFile }));
  const runtime = createServerRuntime({ sessionStoreFactory, providerSettings });
  let server: ServerType | undefined;

  try {
    await runtime.start();
    const sessionStore = getServerSessionStore(runtime);
    const sessionService = createSessionService({ projectStore, sessionStore });
    const agentRunner = createServerAgentRunner(runtime);

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

    let stopPromise: Promise<void> | undefined;
    const stop = async (): Promise<void> => {
      if (stopPromise !== undefined) {
        return stopPromise;
      }
      stopPromise = (async () => {
        await closeServer(createdServer);
        try {
          await runtime.stop();
        } finally {
          await closeProjectStore(projectStore);
        }
      })();
      return stopPromise;
    };

    process.once('SIGINT', () => {
      void stop();
    });
    process.once('SIGTERM', () => {
      void stop();
    });

    return { port, runtime, server: createdServer, stop };
  } catch (error) {
    if (server !== undefined) {
      await closeServer(server).catch(() => undefined);
    }
    await runtime.stop().catch(() => undefined);
    await closeProjectStore(projectStore).catch(() => undefined);
    throw error;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await startServer();
}
