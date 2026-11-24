import { randomUUID } from 'node:crypto';
import { statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { isAbsolute } from 'node:path';
import { z } from 'zod';
import { isTrustedSender } from './sender-origin.js';
import type { IpcMain, IpcMainEvent, IpcMainInvokeEvent, WebContents } from 'electron';

/** IPC channels for the user-driven terminal. Renderer → Main and Main → Renderer. */
export const terminalChannels = {
  create: 'weave:terminal:create',
  input: 'weave:terminal:input',
  resize: 'weave:terminal:resize',
  dispose: 'weave:terminal:dispose',
  data: 'weave:terminal:data',
  exit: 'weave:terminal:exit',
} as const;

/** The subset of a node-pty process the host depends on. */
export interface PtyProcess {
  readonly onData: (listener: (data: string) => void) => void;
  readonly onExit: (listener: (event: { readonly exitCode: number }) => void) => void;
  readonly write: (data: string) => void;
  readonly resize: (cols: number, rows: number) => void;
  readonly kill: () => void;
}

export interface PtySpawnOptions {
  readonly shell: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly cols: number;
  readonly rows: number;
  readonly env: NodeJS.ProcessEnv;
}

/** Creates a pty process; injected in tests so the native module never loads. */
export type PtySpawner = (options: PtySpawnOptions) => PtyProcess;

const sizeSchema = z.number().int().positive().max(1000);
const createRequestSchema = z.object({
  cwd: z.string().min(1).nullable().optional(),
  cols: sizeSchema,
  rows: sizeSchema,
});
const inputSchema = z.object({ id: z.string().min(1), data: z.string() });
const resizeSchema = z.object({ id: z.string().min(1), cols: sizeSchema, rows: sizeSchema });
const disposeSchema = z.object({ id: z.string().min(1) });

interface NodePtyModule {
  readonly spawn: (
    file: string,
    args: readonly string[],
    options: {
      readonly name: string;
      readonly cwd: string;
      readonly cols: number;
      readonly rows: number;
      readonly env: NodeJS.ProcessEnv;
    },
  ) => PtyProcess;
}

/** Loads node-pty lazily so tests and non-terminal launches never touch the native module. */
function defaultSpawner(options: PtySpawnOptions): PtyProcess {
  const require = createRequire(import.meta.url);
  const pty = require('node-pty') as NodePtyModule;
  return pty.spawn(options.shell, options.args, {
    name: 'xterm-256color',
    cwd: options.cwd,
    cols: options.cols,
    rows: options.rows,
    env: options.env,
  });
}

/** Picks the user's interactive shell for the current platform. */
function resolveShell(override: string | undefined): { shell: string; args: readonly string[] } {
  if (override !== undefined && override !== '') {
    return { shell: override, args: [] };
  }
  if (process.platform === 'win32') {
    return { shell: process.env.ComSpec ?? 'powershell.exe', args: [] };
  }
  return { shell: process.env.SHELL ?? '/bin/bash', args: [] };
}

/** Falls back to the home directory when the requested folder is not a usable absolute directory. */
function resolveCwd(requested: string | null | undefined): string {
  if (typeof requested === 'string' && isAbsolute(requested) && !requested.includes('\0')) {
    try {
      if (statSync(requested).isDirectory()) {
        return requested;
      }
    } catch {
      // Not accessible; fall through to the home directory.
    }
  }
  return homedir();
}

export interface TerminalHostOptions {
  readonly ipcMain: IpcMain;
  /** Only this Studio origin may control terminals. */
  readonly studioOrigin: string;
  /** Returns the renderer that receives terminal output. */
  readonly getWebContents: () => WebContents | undefined;
  readonly spawn?: PtySpawner;
  /** Overrides the shell; defaults to the platform interactive shell. */
  readonly shell?: string;
  readonly env?: NodeJS.ProcessEnv;
}

export interface TerminalHost {
  /** Kills every live pty but keeps the IPC handlers registered. */
  readonly disposeSessions: () => void;
  /** Kills every live pty and removes the IPC handlers. */
  readonly dispose: () => void;
}

/**
 * Drops `WEAVE_*` variables (the Server's own configuration, which can carry
 * model-provider keys). Other variables belong to the user's shell and stay.
 */
export function createTerminalEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(environment)) {
    if (value !== undefined && !/^WEAVE_/i.test(name)) {
      result[name] = value;
    }
  }
  return result;
}

