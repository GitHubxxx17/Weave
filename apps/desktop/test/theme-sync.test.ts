import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDesktopConfig } from '../src/desktop-config.js';
import { getDesktopStatePath, readDesktopState } from '../src/desktop-state.js';
import { setThemeChannel, studioBackgroundColors } from '../src/theme.js';

const mocks = vi.hoisted(() => {
  class FakeBrowserWindow {
    static instances: FakeBrowserWindow[] = [];
    readonly webContents = { on: vi.fn(), setWindowOpenHandler: vi.fn() };
    readonly isDestroyed = vi.fn(() => false);
    readonly setBackgroundColor = vi.fn();
    readonly loadURL = vi.fn(async () => undefined);
    readonly on = vi.fn();

    constructor(readonly options: { backgroundColor?: string }) {
      FakeBrowserWindow.instances.push(this);
    }
  }

  return {
    FakeBrowserWindow,
    userDataDirectory: '',
    app: {
      exit: vi.fn(),
      getPath: vi.fn(() => ''),
      isReady: vi.fn(() => true),
      on: vi.fn(),
      setName: vi.fn(),
      quit: vi.fn(),
      requestSingleInstanceLock: vi.fn(() => true),
      whenReady: vi.fn(() => new Promise<void>(() => undefined)),
    },
    dialog: { showErrorBox: vi.fn(), showOpenDialog: vi.fn() },
    ipcMain: {
      handle: vi.fn(),
      on: vi.fn(),
      removeAllListeners: vi.fn(),
      removeHandler: vi.fn(),
    },
    nativeTheme: {
      themeSource: 'system' as 'system' | 'light' | 'dark',
      /** When true the system is light, so `themeSource` alone decides the result. */
      followThemeSource: false,
      systemDark: false,
      get shouldUseDarkColors(): boolean {
        return this.followThemeSource ? this.themeSource === 'dark' : this.systemDark;
      },
      on: vi.fn(),
    },
    safeStorage: { isEncryptionAvailable: vi.fn(() => true) },
    shell: { openPath: vi.fn() },
    startServer: vi.fn(),
  };
});

vi.mock('electron', () => ({
  BrowserWindow: Object.assign(mocks.FakeBrowserWindow, {
    fromWebContents: vi.fn(() => null),
    getAllWindows: vi.fn(() => mocks.FakeBrowserWindow.instances),
  }),
  app: mocks.app,
  dialog: mocks.dialog,
  ipcMain: mocks.ipcMain,
  nativeTheme: mocks.nativeTheme,
  safeStorage: mocks.safeStorage,
  shell: mocks.shell,
}));

vi.mock('@weave/server/main', () => ({ startServer: mocks.startServer }));

const {
  applyStoredTheme,
  applyWindowBackgrounds,
  createMainWindow,
  handleSetTheme,
  startDesktopApplication,
} = await import('../src/main.js');

const origin = 'http://127.0.0.1:46321';

function eventFrom(url: string, isMainFrame = true) {
  const sender = { getURL: () => url, mainFrame: {} as unknown };
  const frame = { url, origin: new URL(url).origin };
  if (isMainFrame) {
    sender.mainFrame = frame;
  }
  return { senderFrame: frame, sender };
}

