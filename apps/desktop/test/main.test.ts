import { readFileSync } from 'node:fs';
import { parse } from 'node:path';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createDesktopConfig } from '../src/desktop-config.js';

const mocks = vi.hoisted(() => {
  class FakeBrowserWindow {
    static instances: FakeBrowserWindow[] = [];
    readonly webContents = {
      on: vi.fn(),
      setWindowOpenHandler: vi.fn(),
    };
    readonly isDestroyed = vi.fn(() => false);
    readonly loadURL = vi.fn(async () => undefined);

    constructor(readonly options: unknown) {
      FakeBrowserWindow.instances.push(this);
    }
  }

  return {
    safeStorage: {
      isEncryptionAvailable: vi.fn(() => true),
      encryptString: vi.fn(),
      decryptString: vi.fn(),
    },
    app: {
      exit: vi.fn(),
      getPath: vi.fn(() => '/tmp/weave-user-data'),
      isReady: vi.fn(() => true),
      on: vi.fn(),
      setName: vi.fn(),
      quit: vi.fn(),
      whenReady: vi.fn(() => new Promise<void>(() => undefined)),
    },
    dialog: {
      showErrorBox: vi.fn(),
      showOpenDialog: vi.fn(),
    },
    ipcMain: {
      handle: vi.fn(),
      removeHandler: vi.fn(),
    },
    FakeBrowserWindow,
    startServer: vi.fn(),
  };
});

vi.mock('electron', () => ({
  BrowserWindow: Object.assign(mocks.FakeBrowserWindow, { fromWebContents: vi.fn(() => null) }),
  app: mocks.app,
  dialog: mocks.dialog,
  ipcMain: mocks.ipcMain,
  safeStorage: mocks.safeStorage,
}));

vi.mock('@weave/server/main', () => ({
  startServer: mocks.startServer,
}));

const {
  createDesktopFetch,
  createMainWindow,
  getWindowChrome,
  handlePickDirectory,
  startDesktopApplication,
  startDesktopServer,
} = await import('../src/main.js');

const config = createDesktopConfig({
  userDataDirectory: '/tmp/weave-user-data',
  environment: {},
});

const providerSecretCodec = {
  isAvailable: vi.fn(() => true),
  encrypt: vi.fn((value: string) => value),
  decrypt: vi.fn((value: string) => value),
};

