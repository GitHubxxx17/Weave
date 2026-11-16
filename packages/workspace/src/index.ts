/** Public API for local Project metadata and Project/Session relationships. */

export {
  createProjectInputSchema,
  projectIdSchema,
  projectSchema,
  projectSessionIdSchema,
  projectSessionRefSchema,
} from './types.js';
export type { CreateProjectInput, Project, ProjectSessionRef } from './types.js';

export { sqliteProjectStoreOptionsSchema, WorkspaceStoreError } from './store.js';
export type { ProjectStore, WorkspaceStoreErrorCode } from './store.js';

export { createInMemoryProjectStore } from './memory-store.js';
export { createSqliteProjectStore } from './sqlite-store.js';
