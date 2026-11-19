import { z } from 'zod';
import type { Context, Hono } from 'hono';
import { createWorkspacePolicy, restoreFileSnapshot, type Runtime } from '@weave/runtime';
import { fileUndoForTurn } from '@weave/session';
import type { ProjectStore } from '@weave/workspace';
import { getServerSessionStore } from './runtime.js';

/** Dependency used to resolve a project's workspace folder for restore. */
export interface FileUndoAppOptions {
  readonly projectStore?: ProjectStore | undefined;
}

const undoBodySchema = z.object({ turnId: z.string().min(1) }).strict();

function jsonError(context: Context, status: 400 | 404 | 503, code: string, message: string) {
  return context.json({ error: { code, message } }, status);
}

/**
 * Mounts the file-undo route: restores every file one turn changed back to the
 * content captured before the turn (or deletes files the turn created). Paths
 * are resolved through the project's Workspace policy, so a restore can never
 * write outside the project folder.
 */
export function registerFileUndoRoutes(
  app: Hono,
  runtime: Runtime,
  options: FileUndoAppOptions,
): void {
  app.post('/projects/:projectId/sessions/:sessionId/undo', async (context: Context) => {
    const projectStore = options.projectStore;
    if (projectStore === undefined) {
      return jsonError(context, 503, 'undo-unavailable', 'Undo is not available');
    }

    const projectId = context.req.param('projectId');
    const sessionId = context.req.param('sessionId');
    if (projectId === undefined || sessionId === undefined) {
      return jsonError(context, 400, 'undo-invalid-input', 'Project and session are required');
    }

    let body: unknown;
    try {
      body = await context.req.json();
    } catch {
      return jsonError(context, 400, 'undo-invalid-input', 'Request body is invalid');
    }
    const parsed = undoBodySchema.safeParse(body);
    if (!parsed.success) {
      return jsonError(context, 400, 'undo-invalid-input', 'turnId is required');
    }

    const project = await projectStore.getProject(projectId);
    if (project === undefined) {
      return jsonError(context, 404, 'undo-project-not-found', 'Project was not found');
    }
    if (project.folderPath === undefined) {
      return jsonError(context, 400, 'undo-no-workspace', 'Project folder is not set');
    }

    const events = await getServerSessionStore(runtime).read(sessionId);
    const snapshots = fileUndoForTurn(events, parsed.data.turnId);
    const workspace = createWorkspacePolicy({ root: project.folderPath });

    const restored: string[] = [];
    const failed: string[] = [];
    for (const snapshot of snapshots) {
      try {
        const outcome = await restoreFileSnapshot(snapshot, workspace);
        if (outcome !== 'skipped') {
          restored.push(snapshot.path);
        }
      } catch {
        failed.push(snapshot.path);
      }
    }

    return context.json({ restored, failed }, 200);
  });
}
