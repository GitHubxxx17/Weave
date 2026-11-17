import { fileURLToPath } from 'node:url';
import { app, BrowserWindow, dialog } from 'electron';
import { startServer } from '@weave/server/main';
import { createDesktopConfig, type DesktopConfig } from './desktop-config.js';
import { createElectronProviderSecretCodec } from './provider-secret-codec.js';
import type { ProviderSecretCodec } from '@weave/server';

interface DesktopServer {
  readonly port: number;
  readonly stop: () => Promise<void>;
}

const serverUrlArgumentPrefix = '--weave-server-url=';

app.setName('Weave');

function getPreloadPath(): string {
  return fileURLToPath(new URL('./preload.cjs', import.meta.url));
}

function getServerUrlArgument(serverUrl: string): string {
  return `${serverUrlArgumentPrefix}${encodeURIComponent(serverUrl)}`;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function renderStartupError(title: string, error: unknown): string {
  const message = getErrorMessage(error);
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

export function createMainWindow(config: DesktopConfig, serverUrl: string): BrowserWindow {
  const window = new BrowserWindow({
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: getPreloadPath(),
      additionalArguments: [getServerUrlArgument(serverUrl)],
    },
  });

  window.webContents.on('will-navigate', (event, url) => {
    if (new URL(url).origin !== config.studioOrigin) {
      event.preventDefault();
    }
  });
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (new URL(url).origin !== config.studioOrigin) {
      return { action: 'deny' };
    }
    return { action: 'deny' };
  });

  void window.loadURL(config.studioUrl).catch((error: unknown) => {
    showWindowError(window, error);
  });

  return window;
}

export async function startDesktopServer(
  config: DesktopConfig,
  providerSecretCodec: ProviderSecretCodec,
): Promise<{ port: number; stop: () => Promise<void> }> {
  const server = await startServer(0, {
    databaseFile: config.databaseFile,
    studioOrigin: config.studioOrigin,
    providerSecretCodec,
  });

  return {
    port: server.port,
    stop: server.stop,
  };
}

let desktopServer: DesktopServer | undefined;
let stopPromise: Promise<void> | undefined;
let isQuitting = false;

async function stopDesktopServer(): Promise<void> {
  if (stopPromise !== undefined) {
    return stopPromise;
  }

  stopPromise = (async () => {
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
    createMainWindow(config, `http://127.0.0.1:${desktopServer.port}`);
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

void app
  .whenReady()
  .then(startDesktopApplication)
  .catch((error: unknown) => {
    console.error('Weave Desktop could not initialize Electron:', getErrorMessage(error));
    app.exit(1);
  });
