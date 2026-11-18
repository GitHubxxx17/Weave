import { execFile } from 'node:child_process';

/**
 * Environment helpers for `run_command`.
 *
 * A desktop app started from Finder inherits a minimal PATH, so tools that a
 * user's `~/.zshrc` puts on PATH (nvm, pnpm) would be missing. Like VS Code,
 * the environment of an interactive login shell is resolved once and reused.
 */

const startMarker = '__WEAVE_ENV_START__';
const endMarker = '__WEAVE_ENV_END__';
const defaultResolveTimeoutMs = 5000;

/** Variable names never passed to commands; they may hold credentials. */
const secretNamePattern = /KEY|SECRET|TOKEN|PASSWORD/i;

/** The shell `run_command` uses on this platform. */
export function defaultCommandShell(platform: NodeJS.Platform = process.platform): string {
  if (platform === 'win32') {
    return 'powershell.exe';
  }
  const shell = process.env.SHELL;
  return shell === undefined || shell === '' ? '/bin/bash' : shell;
}

function parseNulSeparatedEnvironment(output: string): NodeJS.ProcessEnv | undefined {
  const start = output.indexOf(startMarker);
  const end = output.lastIndexOf(endMarker);
  if (start === -1 || end === -1 || end < start) {
    return undefined;
  }
  const environment: NodeJS.ProcessEnv = {};
  for (const entry of output.slice(start + startMarker.length, end).split('\0')) {
    const separator = entry.indexOf('=');
    if (separator > 0) {
      environment[entry.slice(0, separator)] = entry.slice(separator + 1);
    }
  }
  return Object.keys(environment).length > 0 ? environment : undefined;
}

/**
 * Runs `shell -ilc` once to read the environment an interactive login shell
 * would have. Falls back to `baseEnvironment` on Windows, on timeout, or when
 * the output cannot be parsed. Markers delimit the output so text printed by
 * the user's shell startup files is ignored.
 */
export function resolveLoginShellEnvironment(
  options: {
    readonly shell?: string | undefined;
    readonly timeoutMs?: number | undefined;
    readonly baseEnvironment?: NodeJS.ProcessEnv | undefined;
  } = {},
): Promise<NodeJS.ProcessEnv> {
  const base = { ...(options.baseEnvironment ?? process.env) };
  if (process.platform === 'win32') {
    return Promise.resolve(base);
  }
  const shell = options.shell ?? defaultCommandShell();
  return new Promise((resolve) => {
    const child = execFile(
      shell,
      ['-ilc', `printf '%s' '${startMarker}'; env -0; printf '%s' '${endMarker}'`],
      {
        encoding: 'utf8',
        env: base,
        maxBuffer: 8 * 1024 * 1024,
        timeout: options.timeoutMs ?? defaultResolveTimeoutMs,
        windowsHide: true,
      },
      (_error, stdout) => {
        // A non-zero exit from a noisy startup file still prints the markers.
        resolve(parseNulSeparatedEnvironment(stdout ?? '') ?? base);
      },
    );
    // Startup files that prompt for input must not wait on an open stdin.
    child.stdin?.end();
  });
}

const resolvedEnvironments = new Map<string, Promise<NodeJS.ProcessEnv>>();

/** {@link resolveLoginShellEnvironment}, cached per shell for the process lifetime. */
export function cachedLoginShellEnvironment(shell: string): Promise<NodeJS.ProcessEnv> {
  let pending = resolvedEnvironments.get(shell);
  if (pending === undefined) {
    pending = resolveLoginShellEnvironment({ shell });
    resolvedEnvironments.set(shell, pending);
  }
  return pending;
}

/**
 * Removes variables a command must not see and pins non-interactive output.
 *
 * Drops `WEAVE_*` (the Server's own configuration, which can carry API keys)
 * and any name containing KEY, SECRET, TOKEN or PASSWORD.
 */
export function filterCommandEnvironment(environment: NodeJS.ProcessEnv): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(environment)) {
    if (value === undefined || /^WEAVE_/i.test(name) || secretNamePattern.test(name)) {
      continue;
    }
    result[name] = value;
  }
  return {
    ...result,
    NO_COLOR: '1',
    TERM: 'dumb',
    PAGER: 'cat',
    GIT_PAGER: 'cat',
    GIT_TERMINAL_PROMPT: '0',
  };
}
