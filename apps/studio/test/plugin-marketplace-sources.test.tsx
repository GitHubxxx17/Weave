// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PluginCatalogProvider } from '../src/features/plugins/plugin-catalog-context.js';
import { createPluginCatalogStore } from '../src/features/plugins/plugin-catalog-store.js';
import { PluginMarketplacePage } from '../src/features/plugins/plugin-marketplace-page.js';
import { firstCandidate } from './support/managed-plugin-fixtures.js';

const builtin = {
  id: 'weave',
  name: 'Weave 目录',
  url: null,
  kind: 'builtin',
  status: 'ready',
  stale: false,
  removable: false,
};
const team = {
  id: 'team',
  name: '团队目录',
  url: 'https://example.com/index.json',
  kind: 'remote',
  status: 'unfetched',
  stale: false,
  removable: true,
};
const sourceEnvelope = (sources = [builtin, team], revision = 3) => ({
  schemaVersion: 1,
  revision,
  sources,
});
const catalog = (id: string, title?: string) => ({
  schemaVersion: 1,
  hostVersion: '0.0.0',
  communityStatus: 'ready',
  indexSource: {
    id,
    name: id === 'weave' ? builtin.name : team.name,
    url: id === 'weave' ? null : team.url,
  },
  entries:
    title === undefined
      ? []
      : [
          {
            kind: 'github',
            category: 'community',
            id: firstCandidate.manifest.id,
            name: title,
            description: '社区能力',
            publisher: 'Developer',
            tags: [],
            releases: [
              {
                manifest: firstCandidate.manifest,
                source: {
                  repository: 'https://github.com/developer/plugin',
                  commit: 'a'.repeat(40),
                  subdirectory: '',
                },
                compatibility: 'compatible',
              },
            ],
          },
        ],
});

