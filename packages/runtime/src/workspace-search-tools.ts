import { lstat, stat } from 'node:fs/promises';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { z } from 'zod';
import type { GrepOutcome, GrepTask, GrepWorkerData } from './grep-worker.js';
import {
  assertWorkspaceSource,
  checkSignal,
  createMappedError,
  mapFilesystemError,
  resolveExistingTarget,
  resolveLexicalPath,
  resolvePolicy,
  resolveRealRoot,
  toPosixPath,
} from './workspace-access.js';
import { indexWorkspaceFiles, walkWorkspaceFiles } from './workspace-file-index.js';
import type { WorkspaceSource } from './workspace-file-types.js';
import type { ToolDefinition, ToolExecutionContext } from './tool-types.js';

const nonEmptyStringSchema = z.string().min(1);

/** Input accepted by the `list_dir` Runtime tool. */
export interface ListDirInput {
  /** Workspace-relative directory; defaults to the Workspace root. */
  readonly path?: string | undefined;
  /** Levels below `path` to show, 1 to 5; defaults to 2. */
  readonly depth?: number | undefined;
}

/** Input accepted by the `glob` Runtime tool. */
export interface GlobInput {
  /** Glob pattern relative to `path`, such as `src/**\/*.ts`. */
  readonly pattern: string;
  /** Workspace-relative directory to search; defaults to the Workspace root. */
  readonly path?: string | undefined;
}

/** Input accepted by the `grep` Runtime tool. */
export interface GrepInput {
  /** Text to find, or a JavaScript regular expression when `regex` is true. */
  readonly pattern: string;
  /** Workspace-relative directory or file to search; defaults to the root. */
  readonly path?: string | undefined;
  /** Glob that limits searched files; without `/` it matches file names. */
  readonly include?: string | undefined;
  readonly regex?: boolean | undefined;
  readonly ignoreCase?: boolean | undefined;
  /** Context lines before and after each match, 0 to 5. */
  readonly contextLines?: number | undefined;
}

export const listDirInputSchema: z.ZodType<ListDirInput> = z.object({
  path: nonEmptyStringSchema.optional(),
  depth: z.number().int().min(1).max(5).optional(),
});

export const globInputSchema: z.ZodType<GlobInput> = z.object({
  pattern: nonEmptyStringSchema,
  path: nonEmptyStringSchema.optional(),
});

export const grepInputSchema: z.ZodType<GrepInput> = z.object({
  pattern: nonEmptyStringSchema,
  path: nonEmptyStringSchema.optional(),
  include: nonEmptyStringSchema.optional(),
  regex: z.boolean().optional(),
  ignoreCase: z.boolean().optional(),
  contextLines: z.number().int().min(0).max(5).optional(),
});

/** Options for {@link createWorkspaceSearchTools}. */
export type WorkspaceSearchToolOptions = WorkspaceSource & {
  /** Upper bound for one `grep`; defaults to 20 seconds. */
  readonly searchTimeoutMs?: number | undefined;
  /** Files indexed before listings report themselves incomplete. */
  readonly maxIndexedFiles?: number | undefined;
};

/** The read-only search tools exposed by the Runtime. */
export interface WorkspaceSearchTools {
  readonly listDir: ToolDefinition<ListDirInput, string>;
  readonly glob: ToolDefinition<GlobInput, string>;
  readonly grep: ToolDefinition<GrepInput, string>;
}

const maxListEntries = 500;
const maxGlobResults = 200;
const defaultSearchTimeoutMs = 20_000;

const grepLimits = {
  maxOutputLines: 100,
  maxLinesPerFile: 20,
  maxFileBytes: 1_000_000,
  maxLineLength: 300,
} as const;

/** Files whose contents `grep` never reads. */
function isSecretFile(file: string): boolean {
  const name = path.posix.basename(file);
  return name === '.env' || name.startsWith('.env.');
}

interface SearchScope {
  /** Real Workspace root. */
  readonly root: string;
  /** Scope relative to the root, `/`-separated; `.` for the root itself. */
  readonly relative: string;
  readonly kind: 'directory' | 'file';
}

async function resolveScope(
  options: WorkspaceSource,
  context: ToolExecutionContext,
  inputPath: string | undefined,
): Promise<SearchScope> {
  checkSignal(context);
  const workspace = await resolvePolicy(options, context);
  const candidate = resolveLexicalPath(workspace, inputPath ?? '.', 'read');
  const root = await resolveRealRoot(workspace.root);
  const target = await resolveExistingTarget(root, candidate, 'read');
  let metadata;
  try {
    metadata = await stat(target);
  } catch (error: unknown) {
    throw mapFilesystemError(error, 'read');
  }
  const relative = toPosixPath(path.relative(root, target)) || '.';
  if (metadata.isDirectory()) {
    return { root, relative, kind: 'directory' };
  }
  if (metadata.isFile()) {
    return { root, relative, kind: 'file' };
  }
  throw createMappedError(
    'workspace-file-read-failed',
    'Workspace path is not a file or directory',
  );
}

