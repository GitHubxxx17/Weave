import type { Context, Hono } from 'hono';
import { z } from 'zod';
import type { ProjectStore } from '@weave/workspace';
import {
  SessionServiceError,
  type ProjectListWarning,
  type SessionService,
  type SessionSummary,
} from './session-service.js';
import { WorkspaceStoreError } from '@weave/workspace';

const createProjectRequestSchema = z
  .object({
    name: z.string().min(1),
    folderName: z.string().min(1),
    folderPath: z.string().min(1).optional(),
  })
  .strict();

const createSessionRequestSchema = z
  .object({
    title: z.string().min(1).optional(),
  })
  .strict();

const includeArchivedSchema = z.enum(['true', 'false']).transform((value) => value === 'true');

/** Dependencies needed by Project and Project Session routes. */
export interface WorkspaceAppOptions {
  readonly projectStore?: ProjectStore | undefined;
  readonly sessionService?: SessionService | undefined;
}

function errorStatus(code: string): 400 | 404 | 409 | 422 | 500 | 503 {
  if (code === 'workspace-store-invalid-input' || code === 'invalid-request') {
    return 400;
  }
  if (code === 'workspace-project-not-found' || code === 'session-not-found') {
    return 404;
  }
  if (code === 'workspace-session-already-attached' || code === 'session-archived') {
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

function getDependencies(
  context: Context,
  options: WorkspaceAppOptions,
):
  | {
      readonly projectStore: ProjectStore;
      readonly sessionService: SessionService;
    }
  | Response {
  if (options.projectStore === undefined || options.sessionService === undefined) {
    return jsonError(context, 'session-service-unavailable', 'Workspace service is not available');
  }
  return { projectStore: options.projectStore, sessionService: options.sessionService };
}

/** Mounts Project and Project Session management routes. */
export function registerWorkspaceRoutes(app: Hono, options: WorkspaceAppOptions): void {
  app.get('/projects', async (context) => {
    const dependencies = getDependencies(context, options);
    if (dependencies instanceof Response) {
      return dependencies;
    }

    const includeArchivedResult = includeArchivedSchema.safeParse(
      context.req.query('includeArchived') ?? 'false',
    );
    if (!includeArchivedResult.success) {
      return jsonError(context, 'invalid-request', 'Query parameters are invalid');
    }

    try {
      const projects = await dependencies.projectStore.listProjects();
      const warnings: ProjectListWarning[] = [];
      const projectResponses = [];

      for (const project of projects) {
        const result = await dependencies.sessionService.listProjectSessions(project.id, {
          includeArchived: includeArchivedResult.data,
        });
        warnings.push(...result.warnings);
        projectResponses.push({
          ...project,
          sessions: result.sessions,
        });
      }

      return context.json({ projects: projectResponses, warnings });
    } catch (error) {
      return mapError(context, error);
    }
  });

  app.post('/projects', async (context) => {
    const dependencies = getDependencies(context, options);
    if (dependencies instanceof Response) {
      return dependencies;
    }

    const body = await readJson(context);
    if (body instanceof Response) {
      return body;
    }
    const parsed = createProjectRequestSchema.safeParse(body);
    if (!parsed.success) {
      return jsonError(context, 'workspace-store-invalid-input', 'Project input is invalid');
    }

    try {
      return context.json(await dependencies.projectStore.createProject(parsed.data), 201);
    } catch (error) {
      return mapError(context, error);
    }
  });

  app.get('/projects/:projectId/sessions', async (context) => {
    const dependencies = getDependencies(context, options);
    if (dependencies instanceof Response) {
      return dependencies;
    }

    const includeArchivedResult = includeArchivedSchema.safeParse(
      context.req.query('includeArchived') ?? 'false',
    );
    if (!includeArchivedResult.success) {
      return jsonError(context, 'invalid-request', 'Query parameters are invalid');
    }

    try {
      const result = await dependencies.sessionService.listProjectSessions(
        context.req.param('projectId'),
        { includeArchived: includeArchivedResult.data },
      );
      return context.json(result);
    } catch (error) {
      return mapError(context, error);
    }
  });

  app.post('/projects/:projectId/sessions', async (context) => {
    const dependencies = getDependencies(context, options);
    if (dependencies instanceof Response) {
      return dependencies;
    }

    const body = await readJson(context);
    if (body instanceof Response) {
      return body;
    }
    const parsed = createSessionRequestSchema.safeParse(body);
    if (!parsed.success) {
      return jsonError(context, 'workspace-store-invalid-input', 'Session input is invalid');
    }

    try {
      return context.json(
        await dependencies.sessionService.create(context.req.param('projectId'), parsed.data.title),
        201,
      );
    } catch (error) {
      return mapError(context, error);
    }
  });
}

export type { SessionSummary };
