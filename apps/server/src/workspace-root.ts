import type { ProjectStore } from '@weave/workspace';

/**
 * Creates a lookup from Session id to the absolute folder of its Project.
 *
 * Local Weave installs hold a small number of Projects, so the lookup scans
 * Projects that have a `folderPath` and their Session references instead of
 * adding a reverse index to the Project Store contract.
 */
export function createWorkspaceRootResolver(
  projectStore: ProjectStore,
): (sessionId: string) => Promise<string | undefined> {
  return async (sessionId) => {
    const projects = await projectStore.listProjects();
    for (const project of projects) {
      if (project.folderPath === undefined) {
        continue;
      }
      const refs = await projectStore.listSessionRefs(project.id);
      if (refs.some((ref) => ref.sessionId === sessionId)) {
        return project.folderPath;
      }
    }
    return undefined;
  };
}
