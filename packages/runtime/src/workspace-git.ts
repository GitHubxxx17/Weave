import { execFile } from 'node:child_process';
import { resolveLexicalPath, toPosixPath } from './workspace-access.js';
import { createWorkspacePolicy } from './workspace-policy.js';

/**
 * Read-only Git access for the Studio single-file diff: the content of one
 * file at a Git ref (default `HEAD`), used as the "before" side against the
 * current working-tree content. `git show` is run through `execFile` (no
 * shell), in the project folder, mirroring `workspace-file-index`'s Git call.
 */

/** A file's content at a Git ref. `tracked` is false when the ref has no such file. */
export interface GitBaseContent {
  readonly content: string;
  /** False for a new/untracked file, a path absent from the ref, or a non-Git folder. */
  readonly tracked: boolean;
}

const gitTimeoutMs = 15_000;
const gitMaxOutputBytes = 16 * 1024 * 1024;

/**
 * Returns `relativePath`'s content at `ref` inside the project folder.
 *
 * The path is validated through the Workspace policy (rejects `..`, absolute
 * paths, null bytes) before use. `ref` is fixed by the caller (not taken from
 * client input) so it cannot inject Git options. A file missing from the ref,
 * or a folder that is not a Git repository, resolves to empty untracked
 * content rather than throwing, so the diff renders it as newly added.
 */
export async function readGitBaseContent(
  rootPath: string,
  relativePath: string,
  ref = 'HEAD',
): Promise<GitBaseContent> {
  const policy = createWorkspacePolicy({ root: rootPath });
  const resolved = resolveLexicalPath(policy, relativePath, 'read');
  const posix = toPosixPath(resolved.relativePath);
  return new Promise<GitBaseContent>((resolve) => {
    execFile(
      'git',
      ['show', `${ref}:./${posix}`],
      {
        cwd: policy.root,
        encoding: 'utf8',
        env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' },
        maxBuffer: gitMaxOutputBytes,
        timeout: gitTimeoutMs,
        windowsHide: true,
      },
      (error, stdout) => {
        resolve(
          error === null ? { content: stdout, tracked: true } : { content: '', tracked: false },
        );
      },
    );
  });
}
