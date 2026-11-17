import { beforeEach, describe, expect, it, vi } from 'vitest';

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
    },
    FakeBrowserWindow,
    startServer: vi.fn(),
  };
});

vi.mock('electron', () => ({
  BrowserWindow: mocks.FakeBrowserWindow,
  app: mocks.app,
  dialog: mocks.dialog,
  safeStorage: mocks.safeStorage,
}));

vi.mock('@weave/server/main', () => ({
  startServer: mocks.startServer,
}));

const { createDesktopFetch, createMainWindow, startDesktopApplication, startDesktopServer } =
  await import('../src/main.js');

const config = {
  userDataDirectory: '/tmp/weave-user-data',
  databaseFile: '/tmp/weave-user-data/weave.sqlite',
  studioUrl: 'http://127.0.0.1:5173',
  studioOrigin: 'http://127.0.0.1:5173',
} as const;

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

  it('starts the Server with the desktop database and Studio origin', async () => {
    const stop = vi.fn(async () => undefined);
    mocks.startServer.mockResolvedValueOnce({ port: 46321, stop });

    const result = await startDesktopServer(config, providerSecretCodec);

    expect(mocks.startServer).toHaveBeenCalledWith(0, {
      databaseFile: config.databaseFile,
      studioOrigin: config.studioOrigin,
      providerSecretCodec,
      fetch: expect.any(Function),
    });
    expect(result.port).toBe(46321);
    expect(result.stop).toBe(stop);
  });

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
    const window = createMainWindow(config, 'http://127.0.0.1:46321');
    const instance = mocks.FakeBrowserWindow.instances[0];

    expect(window).toBe(instance);
    expect(instance?.options).toMatchObject({
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        preload: expect.stringMatching(/preload\.cjs$/),
        additionalArguments: ['--weave-server-url=http%3A%2F%2F127.0.0.1%3A46321'],
      },
    });
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

  it('shows a user-visible error when the Server cannot start', async () => {
    mocks.startServer.mockRejectedValueOnce(new Error('SQLite 初始化失败'));

    await startDesktopApplication();

    expect(mocks.dialog.showErrorBox).toHaveBeenCalledWith(
      'Weave Desktop 启动失败',
      'SQLite 初始化失败',
    );
    expect(mocks.app.exit).toHaveBeenCalledWith(1);
  });
});
