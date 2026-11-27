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
      requestSingleInstanceLock: vi.fn(() => true),
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
    shell: { openPath: vi.fn() },
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
  shell: mocks.shell,
}));

vi.mock('@weave/server/main', () => ({
  startServer: mocks.startServer,
}));

const {
  createDesktopFetch,
  createMainWindow,
  describeMissingStudio,
  getWindowChrome,
  handleOpenDataDirectory,
  handlePickDirectory,
  registerSingleInstance,
  renderStartupError,
  resolveStudioTarget,
  startDesktopApplication,
  startDesktopServer,
  watchRendererLifecycle,
} = await import('../src/main.js');

// Development shape: the window loads the Vite server named by WEAVE_STUDIO_URL.
const config = createDesktopConfig({
  userDataDirectory: '/tmp/weave-user-data',
  environment: { WEAVE_STUDIO_URL: 'http://127.0.0.1:5173' },
});

// Default shape: the embedded Server hosts the built Studio.
const hostedConfig = createDesktopConfig({
  userDataDirectory: '/tmp/weave-user-data',
  studioDirectory: '/app/studio/dist',
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
        environment: {
          WEAVE_PLUGINS_DIR: override,
          WEAVE_STUDIO_URL: 'http://127.0.0.1:5173',
        },
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

  it('hosts Studio from the embedded Server and trusts only its origin', async () => {
    mocks.startServer.mockResolvedValueOnce({ port: 46321, stop: vi.fn() });
    await startDesktopServer(hostedConfig, providerSecretCodec);
    const options = mocks.startServer.mock.lastCall?.[1];
    expect(options).toMatchObject({ studioDirectory: '/app/studio/dist' });
    expect(options).not.toHaveProperty('studioOrigin');
    expect(options).not.toHaveProperty('host');

    const target = resolveStudioTarget(hostedConfig, 'http://127.0.0.1:46321');
    expect(target).toEqual({ url: 'http://127.0.0.1:46321/', origin: 'http://127.0.0.1:46321' });

    createMainWindow(hostedConfig, 'http://127.0.0.1:46321', 'native');
    const instance = mocks.FakeBrowserWindow.instances[0];
    expect(instance?.loadURL).toHaveBeenCalledWith('http://127.0.0.1:46321/');
    const navigate = instance?.webContents.on.mock.calls.find(
      ([name]) => name === 'will-navigate',
    )?.[1] as ((event: { preventDefault: () => void }, url: string) => void) | undefined;
    const allowed = vi.fn();
    navigate?.({ preventDefault: allowed }, 'http://127.0.0.1:46321/projects');
    expect(allowed).not.toHaveBeenCalled();
    const blocked = vi.fn();
    navigate?.({ preventDefault: blocked }, 'http://127.0.0.1:5173/');
    expect(blocked).toHaveBeenCalledOnce();
  });

  it('passes --host to the Server and loads the page with the access token', async () => {
    const hostConfig = createDesktopConfig({
      userDataDirectory: '/tmp/weave-user-data',
      studioDirectory: '/app/studio/dist',
      argv: ['--host', '0.0.0.0'],
      environment: {},
    });
    mocks.startServer.mockResolvedValueOnce({ port: 46321, stop: vi.fn(), accessToken: 'tok' });

    const server = await startDesktopServer(hostConfig, providerSecretCodec);

    expect(mocks.startServer.mock.lastCall?.[1]).toMatchObject({ host: '0.0.0.0' });
    expect(server.accessToken).toBe('tok');
    expect(resolveStudioTarget(hostConfig, 'http://127.0.0.1:46321', 'tok')).toEqual({
      url: 'http://127.0.0.1:46321/?token=tok',
      origin: 'http://127.0.0.1:46321',
    });
  });

  it('keeps WEAVE_STUDIO_URL as the page and trusted origin for development', () => {
    expect(resolveStudioTarget(config, 'http://127.0.0.1:46321')).toEqual({
      url: 'http://127.0.0.1:5173',
      origin: 'http://127.0.0.1:5173',
    });
  });

  it('reports a missing Studio build and renders an error page instead of loading', () => {
    expect(describeMissingStudio(config)).toBeUndefined();
    const message = describeMissingStudio(hostedConfig);
    expect(message).toContain('/app/studio/dist');

    createMainWindow(hostedConfig, 'http://127.0.0.1:46321', 'native', {
      startupError: new Error(message),
    });
    const instance = mocks.FakeBrowserWindow.instances[0];
    expect(instance?.loadURL).toHaveBeenCalledOnce();
    expect(instance?.loadURL).toHaveBeenCalledWith(expect.stringMatching(/^data:text\/html/));
    expect(instance?.loadURL).not.toHaveBeenCalledWith('http://127.0.0.1:46321/');
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
    vi.stubEnv('WEAVE_STUDIO_URL', 'http://127.0.0.1:5173');
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

describe('desktop window hardening', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.FakeBrowserWindow.instances.length = 0;
  });

  it('escapes the title and message in the startup error page', () => {
    const html = renderStartupError('<b>t</b>', new Error('<script>alert(1)</script>&"\''));

    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<b>t</b>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;&amp;&quot;&#39;');
    expect(html).toContain('&lt;b&gt;t&lt;/b&gt;');
  });

  function webContentsHandlers(window: InstanceType<typeof mocks.FakeBrowserWindow>) {
    const find = (name: string) =>
      window.webContents.on.mock.calls.find(([eventName]) => eventName === name)?.[1] as
        ((...args: unknown[]) => void) | undefined;
    return { navigation: find('did-start-navigation'), gone: find('render-process-gone') };
  }

  it('resets terminals on main-frame navigation but not on same-document or subframe navigation', () => {
    const window = createMainWindow(config, 'http://127.0.0.1:46321', 'native');
    const reset = vi.fn();
    watchRendererLifecycle(window, reset);
    const { navigation } = webContentsHandlers(
      window as unknown as InstanceType<typeof mocks.FakeBrowserWindow>,
    );

    navigation?.({ isMainFrame: false, isSameDocument: false });
    navigation?.({ isMainFrame: true, isSameDocument: true });
    expect(reset).not.toHaveBeenCalled();

    navigation?.({ isMainFrame: true, isSameDocument: false });
    expect(reset).toHaveBeenCalledOnce();
  });

  it('resets terminals and shows an error page when the renderer process is gone', () => {
    const window = createMainWindow(config, 'http://127.0.0.1:46321', 'native');
    const instance = window as unknown as InstanceType<typeof mocks.FakeBrowserWindow>;
    const reset = vi.fn();
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    watchRendererLifecycle(window, reset);

    webContentsHandlers(instance).gone?.({}, { reason: 'crashed', exitCode: 11 });

    expect(reset).toHaveBeenCalledOnce();
    expect(instance.loadURL).toHaveBeenLastCalledWith(expect.stringMatching(/^data:text\/html/));
    consoleError.mockRestore();
  });

  it('refuses to start without the single-instance lock', () => {
    mocks.app.requestSingleInstanceLock.mockReturnValueOnce(false);

    expect(registerSingleInstance(() => undefined)).toBe(false);
    expect(mocks.app.on).not.toHaveBeenCalledWith('second-instance', expect.any(Function));
  });

  it('restores and focuses the existing window on a second launch', () => {
    const window = {
      isDestroyed: vi.fn(() => false),
      isMinimized: vi.fn(() => true),
      restore: vi.fn(),
      focus: vi.fn(),
    };

    expect(registerSingleInstance(() => window as never)).toBe(true);
    const handler = mocks.app.on.mock.calls.find(
      ([eventName]) => eventName === 'second-instance',
    )?.[1] as (() => void) | undefined;
    handler?.();

    expect(window.restore).toHaveBeenCalledOnce();
    expect(window.focus).toHaveBeenCalledOnce();
  });
});

describe('desktop folder picker IPC', () => {
  const trustedFrame = { url: 'http://127.0.0.1:5173/', origin: 'http://127.0.0.1:5173' };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  function invokeEvent(senderFrame: { url: string; origin?: string } | null) {
    return {
      senderFrame,
      sender: { getURL: () => senderFrame?.url ?? '', mainFrame: senderFrame },
    } as never;
  }

  it.each([{ args: [] }, { args: ['project'] }])(
    'opens the existing project dialog for $args',
    async ({ args }) => {
      mocks.dialog.showOpenDialog.mockResolvedValue({
        canceled: false,
        filePaths: ['/Users/mi/projects/demo'],
      });

      await expect(
        handlePickDirectory(invokeEvent(trustedFrame), config.studioOrigin, ...args),
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
      handlePickDirectory(invokeEvent(trustedFrame), config.studioOrigin, 'plugin-import'),
    ).resolves.toEqual({ path: root, name: root });
    expect(mocks.dialog.showOpenDialog).toHaveBeenCalledWith({
      title: '选择已打包的插件文件夹',
      properties: ['openDirectory'],
    });
  });

  it('returns null when the user cancels', async () => {
    mocks.dialog.showOpenDialog.mockResolvedValue({ canceled: true, filePaths: [] });

    await expect(
      handlePickDirectory(invokeEvent(trustedFrame), config.studioOrigin, 'plugin-import'),
    ).resolves.toBeNull();
  });

  it('ignores requests with an untrusted or invalid frame URL without opening a dialog', async () => {
    await expect(
      handlePickDirectory(
        invokeEvent({ ...trustedFrame, url: 'https://evil.example/' }),
        config.studioOrigin,
        'plugin-import',
      ),
    ).resolves.toBeNull();
    await expect(
      handlePickDirectory(invokeEvent({ ...trustedFrame, url: 'not a url' }), config.studioOrigin),
    ).resolves.toBeNull();
    expect(mocks.dialog.showOpenDialog).not.toHaveBeenCalled();
  });

  it.each([
    { frame: { ...trustedFrame, origin: 'null' }, reason: 'an opaque origin' },
    { frame: { ...trustedFrame, origin: 'http://127.0.0.1:5174' }, reason: 'a different origin' },
    { frame: { url: trustedFrame.url }, reason: 'a missing origin' },
    { frame: null, reason: 'a missing frame' },
  ])('rejects $reason without opening a dialog', async ({ frame }) => {
    mocks.dialog.showOpenDialog.mockResolvedValue({
      canceled: false,
      filePaths: ['/Users/mi/projects/demo'],
    });

    await expect(
      handlePickDirectory(invokeEvent(frame), config.studioOrigin, 'plugin-import'),
    ).resolves.toBeNull();
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
      handlePickDirectory(invokeEvent(trustedFrame), config.studioOrigin, ...args),
    ).resolves.toBeNull();
    expect(mocks.dialog.showOpenDialog).not.toHaveBeenCalled();
  });
});

