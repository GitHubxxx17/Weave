import { Hono } from 'hono';
import { z } from 'zod';
import type { Runtime } from '@weave/runtime';

const healthResponseSchema = z.object({
  status: z.enum(['ok', 'unavailable']),
  runtime: z.enum(['created', 'starting', 'running', 'stopping', 'stopped']),
});

/**
 * Creates the HTTP control-plane application around an existing Runtime.
 *
 * The app reads Runtime state but does not construct services or execute agent
 * behavior. Keeping that boundary thin allows the same Runtime to be reused by
 * CLI, desktop, and test entry points.
 *
 * @param runtime Runtime whose lifecycle is exposed by the health endpoint.
 * @returns A Hono application that can be mounted on a server or tested in memory.
 */
export function createApp(runtime: Runtime): Hono {
  const app = new Hono();

  app.get('/health', (context) => {
    const running = runtime.status === 'running';
    const body = healthResponseSchema.parse({
      status: running ? 'ok' : 'unavailable',
      runtime: runtime.status,
    });

    return context.json(body, running ? 200 : 503);
  });

  return app;
}
