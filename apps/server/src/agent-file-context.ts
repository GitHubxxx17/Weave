import { AgentExecutionError, captureWorkspaceFiles, type CaptureFiles } from '@weave/runtime';
import type { ProjectStore } from '@weave/workspace';

/** Project authority belongs to Server; Runtime receives only a trusted root. */
export function createFileContextCapture(projects: ProjectStore): CaptureFiles {
  const owner = async (sessionId: string) => {
    const matches = [];
    for (const project of await projects.listProjects()) {
      if ((await projects.listSessionRefs(project.id)).some((ref) => ref.sessionId === sessionId))
        matches.push(project);
    }
    return matches.length === 1 ? matches[0] : undefined;
  };
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