describe('desktop main process', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.FakeBrowserWindow.instances.length = 0;
  });

  it('starts the Server with the default desktop plugin directory and first binding enabled', async () => {
    const stop = vi.fn(async () => undefined);
    mocks.startServer.mockResolvedValueOnce({ port: 46321, stop });

    const result = await startDesktopServer(config, providerSecretCodec);

    expect(mocks.startServer).toHaveBeenCalledWith(0, {
      databaseFile: config.databaseFile,
      dataDirectory: config.userDataDirectory,
      pluginsDirectory: '/tmp/weave-user-data/plugins',
      managedPluginStore: { initialBinding: 'allow-unbound' },
      studioOrigin: config.studioOrigin,
      providerSecretCodec,
      fetch: expect.any(Function),
    });
    expect(result.port).toBe(46321);
    expect(result.stop).toBe(stop);
  });

  it.each(['/tmp/custom-plugins', './custom/../plugins', ''])(
    'passes the plugin directory override %j verbatim without enabling first binding',
    async (override) => {
      const configWithOverride = createDesktopConfig({
        userDataDirectory: config.userDataDirectory,
        environment: { WEAVE_PLUGINS_DIR: override },
      });
      mocks.startServer.mockResolvedValueOnce({ port: 46321, stop: vi.fn() });

      await startDesktopServer(configWithOverride, providerSecretCodec);

      expect(mocks.startServer).toHaveBeenCalledWith(0, {
        databaseFile: config.databaseFile,
        dataDirectory: config.userDataDirectory,
        pluginsDirectory: override,
        studioOrigin: config.studioOrigin,
        providerSecretCodec,
        fetch: expect.any(Function),
      });
      expect(mocks.startServer.mock.lastCall?.[1]).not.toHaveProperty('managedPluginStore');
    },
  );

  it('uses the standard Node Fetch contract for provider requests', async () => {
    const response = new Response('ok');
    const originalFetch = globalThis.fetch;
    const fetchMock = vi.fn<typeof fetch>(async () => response);
    vi.stubGlobal('fetch', fetchMock);

    try {
      await expect(createDesktopFetch()('https://api.deepseek.com')).resolves.toBe(response);
      expect(fetchMock).toHaveBeenCalledWith('https://api.deepseek.com', undefined);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('creates a hardened BrowserWindow and blocks external navigation', () => {
    const window = createMainWindow(config, 'http://127.0.0.1:46321', 'native');
    const instance = mocks.FakeBrowserWindow.instances[0];

    expect(window).toBe(instance);
    expect(instance?.options).toMatchObject({
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        preload: expect.stringMatching(/preload\.cjs$/),
        additionalArguments: [
          '--weave-server-url=http%3A%2F%2F127.0.0.1%3A46321',
          '--weave-window-chrome=native',
        ],
      },
    });
    expect(instance?.options).not.toHaveProperty('titleBarStyle');
    expect(instance?.loadURL).toHaveBeenCalledWith(config.studioUrl);

    const navigateHandler = instance?.webContents.on.mock.calls.find(
      ([eventName]) => eventName === 'will-navigate',
    )?.[1] as ((event: { preventDefault: () => void }, url: string) => void) | undefined;
    const preventDefault = vi.fn();
    navigateHandler?.({ preventDefault }, 'https://untrusted.example');

    expect(preventDefault).toHaveBeenCalledOnce();
    expect(instance?.webContents.setWindowOpenHandler).toHaveBeenCalledWith(expect.any(Function));
    const openHandler = instance?.webContents.setWindowOpenHandler.mock.calls[0]?.[0] as
      ((details: { url: string }) => { action: string }) | undefined;
    expect(openHandler?.({ url: 'http://127.0.0.1:5173/help' })).toEqual({ action: 'deny' });
  });

  it('hides the macOS title bar and tells the Renderer about it', () => {
    expect(getWindowChrome('darwin')).toBe('hidden-inset');
    expect(getWindowChrome('win32')).toBe('native');
    expect(getWindowChrome('linux')).toBe('native');

    createMainWindow(config, 'http://127.0.0.1:46321', 'hidden-inset');
    const instance = mocks.FakeBrowserWindow.instances[0];

    expect(instance?.options).toMatchObject({
      backgroundColor: expect.stringMatching(/^#[0-9a-f]{6}$/),
      titleBarStyle: 'hidden',
      trafficLightPosition: { x: expect.any(Number), y: expect.any(Number) },
      webPreferences: {
        additionalArguments: [
          '--weave-server-url=http%3A%2F%2F127.0.0.1%3A46321',
          '--weave-window-chrome=hidden-inset',
        ],
      },
    });
  });

  it('shows a user-visible error when the Server cannot start', async () => {
    mocks.startServer.mockRejectedValueOnce(new Error('SQLite 初始化失败'));

    await startDesktopApplication();

    expect(mocks.dialog.showErrorBox).toHaveBeenCalledWith(
      'Weave Desktop 启动失败',
      'SQLite 初始化失败',
    );
    expect(mocks.app.exit).toHaveBeenCalledWith(1);
  });

  it('shows the Server error for an empty plugin directory override before opening a window', async () => {
    const serverError = 'pluginsDirectory must not be empty';
    vi.stubEnv('WEAVE_PLUGINS_DIR', '');
    vi.stubEnv('WEAVE_STUDIO_URL', undefined);
    mocks.startServer.mockRejectedValueOnce(new Error(serverError));

    try {
      await startDesktopApplication();
    } finally {
      vi.unstubAllEnvs();
    }

    expect(mocks.startServer).toHaveBeenCalledWith(0, {
      databaseFile: config.databaseFile,
      dataDirectory: config.userDataDirectory,
      pluginsDirectory: '',
      studioOrigin: config.studioOrigin,
      providerSecretCodec: expect.any(Object),
      fetch: expect.any(Function),
    });
    expect(mocks.dialog.showErrorBox).toHaveBeenCalledWith('Weave Desktop 启动失败', serverError);
    expect(mocks.app.exit).toHaveBeenCalledWith(1);
    expect(mocks.FakeBrowserWindow.instances).toHaveLength(0);
  });
});

describe('desktop folder picker IPC', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function invokeEvent(url: string) {
    return { senderFrame: { url }, sender: {} } as never;
  }

  it.each([{ args: [] }, { args: ['project'] }])(
    'opens the existing project dialog for $args',
    async ({ args }) => {
      mocks.dialog.showOpenDialog.mockResolvedValue({
        canceled: false,
        filePaths: ['/Users/mi/projects/demo'],
      });

      await expect(
        handlePickDirectory(invokeEvent('http://127.0.0.1:5173/'), config.studioOrigin, ...args),
      ).resolves.toEqual({ path: '/Users/mi/projects/demo', name: 'demo' });
      expect(mocks.dialog.showOpenDialog).toHaveBeenCalledWith({
        title: '选择项目文件夹',
        properties: ['openDirectory', 'createDirectory'],
      });
    },
  );

  it('opens an existing-directory dialog for plugins and returns a name for a filesystem root', async () => {
    const root = parse(process.cwd()).root;
    mocks.dialog.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [root] });

    await expect(
      handlePickDirectory(
        invokeEvent('http://127.0.0.1:5173/'),
        config.studioOrigin,
        'plugin-import',
      ),
    ).resolves.toEqual({ path: root, name: root });
    expect(mocks.dialog.showOpenDialog).toHaveBeenCalledWith({
      title: '选择已打包的插件文件夹',
      properties: ['openDirectory'],
    });
  });

  it('returns null when the user cancels', async () => {
    mocks.dialog.showOpenDialog.mockResolvedValue({ canceled: true, filePaths: [] });

    await expect(
      handlePickDirectory(
        invokeEvent('http://127.0.0.1:5173/'),
        config.studioOrigin,
        'plugin-import',
      ),
    ).resolves.toBeNull();
  });

  it('ignores requests from an untrusted origin without opening a dialog', async () => {
    await expect(
      handlePickDirectory(
        invokeEvent('https://evil.example/'),
        config.studioOrigin,
        'plugin-import',
      ),
    ).resolves.toBeNull();
    await expect(handlePickDirectory(invokeEvent('not a url'), config.studioOrigin)).resolves.toBe(
      null,
    );
    expect(mocks.dialog.showOpenDialog).not.toHaveBeenCalled();
  });

  it.each([
    { args: ['other'] },
    { args: [undefined] },
    { args: [{}] },
    { args: ['plugin-import', {}] },
  ])('rejects invalid picker arguments $args without opening a dialog', async ({ args }) => {
    mocks.dialog.showOpenDialog.mockResolvedValue({
      canceled: false,
      filePaths: ['/Users/mi/projects/demo'],
    });

    await expect(
      handlePickDirectory(invokeEvent('http://127.0.0.1:5173/'), config.studioOrigin, ...args),
    ).resolves.toBeNull();
    expect(mocks.dialog.showOpenDialog).not.toHaveBeenCalled();
  });
});

