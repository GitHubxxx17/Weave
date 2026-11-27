// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { filterSettingsCategories } from '../src/app/settings-categories.js';
import { SettingsSidebar } from '../src/app/settings-sidebar.js';
import { formatBytes, StorageSettingsView } from '../src/app/storage-settings-view.js';

const fetchMock = vi.fn();

const storagePayload = {
  dataDirectory: '/data/weave',
  locations: [
    {
      id: 'database',
      kind: 'file',
      path: '/data/weave/weave.sqlite',
      exists: true,
      sizeBytes: 13_002_342,
      truncated: false,
    },
    {
      id: 'memory',
      kind: 'file',
      path: '/data/weave/weave.sqlite.memory.sqlite',
      exists: false,
      sizeBytes: null,
      truncated: false,
    },
    {
      id: 'plugins',
      kind: 'directory',
      path: '/data/weave/plugins',
      exists: true,
      sizeBytes: 5 * 1024,
      truncated: true,
    },
    {
      id: 'skills',
      kind: 'directory',
      path: '/data/weave/skills',
      exists: true,
      sizeBytes: null,
      truncated: false,
      error: 'permission-denied',
    },
  ],
};

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  cleanup();
  delete window.weaveDesktop;
  fetchMock.mockReset();
  vi.unstubAllGlobals();
});

describe('SettingsSidebar', () => {
  it('marks the active category and reports selections', () => {
    const onSelect = vi.fn();
    render(<SettingsSidebar activeCategory="providers" onSelectCategory={onSelect} />);

    expect(screen.getByRole('button', { name: '模型服务' }).getAttribute('aria-current')).toBe(
      'page',
    );
    expect(
      screen.getByRole('button', { name: '数据存储' }).getAttribute('aria-current'),
    ).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '数据存储' }));
    expect(onSelect).toHaveBeenCalledWith('storage');
  });

  it('keeps unfinished categories disabled', () => {
    render(<SettingsSidebar activeCategory="providers" onSelectCategory={vi.fn()} />);
    for (const name of [/运行权限/]) {
      const button = screen.getByRole('button', { name }) as HTMLButtonElement;
      expect(button.disabled).toBe(true);
      expect(button.textContent).toContain('即将推出');
    }
  });

  it('filters categories by name and keyword, and shows an empty state', () => {
    render(<SettingsSidebar activeCategory="providers" onSelectCategory={vi.fn()} />);
    const search = screen.getByRole('searchbox', { name: '搜索设置' });

    fireEvent.change(search, { target: { value: '数据库' } });
    expect(screen.getByRole('button', { name: '数据存储' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: '模型服务' })).toBeNull();

    fireEvent.change(search, { target: { value: 'PROVIDER' } });
    expect(screen.getByRole('button', { name: '模型服务' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: '数据存储' })).toBeNull();

    fireEvent.change(search, { target: { value: '不存在的关键词' } });
    expect(screen.getByText('没有匹配的设置')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '模型服务' })).toBeNull();

    fireEvent.change(search, { target: { value: '' } });
    expect(screen.getAllByRole('button').length).toBe(4);
  });

  it('matches the storage keywords from the product brief', () => {
    for (const word of ['目录', '路径', '数据库', '插件', '占用']) {
      expect(filterSettingsCategories(word).map(({ id }) => id)).toContain('storage');
    }
  });
});

describe('formatBytes', () => {
  it('uses binary units with one decimal', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(1023)).toBe('1023 B');
    expect(formatBytes(1024)).toBe('1.0 KB');
    expect(formatBytes(13_002_342)).toBe('12.4 MB');
    expect(formatBytes(3 * 1024 ** 3)).toBe('3.0 GB');
  });
});

describe('StorageSettingsView', () => {
  it('shows a loading state, then names, paths and sizes', async () => {
    fetchMock.mockResolvedValue(Response.json(storagePayload));
    render(<StorageSettingsView />);

    expect(screen.getByRole('status').textContent).toContain('正在读取');
    expect(await screen.findByText('/data/weave/weave.sqlite')).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledWith('/settings/storage', expect.anything());
    expect(screen.getByText('主数据库')).toBeTruthy();
    expect(screen.getByText('12.4 MB')).toBeTruthy();
    expect(screen.getByText('尚未创建')).toBeTruthy();
    expect(screen.getByText('至少 5.0 KB')).toBeTruthy();
    expect(screen.getByText('无权限读取')).toBeTruthy();
    expect(screen.getByLabelText('数据目录').textContent).toContain('/data/weave');
  });

  it('shows the local-only message on 403 storage-local-only', async () => {
    fetchMock.mockResolvedValue(
      Response.json(
        { error: { code: 'storage-local-only', message: 'local only' } },
        { status: 403 },
      ),
    );
    render(<StorageSettingsView />);
    expect((await screen.findByRole('alert')).textContent).toBe(
      '出于安全考虑，存储位置只能在运行 Weave 的这台电脑上查看',
    );
  });

  it('shows other failures and reloads on refresh', async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json(
        { error: { code: 'storage-unavailable', message: '存储位置信息不可用' } },
        { status: 503 },
      ),
    );
    render(<StorageSettingsView />);
    expect((await screen.findByRole('alert')).textContent).toBe('存储位置信息不可用');

    fetchMock.mockResolvedValueOnce(Response.json(storagePayload));
    fireEvent.click(screen.getByRole('button', { name: '刷新' }));
    expect(await screen.findByText('/data/weave/weave.sqlite')).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('shows a network failure and rejects malformed payloads', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'));
    render(<StorageSettingsView />);
    expect((await screen.findByRole('alert')).textContent).toBe('无法连接到本地服务');

    fetchMock.mockResolvedValueOnce(Response.json({ dataDirectory: '/x', locations: [{ id: 1 }] }));
    fireEvent.click(screen.getByRole('button', { name: '刷新' }));
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toBe('本地服务返回的数据格式无效'),
    );
  });

  it('shows the open button only with a Desktop bridge and reports failures', async () => {
    fetchMock.mockImplementation(async () => Response.json(storagePayload));
    const { unmount } = render(<StorageSettingsView />);
    await screen.findByText('/data/weave/weave.sqlite');
    expect(screen.queryByRole('button', { name: '打开数据目录' })).toBeNull();
    unmount();

    const openDataDirectory = vi.fn().mockResolvedValue({ ok: false, error: '无法打开' });
    window.weaveDesktop = { isDesktop: true, serverUrl: '', openDataDirectory };
    render(<StorageSettingsView />);
    await screen.findByText('/data/weave/weave.sqlite');
    fireEvent.click(screen.getByRole('button', { name: '打开数据目录' }));
    expect(openDataDirectory).toHaveBeenCalledWith();
    expect((await screen.findByRole('alert')).textContent).toBe('无法打开');
  });
});
