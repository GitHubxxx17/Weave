import { lstat, realpath, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  WorkspaceFileError,
  readFileInputSchema,
  writeFileInputSchema,
  type ReadFileInput,
  type WorkspaceFileErrorCode,
  type WorkspaceFileToolOptions,
  type WorkspaceFileTools,
  type WriteFileInput,
  type WriteFileResult,
} from './workspace-file-types.js';
import { WorkspacePolicyError } from './workspace-types.js';
import type { ToolDefinition, ToolExecutionContext } from './tool-types.js';

const defaultMaxReadBytes = 1_000_000;
const defaultMaxWriteBytes = 1_000_000;

interface NodeFileError extends Error {
  readonly code?: string;
}

interface ResolvedWorkspacePath {
  readonly absolutePath: string;
  readonly relativePath: string;
}

function isNodeFileError(error: unknown): error is NodeFileError {
  return error instanceof Error;
}

function isAbortError(error: unknown): boolean {
  return (
    (error instanceof DOMException && error.name === 'AbortError') ||
    (error instanceof Error && error.name === 'AbortError')
  );
}

function isInsideRoot(root: string, target: string): boolean {
  const relativePath = path.relative(root, target);
  return (
    relativePath === '' ||
    (relativePath !== '..' &&
      !relativePath.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relativePath))
  );
}

function validateLimit(name: string, value: number | undefined): number | undefined {
  if (value !== undefined && (!Number.isFinite(value) || value < 0)) {
    throw new RangeError(`${name} must be a finite non-negative number`);
  }
  return value;
}

