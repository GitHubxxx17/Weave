import type { Context, Hono } from 'hono';
import { z } from 'zod';
import { SessionServiceError, type SessionService } from './session-service.js';
import { WorkspaceStoreError } from '@weave/workspace';

const renameSessionRequestSchema = z
  .object({
    title: z.string().min(1),
  })
  .strict();

/** Dependencies needed by Session lifecycle routes. */
export interface SessionAppOptions {
  readonly sessionService?: SessionService | undefined;
}

function errorStatus(code: string): 400 | 404 | 409 | 410 | 422 | 500 | 503 {
  if (code === 'workspace-store-invalid-input' || code === 'invalid-request') {
    return 400;
  }
  if (code === 'workspace-project-not-found' || code === 'session-not-found') {
    return 404;
  }
  if (code === 'session-deleted') {
    return 410;
  }
  if (code === 'session-archived' || code === 'workspace-session-already-attached') {
    return 409;
  }
  if (code === 'session-projection-invalid') {
    return 422;
  }
  if (code === 'session-service-unavailable') {
    return 503;
  }
  return 500;
}

function jsonError(context: Context, code: string, message: string): Response {
  return context.json({ error: { code, message } }, errorStatus(code));
}

function mapError(context: Context, error: unknown): Response {
  if (error instanceof WorkspaceStoreError || error instanceof SessionServiceError) {
    return jsonError(context, error.code, error.message);
  }
  return jsonError(context, 'server-internal-error', 'Server request failed');
}

async function readJson(context: Context): Promise<unknown | Response> {
  try {
    return (await context.req.json()) as unknown;
  } catch {
    return jsonError(context, 'invalid-request', 'Request body is invalid');
  }
}

function getService(context: Context, options: SessionAppOptions): SessionService | Response {
  return (
    options.sessionService ??
    jsonError(context, 'session-service-unavailable', 'Session service is not available')
  );
}

/** Mounts Session detail and lifecycle routes. */
export function registerSessionRoutes(app: Hono, options: SessionAppOptions): void {
  app.get('/sessions/:sessionId', async (context) => {
    const service = getService(context, options);
    if (service instanceof Response) {
      return service;
    }
    try {
      return context.json(await service.get(context.req.param('sessionId')));
    } catch (error) {
      return mapError(context, error);
    }
  });

  app.patch('/sessions/:sessionId', async (context) => {
    const service = getService(context, options);
    if (service instanceof Response) {
      return service;
    }
    const body = await readJson(context);
    if (body instanceof Response) {
      return body;
    }
    const parsed = renameSessionRequestSchema.safeParse(body);
    if (!parsed.success) {
      return jsonError(context, 'workspace-store-invalid-input', 'Session title is invalid');
    }
    try {
      return context.json(await service.rename(context.req.param('sessionId'), parsed.data.title));
    } catch (error) {
      return mapError(context, error);
    }
  });

  app.post('/sessions/:sessionId/archive', async (context) => {
    const service = getService(context, options);
    if (service instanceof Response) {
      return service;
    }
    try {
      return context.json(await service.archive(context.req.param('sessionId')));
    } catch (error) {
      return mapError(context, error);
    }
  });

  app.post('/sessions/:sessionId/restore', async (context) => {
    const service = getService(context, options);
    if (service instanceof Response) {
      return service;
    }
    try {
      return context.json(await service.restore(context.req.param('sessionId')));
    } catch (error) {
      return mapError(context, error);
    }
  });

  app.delete('/sessions/:sessionId', async (context) => {
    const service = getService(context, options);
    if (service instanceof Response) {
      return service;
    }
    try {
      return context.json(await service.delete(context.req.param('sessionId')));
    } catch (error) {
      return mapError(context, error);
    }
  });
}
