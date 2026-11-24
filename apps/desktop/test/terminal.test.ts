import { describe, expect, it, vi } from 'vitest';

import {
  registerTerminalHost,
  terminalChannels,
  type PtyProcess,
  type PtySpawnOptions,
} from '../src/terminal.js';

const studioOrigin = 'http://127.0.0.1:5173';

function createFakePty() {
  const dataListeners: Array<(data: string) => void> = [];
  const exitListeners: Array<(event: { exitCode: number }) => void> = [];
  const pty: PtyProcess = {
    onData: (listener) => dataListeners.push(listener),
    onExit: (listener) => exitListeners.push(listener),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
  };
  return {
    pty,
    emitData: (data: string) => dataListeners.forEach((listener) => listener(data)),
    emitExit: (exitCode: number) => exitListeners.forEach((listener) => listener({ exitCode })),
  };
}

function createHarness() {
  const handlers = new Map<string, (event: unknown, raw: unknown) => unknown>();
  const listeners = new Map<string, (event: unknown, raw: unknown) => void>();
  const ipcMain = {
    handle: vi.fn((channel: string, handler: (event: unknown, raw: unknown) => unknown) => {
      handlers.set(channel, handler);
    }),
    on: vi.fn((channel: string, listener: (event: unknown, raw: unknown) => void) => {
      listeners.set(channel, listener);
    }),
    removeHandler: vi.fn((channel: string) => handlers.delete(channel)),
    removeAllListeners: vi.fn((channel: string) => listeners.delete(channel)),
  };
  const sent: Array<{ channel: string; payload: unknown }> = [];
  const webContents = {
    isDestroyed: () => false,
    send: (channel: string, payload: unknown) => sent.push({ channel, payload }),
  };
  const spawned: PtySpawnOptions[] = [];
  const fake = createFakePty();
  const spawn = vi.fn((options: PtySpawnOptions) => {
    spawned.push(options);
    return fake.pty;
  });
  const host = registerTerminalHost({
    ipcMain: ipcMain as never,
    studioOrigin,
    getWebContents: () => webContents as never,
    spawn,
    shell: '/bin/bash',
    env: { PATH: '/usr/bin', WEAVE_API_KEY: 'sk-secret', MY_API_TOKEN: 'user-var' },
  });
  const trustedEvent = { senderFrame: { url: `${studioOrigin}/`, origin: studioOrigin } };
  return { handlers, listeners, sent, spawned, fake, spawn, host, trustedEvent, webContents };
}

