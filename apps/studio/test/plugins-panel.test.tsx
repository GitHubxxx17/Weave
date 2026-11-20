// @vitest-environment jsdom

import { StrictMode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

import { PluginCatalogProvider } from '../src/features/plugins/plugin-catalog-context.js';
import {
  createPluginCatalogStore,
  type PluginCatalogStore,
} from '../src/features/plugins/plugin-catalog-store.js';
import type { PluginCatalog, PluginListItem } from '../src/features/plugins/plugin-types.js';
import {
  PluginsPanel,
  groupByOrigin,
  permissionLabel,
} from '../src/features/plugins/plugins-panel.js';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function plugin(over: Partial<PluginListItem> = {}): PluginListItem {
  return {
    id: 'server-echo',
    name: 'Server Echo',
    version: '1.2.3',
    state: 'loaded',
    origin: 'registered',
    host: 'in-process',
    capabilities: ['tool'],
    provides: {
      tools: ['echo'],
      providers: [],
      promptSections: [],
      events: [],
      commands: [],
      hooks: [],
      services: [],
    },
    ...over,
  };
}

/** Answers each request with the next response; the last one repeats. */
function stubPlugins(...responses: Array<readonly PluginListItem[] | number>) {
  const queue = [...responses];
  const fetchMock = vi.fn(async () => {
    const next = queue.length > 1 ? queue.shift() : queue[0];
    if (typeof next === 'number') {
      return new Response('{}', { status: next });
    }
    return new Response(JSON.stringify({ plugins: next ?? [] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function renderPluginPanel(
  hasRunningSessions = false,
  store: PluginCatalogStore = createPluginCatalogStore(),
) {
  return render(
    <PluginCatalogProvider store={store}>
      <PluginsPanel hasRunningSessions={hasRunningSessions} />
    </PluginCatalogProvider>,
  );
}

const digest = 'a'.repeat(64);
const nextDigest = 'b'.repeat(64);
function localPlugin(state = 'pending-trust', id = 'local-echo'): PluginListItem {
  const manifest = {
    id,
    name: id,
    version: '1.0.0',
    apiVersion: '1',
    capabilities: ['tool'],
    contributes: { tools: ['declared-echo'] },
    permissions: [],
  };
  return plugin({
    id,
    name: id,
    origin: 'local',
    state,
    provides: {
      tools: [],
      providers: [],
      promptSections: [],
      events: [],
      commands: [],
      hooks: [],
      services: [],
    },
    contributes: manifest.contributes,
    local: {
      directory: `/plugins/${id}`,
      enabled: state !== 'disabled',
      digest,
      manifest,
      ...(state === 'pending-trust' ? {} : { trusted: { digest, trustedAt: 'today', manifest } }),
    },
  });
}
function catalog(
  plugins: readonly PluginListItem[],
  over: Partial<NonNullable<PluginCatalog['local']>> = {},
): PluginCatalog {
  return {
    plugins,
    local: {
      directory: '/plugins',
      exists: true,
      truncated: false,
      trustSequence: 0,
      generation: { id: 1, acceptingRuns: true, plugins: [] },
      ...over,
    },
  };
}
function stubCatalog(...responses: unknown[]) {
  const queue = [...responses];
  const fetchMock = vi.fn(
    async () =>
      new Response(JSON.stringify(queue.length > 1 ? queue.shift() : queue[0]), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('permissionLabel', () => {
  it('describes the declared permissions in words', () => {
    expect(permissionLabel('workspace:read')).toBe('读取工作区');
    expect(permissionLabel('workspace:write')).toBe('写入工作区');
    expect(permissionLabel('process:spawn')).toBe('运行进程');
    expect(permissionLabel('network:request')).toBe('访问网络');
  });

  it('names the service a service permission uses and shows unknown ones as written', () => {
    expect(permissionLabel('service:weave.session.store')).toBe('使用服务 weave.session.store');
    expect(permissionLabel('clipboard:write')).toBe('clipboard:write');
  });
});

describe('groupByOrigin', () => {
  it('lists builtin, registered and kernel plugins in that order, then other origins', () => {
    const groups = groupByOrigin([
      plugin({ id: 'a', origin: 'kernel' }),
      plugin({ id: 'b', origin: 'market' }),
      plugin({ id: 'local-one', origin: 'local' }),
      plugin({ id: 'c', origin: 'builtin' }),
      plugin({ id: 'd', origin: 'registered' }),
      plugin({ id: 'e', origin: 'builtin' }),
    ]);

    expect(groups.map((group) => [group.origin, group.plugins.map((item) => item.id)])).toEqual([
      ['builtin', ['c', 'e']],
      ['registered', ['d']],
      ['kernel', ['a']],
      ['local', ['local-one']],
      ['market', ['b']],
    ]);
  });

  it('omits an origin that has no plugins', () => {
    expect(groupByOrigin([])).toEqual([]);
  });
});

describe('PluginsPanel', () => {
  it('shows a loading state, then the plugins grouped by origin', async () => {
    stubPlugins([
      plugin({ id: 'tool-registry', name: 'Tool Registry', origin: 'builtin' }),
      plugin({ id: 'server-echo', name: 'Server Echo' }),
    ]);

    renderPluginPanel();

    expect(screen.getByRole('status').textContent).toContain('正在读取插件');
    expect(await screen.findByText('Server Echo')).toBeTruthy();
    expect(screen.getByText('Tool Registry')).toBeTruthy();
    expect(screen.getByRole('heading', { name: /内置/ })).toBeTruthy();
    expect(screen.getByRole('heading', { name: /已注册/ })).toBeTruthy();
    expect(screen.getByText('2 个')).toBeTruthy();
  });

  it('shows what a plugin provides, its permissions and the versions it supports', async () => {
    stubPlugins([
      plugin({
        description: '回显文本',
        host: 'mcp',
        capabilities: ['tool', 'prompt', 'event', 'command'],
        engines: { weave: '>=1.0.0' },
        permissions: ['workspace:read', 'service:weave.session.store'],
        provides: {
          tools: ['echo', 'shout'],
          providers: [],
          promptSections: ['style'],
          events: ['server-echo/entry-added'],
          commands: ['recap'],
          hooks: ['weave.tools.policy'],
          services: [],
        },
      }),
    ]);

    renderPluginPanel();

    const item = (await screen.findByText('Server Echo')).closest('details');
    expect(item).not.toBeNull();
    const detail = within(item as HTMLElement);
    expect(detail.getByText('v1.2.3')).toBeTruthy();
    expect(detail.getByText('MCP')).toBeTruthy();
    expect(detail.getByText('server-echo')).toBeTruthy();
    expect(detail.getByText('回显文本')).toBeTruthy();
    expect(detail.getByText('工具', { selector: '.plugin-chip' })).toBeTruthy();
    expect(detail.getByText('提示词', { selector: '.plugin-chip' })).toBeTruthy();
    expect(detail.getByText('会话事件', { selector: '.plugin-chip' })).toBeTruthy();
    expect(detail.getByText('命令', { selector: '.plugin-chip' })).toBeTruthy();
    expect(detail.getByText('echo')).toBeTruthy();
    expect(detail.getByText('shout')).toBeTruthy();
    expect(detail.getByText('style')).toBeTruthy();
    expect(detail.getByText('server-echo/entry-added')).toBeTruthy();
    expect(detail.getByText('recap')).toBeTruthy();
    expect(detail.getByText('钩子', { selector: 'dt' })).toBeTruthy();
    expect(detail.getByText('weave.tools.policy')).toBeTruthy();
    expect(detail.getByText('读取工作区')).toBeTruthy();
    expect(detail.getByText('使用服务 weave.session.store')).toBeTruthy();
    expect(detail.getByText('>=1.0.0')).toBeTruthy();
  });

  it('renders future strings safely even when they match object prototype properties', async () => {
    stubPlugins([
      plugin({
        origin: 'constructor',
        host: '__proto__',
        state: 'toString',
        capabilities: ['constructor'],
        permissions: ['__proto__'],
      }),
    ]);
    renderPluginPanel();
    const name = await screen.findByText('Server Echo');
    fireEvent.click(name);
    expect(screen.getByRole('heading', { name: /constructor/ })).toBeTruthy();
    expect(screen.getByText('toString')).toBeTruthy();
    expect(screen.getAllByText('__proto__')).toHaveLength(2);
  });

  it('does not label an in-process plugin with its host', async () => {
    stubPlugins([plugin()]);

    renderPluginPanel();

    await screen.findByText('Server Echo');
    expect(screen.queryByText('进程内')).toBeNull();
    expect(screen.queryByText('in-process')).toBeNull();
  });

  it('explains an empty list', async () => {
    stubPlugins([]);

    renderPluginPanel();

    expect(await screen.findByText(/当前没有已加载的插件/)).toBeTruthy();
    expect(screen.getByText('0 个')).toBeTruthy();
  });

  it('reports a failed load and loads again on refresh', async () => {
    const fetchMock = stubPlugins(500, [plugin()]);

    renderPluginPanel();

    expect((await screen.findByRole('alert')).textContent).toContain('插件请求失败');

    fireEvent.click(screen.getByRole('button', { name: '刷新插件列表' }));

    expect(await screen.findByText('Server Echo')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not update after it is unmounted mid-request', async () => {
    let resolve: (response: Response) => void = () => undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(
        () =>
          new Promise<Response>((done) => {
            resolve = done;
          }),
      ),
    );

    const { unmount } = renderPluginPanel();
    unmount();
    resolve(new Response(JSON.stringify({ plugins: [] }), { status: 200 }));

    await Promise.resolve();
    expect(screen.queryByText(/当前没有已加载的插件/)).toBeNull();
  });
});

describe('local plugin management panel', () => {
  it('sorts local statuses stably and keeps unknown states read-only', async () => {
    stubCatalog(
      catalog(
        [
          'future',
          'invalid',
          'failed',
          'loaded',
          'changed',
          'pending-trust',
          'disabled',
          'incompatible',
          'changed',
        ].map((state, index) => localPlugin(state, `item-${String(index)}`)),
      ),
    );
    renderPluginPanel();
    await screen.findByText('item-5', { selector: '.plugin-name' });
    expect([...document.querySelectorAll('.plugin-name')].map((node) => node.textContent)).toEqual([
      'item-5',
      'item-4',
      'item-8',
      'item-3',
      'item-6',
      'item-2',
      'item-1',
      'item-7',
      'item-0',
    ]);
    for (const id of ['item-0', 'item-1', 'item-7']) {
      const row = screen.getByText(id, { selector: '.plugin-name' }).closest('li')!;
      fireEvent.click(within(row).getByText(id, { selector: '.plugin-name' }));
      expect(within(row).queryByRole('button')).toBeNull();
    }
  });

  it('opens captured review and submits its digest after the catalog changes', async () => {
    const initial = localPlugin();
    const changed = { ...initial, local: { ...initial.local!, digest: nextDigest } };
    const fetchMock = stubCatalog(
      catalog([initial]),
      { ...catalog([changed]), result: { generation: 1, unchanged: true, failed: [] } },
      {
        ...catalog([localPlugin('loaded')]),
        result: { generation: 2, unchanged: false, failed: [] },
      },
    );
    const store = createPluginCatalogStore();
    renderPluginPanel(false, store);
    await screen.findByText('local-echo', { selector: '.plugin-name' });
    fireEvent.click(screen.getByText('local-echo', { selector: '.plugin-name' }));
    fireEvent.click(screen.getByRole('button', { name: '审阅并信任' }));
    expect(screen.getByRole('dialog')).toBeTruthy();
    await store.reload();
    fireEvent.click(screen.getByRole('button', { name: '信任并启用' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    const [, request] = fetchMock.mock.calls[2]! as unknown as [string, RequestInit];
    expect(JSON.parse(String(request.body))).toEqual({ digest });
  });

  it('keeps cached rows visible and blocks all writes during a shared reload', async () => {
    const store = createPluginCatalogStore();
    const fetchMock = stubCatalog(catalog([localPlugin(), localPlugin('loaded', 'ready')]));
    renderPluginPanel(false, store);
    await screen.findByText('local-echo', { selector: '.plugin-name' });
    fireEvent.click(screen.getByText('local-echo', { selector: '.plugin-name' }));
    let finish: (response: Response) => void = () => undefined;
    fetchMock.mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          finish = resolve;
        }),
    );
    fireEvent.click(screen.getByRole('button', { name: '刷新插件列表' }));
    expect(screen.getByText('local-echo', { selector: '.plugin-name' })).toBeTruthy();
    expect((screen.getByRole('button', { name: '审阅并信任' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(
      (screen.getByRole('button', { name: '刷新插件列表' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    finish(
      new Response(
        JSON.stringify({
          ...catalog([localPlugin()]),
          result: { generation: 1, unchanged: true, failed: [] },
        }),
        { status: 200 },
      ),
    );
    await waitFor(() =>
      expect(
        (screen.getByRole('button', { name: '刷新插件列表' }) as HTMLButtonElement).disabled,
      ).toBe(false),
    );
  });

  it('hides ambiguous, reserved, malformed and metadata-free actions', async () => {
    stubCatalog(
      catalog([
        localPlugin('pending-trust', 'same'),
        {
          ...localPlugin('pending-trust', 'same'),
          local: { ...localPlugin().local!, directory: '/other' },
        },
        localPlugin('loaded', 'bad/id'),
        {
          ...localPlugin('loaded', 'reserved'),
          error: { code: 'plugin-id-reserved', message: 'reserved' },
        },
        plugin({ origin: 'local', state: 'pending-trust' }),
        localPlugin('future', 'future'),
      ]),
    );
    renderPluginPanel();
    await screen.findByText('future', { selector: '.plugin-name' });
    document.querySelectorAll('summary').forEach((summary) => fireEvent.click(summary));
    expect(screen.queryByRole('button', { name: /审阅|停用|启用|撤销/ })).toBeNull();
  });

  it('shows desired declarations, retained active identity, host limits and operation errors honestly', async () => {
    const changed = localPlugin('changed');
    const manifest = changed.local!.manifest!;
    stubCatalog(
      catalog(
        [
          {
            ...changed,
            local: { ...changed.local!, active: { generation: 1, digest: nextDigest, manifest } },
          },
        ],
        {
          exists: false,
          truncated: true,
          error: { code: 'discovery-failed', message: '无法完成扫描' },
          generation: {
            id: 1,
            acceptingRuns: false,
            plugins: [],
            blocked: { code: 'blocked', message: '等待重新构建' },
          },
        },
      ),
      {
        ...catalog([changed]),
        result: {
          generation: 1,
          unchanged: true,
          failed: [],
          error: { code: 'build-failed', message: '构建失败' },
        },
      },
    );
    renderPluginPanel();
    await screen.findByText('local-echo', { selector: '.plugin-name' });
    fireEvent.click(screen.getByText('local-echo', { selector: '.plugin-name' }));
    expect(screen.getByText('declared-echo')).toBeTruthy();
    expect(screen.getByText(/当前未提供贡献/)).toBeTruthy();
    expect(screen.getByText(nextDigest)).toBeTruthy();
    expect(screen.getByText(/目录不存在/)).toBeTruthy();
    expect(screen.getByText(/发现结果已截断/)).toBeTruthy();
    expect(screen.getByText(/无法完成扫描/)).toBeTruthy();
    expect(screen.getByText(/等待重新构建/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '刷新插件列表' }));
    expect(await screen.findByText(/构建失败/)).toBeTruthy();
  });

  it('routes enable directly and disable/revoke through explicit decisions with the chosen timing', async () => {
    const disabled = localPlugin('disabled');
    const loaded = localPlugin('loaded');
    const response = (row: PluginListItem) => ({
      ...catalog([row]),
      result: { generation: 1, unchanged: false, failed: [] },
    });
    const fetchMock = stubCatalog(
      catalog([disabled]),
      response(loaded),
      response(disabled),
      response(localPlugin()),
    );
    renderPluginPanel(true);
    await screen.findByText('local-echo', { selector: '.plugin-name' });
    fireEvent.click(screen.getByText('local-echo', { selector: '.plugin-name' }));
    fireEvent.click(screen.getByRole('button', { name: '启用' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    await waitFor(() => expect(screen.getByRole('button', { name: '停用' })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: '停用' }));
    expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: '确认停用' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    fireEvent.click(screen.getByRole('button', { name: '撤销信任' }));
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: '确认撤销信任' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    const requests = fetchMock.mock.calls as unknown as [string, RequestInit][];
    expect(requests.map(([url, init]) => [url, init.method])).toEqual([
      ['/plugins', 'GET'],
      ['/plugins/local-echo/enable', 'POST'],
      ['/plugins/local-echo/disable', 'POST'],
      ['/plugins/local-echo/trust?immediate=true', 'DELETE'],
    ]);
  });

  it('retains cached rows and shows the write failure after server reconciliation', async () => {
    const original = catalog([localPlugin('loaded')]);
    let writes = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        if (init?.method === 'POST') {
          writes += 1;
          return new Response(
            JSON.stringify({ error: { code: 'storage-failed', message: '保存失败' } }),
            { status: 500 },
          );
        }
        return new Response(
          JSON.stringify(writes === 0 ? original : catalog([localPlugin('disabled')])),
          { status: 200 },
        );
      }),
    );
    renderPluginPanel();
    await screen.findByText('local-echo', { selector: '.plugin-name' });
    fireEvent.click(screen.getByText('local-echo', { selector: '.plugin-name' }));
    fireEvent.click(screen.getByRole('button', { name: '停用' }));
    fireEvent.click(screen.getByRole('button', { name: '确认停用' }));
    await screen.findByText(/保存失败/, { selector: '.plugin-dialog-error' });
    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    expect(screen.getByText('local-echo', { selector: '.plugin-name' })).toBeTruthy();
    expect(screen.getByText('已停用')).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toContain('保存失败');
  });

  it('restores focus to the plugin tab after the reviewed row disappears', async () => {
    const store = createPluginCatalogStore();
    stubCatalog(catalog([localPlugin()]), {
      ...catalog([]),
      result: { generation: 2, unchanged: false, failed: [] },
    });
    render(
      <PluginCatalogProvider store={store}>
        <button data-plugin-tab="">插件标签</button>
        <PluginsPanel hasRunningSessions={false} />
      </PluginCatalogProvider>,
    );
    await screen.findByText('local-echo', { selector: '.plugin-name' });
    fireEvent.click(screen.getByText('local-echo', { selector: '.plugin-name' }));
    const review = screen.getByRole('button', { name: '审阅并信任' });
    review.focus();
    fireEvent.click(review);
    await act(async () => {
      await store.reload();
    });
    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    expect(document.activeElement).toBe(screen.getByRole('button', { name: '插件标签' }));
  });

  it('shows retained current-generation members independently from an empty discovery snapshot', async () => {
    const removed = localPlugin('loaded', 'removed-local');
    stubCatalog(
      catalog([], {
        generation: {
          id: 3,
          acceptingRuns: false,
          plugins: [{ id: removed.id, digest, manifest: removed.local!.manifest! }],
          blocked: { code: 'blocked', message: '需要重新加载' },
        },
      }),
    );
    renderPluginPanel();
    expect(await screen.findByText(/removed-local/)).toBeTruthy();
    expect(screen.getByText(digest)).toBeTruthy();
    expect(screen.getByRole('heading', { name: '当前加载集合' })).toBeTruthy();
    expect(screen.getByText(/没有发现插件/)).toBeTruthy();
    expect(screen.queryByText(/当前没有已加载的插件/)).toBeNull();
    expect(document.querySelectorAll('.plugin-item')).toHaveLength(0);
    expect(screen.queryByRole('button', { name: /审阅|停用|启用|撤销/ })).toBeNull();
  });

  it('mounts and remounts from the same StrictMode store with GET only', async () => {
    const fetchMock = stubCatalog(catalog([localPlugin()]));
    const store = createPluginCatalogStore();
    const first = render(
      <StrictMode>
        <PluginCatalogProvider store={store}>
          <PluginsPanel hasRunningSessions={false} />
        </PluginCatalogProvider>
      </StrictMode>,
    );
    await screen.findByText('local-echo', { selector: '.plugin-name' });
    first.unmount();
    renderPluginPanel(false, store);
    await screen.findByText('local-echo', { selector: '.plugin-name' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
