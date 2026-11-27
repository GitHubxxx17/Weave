import { withWorkspaceMutation } from './workspace-mutation.js';
import { lstat, mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  WorkspaceFileError,
  defaultReadLineLimit,
  editFileInputSchema,
  readFileInputSchema,
  writeFileInputSchema,
  type EditFileInput,
  type EditFileResult,
  type ReadFileInput,
  type WorkspaceFileToolOptions,
  type WorkspaceFileTools,
  type WriteFileInput,
  type WriteFileResult,
} from './workspace-file-types.js';
import {
  assertWorkspaceSource,
  checkSignal,
  createMappedError,
  isInsideRoot,
  isNodeFileError,
  mapFilesystemError,
  resolveExistingTarget,
  resolveLexicalPath,
  resolvePolicy,
  resolveRealRoot,
  toPosixPath,
  type ResolvedWorkspacePath,
} from './workspace-access.js';
import {
  countLines,
  formatFilePage,
  isBinaryContent,
  planTextEdit,
  type TextEditPlan,
} from './workspace-text.js';
import { isSecretFile } from './secret-files.js';
import { isSensitiveWritePath } from './sensitive-paths.js';
import { runCapturedWrite } from './workspace-write-capture.js';
import type { ToolDefinition, ToolExecutionContext } from './tool-types.js';

const defaultMaxReadBytes = 1_000_000;
const defaultMaxWriteBytes = 1_000_000;

function validateLimit(name: string, value: number | undefined): number | undefined {
  if (value !== undefined && (!Number.isFinite(value) || value < 0)) {
    throw new RangeError(`${name} must be a finite non-negative number`);
  }
  return value;
}

interface WorkspaceTextFile {
  readonly target: string;
  readonly relativePath: string;
  readonly content: string;
}

/** Opens an existing regular UTF-8 text file inside the Workspace. */
async function readTextFile(
  options: WorkspaceFileToolOptions,
  context: ToolExecutionContext,
  inputPath: string,
  operation: 'read' | 'write',
): Promise<WorkspaceTextFile> {
  checkSignal(context);
  const workspace = await resolvePolicy(options, context);
  const candidate = resolveLexicalPath(workspace, inputPath, operation);
  const root = await resolveRealRoot(workspace.root);
  const target = await resolveExistingTarget(root, candidate, operation);

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

  const maxBytes = options.maxReadBytes ?? defaultMaxReadBytes;
  if (metadata.size > maxBytes) {
    throw createMappedError(
      'workspace-file-too-large',
      `Workspace file exceeds the ${maxBytes}-byte read limit`,
    );
  }

  checkSignal(context);
  let bytes: Buffer;
  try {
    bytes = await readFile(target, { signal: context.signal });
  } catch (error: unknown) {
    throw mapFilesystemError(error, 'read');
  }
  if (bytes.byteLength > maxBytes) {
    throw createMappedError(
      'workspace-file-too-large',
      `Workspace file exceeds the ${maxBytes}-byte read limit`,
    );
  }
  if (isBinaryContent(bytes)) {
    throw createMappedError(
      'workspace-file-binary',
      'Workspace file looks binary; read_file only returns text files',
    );
  }
  return {
    target,
    relativePath: toPosixPath(candidate.relativePath),
    content: bytes.toString('utf8'),
  };
}

/**
 * Whether reading `inputPath` needs the secret-file Approval. The name typed by
 * the model and the name of the real file behind any symbolic link are both
 * checked. A missing file or a path outside the Workspace is left to the read
 * itself, which fails without exposing content; any other resolution failure
 * is treated as a secret file.
 */
async function readsSecretFile(
  inputPath: string,
  context: ToolExecutionContext,
  options: WorkspaceFileToolOptions,
): Promise<boolean> {
  if (isSecretFile(inputPath)) {
    return true;
  }
  try {
    const workspace = await resolvePolicy(options, context);
    const candidate = resolveLexicalPath(workspace, inputPath, 'read');
    const root = await resolveRealRoot(workspace.root);
    const target = await resolveExistingTarget(root, candidate, 'read');
    return isSecretFile(target);
  } catch (error: unknown) {
    return !(
      error instanceof WorkspaceFileError &&
      (
        [
          'workspace-file-unavailable',
          'workspace-file-not-found',
          'workspace-file-not-directory',
          'workspace-file-outside-root',
          'workspace-file-invalid-input',
          'workspace-file-symlink-outside-root',
        ] as readonly string[]
      ).includes(error.code)
    );
  }
}

