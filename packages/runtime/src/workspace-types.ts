import { z } from 'zod';

const workspaceOperationSchema = z.enum(['read', 'write', 'execute']);

/**
 * Operation intent carried through the Workspace boundary.
 *
 * The first policy slice uses the same root rule for every operation. Keeping
 * the intent in the contract lets later policies distinguish read, write, and
 * execute without changing tool call shapes.
 */
export type WorkspaceOperation = z.infer<typeof workspaceOperationSchema>;

/** Options used to create a Workspace path policy. */
export interface WorkspacePolicyOptions {
  /** Absolute root directory available to Workspace-aware tools. */
  readonly root: string;
}

/** Normalized path metadata returned after a policy check. */
export interface WorkspacePath {
  /** Absolute path resolved from the configured Workspace root. */
  readonly absolutePath: string;
  /** Platform-normalized path relative to the Workspace root. */
  readonly relativePath: string;
  /** Operation intent that was checked for this path. */
  readonly operation: WorkspaceOperation;
}

/** Runtime input validation for Workspace construction options. */
export const workspacePolicyOptionsSchema = z.object({
  root: z.string().min(1),
});

/** Runtime input validation for one Workspace path resolution request. */
export const workspacePathRequestSchema = z.object({
  inputPath: z.string().min(1),
  operation: workspaceOperationSchema,
});

/** Stable failure categories exposed by the Workspace path boundary. */
export type WorkspacePolicyErrorCode =
  | 'workspace-invalid-input'
  | 'workspace-invalid-root'
  | 'workspace-absolute-path-not-allowed'
  | 'workspace-path-outside-root';

/** Error raised when a path cannot be accepted by the Workspace policy. */
export class WorkspacePolicyError extends Error {
  readonly code: WorkspacePolicyErrorCode;

  constructor(code: WorkspacePolicyErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'WorkspacePolicyError';
    this.code = code;
  }
}
