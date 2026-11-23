import { z } from 'zod';
import type { Context, Hono } from 'hono';
import {
  createFileUndoService,
  FileUndoError,
  type FileUndoInput,
  type Runtime,
} from '@weave/runtime';
import type { ProjectStore } from '@weave/workspace';
import { readFileUndoRequest } from './file-undo-guard.js';
import {
  ProjectFolderAuthorityError,
  type ProjectFolderAuthority,
} from './project-folder-authority.js';
import { getServerSessionStore } from './runtime.js';

export interface FileUndoAppOptions {
  readonly projectStore?: ProjectStore | undefined;
  readonly projectFolderAuthority?: ProjectFolderAuthority | undefined;
}
const id = z.string().min(1).max(128);
const undoBodySchema = z.object({ turnId: id, operationId: id, requestId: id }).strict();
const reviewQuerySchema = z.object({ turnId: id }).strict();
function errorResponse(context: Context, error: unknown) {
  if (error instanceof FileUndoError) {
    const status =
      error.code === 'undo-request-too-large'
        ? 413
        : error.code === 'undo-invalid-input'
          ? 400
          : error.code.includes('not-found')
            ? 404
            : error.code === 'undo-unavailable'
              ? 503
              : 409;
    return context.json({ error: { code: error.code, message: error.message } }, status);
  }
  return context.json(
    {
      error: {
        code: 'undo-unavailable',
        message: 'File undo could not be completed; retry the same request',
      },
    },
    503,
  );
}

function mapAuthorityError(error: unknown): never {
  if (error instanceof ProjectFolderAuthorityError) {
    if (error.code === 'task-project-relation-changed')
      throw new FileUndoError('undo-session-not-found', 'Session was not found in this Project');
    if (error.code === 'task-project-folder-changed' || error.code === 'task-project-root-changed')
      throw new FileUndoError('undo-root-changed', 'Project folder changed');
  }
  throw error;
}

/** HTTP validation and Project admission only; Runtime owns restoration. */
export function registerFileUndoRoutes(
  app: Hono,
  runtime: Runtime,
  options: FileUndoAppOptions,
): void {
  async function withInput<T>(
    context: Context,
    turnId: string,
    operation: (input: Omit<FileUndoInput, 'operationId' | 'requestId'>) => Promise<T>,
  ): Promise<T> {
    const projectId = context.req.param('projectId');
    const sessionId = context.req.param('sessionId');
    if (!projectId || !sessionId)
      throw new FileUndoError('undo-invalid-input', 'Project and Session are required');
    const projects = options.projectStore;
    const authority = options.projectFolderAuthority;
    if (projects === undefined || authority === undefined)
      throw new FileUndoError('undo-unavailable', 'File undo is unavailable');
    const project = await projects.getProject(projectId);
    if (project === undefined)
      throw new FileUndoError('undo-project-not-found', 'Project was not found');
    if (project.folderPath === undefined)
      throw new FileUndoError('undo-no-workspace', 'Project folder is not set');
    const binding = await authority.capture(sessionId).catch(mapAuthorityError);
    try {
      if (authority.snapshot(binding).projectId !== projectId)
        throw new FileUndoError('undo-session-not-found', 'Session was not found in this Project');
      const workspace = await authority.resolve(binding, sessionId);
      if (workspace === undefined)
        throw new FileUndoError('undo-no-workspace', 'Project folder is not set');
      return await operation({
        projectId,
        sessionId,
        turnId,
        workspace,
        assertMutationCurrent: () => authority.assertEffectCurrentSync(binding),
      });
    } catch (error) {
      mapAuthorityError(error);
    } finally {
      authority.release(binding);
    }
  }
  app.get('/projects/:projectId/sessions/:sessionId/file-undo', async (context) => {
    context.header('Cache-Control', 'no-store');
    try {
      const query = reviewQuerySchema.safeParse(context.req.query());
      if (!query.success) throw new FileUndoError('undo-invalid-input', 'turnId is required');
      return context.json(
        await withInput(context, query.data.turnId, (input) =>
          createFileUndoService({ store: getServerSessionStore(runtime) }).review(input),
        ),
      );
    } catch (error) {
      return errorResponse(context, error);
    }
  });
  app.post('/projects/:projectId/sessions/:sessionId/undo', async (context) => {
    context.header('Cache-Control', 'no-store');
    try {
      if (new URL(context.req.url).searchParams.size !== 0)
        throw new FileUndoError('undo-invalid-input', 'Query parameters are not accepted');
      const parsed = undoBodySchema.safeParse(await readFileUndoRequest(context.req.raw));
      if (!parsed.success)
        throw new FileUndoError(
          'undo-invalid-input',
          'turnId, operationId and requestId are required',
        );
      return context.json(
        await withInput(context, parsed.data.turnId, (input) =>
          createFileUndoService({ store: getServerSessionStore(runtime) }).undo({
            ...input,
            ...parsed.data,
          }),
        ),
      );
    } catch (error) {
      return errorResponse(context, error);
    }
  });
}