describe('desktop open data directory IPC', () => {
  const trustedFrame = { url: 'http://127.0.0.1:5173/', origin: 'http://127.0.0.1:5173' };
  const dataDirectory = '/tmp/weave-user-data';

  beforeEach(() => {
    vi.clearAllMocks();
  });

  function invokeEvent(senderFrame: { url: string; origin?: string } | null) {
    return {
      senderFrame,
      sender: { getURL: () => senderFrame?.url ?? '', mainFrame: senderFrame },
    } as never;
  }

  it('opens only the configured data directory for a trusted sender', async () => {
    mocks.shell.openPath.mockResolvedValue('');

    await expect(
      handleOpenDataDirectory(invokeEvent(trustedFrame), config.studioOrigin, dataDirectory),
    ).resolves.toEqual({ ok: true });
    expect(mocks.shell.openPath).toHaveBeenCalledExactlyOnceWith(dataDirectory);
  });

  it('refuses a renderer-supplied path', async () => {
    const result = await handleOpenDataDirectory(
      invokeEvent(trustedFrame),
      config.studioOrigin,
      dataDirectory,
      '/etc',
    );
    expect(result.ok).toBe(false);
    expect(mocks.shell.openPath).not.toHaveBeenCalled();
  });

  it.each([
    { frame: { ...trustedFrame, url: 'https://evil.example/', origin: 'https://evil.example' } },
    { frame: { ...trustedFrame, origin: 'null' } },
    { frame: { url: trustedFrame.url } },
    { frame: null },
  ])('rejects an untrusted sender without opening anything', async ({ frame }) => {
    const result = await handleOpenDataDirectory(
      invokeEvent(frame),
      config.studioOrigin,
      dataDirectory,
    );
    expect(result.ok).toBe(false);
    expect(mocks.shell.openPath).not.toHaveBeenCalled();
  });

  it('returns the OS error message when opening fails', async () => {
    mocks.shell.openPath.mockResolvedValue('Failed to open path');
    await expect(
      handleOpenDataDirectory(invokeEvent(trustedFrame), config.studioOrigin, dataDirectory),
    ).resolves.toEqual({ ok: false, error: 'Failed to open path' });
  });

  it('returns an error when openPath throws', async () => {
    mocks.shell.openPath.mockRejectedValue(new Error('boom'));
    await expect(
      handleOpenDataDirectory(invokeEvent(trustedFrame), config.studioOrigin, dataDirectory),
    ).resolves.toEqual({ ok: false, error: 'boom' });
  });

  it('exposes a preload bridge that sends no arguments', async () => {
    const contextBridge = { exposeInMainWorld: vi.fn<(name: string, bridge: unknown) => void>() };
    const ipcRenderer = {
      invoke: vi.fn<(...args: string[]) => Promise<unknown>>().mockResolvedValue({ ok: true }),
    };
    const source = readFileSync(new URL('../src/preload.cts', import.meta.url), 'utf8');
    const { outputText } = ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
      fileName: 'preload.cts',
    });
    runInNewContext(outputText, {
      exports: {},
      require: () => ({ contextBridge, ipcRenderer }),
      process: { argv: ['--weave-server-url=http%3A%2F%2F127.0.0.1%3A46321'] },
    });
    const bridge = contextBridge.exposeInMainWorld.mock.calls[0]?.[1] as {
      openDataDirectory: (...args: unknown[]) => Promise<unknown>;
    };
    await bridge.openDataDirectory('/etc');
    expect(ipcRenderer.invoke.mock.calls).toEqual([['weave:open-data-directory']]);
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
