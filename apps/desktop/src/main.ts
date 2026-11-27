import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { basename, join } from 'node:path';
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  shell,
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
  /** Present when the Server listens beyond loopback (`--host`). */
  readonly accessToken?: string | undefined;
}

/** Where the window loads Studio from, and the only origin the bridge trusts. */
export interface StudioTarget {
  readonly url: string;
  readonly origin: string;
}

/**
 * Picks the page the window loads. `WEAVE_STUDIO_URL` (development) wins;
 * otherwise the window loads the embedded Server, which hosts the built Studio,
 * so the trusted origin is the Server's own loopback origin. A non-loopback
 * `--host` requires the access token, which rides on the first page load and
 * is exchanged for a cookie by the Server.
 */
export function resolveStudioTarget(
  config: DesktopConfig,
  serverUrl: string,
  accessToken?: string,
): StudioTarget {
  if (config.studioUrl !== undefined && config.studioOrigin !== undefined) {
    return { url: config.studioUrl, origin: config.studioOrigin };
  }
  const origin = new URL(serverUrl).origin;
  return {
    url: accessToken === undefined ? `${origin}/` : `${origin}/?token=${accessToken}`,
    origin,
  };
}

/** Built Studio shipped next to the desktop app (`apps/studio/dist`). */
export function getStudioDirectory(): string {
  return fileURLToPath(new URL('../../studio/dist', import.meta.url));
}

/** Describes why the hosted Studio cannot be loaded, or `undefined` when it can. */
export function describeMissingStudio(config: DesktopConfig): string | undefined {
  if (config.studioUrl !== undefined) {
    return undefined;
  }
  if (
    config.studioDirectory === undefined ||
    !existsSync(join(config.studioDirectory, 'index.html'))
  ) {
    return `找不到已构建的 Studio（${config.studioDirectory ?? '未配置目录'}/index.html）。请先运行 pnpm --filter @weave/studio build，或设置 WEAVE_STUDIO_URL 指向开发服务器。`;
  }
  return undefined;
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

/** IPC channel used by the Preload `openDataDirectory()` bridge. */
export const openDataDirectoryChannel = 'weave:open-data-directory';

/** Result of `openDataDirectory()`; `error` is a plain message from the OS. */
export interface OpenDataDirectoryResult {
  readonly ok: boolean;
  readonly error?: string;
}

/**
 * Handles `openDataDirectory()` from the Studio Renderer.
 *
 * Opens the configured data directory in the system file manager. The Renderer
 * supplies no path (any argument is refused), so it cannot open arbitrary locations.
 */
export async function handleOpenDataDirectory(
  event: IpcMainInvokeEvent,
  studioOrigin: string,
  dataDirectory: string,
  ...extraArgs: unknown[]
): Promise<OpenDataDirectoryResult> {
  if (!isTrustedSender(event, studioOrigin)) {
    return { ok: false, error: '不受信任的请求来源' };
  }
  if (extraArgs.length > 0) {
    return { ok: false, error: '该操作不接受参数' };
  }
  try {
    // `shell.openPath` resolves to an empty string on success, otherwise an error message.
    const message = await shell.openPath(dataDirectory);
    return message === '' ? { ok: true } : { ok: false, error: message };
  } catch (error: unknown) {
    return { ok: false, error: getErrorMessage(error) };
  }
}

function registerDesktopIpc(studioOrigin: string, dataDirectory: string): void {
  ipcMain.removeHandler(openDataDirectoryChannel);
  ipcMain.handle(openDataDirectoryChannel, (event, ...args: unknown[]) =>
    handleOpenDataDirectory(event, studioOrigin, dataDirectory, ...args),
  );
  ipcMain.removeHandler(pickDirectoryChannel);
  ipcMain.handle(pickDirectoryChannel, (event, ...pickerArgs: unknown[]) =>
    handlePickDirectory(event, studioOrigin, ...pickerArgs),
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
  options: { readonly target?: StudioTarget; readonly startupError?: unknown } = {},
): BrowserWindow {
  const target = options.target ?? resolveStudioTarget(config, serverUrl);
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
    if (new URL(url).origin !== target.origin) {
      event.preventDefault();
    }
  });
  window.webContents.setWindowOpenHandler(() => {
    // Studio never opens child windows; external links go through the system
    // browser outside this process, so every window.open request is denied.
    return { action: 'deny' };
  });

  if (options.startupError !== undefined) {
    showWindowError(window, options.startupError);
  } else {
    void window.loadURL(target.url).catch((error: unknown) => {
      showWindowError(window, error);
    });
  }

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
  hostStudio = true,
): Promise<{ port: number; stop: () => Promise<void>; accessToken?: string | undefined }> {
  const server = await startServer(0, {
    databaseFile: config.databaseFile,
    dataDirectory: config.userDataDirectory,
    pluginsDirectory: config.pluginsDirectory,
    ...(config.allowInitialManagedPluginBinding
      ? { managedPluginStore: { initialBinding: 'allow-unbound' } }
      : {}),
    // With `WEAVE_STUDIO_URL` the page comes from another origin (Vite); otherwise
    // the Server hosts the built Studio itself and the page is same-origin.
    ...(config.studioOrigin === undefined ? {} : { studioOrigin: config.studioOrigin }),
    ...(hostStudio && config.studioUrl === undefined && config.studioDirectory !== undefined
      ? { studioDirectory: config.studioDirectory }
      : {}),
    ...(config.host === undefined ? {} : { host: config.host }),
    providerSecretCodec,
    fetch: createDesktopFetch(),
  });

  return {
    port: server.port,
    stop: server.stop,
    ...(server.accessToken === undefined ? {} : { accessToken: server.accessToken }),
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
      studioDirectory: getStudioDirectory(),
      argv: process.argv.slice(1),
    });
    const missingStudio = describeMissingStudio(config);
    desktopServer = await startDesktopServer(
      config,
      createElectronProviderSecretCodec(),
      missingStudio === undefined,
    );
    const serverUrl = `http://127.0.0.1:${desktopServer.port}`;
    const target = resolveStudioTarget(config, serverUrl, desktopServer.accessToken);
    registerDesktopIpc(target.origin, config.userDataDirectory);
    const window = createMainWindow(config, serverUrl, getWindowChrome(), {
      target,
      ...(missingStudio === undefined ? {} : { startupError: new Error(missingStudio) }),
    });
    mainWindow = window;
    terminalHost = registerTerminalHost({
      ipcMain,
      studioOrigin: target.origin,
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
