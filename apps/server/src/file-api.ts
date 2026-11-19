import type { Context, Hono } from 'hono';
import { stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { z } from 'zod';
import type { ProjectStore } from '@weave/workspace';
import {
  WorkspaceFileError,
  listWorkspaceFiles,
  readGitBaseContent,
  readWorkspaceFileContent,
} from '@weave/runtime';

/** Dependencies needed by the read-only project file routes. */
export interface FileAppOptions {
  readonly projectStore?: ProjectStore | undefined;
}

const filePathQuerySchema = z.string().min(1);

function status(code: string): 400 | 404 | 409 | 415 | 500 | 503 {
  if (code === 'workspace-file-not-found') {
    return 404;
  }
  if (code === 'workspace-file-binary') {
    return 415;
  }
  if (
    code === 'workspace-file-outside-root' ||
    code === 'workspace-file-symlink-outside-root' ||
    code === 'workspace-file-invalid-input' ||
    code === 'workspace-file-is-directory' ||
    code === 'invalid-request'
  ) {
    return 400;
  }
  if (code === 'workspace-project-not-found') {
    return 404;
  }
  if (code === 'project-folder-unset') {
    return 409;
  }
  if (code === 'project-folder-invalid') {
    return 400;
  }
  if (code === 'session-service-unavailable') {
    return 503;
  }
  return 500;
}

function jsonError(context: Context, code: string, message: string): Response {
  return context.json({ error: { code, message } }, status(code));
}

/** The viewer and tree only accept an existing absolute project directory. */
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

/** Resolves the project's folder, or an error Response the caller returns as-is. */
async function resolveProjectFolder(
  context: Context,
  options: FileAppOptions,
): Promise<string | Response> {
  const store = options.projectStore;
  if (store === undefined) {
    return jsonError(context, 'session-service-unavailable', 'Workspace service is not available');
  }
  const projectId = context.req.param('projectId');
  if (projectId === undefined) {
    return jsonError(context, 'invalid-request', 'A projectId is required');
  }
  let project;
  try {
    project = await store.getProject(projectId);
  } catch {
    return jsonError(context, 'server-internal-error', 'Server request failed');
  }
  if (project === undefined) {
    return jsonError(context, 'workspace-project-not-found', 'Project was not found');
  }
  const folderPath = project.folderPath;
  if (folderPath === undefined) {
    return jsonError(context, 'project-folder-unset', 'Project has no folder set');
  }
  if (!(await isExistingDirectory(folderPath))) {
    return jsonError(
      context,
      'project-folder-invalid',
      'Project folder is not an existing directory',
    );
  }
  return folderPath;
}

function mapFileError(context: Context, error: unknown): Response {
  if (error instanceof WorkspaceFileError) {
    return jsonError(context, error.code, error.message);
  }
  return jsonError(context, 'server-internal-error', 'Server request failed');
}

/** Mounts read-only project file tree and file-content routes. */
export function registerFileRoutes(app: Hono, options: FileAppOptions): void {
  app.get('/projects/:projectId/tree', async (context) => {
    const folder = await resolveProjectFolder(context, options);
    if (folder instanceof Response) {
      return folder;
    }
    try {
      const listing = await listWorkspaceFiles(folder, { signal: context.req.raw.signal });
      return context.json(listing);
    } catch (error) {
      return mapFileError(context, error);
    }
  });

  app.get('/projects/:projectId/file', async (context) => {
    const folder = await resolveProjectFolder(context, options);
    if (folder instanceof Response) {
      return folder;
    }
    const pathResult = filePathQuerySchema.safeParse(context.req.query('path'));
    if (!pathResult.success) {
      return jsonError(context, 'invalid-request', 'A non-empty path query is required');
    }
    try {
      const file = await readWorkspaceFileContent(folder, pathResult.data, {
        signal: context.req.raw.signal,
      });
      return context.json(file);
    } catch (error) {
      return mapFileError(context, error);
    }
  });

  app.get('/projects/:projectId/file-diff', async (context) => {
    const folder = await resolveProjectFolder(context, options);
    if (folder instanceof Response) {
      return folder;
    }
    const pathResult = filePathQuerySchema.safeParse(context.req.query('path'));
    if (!pathResult.success) {
      return jsonError(context, 'invalid-request', 'A non-empty path query is required');
    }
    try {
      const [base, current] = await Promise.all([
        readGitBaseContent(folder, pathResult.data),
        readWorkspaceFileContent(folder, pathResult.data, { signal: context.req.raw.signal }),
      ]);
      return context.json({
        path: current.path,
        oldContent: base.content,
        newContent: current.content,
        changed: base.content !== current.content,
        tracked: base.tracked,
      });
    } catch (error) {
      return mapFileError(context, error);
    }
  });
}