/**
 * Real Workspace-relative path a write to `candidate` would modify: symbolic
 * links are followed, and a file that does not exist yet is placed below the
 * real path of its deepest existing ancestor.
 */
async function resolveWriteDestination(
  root: string,
  candidate: ResolvedWorkspacePath,
): Promise<string> {
  const missing: string[] = [];
  let current = candidate.absolutePath;
  for (;;) {
    try {
      const real = await realpath(current);
      return toPosixPath(path.relative(root, path.join(real, ...missing)));
    } catch (error: unknown) {
      const code = isNodeFileError(error) ? (error as NodeJS.ErrnoException).code : undefined;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') {
        throw error;
      }
      // A dangling symbolic link cannot be judged by its target.
      if (
        await lstat(current).then(
          () => true,
          () => false,
        )
      ) {
        throw error;
      }
      const parent = path.dirname(current);
      if (parent === current) {
        throw error;
      }
      missing.unshift(path.basename(current));
      current = parent;
    }
  }
}

/**
 * Whether a write or edit of `inputPath` hits a sensitive file in `trust` mode.
 * The typed path and the real path behind any symbolic link are both checked.
 * A path outside the Workspace is left to the write itself, which fails;
 * any other resolution failure asks.
 */
async function writesSensitiveFile(
  inputPath: string,
  context: ToolExecutionContext,
  options: WorkspaceFileToolOptions,
): Promise<boolean> {
  try {
    const workspace = await resolvePolicy(options, context);
    const candidate = resolveLexicalPath(workspace, inputPath, 'write');
    if (isSensitiveWritePath(toPosixPath(candidate.relativePath))) {
      return true;
    }
    const root = await resolveRealRoot(workspace.root);
    const destination = await resolveWriteDestination(root, candidate);
    return isSensitiveWritePath(destination);
  } catch (error: unknown) {
    return !(
      error instanceof WorkspaceFileError &&
      (
        [
          'workspace-file-unavailable',
          'workspace-file-outside-root',
          'workspace-file-invalid-input',
        ] as readonly string[]
      ).includes(error.code)
    );
  }
}

/** Summary field that tells the user why a write asks for Approval. */
async function sensitiveReason(
  inputPath: string,
  context: ToolExecutionContext,
  options: WorkspaceFileToolOptions,
): Promise<{ askReason?: 'sensitive-path' }> {
  return (await writesSensitiveFile(inputPath, context, options))
    ? { askReason: 'sensitive-path' }
    : {};
}

async function readWorkspaceFile(
  input: ReadFileInput,
  context: ToolExecutionContext,
  options: WorkspaceFileToolOptions,
): Promise<string> {
  const file = await readTextFile(options, context, input.path, 'read');
  return formatFilePage(file.content, input.offset ?? 1, input.limit ?? defaultReadLineLimit);
}

interface WritePlan {
  readonly target: string;
  readonly relativePath: string;
  readonly bytes: number;
  readonly existed: boolean;
  readonly previousBytes?: number | undefined;
  readonly previousLines?: number | undefined;
  /** Absolute directories to create, outermost first. */
  readonly missingDirectories: readonly string[];
  /** The same directories relative to the Workspace root. */
  readonly createdDirectories: readonly string[];
}