function createMappedError(
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

function mapFilesystemError(error: unknown, operation: 'read' | 'write'): WorkspaceFileError {
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

async function resolveRealRoot(workspaceRoot: string): Promise<string> {
  try {
    return await realpath(workspaceRoot);
  } catch (error: unknown) {
    throw mapFilesystemError(error, 'read');
  }
}

function resolveLexicalPath(
  workspace: WorkspaceFileToolOptions['workspace'],
  inputPath: string,
  operation: 'read' | 'write',
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

async function resolveExistingTarget(
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

function checkSignal(context: ToolExecutionContext): void {
  context.signal.throwIfAborted();
}

async function readWorkspaceFile(
  input: ReadFileInput,
  context: ToolExecutionContext,
  options: WorkspaceFileToolOptions,
): Promise<string> {
  checkSignal(context);
  const candidate = resolveLexicalPath(options.workspace, input.path, 'read');
  const root = await resolveRealRoot(options.workspace.root);
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

  const maxBytes = input.maxBytes ?? options.maxReadBytes ?? defaultMaxReadBytes;
  if (metadata.size > maxBytes) {
    throw createMappedError(
      'workspace-file-too-large',
      `Workspace file exceeds the ${maxBytes}-byte read limit`,
    );
  }

  checkSignal(context);
  let content: string;
  try {
    content = await readFile(target, { encoding: 'utf8', signal: context.signal });
  } catch (error: unknown) {
    throw mapFilesystemError(error, 'read');
  }
  if (Buffer.byteLength(content, 'utf8') > maxBytes) {
    throw createMappedError(
      'workspace-file-too-large',
      `Workspace file exceeds the ${maxBytes}-byte read limit`,
    );
  }
  return content;
}

async function resolveWriteTarget(
  candidate: ResolvedWorkspacePath,
  root: string,
  overwrite: boolean,
): Promise<{ target: string; existed: boolean }> {
  let candidateMetadata;
  try {
    candidateMetadata = await lstat(candidate.absolutePath);
  } catch (error: unknown) {
    const code = isNodeFileError(error) ? error.code : undefined;
    if (code !== 'ENOENT') {
      throw mapFilesystemError(error, 'write');
    }
  }

  if (candidateMetadata !== undefined) {
    let target: string;
    try {
      target = await resolveExistingTarget(root, candidate, 'write');
    } catch (error: unknown) {
      if (
        candidateMetadata.isSymbolicLink() &&
        error instanceof WorkspaceFileError &&
        error.code === 'workspace-file-not-found'
      ) {
        throw createMappedError(
          'workspace-file-symlink-outside-root',
          'Workspace file symlink target could not be resolved safely',
          error,
        );
      }
      throw error;
    }
    let metadata;
    try {
      metadata = await stat(target);
    } catch (error: unknown) {
      throw mapFilesystemError(error, 'write');
    }
    if (metadata.isDirectory()) {
      throw createMappedError('workspace-file-is-directory', 'Workspace path is a directory');
    }
    if (!metadata.isFile()) {
      throw createMappedError(
        'workspace-file-write-failed',
        'Workspace path is not a regular file',
      );
    }
    if (!overwrite) {
      throw createMappedError(
        'workspace-file-already-exists',
        'Workspace file already exists and overwrite is disabled',
      );
    }
    return { target, existed: true };
  }

  let parent: string;
  try {
    parent = await realpath(path.dirname(candidate.absolutePath));
  } catch (error: unknown) {
    throw mapFilesystemError(error, 'write');
  }
  if (!isInsideRoot(root, parent)) {
    throw createMappedError(
      'workspace-file-symlink-outside-root',
      'Workspace file parent symlink resolves outside the configured root',
    );
  }
  return {
    target: path.join(parent, path.basename(candidate.absolutePath)),
    existed: false,
  };
}

async function writeWorkspaceFile(
  input: WriteFileInput,
  context: ToolExecutionContext,
  options: WorkspaceFileToolOptions,
): Promise<WriteFileResult> {
  const bytesWritten = Buffer.byteLength(input.content, 'utf8');
  const maxBytes = input.maxBytes ?? options.maxWriteBytes ?? defaultMaxWriteBytes;
  if (bytesWritten > maxBytes) {
    throw createMappedError(
      'workspace-file-too-large',
      `Workspace file exceeds the ${maxBytes}-byte write limit`,
    );
  }

  checkSignal(context);
  const candidate = resolveLexicalPath(options.workspace, input.path, 'write');
  const root = await resolveRealRoot(options.workspace.root);
  const { target, existed } = await resolveWriteTarget(candidate, root, input.overwrite === true);

  checkSignal(context);
  try {
    await writeFile(target, input.content, {
      encoding: 'utf8',
      flag: existed ? 'w' : 'wx',
      signal: context.signal,
    });
  } catch (error: unknown) {
    throw mapFilesystemError(error, 'write');
  }

  return {
    path: candidate.relativePath,
    bytesWritten,
    overwritten: existed,
  };
}

/** Creates UTF-8 file tools protected by a Workspace policy. */
export function createWorkspaceFileTools(options: WorkspaceFileToolOptions): WorkspaceFileTools {
  const maxReadBytes = validateLimit('maxReadBytes', options.maxReadBytes);
  const maxWriteBytes = validateLimit('maxWriteBytes', options.maxWriteBytes);
  const normalizedOptions = {
    ...options,
    ...(maxReadBytes === undefined ? {} : { maxReadBytes }),
    ...(maxWriteBytes === undefined ? {} : { maxWriteBytes }),
  };

  const readFileTool: ToolDefinition<ReadFileInput, string> = {
    name: 'read_file',
    description: 'Read a UTF-8 text file inside the configured Workspace',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', minLength: 1 },
        maxBytes: { type: 'number', minimum: 0 },
      },
      required: ['path'],
      additionalProperties: false,
    },
    inputSchema: readFileInputSchema,
    execute: (input, context) => readWorkspaceFile(input, context, normalizedOptions),
  };

  const writeFileTool: ToolDefinition<WriteFileInput, WriteFileResult> = {
    name: 'write_file',
    description: 'Write UTF-8 text to a file inside the configured Workspace',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', minLength: 1 },
        content: { type: 'string' },
        overwrite: { type: 'boolean' },
        maxBytes: { type: 'number', minimum: 0 },
      },
      required: ['path', 'content'],
      additionalProperties: false,
    },
    inputSchema: writeFileInputSchema,
    execute: (input, context) => writeWorkspaceFile(input, context, normalizedOptions),
  };

  return Object.freeze({
    readFile: Object.freeze(readFileTool),
    writeFile: Object.freeze(writeFileTool),
  });
}
