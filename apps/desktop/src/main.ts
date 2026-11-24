import { fileURLToPath } from 'node:url';
import { basename } from 'node:path';
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  type BrowserWindowConstructorOptions,
  type IpcMainInvokeEvent,
  type OpenDialogOptions,
} from 'electron';
import { startServer } from '@weave/server/main';
import { z } from 'zod';
import { createDesktopConfig, type DesktopConfig } from './desktop-config.js';
import { createElectronProviderSecretCodec } from './provider-secret-codec.js';
import { isTrustedSender } from './sender-origin.js';
import { registerTerminalHost, type TerminalHost } from './terminal.js';
import type { ProviderSecretCodec } from '@weave/server';

interface DesktopServer {
  readonly port: number;
  readonly stop: () => Promise<void>;
}

const serverUrlArgumentPrefix = '--weave-server-url=';
const windowChromeArgumentPrefix = '--weave-window-chrome=';

/** Matches the Studio page background so the window never flashes white. */
const studioBackgroundColor = '#f7f8fc';

/**
 * How the desktop window draws its title bar. The Renderer reads the value
 * from the Preload bridge and adapts its layout (drag regions, traffic lights).
 */
export type WindowChrome = 'hidden-inset' | 'native';

/** macOS hides the system title bar; other platforms keep the native frame. */
export function getWindowChrome(platform: NodeJS.Platform = process.platform): WindowChrome {
  return platform === 'darwin' ? 'hidden-inset' : 'native';
}

function getWindowChromeOptions(chrome: WindowChrome): BrowserWindowConstructorOptions {
  if (chrome === 'native') {
    return {};
  }
  // Traffic lights sit in the top band of Studio's 76px navigation column.
  return { titleBarStyle: 'hidden', trafficLightPosition: { x: 12, y: 16 } };
}

app.setName('Weave');

function getPreloadPath(): string {
  return fileURLToPath(new URL('./preload.cjs', import.meta.url));
}

function getServerUrlArgument(serverUrl: string): string {
  return `${serverUrlArgumentPrefix}${encodeURIComponent(serverUrl)}`;
}

/** Returns the standard Fetch implementation used by the desktop Server. */
export function createDesktopFetch(): typeof globalThis.fetch {
  return (input, init) => globalThis.fetch(input, init);
}

/** IPC channel used by the Preload `pickDirectory()` bridge. */
export const pickDirectoryChannel = 'weave:pick-directory';
const pickerArgsSchema = z.union([z.tuple([]), z.tuple([z.enum(['project', 'plugin-import'])])]);

/** A folder the user explicitly chose in the system dialog. */
export interface PickedDirectory {
  readonly path: string;
  readonly name: string;
}

/**
 * Handles `pickDirectory()` from the Studio Renderer.
 *
 * Only the trusted Studio origin may open the dialog, and the Renderer only
 * receives the folder the user chose; it gains no other filesystem access.
 */
export async function handlePickDirectory(
  event: IpcMainInvokeEvent,
  studioOrigin: string,
  ...pickerArgs: unknown[]
): Promise<PickedDirectory | null> {
  if (!isTrustedSender(event, studioOrigin)) {
    return null;
  }
  const parsed = pickerArgsSchema.safeParse(pickerArgs);
  if (!parsed.success) {
    return null;
  }
  const isPluginImport = parsed.data[0] === 'plugin-import';
  const options: OpenDialogOptions = isPluginImport
    ? { title: '选择已打包的插件文件夹', properties: ['openDirectory'] }
    : { title: '选择项目文件夹', properties: ['openDirectory', 'createDirectory'] };
  const window = BrowserWindow.fromWebContents(event.sender);
  const result =
    window === null
      ? await dialog.showOpenDialog(options)
      : await dialog.showOpenDialog(window, options);
  const folderPath = result.filePaths[0];
  if (result.canceled || folderPath === undefined) {
    return null;
  }
  const folderName = basename(folderPath);
  return { path: folderPath, name: isPluginImport ? folderName || folderPath : folderName };
}

