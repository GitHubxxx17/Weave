import { serve, type ServerType } from '@hono/node-server';
import { z } from 'zod';
import { createApp } from './app.js';
import { createServerRuntime } from './runtime.js';

const portSchema = z.coerce.number().int().min(1).max(65535);
const defaultPort = 4317;

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

/**
 * Starts the local HTTP control plane and its Runtime.
 *
 * The function resolves only after the TCP server is listening. If binding
 * fails, it closes any partially-created server and stops the Runtime before
 * rethrowing the original error.
 *
 * @param portInput Port number or string value validated by the server boundary.
 * @returns Server handles and a coordinated stop function.
 */
export async function startServer(portInput: string | number = process.env.PORT ?? defaultPort) {
  const port = portSchema.parse(portInput);
  const runtime = createServerRuntime();
  await runtime.start();

  let resolveListening!: () => void;
  let rejectListening!: (error: unknown) => void;
  const listening = new Promise<void>((resolve, reject) => {
    resolveListening = resolve;
    rejectListening = reject;
  });
  const server = serve(
    {
      fetch: createApp(runtime).fetch,
      hostname: '127.0.0.1',
      port,
    },
    () => {
      resolveListening();
    },
  );
  const onError = (error: unknown): void => {
    rejectListening(error);
  };
  server.once('error', onError);

  try {
    await listening;
  } catch (error) {
    await closeServer(server).catch(() => undefined);
    await runtime.stop();
    throw error;
  } finally {
    server.off('error', onError);
  }

  const stop = async (): Promise<void> => {
    await closeServer(server);
    await runtime.stop();
  };

  process.once('SIGINT', () => {
    void stop();
  });
  process.once('SIGTERM', () => {
    void stop();
  });

  return { port, runtime, server, stop };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await startServer();
}
