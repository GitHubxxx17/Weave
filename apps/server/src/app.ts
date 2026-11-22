import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { z } from 'zod';
import { registerProviderRoutes, type ProviderAppOptions } from './provider-api.js';
import type { Runtime } from '@weave/runtime';
import { registerApprovalRoutes, type ApprovalAppOptions } from './approval-api.js';
import { registerAgentRoutes, type AgentAppOptions } from './agent-api.js';
import { registerSessionRoutes, type SessionAppOptions } from './session-api.js';
import { registerWorkspaceRoutes, type WorkspaceAppOptions } from './workspace-api.js';
import { registerFileUndoRoutes } from './file-undo-api.js';
import { registerFileRoutes, type FileAppOptions } from './file-api.js';
import { registerPluginRoutes, type PluginAppOptions } from './plugin-api.js';
import { registerMcpRoutes, type McpAppOptions } from './mcp-api.js';

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
export interface AppOptions
  extends
    ApprovalAppOptions,
    AgentAppOptions,
    SessionAppOptions,
    WorkspaceAppOptions,
    FileAppOptions,
    PluginAppOptions,
    McpAppOptions,
    ProviderAppOptions {
  /**
   * Exact browser origin allowed to call the local control plane.
   *
   * The desktop composition root supplies this value because its Studio and
   * randomly-port Server use different origins.
   */
  readonly studioOrigin?: string;
}

export function createApp(runtime: Runtime, options?: AppOptions): Hono {
  const app = new Hono();
  const studioOrigin = options?.studioOrigin;

  // Hono's trailing wildcard matches the collection as well as descendants.
  app.use('/plugins/managed/*', async (context, next) => {
    context.header('Cache-Control', 'no-store');
    await next();
  });

  if (studioOrigin !== undefined) {
    app.use(
      '*',
      cors({
        origin: studioOrigin,
        allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
        allowHeaders: ['Content-Type'],
      }),
    );
  }

  app.get('/health', (context) => {
    const running = runtime.status === 'running';
    const body = healthResponseSchema.parse({
      status: running ? 'ok' : 'unavailable',
      runtime: runtime.status,
    });

    return context.json(body, running ? 200 : 503);
  });

  registerApprovalRoutes(app, runtime, options ?? {});
  registerWorkspaceRoutes(app, options ?? {});
  registerFileUndoRoutes(app, runtime, options ?? {});
  registerFileRoutes(app, options ?? {});
  registerSessionRoutes(app, options ?? {});
  registerAgentRoutes(app, runtime, options ?? {});
  registerProviderRoutes(app, options ?? {});
  registerPluginRoutes(app, options ?? {});
  registerMcpRoutes(app, options ?? {});

  return app;
}

export type { ApprovalAppOptions } from './approval-api.js';
export type { AgentAppOptions } from './agent-api.js';
export type { PluginAppOptions } from './plugin-api.js';
export type { McpAppOptions } from './mcp-api.js';
export type { ProviderAppOptions } from './provider-api.js';
export type { ProviderSecretCodec } from './provider-secret-codec.js';
