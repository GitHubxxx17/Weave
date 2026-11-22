// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

import {
  PluginCatalogProvider,
  PluginPendingBadge,
} from '../src/features/plugins/plugin-catalog-context.js';
import { createPluginCatalogStore } from '../src/features/plugins/plugin-catalog-store.js';
import { PluginsPanel } from '../src/features/plugins/plugins-panel.js';
import type { PluginListItem } from '../src/features/plugins/plugin-types.js';
import { disabledManagedCatalog } from './support/disabled-managed-catalog.js';
import { managedCatalog, managedPreview } from './support/managed-plugin-fixtures.js';
import type {
  McpManagementSnapshot,
  McpServerConfig,
  McpServerRecord,
} from '../src/features/mcp/mcp-types.js';

const digest = 'a'.repeat(64);
const previousDigest = 'b'.repeat(64);
const generation = { id: 3, acceptingRuns: true };
const config: McpServerConfig = {
  schemaVersion: 1,
  id: 'echo',
  label: 'Echo service',
  transport: 'stdio',
  command: '/usr/bin/node',
  args: ['/tools/echo.mjs', ''],
  cwd: '/workspace',
  env: {},
};
function server(over: Partial<McpServerRecord> = {}): McpServerRecord {
  return {
    config,
    configDigest: digest,
    enabled: true,
    state: 'loaded',
    stale: false,
    trustedDigest: digest,
    drainingGenerations: [],
    tools: [],
    ...over,
  };
}
function registry(id = 'mcp-echo'): PluginListItem {
  return {
    id,
    name: 'Echo service',
    version: '1.0.0',
    origin: 'kernel',
    host: 'mcp',
    state: 'loaded',
    capabilities: ['tool'],
    provides: {
      tools: ['mcp-echo--echo'],
      providers: [],
      promptSections: [],
      events: [],
      commands: [],
      hooks: [],
      services: [],
    },
  };
}
const json = (value: unknown, status = 200): Response =>
  new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
const disabledMcp = (): Response =>
  json({ error: { code: 'mcp-management-disabled', message: 'disabled' } }, 404);
