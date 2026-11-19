import { open, stat } from 'node:fs/promises';
import {
  createMappedError,
  mapFilesystemError,
  resolveExistingTarget,
  resolveLexicalPath,
  resolveRealRoot,
  toPosixPath,
} from './workspace-access.js';
import { indexWorkspaceFiles } from './workspace-file-index.js';
import { createWorkspacePolicy } from './workspace-policy.js';
import { isBinaryContent } from './workspace-text.js';

/**
 * Read-only directory and file access for the Studio file tree. These are
 * plain functions, not Agent tools: the UI reads the project folder directly
 * through the Server, with no Approval. They reuse the same Workspace policy
 * and ignore rules as the Agent file tools, so the boundary stays identical.
 */

/** A flat listing of a project's files for the Studio tree to build from. */
export interface WorkspaceFileListing {
  /** POSIX-relative paths, ignore-filtered and sorted. */
  readonly files: readonly string[];
  /** `git` when `.gitignore` applied; `walk` when the built-in ignore list did. */
  readonly source: 'git' | 'walk';
  /** True when listing stopped at the file-count limit. */
  readonly truncated: boolean;
}

/** Default cap for one viewer read; larger files are returned truncated. */
const defaultViewerMaxBytes = 2_000_000;

/**
 * Lists the project's files (ignore-filtered, symlinks skipped) as POSIX
 * relative paths. The tree is built on the client from this flat set.
 */
export async function listWorkspaceFiles(
  rootPath: string,
  options: { readonly signal: AbortSignal; readonly maxFiles?: number },
): Promise<WorkspaceFileListing> {
  const root = await resolveRealRoot(rootPath);
  const index = await indexWorkspaceFiles(root, {
    signal: options.signal,
    ...(options.maxFiles === undefined ? {} : { maxFiles: options.maxFiles }),
  });
  return { files: index.files, source: index.source, truncated: index.truncated };
}

/** Text content of one file for read-only viewing. */
export interface WorkspaceFileContent {
  readonly path: string;
  readonly content: string;
  /** Full file size in bytes, even when the content is truncated. */
  readonly bytes: number;
  /** True when only the first `maxBytes` were returned. */
  readonly truncated: boolean;
}

/**
 * Reads one UTF-8 text file inside the project folder for read-only viewing.
 *
 * Enforces the same boundary as the file tools (no `..`, no symlink escaping
 * the root). A file larger than `maxBytes` is returned as its first `maxBytes`
 * with `truncated: true` instead of failing, so large logs still open. Binary
 * files are rejected with `workspace-file-binary`.
 */
export async function readWorkspaceFileContent(
  rootPath: string,
  relativePath: string,
  options: { readonly signal: AbortSignal; readonly maxBytes?: number },
): Promise<WorkspaceFileContent> {
  const maxBytes = options.maxBytes ?? defaultViewerMaxBytes;
  const policy = createWorkspacePolicy({ root: rootPath });
  const candidate = resolveLexicalPath(policy, relativePath, 'read');
  const root = await resolveRealRoot(policy.root);
  const target = await resolveExistingTarget(root, candidate, 'read');

  let metadata;
  try {
    metadata = await stat(target);
  } catch (error: unknown) {
    throw mapFilesystemError(error, 'read');
  }
  if (metadata.isDirectory()) {
    throw createMappedError('workspace-file-is-directory', 'Workspace path is a directory');
  }
  if (!metadata.isFile()) {
    throw createMappedError('workspace-file-read-failed', 'Workspace path is not a regular file');
  }

  const total = metadata.size;
  const readBytes = Math.min(total, maxBytes);
  const buffer = Buffer.alloc(readBytes);
  options.signal.throwIfAborted();
  const handle = await open(target, 'r').catch((error: unknown) => {
    throw mapFilesystemError(error, 'read');
  });
  let bytesRead: number;
  try {
    ({ bytesRead } = await handle.read(buffer, 0, readBytes, 0));
  } catch (error: unknown) {
    throw mapFilesystemError(error, 'read');
  } finally {
    await handle.close();
  }

  const data = buffer.subarray(0, bytesRead);
  if (isBinaryContent(data)) {
    throw createMappedError(
      'workspace-file-binary',
      'Workspace file looks binary; the viewer only shows text files',
    );
  }
  return {
    path: toPosixPath(candidate.relativePath),
    content: data.toString('utf8'),
    bytes: total,
    truncated: total > readBytes,
  };
}
