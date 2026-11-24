import { execFile } from 'node:child_process';
import { lstat, opendir, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { retrievalLimits, retrievalPathSchema } from '@weave/protocol';

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

interface RetrievalFileObservation {
  readonly path?: string;
  readonly ignored?: boolean;
  readonly unsafe?: boolean;
}

interface RetrievalFileListing {
  readonly source: 'git' | 'walk';
  readonly files: readonly RetrievalFileObservation[];
  readonly truncated: boolean;
}

const pathDecoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

function decodeRetrievalPath(bytes: Buffer): string | undefined {
  try {
    const text = pathDecoder.decode(bytes);
    if (retrievalPathSchema.safeParse(text).success) return text;
  } catch {
    // Keep invalid bytes out of paths passed to Git, the filesystem and callers.
  }
  return undefined;
}

async function metadataIfPresent(target: string) {
  try {
    return await lstat(target, { bigint: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

// Check inherited rules before choosing walk. A nearer worktree takes over its own rules.
async function findGitAncestor(root: string, signal: AbortSignal): Promise<boolean> {
  let folder = root;
  let unhandledIgnore = false;
  while (true) {
    signal.throwIfAborted();
    if (await metadataIfPresent(path.join(folder, '.git'))) return true;
    unhandledIgnore ||= (await metadataIfPresent(path.join(folder, '.gitignore'))) !== undefined;
    const parent = path.dirname(folder);
    if (parent === folder) break;
    folder = parent;
  }
  if (unhandledIgnore) throw new Error('Workspace ignore rules cannot be applied');
  return false;
}

function runRetrievalGit(
  root: string,
  args: string[],
  options: { readonly signal: AbortSignal; readonly input?: Buffer },
): Promise<Buffer> {
  const { signal, input } = options;
  signal.throwIfAborted();
  // Use this Project's on-disk worktree and configured ignore rules.
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')),
  );
  return new Promise((resolve, reject) => {
    const child = execFile(
      'git',
      ['-c', 'core.fsmonitor=false', ...args],
      {
        cwd: root,
        encoding: 'buffer',
        env: { ...env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' },
        maxBuffer: gitMaxOutputBytes,
        signal,
        timeout: gitTimeoutMs,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (stderr.length === 0 && (error === null || (input !== undefined && error.code === 1))) {
          resolve(stdout);
        } else {
          reject(new Error('Workspace Git discovery failed'));
        }
      },
    );
    if (child.stdin !== null) {
      child.stdin.on('error', () => {
        /* The process callback owns the outcome. */
      });
      child.stdin.end(input);
    }
  });
}

function splitGitPaths(
  output: Buffer,
  signal: AbortSignal,
  limit = Number.MAX_SAFE_INTEGER,
): Buffer[] {
  const entries: Buffer[] = [];
  let from = 0;
  while (from < output.length && entries.length < limit) {
    signal.throwIfAborted();
    const end = output.indexOf(0, from);
    if (end <= from) throw new Error('Workspace Git discovery returned invalid data');
    entries.push(output.subarray(from, end));
    from = end + 1;
  }
  return entries;
}

async function hasUnsafeParent(
  root: string,
  relativePath: string,
  checked: Map<string, boolean>,
): Promise<boolean> {
  const segments = relativePath.split('/');
  let folder = root;
  for (const segment of segments.slice(0, -1)) {
    folder = path.join(folder, segment);
    let unsafe = checked.get(folder);
    if (unsafe === undefined) {
      const metadata = await metadataIfPresent(folder);
      unsafe = metadata !== undefined && (metadata.isSymbolicLink() || !metadata.isDirectory());
      checked.set(folder, unsafe);
      if (metadata === undefined) return false;
    }
    if (unsafe) return true;
  }
  return false;
}

async function gitRetrievalFiles(root: string, signal: AbortSignal): Promise<RetrievalFileListing> {
  const output = await runRetrievalGit(
    root,
    ['ls-files', '--cached', '--others', '--exclude-standard', '--deduplicate', '-z', '--'],
    { signal },
  );
  const rawPaths = splitGitPaths(output, signal, retrievalLimits.maxDiscoveredFiles + 1).sort(
    Buffer.compare,
  );
  const files: RetrievalFileObservation[] = [];
  const checkPaths: string[] = [];
  const checkedParents = new Map<string, boolean>();
  let previous: Buffer | undefined;
  let truncated = false;
  for (const raw of rawPaths) {
    signal.throwIfAborted();
    if (previous?.equals(raw)) continue;
    previous = raw;
    if (files.length === retrievalLimits.maxDiscoveredFiles) {
      truncated = true;
      break;
    }
    const relativePath = decodeRetrievalPath(raw);
    if (relativePath === undefined) {
      files.push({ unsafe: true });
    } else if (await hasUnsafeParent(root, relativePath, checkedParents)) {
      // check-ignore rejects an entire command if one path crosses a symlink.
      files.push({ path: relativePath, unsafe: true });
    } else {
      files.push({ path: relativePath });
      checkPaths.push(relativePath);
    }
  }
  const ignored = new Set<string>();
  for (let index = 0; index < checkPaths.length; index += 256) {
    const paths = checkPaths.slice(index, index + 256);
    const candidates = new Set(paths);
    const input = Buffer.from(`${paths.join('\0')}\0`, 'utf8');
    const ignoredOutput = await runRetrievalGit(
      root,
      ['check-ignore', '--no-index', '--stdin', '-z'],
      { signal, input },
    );
    const ignoredPaths = splitGitPaths(ignoredOutput, signal, paths.length + 1);
    if (ignoredPaths.length > paths.length)
      throw new Error('Workspace Git ignore returned invalid data');
    for (const raw of ignoredPaths) {
      const relativePath = decodeRetrievalPath(raw);
      if (relativePath === undefined || !candidates.has(relativePath))
        throw new Error('Workspace Git ignore returned invalid data');
      ignored.add(relativePath);
    }
  }
  return {
    source: 'git',
    files: files.map((file) => (ignored.has(file.path ?? '') ? { ...file, ignored: true } : file)),
    truncated,
  };
}

async function walkRetrievalFiles(
  root: string,
  signal: AbortSignal,
): Promise<RetrievalFileListing> {
  const pending = [''];
  const files: RetrievalFileObservation[] = [];
  let entriesObserved = 0;
  for (const directory of pending) {
    signal.throwIfAborted();
    const fullPath = path.join(root, directory);
    const before = await lstat(fullPath, { bigint: true });
    if (!before.isDirectory() || before.isSymbolicLink())
      throw new Error('Workspace directory changed during discovery');
    if (
      (await metadataIfPresent(path.join(fullPath, '.gitignore'))) ||
      (await metadataIfPresent(path.join(fullPath, '.git')))
    )
      throw new Error('Workspace ignore rules cannot be applied');
    // Node supports buffer encoding here, though Dir and OpenDirOptions omit it.
    const stream = await opendir(fullPath, { encoding: 'buffer' as BufferEncoding });
    const observations: RetrievalFileObservation[] = [];
    const directories: string[] = [];
    for await (const entry of stream) {
      signal.throwIfAborted();
      // Keep only complete directory results so a cutoff does not depend on
      // the filesystem's iteration order within the incomplete directory.
      if (++entriesObserved > retrievalLimits.maxDiscoveredFiles)
        return { source: 'walk', files, truncated: true };
      const rawName: unknown = entry.name;
      if (!Buffer.isBuffer(rawName)) throw new Error('Workspace directory names could not be read');
      const raw =
        directory === '' ? rawName : Buffer.concat([Buffer.from(`${directory}/`), rawName]);
      const relativePath = decodeRetrievalPath(raw);
      if (relativePath === undefined) {
        observations.push({ unsafe: true });
      } else if (entry.isDirectory()) {
        if (!defaultIgnoredNames.has(path.posix.basename(relativePath).toLowerCase()))
          directories.push(relativePath);
      } else {
        observations.push({ path: relativePath, unsafe: !entry.isFile() });
      }
    }
    const after = await lstat(fullPath, { bigint: true });
    if (
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.birthtimeNs !== before.birthtimeNs ||
      after.ctimeNs !== before.ctimeNs
    )
      throw new Error('Workspace directory changed during discovery');
    files.push(...observations);
    pending.push(...directories.sort());
  }
  return { source: 'walk', files, truncated: false };
}

/** Strict retrieval listing. Existing browse and search tools use their original modes. */
export async function listRetrievalWorkspaceFiles(
  rootPath: string,
  signal: AbortSignal,
): Promise<RetrievalFileListing> {
  signal.throwIfAborted();
  const root = await realpath(rootPath);
  if (await findGitAncestor(root, signal)) return gitRetrievalFiles(root, signal);
  return walkRetrievalFiles(root, signal);
}