interface ScopedFiles {
  /** Paths relative to the Workspace root. */
  readonly files: readonly string[];
  readonly note: string | undefined;
}

/** Files inside a directory scope, honouring ignore rules unless the scope itself is ignored. */
async function filesInScope(
  scope: SearchScope,
  options: WorkspaceSearchToolOptions,
  signal: AbortSignal,
): Promise<ScopedFiles> {
  if (scope.kind === 'file') {
    return { files: [scope.relative], note: undefined };
  }
  const maxFiles = options.maxIndexedFiles;
  const index = await indexWorkspaceFiles(scope.root, {
    signal,
    ...(maxFiles === undefined ? {} : { maxFiles }),
  });
  const prefix = scope.relative === '.' ? '' : `${scope.relative}/`;
  const files = prefix === '' ? index.files : index.files.filter((file) => file.startsWith(prefix));
  const incomplete = index.truncated ? '文件数量超过上限，结果不完整' : undefined;
  if (files.length > 0 || prefix === '') {
    const rule =
      index.source === 'git'
        ? '已按 .gitignore 规则过滤'
        : '已跳过 node_modules、dist 等常见生成目录';
    return { files, note: [rule, incomplete].filter((part) => part !== undefined).join('；') };
  }
  // An explicitly requested directory that the ignore rules hide, such as dist.
  const walked = await walkWorkspaceFiles(scope.root, {
    signal,
    start: scope.relative,
    ...(maxFiles === undefined ? {} : { maxFiles }),
  });
  return {
    files: walked.files,
    note: walked.files.length > 0 ? '这个目录被忽略规则排除，已直接列出' : undefined,
  };
}

