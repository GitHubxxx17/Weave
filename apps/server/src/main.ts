import { serve } from '@hono/node-server';
import { z } from 'zod';
import { createApp } from './app.js';
import { createServerRuntime } from './runtime.js';

const portSchema = z.coerce.number().int().min(1).max(65535);
const defaultPort = 4317;

export async function startServer(portInput: string | number = process.env.PORT ?? defaultPort) {
  const port = portSchema.parse(portInput);
  const runtime = createServerRuntime();
  await runtime.start();

  const server = serve({
    fetch: createApp(runtime).fetch,
    hostname: '127.0.0.1',
    port,
  });

  const stop = async (): Promise<void> => {
    server.close();
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