describe('terminal host', () => {
  it('spawns a pty for a trusted create request and streams its output', async () => {
    const h = createHarness();
    const create = h.handlers.get(terminalChannels.create)!;

    const result = (await create(h.trustedEvent, { cwd: null, cols: 80, rows: 24 })) as {
      id?: string;
    };
    expect(result.id).toBeTruthy();
    expect(h.spawned[0]).toMatchObject({ shell: '/bin/bash', cols: 80, rows: 24 });
    expect(h.spawned[0]?.env).toMatchObject({ TERM: 'xterm-256color' });

    h.fake.emitData('hello');
    expect(h.sent).toContainEqual({
      channel: terminalChannels.data,
      payload: { id: result.id, data: 'hello' },
    });

    h.fake.emitExit(0);
    expect(h.sent).toContainEqual({
      channel: terminalChannels.exit,
      payload: { id: result.id, exitCode: 0 },
    });
  });

  it('writes input and resizes the matching session', async () => {
    const h = createHarness();
    const create = h.handlers.get(terminalChannels.create)!;
    const { id } = (await create(h.trustedEvent, { cols: 80, rows: 24 })) as { id: string };

    h.listeners.get(terminalChannels.input)!(h.trustedEvent, { id, data: 'ls\n' });
    expect(h.fake.pty.write).toHaveBeenCalledWith('ls\n');

    h.listeners.get(terminalChannels.resize)!(h.trustedEvent, { id, cols: 120, rows: 30 });
    expect(h.fake.pty.resize).toHaveBeenCalledWith(120, 30);

    h.listeners.get(terminalChannels.dispose)!(h.trustedEvent, { id });
    expect(h.fake.pty.kill).toHaveBeenCalledOnce();
  });

  it('rejects an untrusted origin and never spawns', async () => {
    const h = createHarness();
    const create = h.handlers.get(terminalChannels.create)!;
    const result = (await create(
      { senderFrame: { url: 'https://evil.example/', origin: 'https://evil.example' } },
      { cols: 80, rows: 24 },
    )) as { error?: string };
    expect(result.error).toBe('untrusted-origin');
    expect(h.spawn).not.toHaveBeenCalled();
  });

  it('rejects an invalid create request', async () => {
    const h = createHarness();
    const create = h.handlers.get(terminalChannels.create)!;
    const result = (await create(h.trustedEvent, { cols: 0, rows: 24 })) as { error?: string };
    expect(result.error).toBe('invalid-request');
    expect(h.spawn).not.toHaveBeenCalled();
  });

  it('kills live sessions and removes handlers on dispose', async () => {
    const h = createHarness();
    const create = h.handlers.get(terminalChannels.create)!;
    await create(h.trustedEvent, { cols: 80, rows: 24 });

    h.host.dispose();
    expect(h.fake.pty.kill).toHaveBeenCalledOnce();
    expect(h.handlers.has(terminalChannels.create)).toBe(false);
    expect(h.listeners.has(terminalChannels.input)).toBe(false);
  });

  it('removes WEAVE_ variables but keeps the user environment', async () => {
    const h = createHarness();
    const create = h.handlers.get(terminalChannels.create)!;
    await create(h.trustedEvent, { cols: 80, rows: 24 });

    expect(h.spawned[0]?.env).toMatchObject({ PATH: '/usr/bin', MY_API_TOKEN: 'user-var' });
    expect(h.spawned[0]?.env).not.toHaveProperty('WEAVE_API_KEY');
  });

  it('disposeSessions kills sessions but keeps the IPC handlers', async () => {
    const h = createHarness();
    const create = h.handlers.get(terminalChannels.create)!;
    await create(h.trustedEvent, { cols: 80, rows: 24 });

    h.host.disposeSessions();

    expect(h.fake.pty.kill).toHaveBeenCalledOnce();
    expect(h.handlers.has(terminalChannels.create)).toBe(true);
    expect(h.listeners.has(terminalChannels.input)).toBe(true);
    expect(h.listeners.has(terminalChannels.dispose)).toBe(true);
  });

  it.each([
    {
      name: 'a different origin',
      frame: { url: 'https://evil.example/', origin: 'https://evil.example' },
    },
    { name: 'a null origin', frame: { url: `${studioOrigin}/`, origin: 'null' } },
    { name: 'a missing origin', frame: { url: `${studioOrigin}/` } },
    { name: 'an invalid URL', frame: { url: 'not a url', origin: studioOrigin } },
    { name: 'a missing frame', frame: null },
  ])('ignores create/input/resize/dispose from $name', async ({ frame }) => {
    const h = createHarness();
    const create = h.handlers.get(terminalChannels.create)!;
    const { id } = (await create(h.trustedEvent, { cols: 80, rows: 24 })) as { id: string };
    const untrusted = { senderFrame: frame };

    expect(await create(untrusted, { cols: 80, rows: 24 })).toEqual({ error: 'untrusted-origin' });
    expect(h.spawn).toHaveBeenCalledOnce();
    h.listeners.get(terminalChannels.input)!(untrusted, { id, data: 'rm -rf /\n' });
    h.listeners.get(terminalChannels.resize)!(untrusted, { id, cols: 10, rows: 10 });
    h.listeners.get(terminalChannels.dispose)!(untrusted, { id });

    expect(h.fake.pty.write).not.toHaveBeenCalled();
    expect(h.fake.pty.resize).not.toHaveBeenCalled();
    expect(h.fake.pty.kill).not.toHaveBeenCalled();
  });
});
