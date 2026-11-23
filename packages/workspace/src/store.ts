import { z } from 'zod';
import type { CreateProjectInput, Project, ProjectSessionRef } from './types.js';

/** Stable error categories exposed by Project Store implementations. */
export type WorkspaceStoreErrorCode =
  | 'workspace-store-closed'
  | 'workspace-store-invalid-input'
  | 'workspace-store-io'
  | 'workspace-store-protocol'
  | 'workspace-project-not-found'
  | 'workspace-project-folder-revision-overflow'
  | 'workspace-session-already-attached';

/** Error raised when a Project Store cannot satisfy an operation. */
export class WorkspaceStoreError extends Error {
  readonly code: WorkspaceStoreErrorCode;

  constructor(code: WorkspaceStoreErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'WorkspaceStoreError';
    this.code = code;
  }
}

export function nextProjectFolderRevision(revision: number): number {
  if (revision === Number.MAX_SAFE_INTEGER) {
    throw new WorkspaceStoreError(
      'workspace-project-folder-revision-overflow',
      'Project folder revision reached the maximum safe integer',
    );
  }
  return revision + 1;
}

/** Runtime validation for SQLite Project Store construction options. */
export const sqliteProjectStoreOptionsSchema = z.object({
  filename: z.string().min(1),
});

/** Append-free metadata storage for Projects and Project/Session relations. */
export interface ProjectStore {
  /** Creates a Project with a durable identity, timestamps and a folder revision of zero. */
  createProject(input: CreateProjectInput): Promise<Project>;

  /** Lists Projects in creation order. */
  listProjects(): Promise<readonly Project[]>;

  /** Reads one Project, returning undefined when it does not exist. */
  getProject(projectId: string): Promise<Project | undefined>;

  /**
   * Sets or clears the absolute local folder of a Project and atomically refreshes
   * `updatedAt` and increments `folderRevision`, including when setting the current
   * path again. Rejects revision overflow before changing the Project.
   * Callers validate that the path exists on disk.
   */
  updateProjectFolder(projectId: string, folderPath: string | undefined): Promise<Project>;

  /**
   * Changes the display name of a Project and refreshes `updatedAt`.
   * Preserves the folder name, path and revision.
   */
  renameProject(projectId: string, name: string): Promise<Project>;

  /** Associates one Session with a Project exactly once. */
  attachSession(projectId: string, sessionId: string): Promise<ProjectSessionRef>;

  /** Lists a Project's Session relationships in creation order. */
  listSessionRefs(projectId: string): Promise<readonly ProjectSessionRef[]>;

  /** Releases Store resources. Repeated calls must be safe. */
  close(): Promise<void>;
}
