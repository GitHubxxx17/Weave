// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';

import type { PluginListItem } from '../src/features/plugins/plugin-types.js';
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
    origin: 'registered',
    host: 'in-process',
    capabilities: ['tool'],
    provides: { tools: ['echo'], providers: [], promptSections: [], services: [] },
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
      plugin({ id: 'c', origin: 'builtin' }),
      plugin({ id: 'd', origin: 'registered' }),
      plugin({ id: 'e', origin: 'builtin' }),
    ]);

    expect(groups.map((group) => [group.origin, group.plugins.map((item) => item.id)])).toEqual([
      ['builtin', ['c', 'e']],
      ['registered', ['d']],
      ['kernel', ['a']],
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

    render(<PluginsPanel />);

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
        capabilities: ['tool', 'prompt'],
        engines: { weave: '>=1.0.0' },
        permissions: ['workspace:read', 'service:weave.session.store'],
        provides: {
          tools: ['echo', 'shout'],
          providers: [],
          promptSections: ['style'],
          services: [],
        },
      }),
    ]);

    render(<PluginsPanel />);

    const item = (await screen.findByText('Server Echo')).closest('details');
    expect(item).not.toBeNull();
    const detail = within(item as HTMLElement);
    expect(detail.getByText('v1.2.3')).toBeTruthy();
    expect(detail.getByText('MCP')).toBeTruthy();
    expect(detail.getByText('server-echo')).toBeTruthy();
    expect(detail.getByText('回显文本')).toBeTruthy();
    expect(detail.getByText('工具', { selector: '.plugin-chip' })).toBeTruthy();
    expect(detail.getByText('提示词', { selector: '.plugin-chip' })).toBeTruthy();
    expect(detail.getByText('echo')).toBeTruthy();
    expect(detail.getByText('shout')).toBeTruthy();
    expect(detail.getByText('style')).toBeTruthy();
    expect(detail.getByText('读取工作区')).toBeTruthy();
    expect(detail.getByText('使用服务 weave.session.store')).toBeTruthy();
    expect(detail.getByText('>=1.0.0')).toBeTruthy();
  });

  it('does not label an in-process plugin with its host', async () => {
    stubPlugins([plugin()]);

    render(<PluginsPanel />);

    await screen.findByText('Server Echo');
    expect(screen.queryByText('进程内')).toBeNull();
    expect(screen.queryByText('in-process')).toBeNull();
  });

  it('explains an empty list', async () => {
    stubPlugins([]);

    render(<PluginsPanel />);

    expect(await screen.findByText(/当前没有已加载的插件/)).toBeTruthy();
    expect(screen.getByText('0 个')).toBeTruthy();
  });

  it('reports a failed load and loads again on refresh', async () => {
    const fetchMock = stubPlugins(500, [plugin()]);

    render(<PluginsPanel />);

    expect((await screen.findByRole('alert')).textContent).toContain('读取插件列表失败');

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

    const { unmount } = render(<PluginsPanel />);
    unmount();
    resolve(new Response(JSON.stringify({ plugins: [] }), { status: 200 }));

    await Promise.resolve();
    expect(screen.queryByText(/当前没有已加载的插件/)).toBeNull();
  });
});
