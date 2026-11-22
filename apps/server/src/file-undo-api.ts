import { z } from 'zod';
import type { Context, Hono } from 'hono';
import {
  createFileUndoService,
  createWorkspacePolicy,
  FileUndoError,
  type Runtime,
} from '@weave/runtime';
import type { ProjectStore } from '@weave/workspace';
import { readFileUndoRequest } from './file-undo-guard.js';
import { getServerSessionStore } from './runtime.js';
export interface FileUndoAppOptions {
  readonly projectStore?: ProjectStore | undefined;
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
/** HTTP validation and Project admission only; Runtime owns restoration. */
export function registerFileUndoRoutes(
  app: Hono,
  runtime: Runtime,
  options: FileUndoAppOptions,
): void {
  async function inputFor(context: Context, turnId: string) {
    const projectId = context.req.param('projectId');
    const sessionId = context.req.param('sessionId');
    if (!projectId || !sessionId)
      throw new FileUndoError('undo-invalid-input', 'Project and Session are required');
    const projects = options.projectStore;
    if (projects === undefined)
      throw new FileUndoError('undo-unavailable', 'File undo is unavailable');
    const project = await projects.getProject(projectId);
    if (project === undefined)
      throw new FileUndoError('undo-project-not-found', 'Project was not found');
    const folder = project.folderPath;
    if (folder === undefined)
      throw new FileUndoError('undo-no-workspace', 'Project folder is not set');
    async function admit() {
      const current = await projects!.getProject(projectId!);
      if (current?.folderPath !== folder)
        throw new FileUndoError('undo-root-changed', 'Project folder changed');
      const refs = await projects!.listSessionRefs(projectId!);
      if (!refs.some((ref) => ref.sessionId === sessionId))
        throw new FileUndoError('undo-session-not-found', 'Session was not found in this Project');
    }
    await admit();
    return {
      projectId,
      sessionId,
      turnId,
      workspace: createWorkspacePolicy({ root: folder }),
      admit,
    };
  }
  app.get('/projects/:projectId/sessions/:sessionId/file-undo', async (context) => {
    context.header('Cache-Control', 'no-store');
    try {
      const query = reviewQuerySchema.safeParse(context.req.query());
      if (!query.success) throw new FileUndoError('undo-invalid-input', 'turnId is required');
      const input = await inputFor(context, query.data.turnId);
      return context.json(
        await createFileUndoService({ store: getServerSessionStore(runtime) }).review(input),
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
      const input = await inputFor(context, parsed.data.turnId);
      return context.json(
        await createFileUndoService({ store: getServerSessionStore(runtime) }).undo({
          ...input,
          ...parsed.data,
        }),
      );
    } catch (error) {
      return errorResponse(context, error);
    }
  });
}
