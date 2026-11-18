import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import {
  WorkspaceFileError,
  type WorkspaceFileErrorCode,
  type WorkspaceSource,
} from './workspace-file-types.js';
import { WorkspacePolicyError } from './workspace-types.js';
import type { WorkspacePolicy } from './workspace-policy.js';
import type { ToolExecutionContext } from './tool-types.js';

/**
 * Internal helpers shared by every Workspace-aware tool (files, search,
 * commands). They are not part of the package's public exports.
 */

interface NodeFileError extends Error {
  readonly code?: string;
}

/** Lexically resolved path inside a Workspace, before any filesystem access. */
export interface ResolvedWorkspacePath {
  readonly absolutePath: string;
  readonly relativePath: string;
}

export function isNodeFileError(error: unknown): error is NodeFileError {
  return error instanceof Error;
}

export function isAbortError(error: unknown): boolean {
  return (
    (error instanceof DOMException && error.name === 'AbortError') ||
    (error instanceof Error && error.name === 'AbortError')
  );
}

export function isInsideRoot(root: string, target: string): boolean {
  const relativePath = path.relative(root, target);
  return (
    relativePath === '' ||
    (relativePath !== '..' &&
      !relativePath.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relativePath))
  );
}

/** Converts a platform relative path to the `/`-separated form shown to models. */
export function toPosixPath(relativePath: string): string {
  return relativePath.split(path.sep).join('/');
}

export function createMappedError(
  code: WorkspaceFileErrorCode,
  message: string,
  cause?: unknown,
): WorkspaceFileError {
  return new WorkspaceFileError(code, message, cause === undefined ? undefined : { cause });
}

function mapPolicyError(error: unknown): WorkspaceFileError {
  if (error instanceof WorkspacePolicyError) {
    return createMappedError(
      'workspace-file-outside-root',
      'Workspace file path is outside the configured root',
      error,
    );
  }
  return createMappedError(
    'workspace-file-invalid-input',
    'Workspace file input is invalid',
    error,
  );
}

export function mapFilesystemError(
  error: unknown,
  operation: 'read' | 'write',
): WorkspaceFileError {
  if (isAbortError(error)) {
    return createMappedError(
      'workspace-file-cancelled',
      'Workspace file operation was cancelled',
      error,
    );
  }

  const code = isNodeFileError(error) ? error.code : undefined;
  if (code === 'ENOENT') {
    return createMappedError('workspace-file-not-found', 'Workspace file was not found', error);
  }
  if (code === 'EACCES' || code === 'EPERM') {
    return createMappedError(
      'workspace-file-permission-denied',
      'Workspace file access was denied',
      error,
    );
  }
  if (code === 'EISDIR') {
    return createMappedError('workspace-file-is-directory', 'Workspace path is a directory', error);
  }
  if (code === 'ENOTDIR') {
    return createMappedError(
      'workspace-file-not-directory',
      'A parent of the Workspace path is not a directory',
      error,
    );
  }
  if (code === 'EEXIST') {
    return createMappedError(
      'workspace-file-already-exists',
      'Workspace file already exists',
      error,
    );
  }

  return createMappedError(
    operation === 'read' ? 'workspace-file-read-failed' : 'workspace-file-write-failed',
    operation === 'read'
      ? 'Workspace file could not be read'
      : 'Workspace file could not be written',
    error,
  );
}

export async function resolveRealRoot(workspaceRoot: string): Promise<string> {
  try {
    return await realpath(workspaceRoot);
  } catch (error: unknown) {
    throw mapFilesystemError(error, 'read');
  }
}

export function resolveLexicalPath(
  workspace: WorkspacePolicy,
  inputPath: string,
  operation: 'read' | 'write' | 'execute',
): ResolvedWorkspacePath {
  try {
    const resolved = workspace.resolve(inputPath, operation);
    return {
      absolutePath: resolved.absolutePath,
      relativePath: resolved.relativePath,
    };
  } catch (error: unknown) {
    throw mapPolicyError(error);
  }
}

/** Resolves an existing path through symlinks and rejects targets outside the root. */
export async function resolveExistingTarget(
  root: string,
  candidate: ResolvedWorkspacePath,
  operation: 'read' | 'write',
): Promise<string> {
  let target: string;
  try {
    target = await realpath(candidate.absolutePath);
  } catch (error: unknown) {
    throw mapFilesystemError(error, operation);
  }
  if (!isInsideRoot(root, target)) {
    throw createMappedError(
      'workspace-file-symlink-outside-root',
      'Workspace file symlink resolves outside the configured root',
    );
  }
  return target;
}

/** Resolves an existing directory inside the Workspace. */
export async function resolveExistingDirectory(
  root: string,
  candidate: ResolvedWorkspacePath,
): Promise<string> {
  const target = await resolveExistingTarget(root, candidate, 'read');
  let metadata;
  try {
    metadata = await stat(target);
  } catch (error: unknown) {
    throw mapFilesystemError(error, 'read');
  }
  if (!metadata.isDirectory()) {
    throw createMappedError('workspace-file-not-directory', 'Workspace path is not a directory');
  }
  return target;
}

export function checkSignal(context: ToolExecutionContext): void {
  context.signal.throwIfAborted();
}

/** Returns the fixed Workspace or resolves the one for this invocation. */
export async function resolvePolicy(
  source: WorkspaceSource,
  context: ToolExecutionContext,
): Promise<WorkspacePolicy> {
  if (source.workspace !== undefined) {
    return source.workspace;
  }
  const workspace = await source.resolveWorkspace(context);
  if (workspace === undefined) {
    throw createMappedError(
      'workspace-file-unavailable',
      'No Workspace folder is configured for this Session',
    );
  }
  return workspace;
}

/** Throws unless `source` provides exactly one Workspace source. */
export function assertWorkspaceSource(source: WorkspaceSource): void {
  if ((source.workspace === undefined) === (source.resolveWorkspace === undefined)) {
    throw new TypeError('Provide exactly one of workspace or resolveWorkspace');
  }
}