describe('desktop theme sync', () => {
  let directory: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    directory = await mkdtemp(join(tmpdir(), 'weave-desktop-theme-'));
    mocks.userDataDirectory = directory;
    mocks.app.getPath.mockReturnValue(directory);
    mocks.nativeTheme.themeSource = 'system';
    mocks.nativeTheme.followThemeSource = false;
    mocks.nativeTheme.systemDark = false;
    mocks.FakeBrowserWindow.instances.length = 0;
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  function createWindow() {
    const config = createDesktopConfig({
      userDataDirectory: directory,
      environment: { WEAVE_STUDIO_URL: origin },
    });
    createMainWindow(config, origin, 'native');
    const window = mocks.FakeBrowserWindow.instances.at(-1);
    if (window === undefined) {
      throw new Error('window was not created');
    }
    return window;
  }

  function followThemeSource(): void {
    mocks.nativeTheme.followThemeSource = true;
  }

  it('creates windows with the background of the current native theme', () => {
    expect(createWindow().options.backgroundColor).toBe(studioBackgroundColors.light);
    mocks.nativeTheme.systemDark = true;
    expect(createWindow().options.backgroundColor).toBe(studioBackgroundColors.dark);
  });

  it('sets themeSource, repaints all windows and records the preference', async () => {
    followThemeSource();
    const first = createWindow();
    const second = createWindow();

    await handleSetTheme(eventFrom(`${origin}/`) as never, origin, directory, 'dark');

    expect(mocks.nativeTheme.themeSource).toBe('dark');
    expect(first.setBackgroundColor).toHaveBeenLastCalledWith(studioBackgroundColors.dark);
    expect(second.setBackgroundColor).toHaveBeenLastCalledWith(studioBackgroundColors.dark);
    expect(await readDesktopState(directory)).toEqual({ version: 1, theme: 'dark' });

    await handleSetTheme(eventFrom(`${origin}/`) as never, origin, directory, 'light');
    expect(mocks.nativeTheme.themeSource).toBe('light');
    expect(first.setBackgroundColor).toHaveBeenLastCalledWith(studioBackgroundColors.light);
    expect(await readDesktopState(directory)).toEqual({ version: 1, theme: 'light' });

    await handleSetTheme(eventFrom(`${origin}/`) as never, origin, directory, 'system');
    expect(mocks.nativeTheme.themeSource).toBe('system');
    expect((await readDesktopState(directory)).theme).toBe('system');
  });

  it('keeps the recorded server port when it records the theme', async () => {
    await writeFile(
      getDesktopStatePath(directory),
      JSON.stringify({ version: 1, serverPort: 43210 }),
    );
    await handleSetTheme(eventFrom(`${origin}/`) as never, origin, directory, 'dark');
    expect(await readDesktopState(directory)).toEqual({
      version: 1,
      serverPort: 43210,
      theme: 'dark',
    });
  });

  it('skips destroyed windows when repainting', () => {
    const window = createWindow();
    window.isDestroyed.mockReturnValue(true);
    applyWindowBackgrounds();
    expect(window.setBackgroundColor).not.toHaveBeenCalled();
  });

  it.each([
    ['another origin', eventFrom('http://127.0.0.1:5173/')],
    ['a child frame', eventFrom(`${origin}/`, false)],
    ['no frame', { senderFrame: null, sender: null }],
  ])('ignores a sender that is %s', async (_name, event) => {
    const window = createWindow();
    await handleSetTheme(event as never, origin, directory, 'dark');
    expect(mocks.nativeTheme.themeSource).toBe('system');
    expect(window.setBackgroundColor).not.toHaveBeenCalled();
    await expect(readFile(getDesktopStatePath(directory), 'utf8')).rejects.toThrow();
  });

  it.each([
    ['no argument', []],
    ['an unknown value', ['blue']],
    ['a wrong type', [1]],
    ['an object', [{ theme: 'dark' }]],
    ['extra arguments', ['dark', 'light']],
  ])('ignores %s', async (_name, args) => {
    const window = createWindow();
    await handleSetTheme(eventFrom(`${origin}/`) as never, origin, directory, ...args);
    expect(mocks.nativeTheme.themeSource).toBe('system');
    expect(window.setBackgroundColor).not.toHaveBeenCalled();
    await expect(readFile(getDesktopStatePath(directory), 'utf8')).rejects.toThrow();
  });

  it('still applies the theme when the preference cannot be recorded', async () => {
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    // A file in place of the data directory makes the write fail.
    const blocked = join(directory, 'blocked');
    await writeFile(blocked, '');
    await handleSetTheme(eventFrom(`${origin}/`) as never, origin, blocked, 'dark');
    expect(mocks.nativeTheme.themeSource).toBe('dark');
    expect(errorLog).toHaveBeenCalled();
    errorLog.mockRestore();
  });

  it('applies the recorded preference at startup and defaults to the system', async () => {
    await applyStoredTheme(directory);
    expect(mocks.nativeTheme.themeSource).toBe('system');

    await writeFile(getDesktopStatePath(directory), JSON.stringify({ version: 1, theme: 'dark' }));
    await applyStoredTheme(directory);
    expect(mocks.nativeTheme.themeSource).toBe('dark');

    await writeFile(getDesktopStatePath(directory), '{broken');
    mocks.nativeTheme.themeSource = 'dark';
    await applyStoredTheme(directory);
    expect(mocks.nativeTheme.themeSource).toBe('system');
  });

  it('starts with the recorded theme, a matching window background and an updated listener', async () => {
    followThemeSource();
    await writeFile(getDesktopStatePath(directory), JSON.stringify({ version: 1, theme: 'dark' }));
    vi.stubEnv('WEAVE_STUDIO_URL', origin);
    mocks.startServer.mockResolvedValueOnce({ port: 46321, stop: vi.fn() });

    try {
      await startDesktopApplication();
    } finally {
      vi.unstubAllEnvs();
    }

    expect(mocks.nativeTheme.themeSource).toBe('dark');
    expect(mocks.FakeBrowserWindow.instances).toHaveLength(1);
    expect(mocks.FakeBrowserWindow.instances[0]?.options.backgroundColor).toBe(
      studioBackgroundColors.dark,
    );
    expect(mocks.ipcMain.on).toHaveBeenCalledWith(setThemeChannel, expect.any(Function));
    expect(mocks.nativeTheme.on).toHaveBeenCalledWith('updated', applyWindowBackgrounds);
  });

  it('repaints windows when the system theme changes while following the system', () => {
    const window = createWindow();
    expect(window.options.backgroundColor).toBe(studioBackgroundColors.light);

    mocks.nativeTheme.systemDark = true;
    applyWindowBackgrounds();
    expect(window.setBackgroundColor).toHaveBeenLastCalledWith(studioBackgroundColors.dark);

    mocks.nativeTheme.systemDark = false;
    applyWindowBackgrounds();
    expect(window.setBackgroundColor).toHaveBeenLastCalledWith(studioBackgroundColors.light);
  });

  it('routes the IPC channel through the sender check', async () => {
    mocks.startServer.mockResolvedValueOnce({ port: 46321, stop: vi.fn() });
    vi.stubEnv('WEAVE_STUDIO_URL', origin);
    try {
      await startDesktopApplication();
    } finally {
      vi.unstubAllEnvs();
    }
    const registered = mocks.ipcMain.on.mock.calls.find(([channel]) => channel === setThemeChannel);
    const listener = registered?.[1] as (event: unknown, ...args: unknown[]) => void;
    expect(mocks.ipcMain.removeAllListeners).toHaveBeenCalledWith(setThemeChannel);

    listener(eventFrom('http://127.0.0.1:5173/'), 'dark');
    expect(mocks.nativeTheme.themeSource).toBe('system');
    listener(eventFrom(`${origin}/`), 'dark');
    expect(mocks.nativeTheme.themeSource).toBe('dark');
  });
});

describe('window background colors', () => {
  const css = readFileSync(new URL('../../studio/src/app/app.css', import.meta.url), 'utf8');

  /** Reads `--app-bg` from the first rule whose selector is exactly `selector`. */
  function readAppBackground(selector: string): string | undefined {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const rule = new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`).exec(css);
    return /--app-bg:\s*(#[0-9a-fA-F]{6})\s*;/.exec(rule?.[1] ?? '')?.[1]?.toLowerCase();
  }

  it('equal the --app-bg values in Studio app.css', () => {
    expect(readAppBackground(':root')).toBe(studioBackgroundColors.light);
    expect(readAppBackground(":root[data-theme='dark']")).toBe(studioBackgroundColors.dark);
  });
});