function formatSize(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

interface TreeNode {
  readonly directories: Map<string, TreeNode>;
  readonly files: string[];
  fileCount: number;
}

function createNode(): TreeNode {
  return { directories: new Map(), files: [], fileCount: 0 };
}

interface TreeEntry {
  readonly depth: number;
  readonly name: string;
  readonly kind: 'directory' | 'file';
  /** Path relative to the Workspace root, for files. */
  readonly file?: string | undefined;
  readonly fileCount?: number | undefined;
}

async function listDirectory(
  input: ListDirInput,
  context: ToolExecutionContext,
  options: WorkspaceSearchToolOptions,
): Promise<string> {
  const scope = await resolveScope(options, context, input.path);
  if (scope.kind !== 'directory') {
    throw createMappedError('workspace-file-not-directory', 'Workspace path is not a directory');
  }
  const { files, note } = await filesInScope(scope, options, context.signal);
  const prefix = scope.relative === '.' ? '' : `${scope.relative}/`;
  const depth = input.depth ?? 2;

  const tree = createNode();
  for (const file of files) {
    const parts = file.slice(prefix.length).split('/');
    let node = tree;
    node.fileCount += 1;
    for (const part of parts.slice(0, -1)) {
      let child = node.directories.get(part);
      if (child === undefined) {
        child = createNode();
        node.directories.set(part, child);
      }
      child.fileCount += 1;
      node = child;
    }
    node.files.push(file);
  }

  const entries: TreeEntry[] = [];
  let hidden = 0;
  const visit = (node: TreeNode, level: number): void => {
    for (const name of [...node.directories.keys()].sort()) {
      const child = node.directories.get(name) as TreeNode;
      if (entries.length >= maxListEntries) {
        hidden += 1;
        continue;
      }
      const expand = level < depth;
      entries.push({
        depth: level,
        name,
        kind: 'directory',
        ...(expand ? {} : { fileCount: child.fileCount }),
      });
      if (expand) {
        visit(child, level + 1);
      }
    }
    for (const file of [...node.files].sort()) {
      if (entries.length >= maxListEntries) {
        hidden += 1;
        continue;
      }
      entries.push({ depth: level, name: path.posix.basename(file), kind: 'file', file });
    }
  };
  visit(tree, 1);

  const lines = [`${scope.relative === '.' ? '.' : scope.relative}/`];
  const sizes = await Promise.all(
    entries.map(async (entry) => {
      if (entry.file === undefined) {
        return undefined;
      }
      try {
        const metadata = await lstat(path.join(scope.root, entry.file));
        return metadata.isSymbolicLink() ? 'link' : metadata.size;
      } catch {
        return 'missing';
      }
    }),
  );
  entries.forEach((entry, index) => {
    const indent = '  '.repeat(entry.depth);
    if (entry.kind === 'directory') {
      lines.push(
        `${indent}${entry.name}/${entry.fileCount === undefined ? '' : `  (${entry.fileCount} 个文件)`}`,
      );
      return;
    }
    const size = sizes[index];
    if (size === 'missing') {
      return;
    }
    lines.push(`${indent}${entry.name}${size === 'link' ? '@' : `  ${formatSize(size ?? 0)}`}`);
  });
  if (entries.length === 0) {
    lines.push('  （目录为空）');
  }

  const notes: string[] = [];
  if (hidden > 0) {
    notes.push(`还有 ${hidden} 项未列出，可以指定子目录或减小 depth`);
  }
  if (note !== undefined && note !== '') {
    notes.push(note);
  }
  return notes.length === 0 ? lines.join('\n') : `${lines.join('\n')}\n\n[${notes.join('；')}]`;
}

function assertRelativePattern(pattern: string): void {
  if (path.posix.isAbsolute(pattern) || path.win32.isAbsolute(pattern)) {
    throw createMappedError(
      'workspace-file-invalid-input',
      'Glob patterns are relative to the search path; do not pass an absolute pattern',
    );
  }
}

async function globFiles(
  input: GlobInput,
  context: ToolExecutionContext,
  options: WorkspaceSearchToolOptions,
): Promise<string> {
  assertRelativePattern(input.pattern);
  const scope = await resolveScope(options, context, input.path);
  if (scope.kind !== 'directory') {
    throw createMappedError('workspace-file-not-directory', 'Workspace path is not a directory');
  }
  const { files } = await filesInScope(scope, options, context.signal);
  const prefix = scope.relative === '.' ? '' : `${scope.relative}/`;
  const matched = files.filter((file) =>
    path.posix.matchesGlob(file.slice(prefix.length), input.pattern),
  );
  if (matched.length === 0) {
    const hint = input.pattern.includes('/') ? '' : `；要同时匹配子目录，请用 **/${input.pattern}`;
    return `没有匹配 ${input.pattern} 的文件${hint}`;
  }
  const shown = matched.slice(0, maxGlobResults);
  const footer =
    matched.length > shown.length
      ? `\n\n[共 ${matched.length} 个匹配，只显示前 ${shown.length} 个，请缩小范围]`
      : '';
  return `${shown.join('\n')}${footer}`;
}

/** Locates the worker module in source (Vitest) and compiled form. */
const grepWorkerUrl = new URL(
  import.meta.url.endsWith('.ts') ? './grep-worker.ts' : './grep-worker.js',
  import.meta.url,
);

function runGrepWorker(
  task: GrepTask,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<GrepOutcome> {
  return new Promise((resolve, reject) => {
    const data: GrepWorkerData = { kind: 'weave-grep', task };
    const worker = new Worker(grepWorkerUrl, { workerData: data });
    let settled = false;
    const settle = (finish: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      void worker.terminate();
      finish();
    };
    const onAbort = (): void => {
      settle(() =>
        reject(signal.reason ?? new DOMException('The operation was aborted', 'AbortError')),
      );
    };
    const timer = setTimeout(() => {
      settle(() =>
        reject(
          createMappedError(
            'workspace-search-failed',
            `Search did not finish within ${Math.round(timeoutMs / 1000)} seconds; narrow the path or include, or search plain text instead of a regular expression`,
          ),
        ),
      );
    }, timeoutMs);
    signal.addEventListener('abort', onAbort, { once: true });
    worker.once('message', (outcome: GrepOutcome) => settle(() => resolve(outcome)));
    worker.once('error', (error: Error) =>
      settle(() => reject(createMappedError('workspace-search-failed', 'Search failed', error))),
    );
    worker.once('exit', (code) => {
      if (code !== 0) {
        settle(() =>
          reject(
            createMappedError('workspace-search-failed', `Search stopped with exit code ${code}`),
          ),
        );
      }
    });
  });
}

function matchesInclude(file: string, scopePrefix: string, include: string): boolean {
  if (!include.includes('/')) {
    return path.posix.matchesGlob(path.posix.basename(file), include);
  }
  return path.posix.matchesGlob(file.slice(scopePrefix.length), include);
}

async function grepFiles(
  input: GrepInput,
  context: ToolExecutionContext,
  options: WorkspaceSearchToolOptions,
): Promise<string> {
  if (input.include !== undefined) {
    assertRelativePattern(input.include);
  }
  const scope = await resolveScope(options, context, input.path);
  const { files } = await filesInScope(scope, options, context.signal);
  const prefix = scope.kind === 'directory' && scope.relative !== '.' ? `${scope.relative}/` : '';
  const candidates = files.filter(
    (file) =>
      !isSecretFile(file) &&
      (input.include === undefined ||
        scope.kind === 'file' ||
        matchesInclude(file, prefix, input.include)),
  );

  const outcome = await runGrepWorker(
    {
      root: scope.root,
      files: candidates,
      pattern: input.pattern,
      regex: input.regex === true,
      ignoreCase: input.ignoreCase === true,
      contextLines: input.contextLines ?? 0,
      ...grepLimits,
    },
    context.signal,
    options.searchTimeoutMs ?? defaultSearchTimeoutMs,
  );
  if (!outcome.ok) {
    throw createMappedError(
      'workspace-search-invalid-pattern',
      `Invalid regular expression: ${outcome.message}`,
    );
  }
  if (outcome.totalMatches === 0) {
    return `没有找到匹配的内容（搜索了 ${outcome.scannedFiles} 个文件）`;
  }

  const lines: string[] = [];
  for (const result of outcome.results) {
    lines.push(result.file);
    result.blocks.forEach((block, index) => {
      if (index > 0) {
        lines.push('  --');
      }
      for (const line of block) {
        lines.push(`  ${line.line}${line.match ? ':' : '-'} ${line.text}`);
      }
    });
  }
  const summary = `共 ${outcome.totalMatches} 处匹配，分布在 ${outcome.filesWithMatches} 个文件`;
  const footer = outcome.truncated
    ? `[${summary}；只显示了一部分，请缩小 path 或用 include 过滤]`
    : `[${summary}]`;
  return `${lines.join('\n')}\n\n${footer}`;
}

/** Creates the read-only `list_dir`, `glob` and `grep` tools for a Workspace. */
export function createWorkspaceSearchTools(
  options: WorkspaceSearchToolOptions,
): WorkspaceSearchTools {
  assertWorkspaceSource(options);

  const listDir: ToolDefinition<ListDirInput, string> = {
    name: 'list_dir',
    description:
      'List files and directories inside the project folder as an indented tree; directories ' +
      'end with / and files show their size. Respects .gitignore. depth sets how many levels ' +
      'to show (1-5, default 2); deeper directories show their file count.',
    readOnly: true,
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          minLength: 1,
          description: 'Directory relative to the project folder',
        },
        depth: { type: 'integer', minimum: 1, maximum: 5 },
      },
      additionalProperties: false,
    },
    inputSchema: listDirInputSchema,
    execute: (input, context) => listDirectory(input, context, options),
  };

  const glob: ToolDefinition<GlobInput, string> = {
    name: 'glob',
    description:
      'Find files whose path matches a glob pattern relative to path (default the project ' +
      'folder), such as src/**/*.ts or **/*.test.ts. A pattern without ** only matches the top ' +
      'level. Respects .gitignore; returns paths relative to the project folder.',
    readOnly: true,
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', minLength: 1 },
        path: { type: 'string', minLength: 1 },
      },
      required: ['pattern'],
      additionalProperties: false,
    },
    inputSchema: globInputSchema,
    execute: (input, context) => globFiles(input, context, options),
  };

  const grep: ToolDefinition<GrepInput, string> = {
    name: 'grep',
    description:
      'Search file contents inside the project folder. pattern is plain text unless regex is ' +
      'true (JavaScript regular expression). include limits the files, such as *.ts or ' +
      'src/**/*.tsx. Returns matching lines grouped by file with line numbers; pass a line ' +
      'number as read_file offset to read around it. Respects .gitignore and skips binary and ' +
      '.env files.',
    readOnly: true,
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', minLength: 1 },
        path: { type: 'string', minLength: 1, description: 'Directory or file to search' },
        include: { type: 'string', minLength: 1 },
        regex: { type: 'boolean' },
        ignoreCase: { type: 'boolean' },
        contextLines: { type: 'integer', minimum: 0, maximum: 5 },
      },
      required: ['pattern'],
      additionalProperties: false,
    },
    inputSchema: grepInputSchema,
    execute: (input, context) => grepFiles(input, context, options),
  };

  return Object.freeze({
    listDir: Object.freeze(listDir),
    glob: Object.freeze(glob),
    grep: Object.freeze(grep),
  });
}