/**
 * Registers the terminal IPC on the Main process. Terminals are driven by the
 * user, not the Agent, so they do not go through Agent Approval; the boundary
 * is that only the trusted Studio origin can open or control them, and output
 * is sent only to the owning renderer.
 */
export function registerTerminalHost(options: TerminalHostOptions): TerminalHost {
  const spawn = options.spawn ?? defaultSpawner;
  const sessions = new Map<string, PtyProcess>();

  function trusted(event: IpcMainInvokeEvent | IpcMainEvent): boolean {
    return isTrustedSender(event, options.studioOrigin);
  }

  function disposeSessions(): void {
    for (const term of sessions.values()) {
      term.kill();
    }
    sessions.clear();
  }

  function send(channel: string, payload: unknown): void {
    const webContents = options.getWebContents();
    if (webContents !== undefined && !webContents.isDestroyed()) {
      webContents.send(channel, payload);
    }
  }

  function handleCreate(
    event: IpcMainInvokeEvent,
    raw: unknown,
  ): { id: string } | { error: string } {
    if (!trusted(event)) {
      return { error: 'untrusted-origin' };
    }
    const parsed = createRequestSchema.safeParse(raw);
    if (!parsed.success) {
      return { error: 'invalid-request' };
    }
    const id = randomUUID();
    const { shell, args } = resolveShell(options.shell);
    let term: PtyProcess;
    try {
      term = spawn({
        shell,
        args,
        cwd: resolveCwd(parsed.data.cwd),
        cols: parsed.data.cols,
        rows: parsed.data.rows,
        env: {
          ...createTerminalEnvironment(options.env ?? process.env),
          TERM: 'xterm-256color',
        },
      });
    } catch {
      return { error: 'spawn-failed' };
    }
    sessions.set(id, term);
    term.onData((data) => send(terminalChannels.data, { id, data }));
    term.onExit(({ exitCode }) => {
      sessions.delete(id);
      send(terminalChannels.exit, { id, exitCode });
    });
    return { id };
  }

  function handleInput(event: IpcMainEvent, raw: unknown): void {
    if (!trusted(event)) {
      return;
    }
    const parsed = inputSchema.safeParse(raw);
    if (parsed.success) {
      sessions.get(parsed.data.id)?.write(parsed.data.data);
    }
  }

  function handleResize(event: IpcMainEvent, raw: unknown): void {
    if (!trusted(event)) {
      return;
    }
    const parsed = resizeSchema.safeParse(raw);
    if (parsed.success) {
      sessions.get(parsed.data.id)?.resize(parsed.data.cols, parsed.data.rows);
    }
  }

  function handleDispose(event: IpcMainEvent, raw: unknown): void {
    if (!trusted(event)) {
      return;
    }
    const parsed = disposeSchema.safeParse(raw);
    if (!parsed.success) {
      return;
    }
    const term = sessions.get(parsed.data.id);
    if (term !== undefined) {
      term.kill();
      sessions.delete(parsed.data.id);
    }
  }

  options.ipcMain.removeHandler(terminalChannels.create);
  options.ipcMain.handle(terminalChannels.create, handleCreate);
  options.ipcMain.on(terminalChannels.input, handleInput);
  options.ipcMain.on(terminalChannels.resize, handleResize);
  options.ipcMain.on(terminalChannels.dispose, handleDispose);

  return {
    disposeSessions,
    dispose() {
      disposeSessions();
      options.ipcMain.removeHandler(terminalChannels.create);
      options.ipcMain.removeAllListeners(terminalChannels.input);
      options.ipcMain.removeAllListeners(terminalChannels.resize);
      options.ipcMain.removeAllListeners(terminalChannels.dispose);
    },
  };
}
