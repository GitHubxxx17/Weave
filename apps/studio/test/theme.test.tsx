// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AppearanceSettingsView } from '../src/app/appearance-settings-view.js';
import { filterSettingsCategories, settingsCategories } from '../src/app/settings-categories.js';
import {
  applyTheme,
  readThemePreference,
  resolveTheme,
  setThemePreference,
  startThemeSync,
  themeStorageKey,
} from '../src/features/settings/theme.js';

interface FakeMedia {
  matches: boolean;
  addEventListener: ReturnType<typeof vi.fn>;
  removeEventListener: ReturnType<typeof vi.fn>;
}

let media: FakeMedia;
let changeListeners: Array<() => void>;

function setSystemDark(dark: boolean): void {
  media.matches = dark;
  for (const listener of [...changeListeners]) listener();
}

beforeEach(() => {
  changeListeners = [];
  media = {
    matches: false,
    addEventListener: vi.fn((_type: string, listener: () => void) => {
      changeListeners.push(listener);
    }),
    removeEventListener: vi.fn((_type: string, listener: () => void) => {
      changeListeners = changeListeners.filter((item) => item !== listener);
    }),
  };
  vi.stubGlobal('matchMedia', () => media);
  window.matchMedia = (() => media) as unknown as typeof window.matchMedia;
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  delete document.documentElement.dataset.theme;
  document.documentElement.style.colorScheme = '';
  vi.unstubAllGlobals();
});

describe('主题偏好读写', () => {
  it('默认跟随系统，合法值原样读出', () => {
    expect(readThemePreference()).toBe('system');
    setThemePreference(document.documentElement, 'dark');
    expect(localStorage.getItem(themeStorageKey)).toBe('dark');
    expect(readThemePreference()).toBe('dark');
    setThemePreference(document.documentElement, 'light');
    expect(readThemePreference()).toBe('light');
  });

  it('非法值回退到跟随系统', () => {
    for (const invalid of ['purple', '', 'DARK', '{"theme":"dark"}']) {
      localStorage.setItem(themeStorageKey, invalid);
      expect(readThemePreference()).toBe('system');
    }
  });
});

describe('解析与应用', () => {
  it('三种选项解析出的 data-theme', () => {
    expect(resolveTheme('light', true)).toBe('light');
    expect(resolveTheme('dark', false)).toBe('dark');
    expect(resolveTheme('system', true)).toBe('dark');
    expect(resolveTheme('system', false)).toBe('light');

    const root = document.documentElement;
    media.matches = true;
    expect(applyTheme(root, 'system')).toBe('dark');
    expect(root.dataset.theme).toBe('dark');
    expect(root.style.colorScheme).toBe('dark');
    applyTheme(root, 'light');
    expect(root.dataset.theme).toBe('light');
    expect(root.style.colorScheme).toBe('light');
  });

  it('首屏同步应用已保存的偏好', () => {
    localStorage.setItem(themeStorageKey, 'dark');
    const stop = startThemeSync(document.documentElement);
    expect(document.documentElement.dataset.theme).toBe('dark');
    stop();
  });

  it('跟随系统时随 matchMedia 变化切换，卸载后移除监听', () => {
    const root = document.documentElement;
    const stop = startThemeSync(root);
    expect(root.dataset.theme).toBe('light');
    setSystemDark(true);
    expect(root.dataset.theme).toBe('dark');
    setSystemDark(false);
    expect(root.dataset.theme).toBe('light');

    stop();
    expect(media.removeEventListener).toHaveBeenCalledTimes(1);
    expect(changeListeners).toHaveLength(0);
    media.matches = true;
    expect(root.dataset.theme).toBe('light');
  });

  it('固定浅色或深色时忽略系统变化', () => {
    const root = document.documentElement;
    setThemePreference(root, 'light');
    const stop = startThemeSync(root);
    setSystemDark(true);
    expect(root.dataset.theme).toBe('light');
    stop();
  });

  it('其他窗口的 storage 事件会同步主题', () => {
    const root = document.documentElement;
    const stop = startThemeSync(root);
    localStorage.setItem(themeStorageKey, 'dark');
    window.dispatchEvent(new StorageEvent('storage', { key: themeStorageKey, newValue: 'dark' }));
    expect(root.dataset.theme).toBe('dark');

    localStorage.setItem('other', 'x');
    window.dispatchEvent(new StorageEvent('storage', { key: 'other', newValue: 'x' }));
    expect(root.dataset.theme).toBe('dark');

    stop();
    localStorage.setItem(themeStorageKey, 'light');
    window.dispatchEvent(new StorageEvent('storage', { key: themeStorageKey, newValue: 'light' }));
    expect(root.dataset.theme).toBe('dark');
  });
});

describe('界面外观设置页', () => {
  it('侧栏里的界面外观可选，且能被"主题"搜到', () => {
    expect(settingsCategories.find(({ id }) => id === 'appearance')?.available).toBe(true);
    expect(filterSettingsCategories('主题').map(({ id }) => id)).toContain('appearance');
  });

  it('默认选中跟随系统，点击后立即生效并保存', () => {
    render(<AppearanceSettingsView />);
    const radios = screen.getAllByRole('radio');
    expect(radios.map((radio) => radio.getAttribute('aria-checked'))).toEqual([
      'true',
      'false',
      'false',
    ]);

    fireEvent.click(screen.getByRole('radio', { name: /深色/ }));
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(localStorage.getItem(themeStorageKey)).toBe('dark');
    expect(screen.getByRole('radio', { name: /深色/ }).getAttribute('aria-checked')).toBe('true');
    expect(screen.getByRole('radio', { name: /跟随系统/ }).getAttribute('aria-checked')).toBe(
      'false',
    );

    fireEvent.click(screen.getByRole('radio', { name: /^浅色/ }));
    expect(document.documentElement.dataset.theme).toBe('light');
    expect(screen.getByRole('radiogroup', { name: '界面主题' })).toBeTruthy();
  });

  it('读取已保存的偏好，并在其他窗口修改后更新选中项', () => {
    localStorage.setItem(themeStorageKey, 'light');
    const stop = startThemeSync(document.documentElement);
    render(<AppearanceSettingsView />);
    expect(screen.getByRole('radio', { name: /^浅色/ }).getAttribute('aria-checked')).toBe('true');

    act(() => {
      localStorage.setItem(themeStorageKey, 'dark');
      window.dispatchEvent(new StorageEvent('storage', { key: themeStorageKey, newValue: 'dark' }));
    });
    expect(screen.getByRole('radio', { name: /深色/ }).getAttribute('aria-checked')).toBe('true');
    stop();
  });
});
