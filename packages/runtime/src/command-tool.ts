import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { z } from 'zod';
import {
  assertWorkspaceSource,
  checkSignal,
  createMappedError,
  resolveExistingDirectory,
  resolveLexicalPath,
  resolvePolicy,
  resolveRealRoot,
  toPosixPath,
} from './workspace-access.js';
import type { WorkspaceSource } from './workspace-file-types.js';
import {
  cachedLoginShellEnvironment,
  defaultCommandShell,
  filterCommandEnvironment,
} from './shell-environment.js';
import type { ToolDefinition, ToolExecutionContext } from './tool-types.js';

/** Input accepted by the `run_command` Runtime tool. */
export interface RunCommandInput {
  /** Shell command line. */
  readonly command: string;
  /** Workspace-relative working directory; defaults to the Workspace root. */
  readonly cwd?: string | undefined;
  /** Milliseconds before the command is stopped. */
  readonly timeoutMs?: number | undefined;
}

export const defaultCommandTimeoutMs = 120_000;
export const maxCommandTimeoutMs = 600_000;

export const runCommandInputSchema: z.ZodType<RunCommandInput> = z.object({
  command: z.string().min(1).max(20_000),
  cwd: z.string().min(1).optional(),
  timeoutMs: z.number().int().min(1000).max(maxCommandTimeoutMs).optional(),
});

/** Options for {@link createCommandTool}. */
export type CommandToolOptions = WorkspaceSource & {
  /** Shell executable; defaults to `$SHELL` (POSIX) or PowerShell (Windows). */
  readonly shell?: string | undefined;
  /**
   * Base environment before filtering. Defaults to the environment of an
   * interactive login shell, resolved once.
   */
  readonly environment?: (() => NodeJS.ProcessEnv | Promise<NodeJS.ProcessEnv>) | undefined;
  readonly defaultTimeoutMs?: number | undefined;
  /** Delay between SIGTERM and SIGKILL when a command is stopped. */
  readonly killGraceMs?: number | undefined;
};

const headLimitBytes = 4 * 1024;
const tailLimitBytes = 24 * 1024;
/** Wait for output to drain after the shell exits before stopping leftovers. */
const drainAfterExitMs = 1000;

// ANSI CSI/OSC/escape sequences; terminals use them for colour and cursor moves.
// Matching control characters is the purpose of this expression.
/* eslint-disable no-control-regex */
const ansiPattern =
  /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-Z\\-_]/g;
/* eslint-enable no-control-regex */

function utf8Length(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

function takeFirstBytes(text: string, maxBytes: number): string {
  if (utf8Length(text) <= maxBytes) {
    return text;
  }
  let end = Math.min(text.length, maxBytes);
  while (end > 0 && utf8Length(text.slice(0, end)) > maxBytes) {
    end = Math.floor(end * 0.9);
  }
  return text.slice(0, end);
}

function takeLastBytes(text: string, maxBytes: number): string {
  if (utf8Length(text) <= maxBytes) {
    return text;
  }
  let start = Math.max(0, text.length - maxBytes);
  while (start < text.length && utf8Length(text.slice(start)) > maxBytes) {
    start += Math.ceil((text.length - start) * 0.1);
  }
  return text.slice(start);
}

/** Keeps the beginning and end of a command's output with bounded memory. */
class OutputCollector {
  private head = '';
  private tail = '';
  private headFull = false;
  private totalBytes = 0;
  private totalNewlines = 0;

  push(text: string): void {
    this.totalBytes += utf8Length(text);
    for (let index = text.indexOf('\n'); index !== -1; index = text.indexOf('\n', index + 1)) {
      this.totalNewlines += 1;
    }
    if (!this.headFull) {
      const room = headLimitBytes - utf8Length(this.head);
      const part = takeFirstBytes(text, room);
      this.head += part;
      if (part.length < text.length) {
        this.headFull = true;
        this.tail += text.slice(part.length);
      }
    } else {
      this.tail += text;
    }
    if (this.tail.length > tailLimitBytes * 4) {
      this.tail = takeLastBytes(this.tail, tailLimitBytes * 2);
    }
  }

  format(): string {
    const clean = (text: string): string =>
      text
        .replace(ansiPattern, '')
        .split('\n')
        // A carriage return redraws the line (progress bars); keep the final state.
        .map((line) => {
          const parts = line.split('\r').filter((part) => part !== '');
          return parts[parts.length - 1] ?? '';
        })
        .join('\n');

    const retainedBytes = utf8Length(this.head) + utf8Length(this.tail);
    if (this.totalBytes === retainedBytes && retainedBytes <= headLimitBytes + tailLimitBytes) {
      return clean(this.head + this.tail);
    }
    let tail = takeLastBytes(this.tail, tailLimitBytes);
    const firstBreak = tail.indexOf('\n');
    if (firstBreak !== -1 && firstBreak < tail.length - 1) {
      tail = tail.slice(firstBreak + 1);
    }
    const countNewlines = (text: string): number => text.split('\n').length - 1;
    const omittedLines = Math.max(
      0,
      this.totalNewlines - countNewlines(this.head) - countNewlines(tail),
    );
    const omittedBytes = Math.max(0, this.totalBytes - utf8Length(this.head) - utf8Length(tail));
    return `${clean(this.head)}\n…省略中间约 ${omittedLines} 行（${(omittedBytes / 1024).toFixed(
      1,
    )} KB）…\n${clean(tail)}`;
  }

  get isEmpty(): boolean {
    return this.totalBytes === 0;
  }
}

function stopProcessTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) {
    return;
  }
  if (process.platform === 'win32') {
    const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    killer.on('error', () => undefined);
    return;
  }
  try {
    // The command runs in its own process group; stop the whole group.
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // The process already exited.
    }
  }
}

