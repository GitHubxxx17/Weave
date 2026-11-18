import { execFile } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import path from 'node:path';

/**
 * Lists the files of a Workspace for the search tools.
 *
 * A Git repository is listed with `git ls-files`, so `.gitignore` rules apply
 * exactly. Any other folder is walked with a built-in ignore list. Symlinks
 * are never followed.
 */

/** Directory names skipped when a folder is not a Git repository. */
export const defaultIgnoredNames: ReadonlySet<string> = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  'coverage',
  '.next',
  '.nuxt',
  '.turbo',
  '.cache',
  '.venv',
  'venv',
  '__pycache__',
  '.pytest_cache',
  '.mypy_cache',
  'target',
  '.gradle',
  '.idea',
]);

/** Files listed before the index stops and reports itself truncated. */
export const defaultMaxIndexedFiles = 50_000;

const gitTimeoutMs = 15_000;
const gitMaxOutputBytes = 64 * 1024 * 1024;

/** Files of one Workspace, as `/`-separated paths relative to its root. */
export interface WorkspaceFileIndex {
  readonly files: readonly string[];
  /** `git` when `.gitignore` rules applied; `walk` when the built-in ignore list did. */
  readonly source: 'git' | 'walk';
  /** True when listing stopped at the file limit. */
  readonly truncated: boolean;
}

function listWithGit(root: string, signal: AbortSignal): Promise<string[] | undefined> {
  return new Promise((resolve) => {
    execFile(
      'git',
      ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
      {
        cwd: root,
        encoding: 'utf8',
        env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' },
        maxBuffer: gitMaxOutputBytes,
        signal,
        timeout: gitTimeoutMs,
        windowsHide: true,
      },
      (error, stdout) => {
        if (error !== null) {
          // Not a repository, Git missing, or cancelled: the caller walks instead.
          resolve(undefined);
          return;
        }
        resolve([...new Set(stdout.split('\0').filter((entry) => entry !== ''))]);
      },
    );
  });
}

/**
 * Walks `start` (relative to `root`) and returns file paths relative to `root`.
 *
 * Directories named in {@link defaultIgnoredNames} are skipped below `start`;
 * `start` itself is always walked, so an explicitly requested `dist` works.
 */
export async function walkWorkspaceFiles(
  root: string,
  options: { readonly signal: AbortSignal; readonly start?: string; readonly maxFiles?: number },
): Promise<{ readonly files: string[]; readonly truncated: boolean }> {
  const maxFiles = options.maxFiles ?? defaultMaxIndexedFiles;
  const files: string[] = [];
  const pending: string[] = [
    options.start === undefined || options.start === '.' ? '' : options.start,
  ];
  while (pending.length > 0) {
    options.signal.throwIfAborted();
    const relativeDirectory = pending.shift() ?? '';
    let entries;
    try {
      entries = await readdir(path.join(root, relativeDirectory), { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (entry.isSymbolicLink()) {
        continue;
      }
      const relativePath =
        relativeDirectory === '' ? entry.name : `${relativeDirectory}/${entry.name}`;
      if (entry.isDirectory()) {
        if (!defaultIgnoredNames.has(entry.name)) {
          pending.push(relativePath);
        }
      } else if (entry.isFile()) {
        files.push(relativePath);
        if (files.length >= maxFiles) {
          return { files, truncated: true };
        }
      }
    }
  }
  return { files, truncated: false };
}

/** Lists every file of the Workspace whose real root is `root`. */
export async function indexWorkspaceFiles(
  root: string,
  options: { readonly signal: AbortSignal; readonly maxFiles?: number },
): Promise<WorkspaceFileIndex> {
  const maxFiles = options.maxFiles ?? defaultMaxIndexedFiles;
  const tracked = await listWithGit(root, options.signal);
  options.signal.throwIfAborted();
  if (tracked !== undefined) {
    // Git always prints `/`-separated paths, on every platform.
    const files = tracked.sort();
    return {
      files: files.slice(0, maxFiles),
      source: 'git',
      truncated: files.length > maxFiles,
    };
  }
  const walked = await walkWorkspaceFiles(root, { signal: options.signal, maxFiles });
  return { files: walked.files.sort(), source: 'walk', truncated: walked.truncated };
}
