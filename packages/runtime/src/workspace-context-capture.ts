import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { executionContextLimits, type ExecutionContext } from '@weave/protocol';
import type { CapturedWorkspaceContext } from '@weave/session';
import { AgentExecutionError } from './agent-execution-types.js';
import { isSecretFile } from './secret-files.js';
import { resolveRealRoot } from './workspace-access.js';
import { indexWorkspaceFiles } from './workspace-file-index.js';

/**
 * Captures the "Git changes" and "Project tree" composer contexts at execution
 * acceptance. Everything here is read-only: Git runs without a shell, without
 * external diff or textconv programs, and its output is size-capped while it
 * streams, so a huge diff never lives in memory.
 */

type CapturedSnapshots = Omit<CapturedWorkspaceContext, 'projectId'>;

export interface CaptureWorkspaceContextsOptions {
  readonly signal: AbortSignal;
  /** Clock for the capture timestamp; tests inject a fixed one. */
  readonly now?: () => Date;
}

/** Why the Git changes context is not available for a project folder. */
export const gitChangesUnavailableMessage =
  'Git changes need a Git repository with at least one commit';

const encoder = new TextEncoder();
const byteLength = (text: string): number => encoder.encode(text).byteLength;

/** Cuts `text` to at most `maxBytes` UTF-8 bytes without splitting a character. */
function truncateUtf8(text: string, maxBytes: number): string {
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length <= maxBytes) return text;
  let end = maxBytes;
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end -= 1;
  return bytes.subarray(0, end).toString('utf8');
}

const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

/** Git must act on the folder it is given, not on one the host environment names. */
function gitEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_OPTIONAL_LOCKS: '0',
    GIT_TERMINAL_PROMPT: '0',
  };
  for (const name of [
    'GIT_DIR',
    'GIT_WORK_TREE',
    'GIT_INDEX_FILE',
    'GIT_COMMON_DIR',
    'GIT_EXTERNAL_DIFF',
    'GIT_PAGER',
  ])
    delete environment[name];
  return environment;
}

interface GitOutput {
  readonly text: string;
  readonly truncated: boolean;
  readonly exitCode: number | null;
}

class GitSpawnError extends Error {
  constructor(readonly code: string | undefined) {
    super('Git could not be started');
  }
}

/** Runs Git without a shell and keeps at most `maxBytes` of stdout. */
function runGit(
  cwd: string,
  args: readonly string[],
  options: { readonly signal: AbortSignal; readonly maxBytes: number },
): Promise<GitOutput> {
  return new Promise((resolve, reject) => {
    if (options.signal.aborted) {
      reject(options.signal.reason);
      return;
    }
    const child = spawn(
      'git',
      [
        '--no-pager',
        // A repository's own config must not run programs for a read-only capture.
        '-c',
        'core.fsmonitor=false',
        '-c',
        'core.quotePath=false',
        ...args,
      ],
      {
        cwd,
        env: gitEnvironment(),
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: true,
        signal: options.signal,
      },
    );
    const chunks: Buffer[] = [];
    let total = 0;
    let truncated = false;
    child.stdout.on('data', (chunk: Buffer) => {
      if (truncated) return;
      const room = options.maxBytes - total;
      if (chunk.length > room) {
        if (room > 0) chunks.push(chunk.subarray(0, room));
        total = options.maxBytes;
        truncated = true;
        child.kill();
        return;
      }
      chunks.push(chunk);
      total += chunk.length;
    });
    child.once('error', (error: NodeJS.ErrnoException) => {
      if (options.signal.aborted) reject(options.signal.reason);
      else reject(new GitSpawnError(error.code));
    });
    child.once('close', (exitCode) => {
      if (options.signal.aborted) {
        reject(options.signal.reason);
        return;
      }
      resolve({
        text: Buffer.concat(chunks).toString('utf8'),
        truncated,
        exitCode: truncated ? 0 : exitCode,
      });
    });
  });
}

function gitUnavailable(): AgentExecutionError {
  return new AgentExecutionError('execution-context-git-unavailable', gitChangesUnavailableMessage);
}

/** Whether `root` is inside a Git work tree whose HEAD resolves to a commit. */
async function verifyGitHead(root: string, signal: AbortSignal): Promise<void> {
  try {
    const head = await runGit(root, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'], {
      signal,
      maxBytes: 1024,
    });
    if (head.exitCode !== 0) throw gitUnavailable();
  } catch (error: unknown) {
    if (error instanceof GitSpawnError) throw gitUnavailable();
    throw error;
  }
}

/** Reports whether the Git changes context can be captured, without capturing it. */
export async function checkGitChangesAvailable(
  rootPath: string,
  options: { readonly signal: AbortSignal },
): Promise<boolean> {
  try {
    await verifyGitHead(await resolveRealRoot(rootPath), options.signal);
    return true;
  } catch (error: unknown) {
    if (error instanceof AgentExecutionError) return false;
    throw error;
  }
}