interface CommandOutcome {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly timedOut: boolean;
  readonly leftoversStopped: boolean;
  readonly durationMs: number;
  readonly output: OutputCollector;
}

function runShellCommand(options: {
  readonly shell: string;
  readonly command: string;
  readonly cwd: string;
  readonly environment: Record<string, string>;
  readonly timeoutMs: number;
  readonly killGraceMs: number;
  readonly signal: AbortSignal;
}): Promise<CommandOutcome> {
  const isWindows = process.platform === 'win32';
  const args = isWindows
    ? ['-NoProfile', '-NonInteractive', '-Command', options.command]
    : ['-c', options.command];

  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const output = new OutputCollector();
    let timedOut = false;
    let leftoversStopped = false;
    let exitCode: number | null = null;
    let exitSignal: NodeJS.Signals | null = null;
    let finished = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let drainTimer: ReturnType<typeof setTimeout> | undefined;

    let child: ChildProcess;
    try {
      child = spawn(options.shell, args, {
        cwd: options.cwd,
        env: options.environment,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: !isWindows,
        windowsHide: true,
      });
    } catch (error: unknown) {
      reject(
        createMappedError(
          'workspace-command-spawn-failed',
          `The shell ${options.shell} could not be started`,
          error,
        ),
      );
      return;
    }

    const stop = (): void => {
      stopProcessTree(child, 'SIGTERM');
      killTimer ??= setTimeout(() => stopProcessTree(child, 'SIGKILL'), options.killGraceMs);
    };
    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      stop();
    }, options.timeoutMs);
    const onAbort = (): void => stop();
    options.signal.addEventListener('abort', onAbort, { once: true });

    const cleanup = (): void => {
      finished = true;
      clearTimeout(timeoutTimer);
      if (killTimer !== undefined) {
        clearTimeout(killTimer);
      }
      if (drainTimer !== undefined) {
        clearTimeout(drainTimer);
      }
      options.signal.removeEventListener('abort', onAbort);
    };

    const decoders = [new TextDecoder(), new TextDecoder()];
    child.stdout?.on('data', (chunk: Buffer) =>
      output.push(decoders[0]?.decode(chunk, { stream: true }) ?? ''),
    );
    child.stderr?.on('data', (chunk: Buffer) =>
      output.push(decoders[1]?.decode(chunk, { stream: true }) ?? ''),
    );

    child.once('error', (error: Error) => {
      if (finished) {
        return;
      }
      cleanup();
      reject(
        createMappedError(
          'workspace-command-spawn-failed',
          `The shell ${options.shell} could not be started`,
          error,
        ),
      );
    });
    child.once('exit', (code, signal) => {
      exitCode = code;
      exitSignal = signal;
      // Background processes can keep the output pipes open after the shell
      // exits; stop them so the call returns and nothing is left running.
      drainTimer = setTimeout(() => {
        leftoversStopped = true;
        stopProcessTree(child, 'SIGKILL');
        child.stdout?.destroy();
        child.stderr?.destroy();
      }, drainAfterExitMs);
    });
    child.once('close', (code, signal) => {
      if (finished) {
        return;
      }
      cleanup();
      for (const decoder of decoders) {
        output.push(decoder.decode());
      }
      if (options.signal.aborted && !timedOut) {
        reject(
          options.signal.reason ?? new DOMException('The operation was aborted', 'AbortError'),
        );
        return;
      }
      resolve({
        exitCode: exitCode ?? code,
        signal: exitSignal ?? signal,
        timedOut,
        leftoversStopped,
        durationMs: Date.now() - startedAt,
        output,
      });
    });
  });
}

