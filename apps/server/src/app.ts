import { Hono } from 'hono';
import { z } from 'zod';
import type { Runtime } from '@weave/runtime';

const healthResponseSchema = z.object({
  status: z.enum(['ok', 'unavailable']),
  runtime: z.enum(['created', 'starting', 'running', 'stopping', 'stopped']),
});

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
