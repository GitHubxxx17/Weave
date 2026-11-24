import {
  AgentExecutionError,
  captureWorkspaceContexts,
  captureWorkspaceFiles,
  type CaptureContexts,
  type CaptureFiles,
} from '@weave/runtime';
import type { ProjectStore } from '@weave/workspace';

/** The single Project that owns a Session, or `undefined` when none or several do. */
function createSessionOwner(projects: ProjectStore) {
  return async (sessionId: string) => {
    const matches = [];
    for (const project of await projects.listProjects()) {
      if ((await projects.listSessionRefs(project.id)).some((ref) => ref.sessionId === sessionId))
        matches.push(project);
    }
    return matches.length === 1 ? matches[0] : undefined;
  };
}

/** Project authority belongs to Server; Runtime receives only a trusted root. */
export function createFileContextCapture(projects: ProjectStore): CaptureFiles {
  const owner = createSessionOwner(projects);
  return async (sessionId, refs, options) => {
    try {
      const project = await owner(sessionId);
      if (project?.folderPath === undefined)
        throw new AgentExecutionError(
          'execution-file-unavailable',
          'Files require one Project with a configured folder',
        );
      const captured = await captureWorkspaceFiles(project.folderPath, refs, options);
      const current = await owner(sessionId);
      if (current?.id !== project.id || current.folderPath !== project.folderPath)
        throw new AgentExecutionError(
          'execution-file-changed',
          'Project file ownership changed during capture',
        );
      return { ...captured, projectId: project.id };
    } catch (error: unknown) {
      if (options.signal.aborted)
        throw new AgentExecutionError(
          'execution-file-capture-timeout',
          'Project file capture ended before acceptance',
        );
      if (error instanceof AgentExecutionError) throw error;
      throw new AgentExecutionError(
        'execution-file-capture-failed',
        'Project files could not be captured',
      );
    }
  };
}

/** Captures Git changes and the project tree for the Project that owns the Session. */
export function createWorkspaceContextCapture(projects: ProjectStore): CaptureContexts {
  const owner = createSessionOwner(projects);
  return async (sessionId, contexts, options) => {
    try {
      const project = await owner(sessionId);
      if (project?.folderPath === undefined)
        throw new AgentExecutionError(
          'execution-context-unavailable',
          'Workspace contexts require one Project with a configured folder',
        );
      const captured = await captureWorkspaceContexts(project.folderPath, contexts, options);
      const current = await owner(sessionId);
      if (current?.id !== project.id || current.folderPath !== project.folderPath)
        throw new AgentExecutionError(
          'execution-context-unavailable',
          'Project ownership changed during context capture',
        );
      return { ...captured, projectId: project.id };
    } catch (error: unknown) {
      if (options.signal.aborted)
        throw new AgentExecutionError(
          'execution-file-capture-timeout',
          'Workspace context capture ended before acceptance',
        );
      if (error instanceof AgentExecutionError) throw error;
      throw new AgentExecutionError(
        'execution-context-capture-failed',
        'Workspace contexts could not be captured',
      );
    }
  };
}