function installFetchWithDisabledManaged(fetchMock: typeof fetch): void {
  vi.stubGlobal(
    'fetch',
    (input: RequestInfo | URL, init?: RequestInit) =>
      disabledManagedCatalog(input, init) ?? fetchMock(input, init),
  );
}
function setup(records: readonly McpServerRecord[], plugins: readonly PluginListItem[] = []) {
  let snapshot: McpManagementSnapshot = { authoritySequence: 7, generation, servers: records };
  const requests: { path: string; method: string; body: unknown }[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    const method = init?.method ?? 'GET';
    requests.push({
      path,
      method,
      body: init?.body === undefined ? undefined : (JSON.parse(String(init.body)) as unknown),
    });
    return path === '/mcp' ? json(snapshot) : json({ plugins, generation: snapshot.generation });
  });
  installFetchWithDisabledManaged(fetchMock);
  const store = createPluginCatalogStore();
  const view = render(
    <PluginCatalogProvider store={store}>
      <PluginPendingBadge />
      <PluginsPanel hasRunningSessions={false} />
    </PluginCatalogProvider>,
  );
  return {
    store,
    view,
    requests,
    fetchMock,
    setSnapshot(next: McpManagementSnapshot) {
      snapshot = next;
    },
  };
}
function openRow(label = config.label): HTMLElement {
  const row = screen.getByText(label, { selector: '.plugin-name' }).closest('details')!;
  fireEvent.click(within(row).getByText(label, { selector: '.plugin-name' }));
  return row;
}
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('MCP management panel', () => {
  it.each([
    ['编辑配置', '保存配置'],
    ['移除', '确认移除'],
  ])(
    'blocks an open %s confirmation after an unresolved managed write and a ready GET',
    async (action, confirm) => {
      const { store, fetchMock } = setup([server()]);
      const requests = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input) === '/plugins/managed' && init?.method === 'GET')
          return Promise.resolve(json({ ...managedCatalog, generation }));
        if (String(input) === '/plugins/managed/import')
          return Promise.resolve(json({ error: { code: 'lost', message: 'lost' } }, 503));
        return fetchMock(input, init);
      });
      vi.stubGlobal('fetch', requests);
      await act(async () => {
        await store.refresh();
      });
      await screen.findByText(config.label, { selector: '.plugin-name' });
      fireEvent.click(within(openRow()).getByRole('button', { name: action }));
      const button = screen.getByRole<HTMLButtonElement>('button', { name: confirm });
      if (action === '编辑配置')
        fireEvent.change(screen.getByLabelText('显示名称'), { target: { value: 'Edited echo' } });
      expect(button.disabled).toBe(false);
      await act(async () => {
        await store.submitManaged({
          kind: 'import',
          preview: {
            ...managedPreview,
            expectedInstallSequence: managedCatalog.heads.installSequence,
          },
        });
        await store.refresh();
      });
      expect(store.getSnapshot().consistency.kind).toBe('ready');
      expect(button.disabled).toBe(true);
      fireEvent.click(button);
      expect(
        requests.mock.calls
          .filter(([, init]) => init?.method !== 'GET')
          .map(([input]) => String(input)),
      ).toEqual(['/plugins/managed/import']);
    },
  );
  it('uses MCP health with independent stale state and joins registry contributions only once', async () => {
    setup(
      [
        server({
          state: 'failed',
          stale: true,
          issue: { code: 'mcp-disconnected', message: '连接已关闭' },
          active: { generation: 2, configDigest: previousDigest },
        }),
      ],
      [registry()],
    );
    await screen.findByText(config.label, { selector: '.plugin-name' });
    expect(screen.getAllByText(config.label, { selector: '.plugin-name' })).toHaveLength(1);
    const row = openRow();
    const detail = within(row);
    expect(detail.getByText('失败', { selector: '.plugin-state' })).toBeTruthy();
    expect(detail.getByText('工具列表已变化')).toBeTruthy();
    expect(detail.getByText(/连接已关闭/)).toBeTruthy();
    expect(detail.getByText('mcp-echo--echo')).toBeTruthy();
    expect(detail.queryByText('已加载', { selector: '.plugin-state' })).toBeNull();
    expect(detail.getByRole('button', { name: '全量重载扩展' })).toBeTruthy();
  });

  it('retains active and draining identities for disabled and removed services', async () => {
    setup([
      server({
        state: 'disabled',
        enabled: false,
        active: { generation: 2, configDigest: digest },
        drainingGenerations: [{ generation: 1, configDigest: previousDigest }],
      }),
      server({
        config: { ...config, id: 'removed', label: 'Removed service' },
        state: 'removed',
        enabled: false,
        active: { generation: 2, configDigest: previousDigest },
      }),
    ]);
    await screen.findByText(config.label, { selector: '.plugin-name' });
    const row = within(openRow());
    expect(row.getByText('已停用', { selector: '.plugin-state' })).toBeTruthy();
    expect(row.getByText(/正在使用：第 2 代/)).toBeTruthy();
    expect(row.getByText(/退役连接：第 1 代/)).toBeTruthy();
    expect(row.getByText(previousDigest)).toBeTruthy();
    const removed = within(openRow('Removed service'));
    expect(removed.getByText('已移除', { selector: '.plugin-state' })).toBeTruthy();
    expect(removed.getByText(/正在使用：第 2 代/)).toBeTruthy();
    expect(removed.queryByRole('button', { name: /编辑|信任|启用|停用|移除/ })).toBeNull();
  });

  it('shows orphan MCP registry entries as read-only diagnostics even on the legacy fallback', async () => {
    installFetchWithDisabledManaged(
      vi.fn(async (input: RequestInfo | URL) =>
        String(input) === '/mcp' ? disabledMcp() : json({ plugins: [registry('mcp-orphan')] }),
      ),
    );
    render(
      <PluginCatalogProvider store={createPluginCatalogStore()}>
        <PluginsPanel hasRunningSessions={false} />
      </PluginCatalogProvider>,
    );
    await screen.findByText('MCP 状态待同步');
    const row = within(openRow());
    expect(row.queryByText('已加载')).toBeNull();
    expect(row.queryByRole('button', { name: /编辑|信任|启用|停用|移除/ })).toBeNull();
    expect(row.getByRole('button', { name: '重新读取目录' })).toBeTruthy();
  });

  it('captures config sequence and saves without starting a trust request', async () => {
    const { store, requests, fetchMock } = setup([
      server({ state: 'untrusted', trustedDigest: undefined, enabled: false }),
    ]);
    await screen.findByText(config.label, { selector: '.plugin-name' });
    const record = within(openRow());
    fireEvent.click(record.getByRole('button', { name: '编辑配置' }));
    expect((screen.getByLabelText('服务 ID') as HTMLInputElement).readOnly).toBe(true);
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      const method = init?.method ?? 'GET';
      requests.push({
        path,
        method,
        body: init?.body === undefined ? undefined : (JSON.parse(String(init.body)) as unknown),
      });
      return json(
        path === '/plugins'
          ? { plugins: [], generation }
          : {
              authoritySequence: 8,
              generation,
              servers: [server({ state: 'untrusted', trustedDigest: undefined, enabled: false })],
              ...(method === 'PUT'
                ? { result: { decisionSequence: 8, applied: true, unchanged: false, failed: [] } }
                : {}),
            },
      );
    });
    fireEvent.click(screen.getByRole('button', { name: '保存配置' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(requests.filter(({ method }) => method !== 'GET')).toEqual([
      { path: '/mcp/servers/echo', method: 'PUT', body: { expectedSequence: 7, config } },
    ]);
    expect(store.getSnapshot().mcpLastResult?.decisionSequence).toBe(8);
  });

  it('invalidates an open captured review when authority changes and combines pending review badges', async () => {
    const { store, setSnapshot, requests } = setup(
      [server({ state: 'changed', configDigest: previousDigest })],
      [registry()],
    );
    await screen.findByLabelText('1 个插件待审阅');
    fireEvent.click(within(openRow()).getByRole('button', { name: '审阅差异' }));
    expect((screen.getByLabelText('完整配置摘要') as HTMLInputElement).value).toBe(previousDigest);
    setSnapshot({ authoritySequence: 8, generation, servers: [server({ state: 'changed' })] });
    await act(async () => {
      await store.refresh();
    });
    expect((screen.getByRole('button', { name: '信任并启用' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect((screen.getByLabelText('完整配置摘要') as HTMLInputElement).value).toBe(previousDigest);
    expect(screen.getByRole('dialog').textContent).toContain('失效');
    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    expect(requests.every(({ method }) => method === 'GET')).toBe(true);
  });

  it('submits immediate decisions unchanged when no visible session is running and retains results across remount', async () => {
    const { store, view, requests, fetchMock } = setup([server()]);
    await screen.findByText(config.label, { selector: '.plugin-name' });
    fireEvent.click(within(openRow()).getByRole('button', { name: '停用' }));
    fireEvent.click(screen.getByRole('checkbox'));
    let finish!: (response: Response) => void;
    const pending = new Promise<Response>((resolve) => {
      finish = resolve;
    });
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      const method = init?.method ?? 'GET';
      requests.push({
        path,
        method,
        body: init?.body === undefined ? undefined : (JSON.parse(String(init.body)) as unknown),
      });
      if (method === 'POST') return pending;
      return json(
        path === '/plugins'
          ? { plugins: [], generation }
          : {
              authoritySequence: 8,
              generation,
              servers: [server({ state: 'disabled', enabled: false })],
            },
      );
    });
    fireEvent.click(screen.getByRole('button', { name: '确认停用' }));
    await waitFor(() => expect(requests.some(({ method }) => method === 'POST')).toBe(true));
    view.unmount();
    render(
      <PluginCatalogProvider store={store}>
        <PluginsPanel hasRunningSessions={false} />
      </PluginCatalogProvider>,
    );
    expect(
      (screen.getByRole('button', { name: '添加 MCP 服务' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    await act(async () => {
      finish(
        json({
          authoritySequence: 8,
          generation,
          servers: [server({ state: 'disabled', enabled: false })],
          result: { decisionSequence: 8, applied: true, unchanged: false, failed: [] },
        }),
      );
      await pending;
    });
    await screen.findByText(/决定序号：8/);
    expect(requests.filter(({ method }) => method === 'POST')).toEqual([
      {
        path: '/mcp/servers/echo/disable',
        method: 'POST',
        body: { expectedSequence: 7, immediate: true },
      },
    ]);
  });

  it('marks retained data old and displays the actual mutation generation when pairing fails', async () => {
    const { fetchMock } = setup([server({ state: 'failed', stale: true })]);
    await screen.findByText(config.label, { selector: '.plugin-name' });
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) =>
      json(
        String(input) === '/plugins'
          ? { plugins: [], generation: { id: 4, acceptingRuns: true } }
          : {
              authoritySequence: 8,
              generation: { id: 5, acceptingRuns: false },
              servers: [],
              ...(init?.method === 'POST'
                ? {
                    result: {
                      decisionSequence: 8,
                      applied: false,
                      unchanged: false,
                      failed: [{ id: 'echo', error: { code: 'mcp-failed', message: '无法启动' } }],
                      error: { code: 'rebuild-failed', message: '未完成重建' },
                    },
                  }
                : {}),
            },
      ),
    );
    fireEvent.click(within(openRow()).getByRole('button', { name: '全量重载扩展' }));
    await screen.findByText(/决定序号：8/);
    expect(screen.getByText(/本次结果：第 5 代/).textContent).toContain('暂停接受新回合');
    expect(screen.getByText(/旧目录/)).toBeTruthy();
    expect(screen.getByText(/无法启动/)).toBeTruthy();
    expect((screen.getByRole('button', { name: '编辑配置' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(
      (screen.getByRole('button', { name: '添加 MCP 服务' }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it('renders server tool metadata as plain data including special JSON keys', async () => {
    const hostile = '<img src=x onerror=alert(1)>';
    setup([
      server({
        tools: [
          {
            name: 'original echo',
            toolName: 'mcp-echo--echo',
            description: hostile,
            inputSchema: JSON.parse(
              '{"type":"object","__proto__":{"text":"<script>bad</script>"}}',
            ) as Record<string, unknown>,
            outputSchema: { type: 'string' },
            annotations: { readOnlyHint: true, title: hostile },
          },
        ],
      }),
    ]);
    await screen.findByText(config.label, { selector: '.plugin-name' });
    const row = within(openRow());
    expect(row.getByText('original echo')).toBeTruthy();
    expect(row.getAllByText(/readOnlyHint|__proto__/)).toHaveLength(2);
    expect(row.getByText(/高风险/)).toBeTruthy();
    expect(row.queryByRole('button', { name: /调用|执行工具/ })).toBeNull();
    expect(document.querySelector('img, script')).toBeNull();
  });

  it('counts MCP reviews without synthetic duplicates and limits only live configurations', async () => {
    const records = Array.from({ length: 8 }, (_, index) =>
      server({
        config: { ...config, id: `echo-${index}`, label: `Service ${index}` },
        state: 'untrusted',
        trustedDigest: undefined,
        enabled: false,
      }),
    );
    const { store, setSnapshot } = setup(records, [registry('mcp-echo-0')]);
    await screen.findByLabelText('8 个插件待审阅');
    expect(
      (screen.getByRole('button', { name: '添加 MCP 服务' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    setSnapshot({
      authoritySequence: 8,
      generation,
      servers: records.map((record, index) =>
        index === 0 ? { ...record, state: 'removed' } : record,
      ),
    });
    await act(async () => {
      await store.refresh();
    });
    expect(
      (screen.getByRole('button', { name: '添加 MCP 服务' }) as HTMLButtonElement).disabled,
    ).toBe(false);
    expect(screen.getByLabelText('7 个插件待审阅')).toBeTruthy();
  });

  it('uses current trust for enable and captured digest for the separate trust action', async () => {
    const { requests, fetchMock } = setup([server({ state: 'disabled', enabled: false })]);
    await screen.findByText(config.label, { selector: '.plugin-name' });
    let row = within(openRow());
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      const method = init?.method ?? 'GET';
      requests.push({
        path,
        method,
        body: init?.body === undefined ? undefined : (JSON.parse(String(init.body)) as unknown),
      });
      return json(
        path === '/plugins'
          ? { plugins: [], generation }
          : {
              authoritySequence: 8,
              generation,
              servers: [server({ state: 'untrusted', trustedDigest: undefined, enabled: false })],
              ...(method === 'POST'
                ? { result: { decisionSequence: 8, applied: true, unchanged: false, failed: [] } }
                : {}),
            },
      );
    });
    fireEvent.click(row.getByRole('button', { name: '启用' }));
    await screen.findByLabelText('1 个插件待审阅');
    row = within(screen.getByText(config.label, { selector: '.plugin-name' }).closest('details')!);
    fireEvent.click(row.getByRole('button', { name: '审阅并信任' }));
    fireEvent.click(screen.getByRole('button', { name: '信任并启用' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(requests.filter(({ method }) => method === 'POST')).toEqual([
      {
        path: '/mcp/servers/echo/enable',
        method: 'POST',
        body: { expectedSequence: 7, configDigest: digest },
      },
      {
        path: '/mcp/servers/echo/trust',
        method: 'POST',
        body: { expectedSequence: 8, configDigest: digest },
      },
    ]);
  });

  it.each([
    ['撤销信任', '确认撤销信任', 'revoke'],
    ['移除', '确认移除', 'remove'],
  ])(
    'confirms %s with the captured authority and default timing',
    async (name, confirm, action) => {
      const { requests, fetchMock } = setup([server()]);
      await screen.findByText(config.label, { selector: '.plugin-name' });
      fireEvent.click(within(openRow()).getByRole('button', { name }));
      fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = String(input);
        const method = init?.method ?? 'GET';
        requests.push({
          path,
          method,
          body: init?.body === undefined ? undefined : (JSON.parse(String(init.body)) as unknown),
        });
        return json(
          path === '/plugins'
            ? { plugins: [], generation }
            : {
                authoritySequence: 8,
                generation,
                servers: [],
                ...(method === 'POST'
                  ? { result: { decisionSequence: 8, applied: true, unchanged: false, failed: [] } }
                  : {}),
              },
        );
      });
      fireEvent.click(screen.getByRole('button', { name: confirm }));
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
      expect(requests.filter(({ method }) => method === 'POST')).toEqual([
        {
          path: `/mcp/servers/echo/${action}`,
          method: 'POST',
          body: { expectedSequence: 7, immediate: false },
        },
      ]);
    },
  );

  it('blocks ordinary plugin authority actions while joint data is refreshing or unavailable', async () => {
    const manifest = {
      id: 'local-tool',
      name: 'Local Tool',
      version: '1.0.0',
      apiVersion: '1',
      capabilities: [],
    };
    const local: PluginListItem = {
      ...registry('local-tool'),
      name: 'Local Tool',
      origin: 'local',
      host: 'in-process',
      state: 'pending-trust',
      local: { directory: '/plugins/local-tool', enabled: false, digest, manifest },
    };
    let unavailable = false;
    let finish!: (response: Response) => void;
    installFetchWithDisabledManaged(
      vi.fn(async (input: RequestInfo | URL) => {
        if (unavailable && String(input) === '/mcp')
          return new Promise<Response>((resolve) => {
            finish = resolve;
          });
        return json(
          String(input) === '/plugins'
            ? {
                plugins: [local],
                generation,
                local: {
                  directory: '/plugins',
                  exists: true,
                  truncated: false,
                  trustSequence: 0,
                  generation: { ...generation, plugins: [] },
                },
              }
            : { authoritySequence: 7, generation, servers: [server()] },
        );
      }),
    );
    const store = createPluginCatalogStore();
    render(
      <PluginCatalogProvider store={store}>
        <PluginsPanel hasRunningSessions={false} />
      </PluginCatalogProvider>,
    );
    await screen.findByText('Local Tool', { selector: '.plugin-name' });
    const localRow = screen
      .getByText('Local Tool', { selector: '.plugin-name' })
      .closest('details')!;
    fireEvent.click(within(localRow).getByText('Local Tool', { selector: '.plugin-name' }));
    unavailable = true;
    let refreshing!: Promise<void>;
    act(() => {
      refreshing = store.refresh();
    });
    expect((screen.getByRole('button', { name: '审阅并信任' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    await waitFor(() => expect(finish).toBeTypeOf('function'));
    await act(async () => {
      finish(json({ error: { code: 'mcp-unavailable', message: '读取失败' } }, 500));
      await refreshing.catch(() => undefined);
    });
    expect(screen.getByText(/旧目录/)).toBeTruthy();
    expect((screen.getByRole('button', { name: '审阅并信任' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it.each(['esm', 'mcp'])(
    'shares the %s pending operation across both management groups',
    async (source) => {
      const manifest = {
        id: 'local-tool',
        name: 'Local Tool',
        version: '1.0.0',
        apiVersion: '1',
        capabilities: [],
      };
      const local: PluginListItem = {
        ...registry('local-tool'),
        name: 'Local Tool',
        origin: 'local',
        host: 'in-process',
        state: 'pending-trust',
        local: { directory: '/plugins/local-tool', enabled: false, digest, manifest },
      };
      const pluginSnapshot = {
        plugins: [local],
        generation,
        local: {
          directory: '/plugins',
          exists: true,
          truncated: false,
          trustSequence: 0,
          generation: { ...generation, plugins: [] },
        },
      };
      let finish!: (response: Response) => void;
      const pending = new Promise<Response>((resolve) => {
        finish = resolve;
      });
      installFetchWithDisabledManaged(
        vi.fn(async (input: RequestInfo | URL, init?: RequestInit) =>
          init?.method === 'POST'
            ? pending
            : json(
                String(input) === '/plugins'
                  ? pluginSnapshot
                  : {
                      authoritySequence: 7,
                      generation,
                      servers: [
                        server({ state: 'untrusted', trustedDigest: undefined, enabled: false }),
                      ],
                    },
              ),
        ),
      );
      const store = createPluginCatalogStore();
      render(
        <PluginCatalogProvider store={store}>
          <PluginsPanel hasRunningSessions={false} />
        </PluginCatalogProvider>,
      );
      await screen.findByText('Local Tool', { selector: '.plugin-name' });
      for (const row of document.querySelectorAll('.plugin-item'))
        fireEvent.click(row.querySelector('summary')!);
      let operation!: Promise<void>;
      act(() => {
        operation =
          source === 'esm' ? store.trust('local-tool', digest) : store.configureMcp(7, config);
      });
      expect(
        screen
          .getAllByRole('button', { name: '审阅并信任' })
          .every((button) => (button as HTMLButtonElement).disabled),
      ).toBe(true);
      expect(
        (screen.getByRole('button', { name: '添加 MCP 服务' }) as HTMLButtonElement).disabled,
      ).toBe(true);
      await act(async () => {
        finish(
          json(
            source === 'esm'
              ? { ...pluginSnapshot, result: { generation: 3, unchanged: true, failed: [] } }
              : {
                  authoritySequence: 7,
                  generation,
                  servers: [server()],
                  result: { decisionSequence: 7, applied: true, unchanged: false, failed: [] },
                },
          ),
        );
        await operation;
      });
      expect(
        (screen.getByRole('button', { name: '添加 MCP 服务' }) as HTMLButtonElement).disabled,
      ).toBe(false);
    },
  );
});
