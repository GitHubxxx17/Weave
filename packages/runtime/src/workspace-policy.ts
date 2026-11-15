import path from 'node:path';
import {
  WorkspacePolicyError,
  workspacePathRequestSchema,
  workspacePolicyOptionsSchema,
  type WorkspaceOperation,
  type WorkspacePath,
  type WorkspacePolicyOptions,
} from './workspace-types.js';

/** Public path validation boundary shared by future Workspace-aware tools. */
export interface WorkspacePolicy {
  /** Normalized absolute Workspace root. */
  readonly root: string;
  /** Resolves one relative path and rejects paths outside the root. */
  resolve(inputPath: string, operation: WorkspaceOperation): WorkspacePath;
}

function createInvalidRootError(cause?: unknown): WorkspacePolicyError {
  return new WorkspacePolicyError(
    'workspace-invalid-root',
    'Workspace root must be a non-empty absolute path',
    cause === undefined ? undefined : { cause },
  );
}

function createInvalidInputError(cause?: unknown): WorkspacePolicyError {
  return new WorkspacePolicyError(
    'workspace-invalid-input',
    'Workspace path input is invalid',
    cause === undefined ? undefined : { cause },
  );
}

function isAbsolutePath(inputPath: string): boolean {
  return path.isAbsolute(inputPath) || path.win32.isAbsolute(inputPath);
}

function isOutsideRoot(relativePath: string): boolean {
  return (
    relativePath === '..' ||
    relativePath.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativePath)
  );
}

/**
 * Creates a lexical Workspace path policy.
 *
 * This policy does not call `realpath`, inspect file metadata, or execute I/O.
 * File and Shell executors must perform those checks again before accessing a
 * filesystem object.
 */
export function createWorkspacePolicy(optionsInput: WorkspacePolicyOptions): WorkspacePolicy {
  const optionsResult = workspacePolicyOptionsSchema.safeParse(optionsInput);
  if (!optionsResult.success || !isAbsolutePath(optionsResult.data.root)) {
    throw createInvalidRootError(optionsResult.success ? undefined : optionsResult.error);
  }

  const root = path.resolve(optionsResult.data.root);

  return Object.freeze({
    root,
    resolve(inputPath: string, operation: WorkspaceOperation): WorkspacePath {
      const requestResult = workspacePathRequestSchema.safeParse({ inputPath, operation });
      if (!requestResult.success) {
        throw createInvalidInputError(requestResult.error);
      }
      if (requestResult.data.inputPath.includes('\0')) {
        throw createInvalidInputError();
      }
      if (isAbsolutePath(requestResult.data.inputPath)) {
        throw new WorkspacePolicyError(
          'workspace-absolute-path-not-allowed',
          'Workspace paths must be relative',
        );
      }

      const absolutePath = path.resolve(root, requestResult.data.inputPath);
      const relativePath = path.relative(root, absolutePath);
      if (isOutsideRoot(relativePath)) {
        throw new WorkspacePolicyError(
          'workspace-path-outside-root',
          'Workspace path is outside the configured root',
        );
      }

      return Object.freeze({
        absolutePath,
        relativePath: relativePath === '' ? '.' : relativePath,
        operation: requestResult.data.operation,
      });
    },
  });
}