/** Resolves an existing write target, following the same symlink rules as reads. */
async function planOverwrite(
  candidate: ResolvedWorkspacePath,
  root: string,
  candidateIsSymlink: boolean,
  input: WriteFileInput,
  maxReadBytes: number,
): Promise<Pick<WritePlan, 'target' | 'previousBytes' | 'previousLines'>> {
  let target: string;
  try {
    target = await resolveExistingTarget(root, candidate, 'write');
  } catch (error: unknown) {
    if (
      candidateIsSymlink &&
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
    throw createMappedError('workspace-file-write-failed', 'Workspace path is not a regular file');
  }
  if (input.overwrite !== true) {
    throw createMappedError(
      'workspace-file-already-exists',
      'Workspace file already exists and overwrite is disabled',
    );
  }

  let previousLines: number | undefined;
  if (metadata.size <= maxReadBytes) {
    try {
      previousLines = countLines(await readFile(target, 'utf8'));
    } catch {
      previousLines = undefined;
    }
  }
  return {
    target,
    previousBytes: metadata.size,
    ...(previousLines === undefined ? {} : { previousLines }),
  };
}

/** Finds the deepest existing ancestor and the directories a new file needs. */
async function planNewFile(
  candidate: ResolvedWorkspacePath,
  root: string,
  lexicalRoot: string,
): Promise<Pick<WritePlan, 'target' | 'missingDirectories' | 'createdDirectories'>> {
  const missing: string[] = [];
  let ancestor = path.dirname(candidate.absolutePath);
  let realAncestor: string;
  for (;;) {
    try {
      realAncestor = await realpath(ancestor);
      break;
    } catch (error: unknown) {
      const code = isNodeFileError(error) ? error.code : undefined;
      if (code !== 'ENOENT' || ancestor === lexicalRoot || ancestor === path.dirname(ancestor)) {
        throw mapFilesystemError(error, 'write');
      }
      missing.unshift(path.basename(ancestor));
      ancestor = path.dirname(ancestor);
    }
  }
  if (!isInsideRoot(root, realAncestor)) {
    throw createMappedError(
      'workspace-file-symlink-outside-root',
      'Workspace file parent symlink resolves outside the configured root',
    );
  }
  const ancestorMetadata = await stat(realAncestor).catch((error: unknown) => {
    throw mapFilesystemError(error, 'write');
  });
  if (!ancestorMetadata.isDirectory()) {
    throw createMappedError(
      'workspace-file-not-directory',
      'A parent of the Workspace path is not a directory',
    );
  }

  const missingDirectories: string[] = [];
  let current = realAncestor;
  for (const segment of missing) {
    current = path.join(current, segment);
    missingDirectories.push(current);
  }
  return {
    target: path.join(current, path.basename(candidate.absolutePath)),
    missingDirectories,
    createdDirectories: missingDirectories.map((directory) =>
      toPosixPath(path.relative(root, directory)),
    ),
  };
}

async function planWrite(
  input: WriteFileInput,
  context: ToolExecutionContext,
  options: WorkspaceFileToolOptions,
): Promise<WritePlan> {
  const bytes = Buffer.byteLength(input.content, 'utf8');
  const maxBytes = options.maxWriteBytes ?? defaultMaxWriteBytes;
  if (bytes > maxBytes) {
    throw createMappedError(
      'workspace-file-too-large',
      `Workspace file exceeds the ${maxBytes}-byte write limit`,
    );
  }

  checkSignal(context);
  const workspace = await resolvePolicy(options, context);
  const candidate = resolveLexicalPath(workspace, input.path, 'write');
  const root = await resolveRealRoot(workspace.root);
  const relativePath = toPosixPath(candidate.relativePath);

  let candidateMetadata;
  try {
    candidateMetadata = await lstat(candidate.absolutePath);
  } catch (error: unknown) {
    const code = isNodeFileError(error) ? error.code : undefined;
    if (code !== 'ENOENT' && code !== 'ENOTDIR') {
      throw mapFilesystemError(error, 'write');
    }
  }

  if (candidateMetadata !== undefined) {
    const overwrite = await planOverwrite(
      candidate,
      root,
      candidateMetadata.isSymbolicLink(),
      input,
      options.maxReadBytes ?? defaultMaxReadBytes,
    );
    return {
      ...overwrite,
      relativePath,
      bytes,
      existed: true,
      missingDirectories: [],
      createdDirectories: [],
    };
  }

  const created = await planNewFile(candidate, root, workspace.root);
  return { ...created, relativePath, bytes, existed: false };
}

async function writeWorkspaceFile(
  input: WriteFileInput,
  context: ToolExecutionContext,
  options: WorkspaceFileToolOptions,
): Promise<WriteFileResult> {
  const plan = await planWrite(input, context, options);

  checkSignal(context);
  const undoUnavailableReason = await runCapturedWrite(
    options,
    context,
    plan.target,
    plan.relativePath,
    plan.existed,
    input.content,
    async () => {
      for (const directory of plan.missingDirectories) {
        checkSignal(context);
        options.assertMutationCurrent?.(context);
        try {
          await mkdir(directory);
        } catch (error: unknown) {
          const code = isNodeFileError(error) ? error.code : undefined;
          if (code !== 'EEXIST') {
            throw mapFilesystemError(error, 'write');
          }
          const metadata = await lstat(directory).catch(() => undefined);
          if (metadata === undefined || !metadata.isDirectory()) {
            throw createMappedError(
              'workspace-file-not-directory',
              'A parent of the Workspace path is not a directory',
              error,
            );
          }
        }
      }
      checkSignal(context);
      options.assertMutationCurrent?.(context);
      try {
        await writeFile(plan.target, input.content, {
          encoding: 'utf8',
          flag: plan.existed ? 'w' : 'wx',
          signal: context.signal,
        });
      } catch (error: unknown) {
        throw mapFilesystemError(error, 'write');
      }
    },
  );

  return {
    path: plan.relativePath,
    bytesWritten: plan.bytes,
    ...(undoUnavailableReason === undefined ? {} : { undoUnavailableReason }),
    overwritten: plan.existed,
    ...(plan.createdDirectories.length === 0
      ? {}
      : { createdDirectories: plan.createdDirectories }),
  };
}

interface EditPlan extends WorkspaceTextFile {
  readonly plan: TextEditPlan;
}

async function planEdit(
  input: EditFileInput,
  context: ToolExecutionContext,
  options: WorkspaceFileToolOptions,
): Promise<EditPlan> {
  const file = await readTextFile(options, context, input.path, 'write');
  const plan = planTextEdit(file.content, input);
  const maxBytes = options.maxWriteBytes ?? defaultMaxWriteBytes;
  if (Buffer.byteLength(plan.updated, 'utf8') > maxBytes) {
    throw createMappedError(
      'workspace-file-too-large',
      `Edited file would exceed the ${maxBytes}-byte write limit`,
    );
  }
  return { ...file, plan };
}

async function editWorkspaceFile(
  input: EditFileInput,
  context: ToolExecutionContext,
  options: WorkspaceFileToolOptions,
): Promise<EditFileResult> {
  // Re-read and re-match: a file changed while the Approval was pending must
  // still contain the exact text, otherwise the edit fails instead of guessing.
  const { target, relativePath, plan } = await planEdit(input, context, options);
  checkSignal(context);
  const undoUnavailableReason = await runCapturedWrite(
    options,
    context,
    target,
    relativePath,
    true,
    plan.updated,
    async () => {
      checkSignal(context);
      options.assertMutationCurrent?.(context);
      try {
        await writeFile(target, plan.updated, {
          encoding: 'utf8',
          flag: 'w',
          signal: context.signal,
        });
      } catch (error: unknown) {
        throw mapFilesystemError(error, 'write');
      }
    },
  );

  return {
    path: relativePath,
    replacements: plan.replacements,
    ...(undoUnavailableReason === undefined ? {} : { undoUnavailableReason }),
    linesAdded: plan.linesAdded,
    linesRemoved: plan.linesRemoved,
    snippet: plan.snippet,
  };
}

/** Creates UTF-8 file tools protected by a Workspace policy. */
export function createWorkspaceFileTools(options: WorkspaceFileToolOptions): WorkspaceFileTools {
  const maxReadBytes = validateLimit('maxReadBytes', options.maxReadBytes);
  const maxWriteBytes = validateLimit('maxWriteBytes', options.maxWriteBytes);
  assertWorkspaceSource(options);
  const normalizedOptions: WorkspaceFileToolOptions = {
    ...options,
    ...(maxReadBytes === undefined ? {} : { maxReadBytes }),
    ...(maxWriteBytes === undefined ? {} : { maxWriteBytes }),
  };

  const readFileTool: ToolDefinition<ReadFileInput, string> = {
    name: 'read_file',
    description:
      'Read a UTF-8 text file inside the project folder. Small files are returned whole. ' +
      'Larger files are returned in pages of up to 2000 lines (about 28 KB); a note at the ' +
      'end gives the lines shown, the total line count, and the offset of the next page. ' +
      'Pass offset and limit to read a specific range, for example around a line found by grep. ' +
      'Reading a .env or .env.* file may contain secrets and waits for user approval ' +
      'unless the run is in yolo mode.',
    readOnly: true,
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', minLength: 1 },
        offset: { type: 'integer', minimum: 1, description: 'First line to return, from 1' },
        limit: { type: 'integer', minimum: 1, description: 'Maximum lines to return' },
      },
      required: ['path'],
      additionalProperties: false,
    },
    inputSchema: readFileInputSchema,
    approval: {
      operation: 'workspace.read_secret_file',
      risk: 'high',
      appliesTo: (input, context) => readsSecretFile(input.path, context, normalizedOptions),
      // The summary carries only the path, never the file content.
      summarize: (input) => ({
        summary: `读取可能包含密钥的文件 ${input.path}`,
        inputSummary: { path: input.path },
      }),
    },
    execute: (input, context) => readWorkspaceFile(input, context, normalizedOptions),
  };

  const writeFileTool: ToolDefinition<WriteFileInput, WriteFileResult> = {
    name: 'write_file',
    description:
      'Create a new UTF-8 text file inside the project folder; missing parent directories ' +
      'are created. To replace an existing file entirely pass overwrite: true, but prefer ' +
      'edit_file for changes to existing files. Depending on the session permission mode, ' +
      'the user may be asked to approve the write.' +
      ' Writing a sensitive file (.git/, git hook and CI configuration, package.json, Makefile, .env and similar files that affect command execution, CI or secrets) always waits for user approval unless the run is in yolo mode.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', minLength: 1 },
        content: { type: 'string' },
        overwrite: { type: 'boolean' },
      },
      required: ['path', 'content'],
      additionalProperties: false,
    },
    inputSchema: writeFileInputSchema,
    approval: {
      operation: 'workspace.write_file',
      risk: 'high',
      asksInTrust: (input, context) => writesSensitiveFile(input.path, context, normalizedOptions),
      summarize: async (input, context) => {
        const plan = await planWrite(input, context, normalizedOptions);
        return {
          summary: `写入 Workspace 文件 ${input.path}`,
          inputSummary: {
            path: input.path,
            bytes: plan.bytes,
            lines: countLines(input.content),
            overwrite: input.overwrite === true,
            ...(plan.previousBytes === undefined ? {} : { previousBytes: plan.previousBytes }),
            ...(plan.previousLines === undefined ? {} : { previousLines: plan.previousLines }),
            createdDirectories: plan.createdDirectories,
            ...(await sensitiveReason(input.path, context, normalizedOptions)),
          },
        };
      },
    },
    execute: async (input, context) => {
      const workspace = await resolvePolicy(normalizedOptions, context);
      return withWorkspaceMutation(workspace.root, () =>
        writeWorkspaceFile(input, context, {
          ...normalizedOptions,
          resolveWorkspace: undefined,
          workspace,
        }),
      );
    },
  };

  const editFileTool: ToolDefinition<EditFileInput, EditFileResult> = {
    name: 'edit_file',
    description:
      'Replace exact text in an existing file inside the project folder. oldText must match ' +
      'the file verbatim, including indentation and line breaks, and must occur once unless ' +
      'replaceAll is true; copy it from read_file output. Depending on the session permission mode, ' +
      'the user may be asked to approve the edit; the approval shows the diff.' +
      ' Editing a sensitive file (.git/, git hook and CI configuration, package.json, Makefile, .env and similar files that affect command execution, CI or secrets) always waits for user approval unless the run is in yolo mode.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', minLength: 1 },
        oldText: { type: 'string', minLength: 1 },
        newText: { type: 'string' },
        replaceAll: { type: 'boolean' },
      },
      required: ['path', 'oldText', 'newText'],
      additionalProperties: false,
    },
    inputSchema: editFileInputSchema,
    approval: {
      operation: 'workspace.edit_file',
      risk: 'medium',
      asksInTrust: (input, context) => writesSensitiveFile(input.path, context, normalizedOptions),
      summarize: async (input, context) => {
        const { plan } = await planEdit(input, context, normalizedOptions);
        return {
          summary: `编辑 Workspace 文件 ${input.path}`,
          inputSummary: {
            path: input.path,
            replacements: plan.replacements,
            linesAdded: plan.linesAdded,
            linesRemoved: plan.linesRemoved,
            diff: plan.diff,
            diffTruncated: plan.diffTruncated,
            ...(await sensitiveReason(input.path, context, normalizedOptions)),
          },
        };
      },
    },
    execute: async (input, context) => {
      const workspace = await resolvePolicy(normalizedOptions, context);
      return withWorkspaceMutation(workspace.root, () =>
        editWorkspaceFile(input, context, {
          ...normalizedOptions,
          resolveWorkspace: undefined,
          workspace,
        }),
      );
    },
  };

  return Object.freeze({
    readFile: Object.freeze(readFileTool),
    writeFile: Object.freeze(writeFileTool),
    editFile: Object.freeze(editFileTool),
  });
}