describe('desktop folder picker preload', () => {
  it('advertises plugin picker support and preserves zero IPC arguments for existing project callers', async () => {
    const contextBridge = { exposeInMainWorld: vi.fn<(name: string, bridge: unknown) => void>() };
    const ipcRenderer = {
      invoke: vi.fn<(...args: string[]) => Promise<null>>().mockResolvedValue(null),
    };
    const source = readFileSync(new URL('../src/preload.cts', import.meta.url), 'utf8');
    const { outputText } = ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
      fileName: 'preload.cts',
    });
    runInNewContext(outputText, {
      exports: {},
      require: (specifier: string) => {
        if (specifier !== 'electron') throw new Error(`Unexpected preload import ${specifier}`);
        return { contextBridge, ipcRenderer };
      },
      process: { argv: ['--weave-server-url=http%3A%2F%2F127.0.0.1%3A46321'] },
    });

    expect(contextBridge.exposeInMainWorld).toHaveBeenCalledWith(
      'weaveDesktop',
      expect.objectContaining({ pluginDirectoryPicker: true }),
    );
    const bridge = contextBridge.exposeInMainWorld.mock.calls[0]?.[1] as {
      pickDirectory: (purpose?: 'project' | 'plugin-import') => Promise<unknown>;
    };
    await bridge.pickDirectory();
    await bridge.pickDirectory('project');
    await bridge.pickDirectory('plugin-import');
    expect(ipcRenderer.invoke.mock.calls).toEqual([
      ['weave:pick-directory'],
      ['weave:pick-directory', 'project'],
      ['weave:pick-directory', 'plugin-import'],
    ]);
  });
});