function setup(
  request: (path: string, init: RequestInit) => Response | Promise<Response> | undefined = () =>
    undefined,
) {
  const fetch = vi.fn((input: RequestInfo | URL, init: RequestInit) => {
    const path = String(input);
    const response = request(path, init);
    if (response !== undefined) return Promise.resolve(response);
    if (path === '/plugins/marketplace/sources')
      return Promise.resolve(Response.json(sourceEnvelope()));
    if (path.startsWith('/plugins/marketplace'))
      return Promise.resolve(Response.json(catalog(path.includes('team') ? 'team' : 'weave')));
    return Promise.resolve(new Response('Unavailable', { status: 503 }));
  });
  vi.stubGlobal('fetch', fetch);
  render(
    <PluginCatalogProvider store={createPluginCatalogStore()}>
      <PluginMarketplacePage hasRunningSessions={false} />
    </PluginCatalogProvider>,
  );
  return fetch;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('marketplace index sources', () => {
  it('adds a source without fetching it and refreshes only on an explicit action', async () => {
    const added = {
      ...team,
      id: 'new',
      name: '开发者目录',
      url: 'https://developer.example/catalog.json',
    };
    const fetch = setup((path) => {
      if (path === '/plugins/marketplace/sources/add')
        return Response.json(sourceEnvelope([builtin, team, added]));
      if (path === '/plugins/marketplace/refresh')
        return Response.json(sourceEnvelope([builtin, team, { ...added, status: 'ready' }]));
      if (path === '/plugins/marketplace?sourceId=new')
        return Response.json({
          ...catalog('new', '新来源工具'),
          indexSource: { id: added.id, name: added.name, url: added.url },
        });
      return undefined;
    });
    await screen.findByRole('combobox', { name: '插件索引源' });
    expect(fetch.mock.calls.every(([, init]) => init.method === 'GET')).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: '管理索引源' }));
    fireEvent.change(screen.getByRole('textbox', { name: '索引源名称' }), {
      target: { value: added.name },
    });
    fireEvent.change(screen.getByRole('textbox', { name: '索引地址' }), {
      target: { value: added.url },
    });
    fireEvent.click(screen.getByRole('button', { name: '添加索引源' }));
    await waitFor(() =>
      expect(
        (screen.getByRole('combobox', { name: '插件索引源' }) as HTMLSelectElement).value,
      ).toBe('new'),
    );
    expect(fetch.mock.calls.filter(([, init]) => init.method === 'POST')).toHaveLength(1);
    expect(await screen.findByText(/尚未读取该索引/)).toBeDefined();
    // The button is disabled while the new source's catalog loads; a click then is silently dropped.
    await waitFor(() =>
      expect((screen.getByRole('button', { name: '刷新市场' }) as HTMLButtonElement).disabled).toBe(
        false,
      ),
    );
    fireEvent.click(screen.getByRole('button', { name: '刷新市场' }));
    await screen.findByRole('button', { name: '查看 新来源工具' });
    // The entry can render before the refresh POST is observed, so wait for the request itself.
    await waitFor(() =>
      expect(
        fetch.mock.calls.filter(([, init]) => init.method === 'POST').map(([path]) => path),
      ).toEqual(['/plugins/marketplace/sources/add', '/plugins/marketplace/refresh']),
    );
  });

  it('keeps official GitHub entries after a failed refresh and attributes their custom stale source', async () => {
    let unavailable = false;
    const fetch = setup((path) => {
      if (path === '/plugins/marketplace/sources')
        return Response.json(sourceEnvelope([builtin, { ...team, status: 'ready' }]));
      if (path === '/plugins/marketplace?sourceId=team') {
        const value = catalog('team', '缓存工具');
        return Response.json({
          ...value,
          communityStatus: unavailable ? 'unavailable' : 'ready',
          entries: value.entries.map((entry) => ({
            ...entry,
            category: 'official',
            publisher: 'Weave',
          })),
        });
      }
      if (path === '/plugins/marketplace/refresh') {
        unavailable = true;
        return Response.json(
          sourceEnvelope([
            builtin,
            { ...team, status: 'unavailable', stale: true, errorCode: 'network' },
          ]),
        );
      }
      return undefined;
    });
    fireEvent.change(await screen.findByRole('combobox', { name: '插件索引源' }), {
      target: { value: 'team' },
    });
    fireEvent.click(screen.getByRole('button', { name: '官方' }));
    fireEvent.click(await screen.findByRole('button', { name: '查看 缓存工具' }));
    expect(
      within(screen.getByRole('region', { name: '缓存工具详情' })).getByText(team.url),
    ).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: '刷新市场' }));
    expect(await screen.findByText(/正在显示上次成功读取的目录/)).toBeDefined();
    expect(await screen.findByText('插件索引目录暂不可用')).toBeDefined();
    expect(screen.getByRole('button', { name: '查看 缓存工具' })).toBeDefined();
    expect(
      within(screen.getByRole('region', { name: '缓存工具详情' })).getByText(team.url),
    ).toBeDefined();
    expect(fetch.mock.calls.filter(([, init]) => init.method !== 'GET')).toHaveLength(1);
  });

  it('ignores late results from a source that is no longer selected', async () => {
    let finish!: (response: Response) => void;
    const pending = new Promise<Response>((resolve) => {
      finish = resolve;
    });
    const fetch = setup((path) =>
      path === '/plugins/marketplace?sourceId=team' ? pending : undefined,
    );
    const picker = await screen.findByRole('combobox', { name: '插件索引源' });
    fireEvent.change(picker, { target: { value: 'team' } });
    await waitFor(() =>
      expect(fetch.mock.calls.some(([path]) => path === '/plugins/marketplace?sourceId=team')).toBe(
        true,
      ),
    );
    fireEvent.change(picker, { target: { value: 'weave' } });
    await act(async () => {
      finish(Response.json(catalog('team', '过期工具')));
    });
    expect(screen.queryByRole('button', { name: '查看 过期工具' })).toBeNull();
    expect(
      fetch.mock.calls.find(([path]) => path === '/plugins/marketplace?sourceId=team')![1].signal
        ?.aborted,
    ).toBe(true);
  });

  it('removes only the index configuration and keeps installed management available', async () => {
    const fetch = setup((path) =>
      path === '/plugins/marketplace/sources/remove'
        ? Response.json(sourceEnvelope([builtin]))
        : undefined,
    );
    await screen.findByRole('combobox', { name: '插件索引源' });
    fireEvent.click(screen.getByRole('button', { name: '管理索引源' }));
    fireEvent.click(screen.getByRole('button', { name: '移除 团队目录' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: '移除 团队目录' })).toBeNull());
    expect(
      fetch.mock.calls.filter(([, init]) => init.method !== 'GET').map(([path]) => path),
    ).toEqual(['/plugins/marketplace/sources/remove']);
    expect(
      JSON.parse(
        String(
          fetch.mock.calls.find(([path]) => path === '/plugins/marketplace/sources/remove')![1]
            .body,
        ),
      ),
    ).toEqual({ id: 'team', revision: 3 });
    expect(screen.getByRole('tab', { name: '已安装' })).toBeDefined();
  });

  it('re-reads the source list and reports a revision conflict', async () => {
    let reads = 0;
    setup((path, init) => {
      if (path === '/plugins/marketplace/sources' && init.method === 'GET') {
        reads += 1;
        return Response.json(sourceEnvelope([builtin, team], reads === 1 ? 3 : 4));
      }
      if (path === '/plugins/marketplace/sources/remove')
        return Response.json(
          { error: { code: 'plugin-marketplace-revision-conflict', message: 'conflict' } },
          { status: 409 },
        );
      return undefined;
    });
    await screen.findByRole('combobox', { name: '插件索引源' });
    fireEvent.click(screen.getByRole('button', { name: '管理索引源' }));
    fireEvent.click(screen.getByRole('button', { name: '移除 团队目录' }));
    expect(await screen.findByText(/已被其他窗口修改/)).toBeDefined();
    await waitFor(() => expect(reads).toBe(2));
  });

  it('does not let an older settings read restore a removed source', async () => {
    let readCount = 0;
    let removeCount = 0;
    let finish!: (response: Response) => void;
    const pending = new Promise<Response>((resolve) => {
      finish = resolve;
    });
    const fetch = setup((path) => {
      if (path === '/plugins/marketplace/sources') {
        readCount += 1;
        return readCount === 1 ? Response.json(sourceEnvelope()) : pending;
      }
      if (path === '/plugins/marketplace/sources/remove') {
        removeCount += 1;
        return removeCount === 1
          ? new Response('Unavailable', { status: 503 })
          : Response.json(sourceEnvelope([builtin]));
      }
      return undefined;
    });
    await screen.findByRole('combobox', { name: '插件索引源' });
    fireEvent.click(screen.getByRole('button', { name: '管理索引源' }));
    fireEvent.click(screen.getByRole('button', { name: '移除 团队目录' }));
    fireEvent.click(await screen.findByRole('button', { name: '重新读取设置' }));
    await waitFor(() => expect(readCount).toBe(2));
    fireEvent.click(screen.getByRole('button', { name: '移除 团队目录' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: '移除 团队目录' })).toBeNull());
    await act(async () => {
      finish(Response.json(sourceEnvelope()));
    });
    expect(screen.queryByRole('button', { name: '移除 团队目录' })).toBeNull();
    expect(
      fetch.mock.calls.filter(([path]) => path === '/plugins/marketplace/sources')[1]![1].signal
        ?.aborted,
    ).toBe(true);
  });

  it('reconciles an uncertain removal after re-reading settings and clears removed-source details', async () => {
    let reads = 0;
    setup((path) => {
      if (path === '/plugins/marketplace/sources') {
        reads += 1;
        return Response.json(sourceEnvelope(reads === 1 ? [builtin, team] : [builtin]));
      }
      if (path === '/plugins/marketplace?sourceId=team')
        return Response.json(catalog('team', '已移除源工具'));
      if (path === '/plugins/marketplace/sources/remove')
        return new Response('Disconnected', { status: 503 });
      return undefined;
    });
    const picker = await screen.findByRole('combobox', { name: '插件索引源' });
    fireEvent.change(picker, { target: { value: 'team' } });
    fireEvent.click(await screen.findByRole('button', { name: '查看 已移除源工具' }));
    fireEvent.click(screen.getByRole('button', { name: '管理索引源' }));
    fireEvent.click(screen.getByRole('button', { name: '移除 团队目录' }));
    fireEvent.click(await screen.findByRole('button', { name: '重新读取设置' }));
    await waitFor(() => expect((picker as HTMLSelectElement).value).toBe('weave'));
    expect(screen.queryByRole('region', { name: '已移除源工具详情' })).toBeNull();
    expect(screen.queryByRole('button', { name: '查看 已移除源工具' })).toBeNull();
  });

  it('keeps the displayed version aligned with the reviewed release after catalog refresh', async () => {
    let refreshed = false;
    setup((path) => {
      if (path === '/plugins/marketplace?sourceId=team') {
        const value = catalog('team', '版本更新工具');
        const entry = value.entries[0]!;
        const release = entry.releases[0]!;
        if (refreshed) {
          entry.releases = [
            {
              ...release,
              manifest: { ...release.manifest, version: '3.0.0' },
              compatibility: 'incompatible',
            },
            {
              ...release,
              manifest: { ...release.manifest, version: '2.0.0' },
              compatibility: 'compatible',
            },
          ];
        }
        return Response.json(value);
      }
      if (path === '/plugins/marketplace/refresh') {
        refreshed = true;
        return Response.json(sourceEnvelope([builtin, { ...team, status: 'ready' }]));
      }
      return undefined;
    });
    fireEvent.change(await screen.findByRole('combobox', { name: '插件索引源' }), {
      target: { value: 'team' },
    });
    fireEvent.click(await screen.findByRole('button', { name: '查看 版本更新工具' }));
    expect((screen.getByRole('combobox', { name: '插件版本' }) as HTMLSelectElement).value).toBe(
      '1.0.0',
    );
    fireEvent.click(screen.getByRole('button', { name: '刷新市场' }));
    await waitFor(() =>
      expect((screen.getByRole('combobox', { name: '插件版本' }) as HTMLSelectElement).value).toBe(
        '2.0.0',
      ),
    );
    expect(screen.getByText('兼容当前 Weave')).toBeDefined();
  });
});