function registerDesktopIpc(config: DesktopConfig): void {
  ipcMain.removeHandler(pickDirectoryChannel);
  ipcMain.handle(pickDirectoryChannel, (event, ...pickerArgs: unknown[]) =>
    handlePickDirectory(event, config.studioOrigin, ...pickerArgs),
  );
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/** Renders the startup error page; title and message are HTML-escaped. */
export function renderStartupError(rawTitle: string, error: unknown): string {
  const title = escapeHtml(rawTitle);
  const message = escapeHtml(getErrorMessage(error));
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${title}</title>
    <style>
      body { margin: 0; padding: 32px; color: #202124; background: #f8f9fa; font: 16px/1.5 system-ui, sans-serif; }
      main { max-width: 720px; margin: 0 auto; padding: 28px; background: white; border: 1px solid #dadce0; border-radius: 8px; }
      h1 { margin-top: 0; font-size: 24px; }
      pre { overflow-wrap: anywhere; white-space: pre-wrap; padding: 12px; background: #f1f3f4; border-radius: 4px; }
    </style>
  </head>
  <body>
    <main>
      <h1>${title}</h1>
      <p>Weave Desktop could not load the Studio interface.</p>
      <pre>${message}</pre>
      <p>Check the local Studio URL and restart the application.</p>
    </main>
  </body>
</html>`;
}

function showWindowError(window: BrowserWindow, error: unknown): void {
  if (window.isDestroyed()) {
    return;
  }

  const errorPage = `data:text/html;charset=utf-8,${encodeURIComponent(
    renderStartupError('Weave Desktop Startup Error', error),
  )}`;
  void window.loadURL(errorPage).catch((loadError: unknown) => {
    console.error(
      'Weave Desktop could not render the startup error page:',
      getErrorMessage(loadError),
    );
  });
}

export function createMainWindow(
  config: DesktopConfig,
  serverUrl: string,
  chrome: WindowChrome = getWindowChrome(),
): BrowserWindow {
  const window = new BrowserWindow({
    backgroundColor: studioBackgroundColor,
    ...getWindowChromeOptions(chrome),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: getPreloadPath(),
      additionalArguments: [
        getServerUrlArgument(serverUrl),
        `${windowChromeArgumentPrefix}${chrome}`,
      ],
    },
  });

  window.webContents.on('will-navigate', (event, url) => {
    if (new URL(url).origin !== config.studioOrigin) {
      event.preventDefault();
    }
  });
  window.webContents.setWindowOpenHandler(() => {
    // Studio never opens child windows; external links go through the system
    // browser outside this process, so every window.open request is denied.
    return { action: 'deny' };
  });

  void window.loadURL(config.studioUrl).catch((error: unknown) => {
    showWindowError(window, error);
  });

  return window;
}

/**
 * Reacts to the Renderer losing its page state. A main-frame navigation or
 * reload orphans any pty the old page created, and a crashed Renderer cannot
 * ask for them to be disposed, so both call `onRendererReset`.
 */
export function watchRendererLifecycle(window: BrowserWindow, onRendererReset: () => void): void {
  window.webContents.on('did-start-navigation', (details: unknown) => {
    const { isMainFrame, isSameDocument } = details as {
      isMainFrame?: boolean;
      isSameDocument?: boolean;
    };
    if (isMainFrame === true && isSameDocument !== true) {
      onRendererReset();
    }
  });
  window.webContents.on('render-process-gone', (_event: unknown, details: unknown) => {
    const { reason, exitCode } = details as { reason?: string; exitCode?: number };
    onRendererReset();
    console.error(
      `Weave Desktop renderer process gone: ${reason ?? 'unknown'} (${exitCode ?? '?'})`,
    );
    showWindowError(
      window,
      new Error(`Studio 渲染进程已退出（${reason ?? 'unknown'}），请重启应用。`),
    );
  });
}

/**
 * Enforces a single running instance. Returns false when another instance
 * holds the lock; a second launch focuses the existing window instead.
 */
export function registerSingleInstance(getWindow: () => BrowserWindow | undefined): boolean {
  if (!app.requestSingleInstanceLock()) {
    return false;
  }
  app.on('second-instance', () => {
    const window = getWindow();
    if (window === undefined || window.isDestroyed()) {
      return;
    }
    if (window.isMinimized()) {
      window.restore();
    }
    window.focus();
  });
  return true;
}

export async function startDesktopServer(
  config: DesktopConfig,
  providerSecretCodec: ProviderSecretCodec,
): Promise<{ port: number; stop: () => Promise<void> }> {
  const server = await startServer(0, {
    databaseFile: config.databaseFile,
    dataDirectory: config.userDataDirectory,
    pluginsDirectory: config.pluginsDirectory,
    ...(config.allowInitialManagedPluginBinding
      ? { managedPluginStore: { initialBinding: 'allow-unbound' } }
      : {}),
    studioOrigin: config.studioOrigin,
    providerSecretCodec,
    fetch: createDesktopFetch(),
  });

  return {
    port: server.port,
    stop: server.stop,
  };
}

let desktopServer: DesktopServer | undefined;
let terminalHost: TerminalHost | undefined;
let mainWindow: BrowserWindow | undefined;
let stopPromise: Promise<void> | undefined;
let isQuitting = false;

async function stopDesktopServer(): Promise<void> {
  if (stopPromise !== undefined) {
    return stopPromise;
  }

  stopPromise = (async () => {
    terminalHost?.dispose();
    terminalHost = undefined;
    const server = desktopServer;
    desktopServer = undefined;
    if (server !== undefined) {
      await server.stop();
    }
  })();

  return stopPromise;
}

function quitAfterStopping(): void {
  if (isQuitting) {
    return;
  }

  isQuitting = true;
  void stopDesktopServer()
    .catch((error: unknown) => {
      console.error('Weave Desktop could not stop the local Server:', getErrorMessage(error));
    })
    .finally(() => {
      app.quit();
    });
}

export async function startDesktopApplication(): Promise<void> {
  try {
    const config = createDesktopConfig({
      userDataDirectory: app.getPath('userData'),
      environment: process.env,
    });
    desktopServer = await startDesktopServer(config, createElectronProviderSecretCodec());
    registerDesktopIpc(config);
    const window = createMainWindow(config, `http://127.0.0.1:${desktopServer.port}`);
    mainWindow = window;
    terminalHost = registerTerminalHost({
      ipcMain,
      studioOrigin: config.studioOrigin,
      getWebContents: () => (window.isDestroyed() ? undefined : window.webContents),
    });
    watchRendererLifecycle(window, () => terminalHost?.disposeSessions());
    window.on('closed', () => {
      mainWindow = undefined;
      terminalHost?.dispose();
      terminalHost = undefined;
    });
  } catch (error: unknown) {
    await stopDesktopServer().catch((cleanupError: unknown) => {
      console.error(
        'Weave Desktop cleanup failed after startup error:',
        getErrorMessage(cleanupError),
      );
    });
    console.error('Weave Desktop failed to start:', getErrorMessage(error));
    if (!app.isReady()) {
      app.exit(1);
      return;
    }
    dialog.showErrorBox('Weave Desktop 启动失败', getErrorMessage(error));
    app.exit(1);
  }
}

app.on('window-all-closed', () => {
  quitAfterStopping();
});

app.on('before-quit', (event) => {
  if (desktopServer !== undefined && !isQuitting) {
    event.preventDefault();
    quitAfterStopping();
  }
});

if (!registerSingleInstance(() => mainWindow)) {
  app.exit(0);
} else {
  void app
    .whenReady()
    .then(startDesktopApplication)
    .catch((error: unknown) => {
      console.error('Weave Desktop could not initialize Electron:', getErrorMessage(error));
      app.exit(1);
    });
}