const truncationMarker = '\n[truncated: output exceeded the context size limit]';
const statusBudgetBytes = 32_768;
/** Secret files keep their name in the diff scope but never their content. */
const secretPathspecs = [':(exclude,glob)**/.env', ':(exclude,glob)**/.env.*'];

async function captureGitChanges(
  root: string,
  signal: AbortSignal,
  capturedAt: string,
): Promise<CapturedWorkspaceContext['snapshots'][number]> {
  await verifyGitHead(root, signal);
  const limit = executionContextLimits.gitChangesBytes;
  const markerBytes = byteLength(truncationMarker);
  const status = await runGit(
    root,
    ['status', '--porcelain=v1', '--untracked-files=normal', '--', '.'],
    { signal, maxBytes: statusBudgetBytes },
  );
  if (status.exitCode !== 0) throw new Error('git status failed');
  const names = await runGit(
    root,
    [
      'diff',
      'HEAD',
      '--no-ext-diff',
      '--no-textconv',
      '--relative',
      '--name-only',
      '-z',
      '--',
      '.',
    ],
    { signal, maxBytes: 1_048_576 },
  );
  if (names.exitCode !== 0) throw new Error('git diff failed');
  const omitted = names.text
    .split('\0')
    .filter((name) => name !== '' && isSecretFile(name))
    .map((name) => name.replaceAll('\n', '\\n'));
  const diff = await runGit(
    root,
    [
      'diff',
      'HEAD',
      '--no-ext-diff',
      '--no-textconv',
      '--no-color',
      '--relative',
      '--',
      '.',
      ...secretPathspecs,
    ],
    { signal, maxBytes: limit + 1 },
  );
  if (diff.exitCode !== 0) throw new Error('git diff failed');

  const statusText = status.text.replaceAll('\0', '');
  const diffText = diff.text.replaceAll('\0', '');
  const sections = [
    `## git status --porcelain=v1\n${statusText === '' ? '(clean)\n' : statusText}`,
    ...(omitted.length === 0
      ? []
      : [
          `## content omitted (environment files)\n${omitted
            .slice(0, 64)
            .map((name) => `${name} (content omitted)`)
            .join('\n')}\n`,
        ]),
    `## git diff HEAD\n${diffText === '' ? '(no changes)\n' : diffText}`,
  ];
  const full = sections.join('\n');
  let truncated = status.truncated || names.truncated || diff.truncated;
  let content = full;
  if (truncated || byteLength(full) > limit) {
    truncated = true;
    content = truncateUtf8(full, limit - markerBytes) + truncationMarker;
  }
  return {
    kind: 'git-changes',
    capturedAt,
    content,
    byteLength: byteLength(content),
    truncated,
    sha256: sha256(content),
  };
}

const unsafePathCharacters = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

async function captureProjectTree(
  root: string,
  signal: AbortSignal,
  capturedAt: string,
): Promise<CapturedWorkspaceContext['snapshots'][number]> {
  const maxEntries = executionContextLimits.projectTreeEntries;
  const limit = executionContextLimits.projectTreeBytes;
  const index = await indexWorkspaceFiles(root, { signal, maxFiles: maxEntries });
  let truncated = index.truncated;
  const marker = '\n[truncated: more files exist than are listed]';
  const budget = limit - byteLength(marker);
  const entries: string[] = [];
  let used = 0;
  for (const file of index.files) {
    if (unsafePathCharacters.test(file)) continue;
    const next = byteLength(file) + (entries.length === 0 ? 0 : 1);
    if (used + next > budget || entries.length >= maxEntries) {
      truncated = true;
      break;
    }
    entries.push(file);
    used += next;
  }
  const content = entries.join('\n') + (truncated ? marker : '');
  return {
    kind: 'project-tree',
    capturedAt,
    content,
    byteLength: byteLength(content),
    truncated,
    sha256: sha256(content),
    entryCount: entries.length,
  };
}

/**
 * Captures the requested contexts of the project folder `rootPath`. Kinds are
 * returned in request order. Cancellation (including the shared acceptance
 * timeout) rejects with the signal's reason.
 */
export async function captureWorkspaceContexts(
  rootPath: string,
  contexts: readonly ExecutionContext[],
  options: CaptureWorkspaceContextsOptions,
): Promise<CapturedSnapshots> {
  const { signal } = options;
  const capturedAt = (options.now?.() ?? new Date()).toISOString();
  const root = await resolveRealRoot(rootPath);
  const snapshots: CapturedWorkspaceContext['snapshots'][number][] = [];
  for (const { kind } of contexts) {
    signal.throwIfAborted();
    snapshots.push(
      kind === 'git-changes'
        ? await captureGitChanges(root, signal, capturedAt)
        : await captureProjectTree(root, signal, capturedAt),
    );
  }
  signal.throwIfAborted();
  return { version: 1, snapshots };
}
