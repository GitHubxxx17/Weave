// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi, beforeEach } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';

import { TerminalPanel } from '../src/features/panel/terminal-panel.js';

const mocks = vi.hoisted(() => {
  const inputListeners: Array<(data: string) => void> = [];
  const fakeTerminal = {
    cols: 80,
    rows: 24,
    loadAddon: vi.fn(),
    open: vi.fn(),
    write: vi.fn(),
    dispose: vi.fn(),
    onData: vi.fn((listener: (data: string) => void) => {
      inputListeners.push(listener);
      return { dispose: vi.fn() };
    }),
  };
  return { fakeTerminal, inputListeners };
});

vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    constructor() {
      return mocks.fakeTerminal;
    }
  },
}));
vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    fit(): void {}
  },
}));

beforeEach(() => {
  mocks.inputListeners.length = 0;
  mocks.fakeTerminal.write.mockClear();
  globalThis.ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  } as unknown as typeof ResizeObserver;
});

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(window, 'weaveDesktop');
  vi.clearAllMocks();
});

function installBridge() {
  let dataListener: ((payload: { id: string; data: string }) => void) | undefined;
  const bridge = {
    create: vi.fn(async () => ({ id: 'term-1' })),
    write: vi.fn(),
    resize: vi.fn(),
    dispose: vi.fn(),
    onData: vi.fn((listener: (payload: { id: string; data: string }) => void) => {
      dataListener = listener;
      return () => undefined;
    }),
    onExit: vi.fn(() => () => undefined),
  };
  window.weaveDesktop = { isDesktop: true, serverUrl: 'http://127.0.0.1:1', terminal: bridge };
  return { bridge, emitData: (data: string) => dataListener?.({ id: 'term-1', data }) };
}

describe('TerminalPanel', () => {
  it('starts a pty in the project folder and bridges input and output', async () => {
    const { bridge, emitData } = installBridge();

    render(<TerminalPanel cwd="/Users/me/project" />);

    await waitFor(() =>
      expect(bridge.create).toHaveBeenCalledWith({ cwd: '/Users/me/project', cols: 80, rows: 24 }),
    );

    act(() => emitData('已连接\r\n'));
    expect(mocks.fakeTerminal.write).toHaveBeenCalledWith('已连接\r\n');

    act(() => mocks.inputListeners[0]?.('ls\r'));
    expect(bridge.write).toHaveBeenCalledWith('term-1', 'ls\r');
  });

  it('shows a desktop-only notice when the terminal bridge is absent', () => {
    render(<TerminalPanel cwd={undefined} />);
    expect(screen.getByText('终端仅在桌面端可用')).toBeTruthy();
  });
});
