// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { readDefaultPermissionMode } from '../src/app/composer-preferences.js';
import { PermissionSettingsView } from '../src/app/permission-settings-view.js';
import { filterSettingsCategories, settingsCategories } from '../src/app/settings-categories.js';

afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe('permission settings', () => {
  it('makes the category available and searchable by its keywords', () => {
    expect(settingsCategories.find(({ id }) => id === 'permissions')?.available).toBe(true);
    for (const word of ['默认', '模式', '完全访问', '敏感', '密钥', '白名单']) {
      expect(filterSettingsCategories(word).map(({ id }) => id)).toContain('permissions');
    }
  });

  it('offers only 常规 and 信任 as the default and explains why 完全访问 is excluded', () => {
    render(<PermissionSettingsView />);
    const group = screen.getByRole('radiogroup', { name: '新会话的默认模式' });
    const radios = within(group).getAllByRole('radio');
    expect(radios.map((radio) => radio.textContent)).toEqual([
      expect.stringContaining('常规'),
      expect.stringContaining('信任'),
    ]);
    expect(screen.getByText(/完全访问不能设为默认/)).toBeTruthy();
    expect(radios[0]?.getAttribute('aria-checked')).toBe('true');
  });

  it('stores the chosen default and restores it on the next render', () => {
    const { unmount } = render(<PermissionSettingsView />);
    fireEvent.click(screen.getByRole('radio', { name: /信任/ }));
    expect(readDefaultPermissionMode()).toBe('trust');
    unmount();
    render(<PermissionSettingsView />);
    expect(screen.getByRole('radio', { name: /信任/ }).getAttribute('aria-checked')).toBe('true');
  });

  it('falls back to 常规 when the stored default is yolo', () => {
    localStorage.setItem('weave.studio.defaultPermissionMode.v1', 'yolo');
    render(<PermissionSettingsView />);
    expect(screen.getByRole('radio', { name: /常规/ }).getAttribute('aria-checked')).toBe('true');
  });

  it('describes what each mode asks about and the sensitive write paths', () => {
    render(<PermissionSettingsView />);
    const ask = screen.getByRole('article', { name: '常规' });
    expect(within(ask).getByText('写入或修改文件')).toBeTruthy();
    expect(within(ask).getByText('运行任何命令')).toBeTruthy();
    const trust = screen.getByRole('article', { name: '信任' });
    expect(within(trust).getByText(/危险命令名单：sudo、rm/)).toBeTruthy();
    expect(within(trust).getByText('写入或修改敏感文件（见下方）')).toBeTruthy();
    expect(within(trust).getByText(/白名单命令：ls、pwd/)).toBeTruthy();
    const yolo = screen.getByRole('article', { name: '完全访问' });
    expect(within(yolo).getByText(/不确认/)).toBeTruthy();
    for (const name of [
      'Git 内部与钩子',
      'CI 配置',
      '包管理与构建脚本',
      '自动执行的环境与编辑器配置',
      '密钥文件',
    ]) {
      expect(screen.getByText(name)).toBeTruthy();
    }
    expect(screen.getByText(/\.github\/workflows\//)).toBeTruthy();
  });
});
