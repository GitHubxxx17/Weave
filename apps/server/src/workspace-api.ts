import type { Context, Hono } from 'hono';
import { stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { z } from 'zod';
import type { ProjectStore } from '@weave/workspace';
import type { ProjectFolderAuthority } from './project-folder-authority.js';
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

/**
 * Partial Project update with at least one field. `name` renames the Project;
 * `folderPath: null` clears the folder and a string sets or replaces it.
 */
const updateProjectRequestSchema = z
  .object({
    name: z.string().min(1).optional(),
    folderPath: z.string().min(1).nullable().optional(),
  })
  .strict()
  .refine((value) => value.name !== undefined || value.folderPath !== undefined);

const includeArchivedSchema = z.enum(['true', 'false']).transform((value) => value === 'true');

/** The Agent can only use a Project folder that the Server can see as a directory. */
async function isExistingDirectory(folderPath: string): Promise<boolean> {
  if (!isAbsolute(folderPath) || folderPath.includes('\0')) {
    return false;
  }
  try {
    return (await stat(folderPath)).isDirectory();
  } catch {
    return false;
  }
}

/** Dependencies needed by Project and Project Session routes. */
export interface WorkspaceAppOptions {
  readonly projectStore?: ProjectStore | undefined;
  readonly sessionService?: SessionService | undefined;
  readonly projectFolderAuthority?: ProjectFolderAuthority | undefined;
}

function errorStatus(code: string): 400 | 404 | 409 | 422 | 500 | 503 {
  if (
    code === 'workspace-store-invalid-input' ||
    code === 'invalid-request' ||
    code === 'project-folder-invalid'
  ) {
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
    if (
      parsed.data.folderPath !== undefined &&
      !(await isExistingDirectory(parsed.data.folderPath))
    ) {
      return jsonError(
        context,
        'project-folder-invalid',
        'Project folder must be an existing absolute directory',
      );
    }

    try {
      return context.json(await dependencies.projectStore.createProject(parsed.data), 201);
    } catch (error) {
      return mapError(context, error);
    }
  });

  app.patch('/projects/:projectId', async (context) => {
    const dependencies = getDependencies(context, options);
    if (dependencies instanceof Response) {
      return dependencies;
    }

    const body = await readJson(context);
    if (body instanceof Response) {
      return body;
    }
    const parsed = updateProjectRequestSchema.safeParse(body);
    if (!parsed.success) {
      return jsonError(context, 'workspace-store-invalid-input', 'Project input is invalid');
    }
    const { name, folderPath } = parsed.data;
    // Validate the folder before writing anything so a bad path cannot leave a
    // half-applied rename behind.
    if (typeof folderPath === 'string' && !(await isExistingDirectory(folderPath))) {
      return jsonError(
        context,
        'project-folder-invalid',
        'Project folder must be an existing absolute directory',
      );
    }

    try {
      const projectId = context.req.param('projectId');
      const store = dependencies.projectStore;
      const authority = options.projectFolderAuthority;
      if (folderPath !== undefined && authority === undefined) {
        return jsonError(
          context,
          'session-service-unavailable',
          'Workspace service is not available',
        );
      }
      const renamed = name === undefined ? undefined : await store.renameProject(projectId, name);
      const project =
        folderPath === undefined
          ? renamed
          : await authority!.updateFolder(projectId, folderPath ?? undefined);
      if (project === undefined) {
        return jsonError(context, 'workspace-store-invalid-input', 'Project input is invalid');
      }
      return context.json(project, 200);
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
