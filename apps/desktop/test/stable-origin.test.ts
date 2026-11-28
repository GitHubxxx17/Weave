import { mkdtemp, rm } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDesktopConfig } from '../src/desktop-config.js';
import { readDesktopState, writeDesktopState } from '../src/desktop-state.js';

vi.mock('electron', () => ({
  BrowserWindow: class {},
  app: {
    setName: vi.fn(),
    on: vi.fn(),
    requestSingleInstanceLock: vi.fn(() => true),
    whenReady: vi.fn(() => new Promise<void>(() => undefined)),
  },
  dialog: {},
  ipcMain: {},
  safeStorage: {},
  shell: {},
}));

const { startDesktopServer } = await import('../src/main.js');

const providerSecretCodec = {
  isAvailable: () => true,
  encrypt: (value: string) => value,
  decrypt: (value: string) => value,
};

/** Runs the real embedded Server against a temporary data directory. */
describe('stable Studio origin with the real Server', () => {
  let directory: string;
  const stops: Array<() => Promise<void>> = [];
  const blockers: net.Server[] = [];

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'weave-desktop-origin-'));
  });

  afterEach(async () => {
    for (const stop of stops.splice(0)) {
      await stop();
    }
    for (const blocker of blockers.splice(0)) {
      await new Promise<void>((resolve) => blocker.close(() => resolve()));
    }
    await rm(directory, { recursive: true, force: true });
  });

  function createConfig() {
    return createDesktopConfig({
      userDataDirectory: directory,
      environment: { WEAVE_STUDIO_URL: 'http://127.0.0.1:5173' },
    });
  }

  async function occupy(): Promise<number> {
    const blocker = net.createServer();
    blockers.push(blocker);
    await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', resolve));
    return (blocker.address() as net.AddressInfo).port;
  }

  it('reuses the recorded port on the next start', async () => {
    const first = await startDesktopServer(createConfig(), providerSecretCodec, false);
    await first.stop();
    expect(await readDesktopState(directory)).toEqual({ version: 1, serverPort: first.port });

    const second = await startDesktopServer(createConfig(), providerSecretCodec, false);
    stops.push(second.stop);
    expect(second.port).toBe(first.port);
  }, 30_000);

  it('falls back to another port when the recorded port is occupied, then keeps the new one', async () => {
    const busyPort = await occupy();
    await writeDesktopState(directory, { serverPort: busyPort });

    const fallback = await startDesktopServer(createConfig(), providerSecretCodec, false);
    expect(fallback.port).not.toBe(busyPort);
    expect(await readDesktopState(directory)).toEqual({ version: 1, serverPort: fallback.port });
    await fallback.stop();

    const next = await startDesktopServer(createConfig(), providerSecretCodec, false);
    stops.push(next.stop);
    expect(next.port).toBe(fallback.port);
  }, 30_000);
});
