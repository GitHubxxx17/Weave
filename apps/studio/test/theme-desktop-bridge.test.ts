// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  setThemePreference,
  startThemeSync,
  themeStorageKey,
} from '../src/features/settings/theme.js';

let systemDark = false;

beforeEach(() => {
  systemDark = false;
  window.matchMedia = (() => ({
    get matches() {
      return systemDark;
    },
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  })) as unknown as typeof window.matchMedia;
});

afterEach(() => {
  localStorage.clear();
  delete window.weaveDesktop;
  delete document.documentElement.dataset.theme;
  document.documentElement.style.colorScheme = '';
});

function installBridge(setTheme: (preference: 'system' | 'light' | 'dark') => void): void {
  window.weaveDesktop = { isDesktop: true, serverUrl: 'http://127.0.0.1:1', setTheme };
}

describe('Desktop 主题桥', () => {
  it('startThemeSync 初次应用时传入偏好，而不是解析结果', () => {
    const setTheme = vi.fn();
    installBridge(setTheme);
    systemDark = true;
    const stop = startThemeSync(document.documentElement);
    expect(setTheme).toHaveBeenCalledExactlyOnceWith('system');
    expect(document.documentElement.dataset.theme).toBe('dark');
    stop();

    localStorage.setItem(themeStorageKey, 'light');
    setTheme.mockClear();
    startThemeSync(document.documentElement)();
    expect(setTheme).toHaveBeenCalledExactlyOnceWith('light');
  });

  it('setThemePreference 把新偏好传给桥', () => {
    const setTheme = vi.fn();
    installBridge(setTheme);
    setThemePreference(document.documentElement, 'dark');
    setThemePreference(document.documentElement, 'system');
    expect(setTheme.mock.calls).toEqual([['dark'], ['system']]);
  });

  it('其他窗口的 storage 事件同步时传给桥，无关的键不触发', () => {
    const setTheme = vi.fn();
    installBridge(setTheme);
    const stop = startThemeSync(document.documentElement);
    setTheme.mockClear();

    localStorage.setItem(themeStorageKey, 'dark');
    window.dispatchEvent(new StorageEvent('storage', { key: themeStorageKey, newValue: 'dark' }));
    expect(setTheme).toHaveBeenCalledExactlyOnceWith('dark');

    window.dispatchEvent(new StorageEvent('storage', { key: 'other', newValue: 'x' }));
    expect(setTheme).toHaveBeenCalledTimes(1);
    stop();
  });

  it('没有桥或没有 setTheme 时不报错，主题照常应用', () => {
    const root = document.documentElement;
    expect(() => setThemePreference(root, 'dark')).not.toThrow();
    expect(root.dataset.theme).toBe('dark');

    window.weaveDesktop = { isDesktop: true, serverUrl: 'http://127.0.0.1:1' };
    expect(() => startThemeSync(root)()).not.toThrow();
    expect(() => setThemePreference(root, 'light')).not.toThrow();
    expect(root.dataset.theme).toBe('light');
  });

  it('桥抛错不影响主题应用', () => {
    installBridge(() => {
      throw new Error('ipc closed');
    });
    expect(() => setThemePreference(document.documentElement, 'dark')).not.toThrow();
    expect(document.documentElement.dataset.theme).toBe('dark');
  });
});
