import { registerAgentExecutionGuards } from './agent-execution-guard.js';
import {
  registerAgentExecutionRoutes,
  type AgentExecutionAppOptions,
} from './agent-execution-api.js';
import { registerAgentTaskRoutes, type AgentTaskAppOptions } from './agent-task-api.js';
import {
  registerPanelGuards,
  registerPanelRoutes,
  type PanelAppOptions,
} from './plugin-panel-api.js';
import { Hono } from 'hono';
import { registerRetrievalRoutes, type RetrievalRouteOptions } from './retrieval-routes.js';
import { registerLocalRequestGuard } from './local-request-guard.js';
import { registerAccessTokenGuard } from './access-token.js';
import { registerStudioStatic } from './studio-static.js';
import { registerRetrievalGuard } from './retrieval-guard.js';
import { registerMemoryRoutes, type MemoryAppOptions } from './memory-api.js';
import { cors } from 'hono/cors';
import { z } from 'zod';
import { registerProviderRoutes, type ProviderAppOptions } from './provider-api.js';
import type { Runtime } from '@weave/runtime';
import { registerApprovalRoutes, type ApprovalAppOptions } from './approval-api.js';
import { registerSessionRoutes, type SessionAppOptions } from './session-api.js';
import { registerWorkspaceRoutes, type WorkspaceAppOptions } from './workspace-api.js';
import { createProjectFolderAuthority } from './project-folder-authority.js';
import { registerSkillRoutes, type SkillAppOptions } from './skill-api.js';
import { registerFileUndoGuards } from './file-undo-guard.js';
import { registerFileUndoRoutes } from './file-undo-api.js';
import { registerFileRoutes, type FileAppOptions } from './file-api.js';
import { registerPluginRoutes, type PluginAppOptions } from './plugin-api.js';
import { registerMcpRoutes, type McpAppOptions } from './mcp-api.js';
import {
  registerPluginMarketplaceRoutes,
  type PluginMarketplaceAppOptions,
} from './plugin-marketplace-api.js';

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
    AgentExecutionAppOptions,
    AgentTaskAppOptions,
    SessionAppOptions,
    WorkspaceAppOptions,
    FileAppOptions,
    PluginAppOptions,
    McpAppOptions,
    PluginMarketplaceAppOptions,
    ProviderAppOptions,
    SkillAppOptions,
    PanelAppOptions,
    MemoryAppOptions {
  readonly retrievalService?: RetrievalRouteOptions['service'];
  readonly retrievalEmbedding?: RetrievalRouteOptions['embedding'];
  /**
   * Exact browser origin allowed to call the local control plane.
   *
   * The desktop composition root supplies this value because its Studio and
   * randomly-port Server use different origins.
   */
  readonly studioOrigin?: string;
  /**
   * `<host>:<port>` (or `*:<port>`) admitted as `Host`/`Origin` besides loopback.
   * Set only when the Server listens beyond loopback.
   */
  readonly trustedHost?: string;
  /** Requires this token on every request except `/health`; set with `trustedHost`. */
  readonly accessToken?: string;
  /** Studio `vite build` output served on paths no API route handles. */
  readonly studioDirectory?: string;
}

export function createApp(runtime: Runtime, options?: AppOptions): Hono {
  const app = new Hono();
  const studioOrigin = options?.studioOrigin;
  const trustedHost = options?.trustedHost;
  const workspaceOptions = {
    ...options,
    projectFolderAuthority:
      options?.projectFolderAuthority ??
      (options?.projectStore === undefined
        ? undefined
        : createProjectFolderAuthority(options.projectStore)),
  };

  // Hono's trailing wildcard matches the collection as well as descendants.
  app.use('/plugins/managed/*', async (context, next) => {
    context.header('Cache-Control', 'no-store');
    await next();
  });

  // The token check precedes every guard so an unauthenticated peer learns nothing.
  if (options?.accessToken !== undefined) registerAccessTokenGuard(app, options.accessToken);

  registerRetrievalGuard(app, studioOrigin, trustedHost);
  registerAgentExecutionGuards(app, studioOrigin, ['/memory', '/memory/*'], undefined, trustedHost);
  registerPanelGuards(app, options ?? {});
  registerAgentExecutionGuards(app, studioOrigin, undefined, undefined, trustedHost);
  registerAgentExecutionGuards(
    app,
    studioOrigin,
    ['/sessions/:sessionId/tasks', '/sessions/:sessionId/tasks/*'],
    undefined,
    trustedHost,
  );
  registerFileUndoGuards(app, options ?? {});
  // Registered after the path guards so they keep their specific error codes;
  // everything they do not cover is admitted (or rejected) here, before CORS.
  registerLocalRequestGuard(app, studioOrigin, trustedHost);

  if (studioOrigin !== undefined) {
    app.use(
      '*',
      cors({
        origin: studioOrigin,
        allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
        allowHeaders: ['Content-Type', 'Last-Event-ID'],
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

  registerRetrievalRoutes(app, {
    service: options?.retrievalService,
    embedding: options?.retrievalEmbedding,
  });
  registerMemoryRoutes(app, options ?? {});
  registerApprovalRoutes(app, runtime, options ?? {});
  registerWorkspaceRoutes(app, workspaceOptions);
  registerFileUndoRoutes(app, runtime, workspaceOptions);
  registerFileRoutes(app, options ?? {});
  registerSessionRoutes(app, options ?? {});
  registerAgentExecutionRoutes(app, options ?? {});
  registerAgentTaskRoutes(app, options ?? {});
  registerSkillRoutes(app, options ?? {});
  registerProviderRoutes(app, options ?? {});
  registerPluginRoutes(app, options ?? {});
  registerPanelRoutes(app, options ?? {});
  registerPluginMarketplaceRoutes(app, options ?? {});
  registerMcpRoutes(app, options ?? {});
  if (options?.studioDirectory !== undefined) {
    registerStudioStatic(app, options.studioDirectory);
  }

  return app;
}

export type { ApprovalAppOptions } from './approval-api.js';
export type { PluginAppOptions } from './plugin-api.js';
export type { McpAppOptions } from './mcp-api.js';
export type { ProviderAppOptions } from './provider-api.js';
export type { ProviderSecretCodec } from './provider-secret-codec.js';