function formatOutcome(command: string, cwd: string, outcome: CommandOutcome): string {
  const seconds = (outcome.durationMs / 1000).toFixed(1);
  const status = outcome.timedOut
    ? `已超时：运行 ${seconds} 秒后被终止`
    : outcome.exitCode !== null
      ? `exit code: ${outcome.exitCode} · ${seconds} s`
      : `被信号 ${outcome.signal ?? '未知'} 终止 · ${seconds} s`;
  const lines = [`$ ${command}`];
  if (cwd !== '.') {
    lines.push(`（工作目录：${cwd}）`);
  }
  lines.push(status);
  if (outcome.leftoversStopped) {
    lines.push('（命令结束后仍有后台进程在运行，已将其结束）');
  }
  lines.push('--- 输出 ---');
  lines.push(outcome.output.isEmpty ? '（没有输出）' : outcome.output.format());
  return lines.join('\n');
}

interface ResolvedCwd {
  readonly absolutePath: string;
  readonly relativePath: string;
}

async function resolveCommandCwd(
  options: CommandToolOptions,
  context: ToolExecutionContext,
  cwd: string | undefined,
): Promise<ResolvedCwd> {
  checkSignal(context);
  const workspace = await resolvePolicy(options, context);
  const candidate = resolveLexicalPath(workspace, cwd ?? '.', 'execute');
  const root = await resolveRealRoot(workspace.root);
  const absolutePath = await resolveExistingDirectory(root, candidate);
  return { absolutePath, relativePath: toPosixPath(path.relative(root, absolutePath)) || '.' };
}

function effectiveTimeout(options: CommandToolOptions, input: RunCommandInput): number {
  return Math.min(
    input.timeoutMs ?? options.defaultTimeoutMs ?? defaultCommandTimeoutMs,
    maxCommandTimeoutMs,
  );
}

function shorten(text: string, maxLength: number): string {
  return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
}

/** Creates the `run_command` tool, whose Approval depends on the permission mode. */
export function createCommandTool(
  options: CommandToolOptions,
): ToolDefinition<RunCommandInput, string> {
  assertWorkspaceSource(options);
  const shell = options.shell ?? defaultCommandShell();
  const environment = options.environment ?? (() => cachedLoginShellEnvironment(shell));
  const killGraceMs = options.killGraceMs ?? 2000;

  const tool: ToolDefinition<RunCommandInput, string> = {
    name: 'run_command',
    description:
      'Run a shell command in the project folder (or in cwd inside it) and return its exit code ' +
      'and output. Use it for tests, builds, linters, git and other commands that finish on ' +
      'their own; do not start servers or watch mode. stdin is closed, and long output keeps ' +
      'only its beginning and end. Depending on the session permission mode, the user may be ' +
      'asked to approve the command. It does not run in a sandbox.',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', minLength: 1 },
        cwd: {
          type: 'string',
          minLength: 1,
          description: 'Directory relative to the project folder',
        },
        timeoutMs: { type: 'integer', minimum: 1000, maximum: maxCommandTimeoutMs },
      },
      required: ['command'],
      additionalProperties: false,
    },
    inputSchema: runCommandInputSchema,
    approval: {
      operation: 'shell.run_command',
      risk: 'high',
      summarize: async (input: RunCommandInput, context: ToolExecutionContext) => {
        const cwd = await resolveCommandCwd(options, context, input.cwd);
        return {
          summary: `运行命令：${shorten(input.command, 120)}`,
          inputSummary: {
            command: input.command,
            cwd: cwd.relativePath,
            timeoutMs: effectiveTimeout(options, input),
          },
        };
      },
    },
    execute: async (input: RunCommandInput, context: ToolExecutionContext) => {
      const cwd = await resolveCommandCwd(options, context, input.cwd);
      const baseEnvironment = await environment();
      checkSignal(context);
      const outcome = await runShellCommand({
        shell,
        command: input.command,
        cwd: cwd.absolutePath,
        environment: filterCommandEnvironment(baseEnvironment),
        timeoutMs: effectiveTimeout(options, input),
        killGraceMs,
        signal: context.signal,
      });
      return formatOutcome(input.command, cwd.relativePath, outcome);
    },
  };
  return Object.freeze(tool);
}
