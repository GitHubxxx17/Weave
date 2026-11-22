// @vitest-environment jsdom

import { createRef } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

import { PanelContainer } from '../src/features/panel/panel-container.js';
import { PluginCatalogProvider } from '../src/features/plugins/plugin-catalog-context.js';
import { createPluginCatalogStore } from '../src/features/plugins/plugin-catalog-store.js';
import type { PanelContext } from '../src/features/panel/panel-data.js';
import { disabledManagedCatalog } from './support/disabled-managed-catalog.js';

function installFetchWithDisabledManaged(fetchMock: typeof fetch): void {
  vi.stubGlobal(
    'fetch',
    (input: RequestInfo | URL, init?: RequestInit) =>
      disabledManagedCatalog(input, init) ?? fetchMock(input, init),
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
beforeEach(() => {
  localStorage.clear();
  installFetchWithDisabledManaged(
    vi.fn(async (input: RequestInfo | URL) =>
      String(input) === '/mcp'
        ? disabledMcp()
        : new Response(JSON.stringify({ plugins: [] }), { status: 200 }),
    ),
  );
});

function disabledMcp(): Response {
  return new Response(
    JSON.stringify({ error: { code: 'mcp-management-disabled', message: 'disabled' } }),
    { status: 404 },
  );
}

function panelContext(): PanelContext {
  return {
    statusKey: 'completed',
    statusLabel: '已完成',
    isRunning: false,
    hasRunningSessions: false,
    sessionLabel: '会话',
    folderPath: '/Users/me/project',
    projectId: 'project-1',
    modelLabel: 'mock',
    turns: [],
    messages: [],
    errorMessage: null,
    formatTime: () => '',
    onSetFolder: () => undefined,
    onJumpToMessage: () => undefined,
  };
}

function renderPanel() {
  return render(
    <PluginCatalogProvider store={createPluginCatalogStore()}>
      <PanelContainer
        context={panelContext()}
        collapsed={false}
        width={360}
        shellRef={createRef<HTMLElement>()}
        conversationRef={createRef<HTMLElement>()}
        onResize={vi.fn()}
        onCollapse={vi.fn()}
      />
    </PluginCatalogProvider>,
  );
}

/** Opens the add menu and clicks the panel with the given label. */
function addPanel(name: string): void {
  fireEvent.click(screen.getByRole('button', { name: '添加面板' }));
  fireEvent.click(screen.getByRole('menuitem', { name }));
}

describe('PanelContainer multi-tab', () => {
  it('opens the five pinned panels and no preview or terminal by default', () => {
    renderPanel();
    for (const label of ['概览', '文件', '工具', '用量', '上下文']) {
      expect(screen.getByRole('tab', { name: label })).toBeTruthy();
    }
    expect(screen.queryByRole('tab', { name: '预览' })).toBeNull();
    expect(screen.queryByRole('tab', { name: '终端' })).toBeNull();
  });

  it('opens two independent preview tabs and numbers the duplicates', () => {
    renderPanel();

    addPanel('预览');
    expect(screen.getByRole('tab', { name: '预览' })).toBeTruthy();
    expect(screen.getAllByRole('region', { name: '预览' })).toHaveLength(1);

    addPanel('预览');
    expect(screen.getByRole('tab', { name: '预览 1' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: '预览 2' })).toBeTruthy();
    // Each tab mounts its own iframe host (kept alive, hidden when inactive),
    // so two preview regions coexist in the DOM.
    expect(screen.getAllByRole('region', { name: '预览', hidden: true })).toHaveLength(2);
  });

  it('opens two independent terminal tabs', () => {
    renderPanel();

    addPanel('终端');
    addPanel('终端');

    expect(screen.getByRole('tab', { name: '终端 1' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: '终端 2' })).toBeTruthy();
    expect(screen.getAllByRole('region', { name: '终端', hidden: true })).toHaveLength(2);
  });

  it('closes one duplicate and drops the numbering from the survivor', () => {
    renderPanel();
    addPanel('预览');
    addPanel('预览');

    fireEvent.click(screen.getByRole('button', { name: '关闭预览 2' }));

    expect(screen.queryByRole('tab', { name: '预览 2' })).toBeNull();
    expect(screen.getByRole('tab', { name: '预览' })).toBeTruthy();
    expect(screen.getAllByRole('region', { name: '预览' })).toHaveLength(1);
  });

  it('focuses an already open single-instance panel instead of duplicating it', () => {
    renderPanel();

    addPanel('用量');

    expect(screen.getAllByRole('tab', { name: '用量' })).toHaveLength(1);
  });

  it('persists opened tabs to the v2 layout key', () => {
    renderPanel();
    addPanel('终端');

    const raw = localStorage.getItem('weave.studio.panelTabs.v2');
    expect(raw).not.toBeNull();
    const stored = JSON.parse(raw ?? '{}') as { tabs: { kind: string }[] };
    expect(stored.tabs.some((tab) => tab.kind === 'terminal')).toBe(true);
  });

  it('reorders tabs by dragging one before another and persists the order', () => {
    renderPanel();
    const tablist = screen.getByRole('tablist', { name: '面板标签' });
    const contextTab = screen.getByRole('tab', { name: '上下文' }).closest('.panel-tab');
    const overviewTab = screen.getByRole('tab', { name: '概览' }).closest('.panel-tab');
    expect(contextTab).not.toBeNull();
    expect(overviewTab).not.toBeNull();

    const dataTransfer = { effectAllowed: '', dropEffect: '', setData: vi.fn(), getData: vi.fn() };
    fireEvent.dragStart(contextTab as Element, { dataTransfer });
    // jsdom reports a zero-sized rect, so clientX 0 lands before the target.
    fireEvent.dragOver(overviewTab as Element, { dataTransfer, clientX: 0 });
    fireEvent.drop(overviewTab as Element, { dataTransfer });

    const order = within(tablist)
      .getAllByRole('tab')
      .map((tab) => tab.textContent);
    expect(order[0]).toBe('上下文');
    expect(order[1]).toBe('概览');

    const layout = JSON.parse(localStorage.getItem('weave.studio.panelTabs.v2') ?? '{}') as {
      tabs: { kind: string }[];
    };
    expect(layout.tabs[0]?.kind).toBe('context');
  });
});

const managedCatalog = {
  plugins: [],
  local: {
    directory: '/plugins',
    exists: true,
    truncated: false,
    trustSequence: 0,
    generation: { id: 1, acceptingRuns: true, plugins: [] },
  },
};

describe('plugin activation boundary', () => {
  it('only reads on restored mount and every activation while explicit reload writes once', async () => {
    localStorage.setItem(
      'weave.studio.panelTabs.v2',
      JSON.stringify({ tabs: [{ id: 'plugins', kind: 'plugins' }], active: 'plugins', pinned: [] }),
    );
    const methods: string[] = [];
    installFetchWithDisabledManaged(
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        if (String(_input) === '/mcp') return disabledMcp();
        const method = init?.method ?? 'GET';
        methods.push(method);
        return new Response(
          JSON.stringify(
            method === 'GET'
              ? managedCatalog
              : { ...managedCatalog, result: { generation: 1, unchanged: true, failed: [] } },
          ),
          { status: 200 },
        );
      }),
    );
    renderPanel();
    await screen.findByText('0 个');
    expect(methods).toEqual(['GET']);
    fireEvent.click(screen.getByRole('tab', { name: '插件' }));
    await waitFor(() => expect(methods).toEqual(['GET', 'GET']));
    await waitFor(() =>
      expect(
        (screen.getByRole('button', { name: '刷新插件列表' }) as HTMLButtonElement).disabled,
      ).toBe(false),
    );
    addPanel('插件');
    await waitFor(() => expect(methods).toEqual(['GET', 'GET', 'GET']));
    expect(screen.getAllByRole('tab', { name: '插件' })).toHaveLength(1);
    await waitFor(() =>
      expect(
        (screen.getByRole('button', { name: '刷新插件列表' }) as HTMLButtonElement).disabled,
      ).toBe(false),
    );
    fireEvent.click(screen.getByRole('button', { name: '关闭插件' }));
    addPanel('插件');
    await waitFor(() => expect(methods).toEqual(['GET', 'GET', 'GET', 'GET']));
    fireEvent.click(screen.getByRole('button', { name: '刷新插件列表' }));
    await waitFor(() => expect(methods).toEqual(['GET', 'GET', 'GET', 'GET', 'POST']));
  });

  it('shares a pending-review badge between the add menu and plugin tab', async () => {
    const manifest = {
      id: 'new-plugin',
      name: 'New Plugin',
      version: '1.0.0',
      apiVersion: '1',
      capabilities: [],
    };
    const plugins = [
      {
        ...manifest,
        origin: 'local',
        host: 'in-process',
        state: 'pending-trust',
        provides: {
          tools: [],
          providers: [],
          promptSections: [],
          events: [],
          commands: [],
          hooks: [],
          services: [],
        },
        local: {
          directory: '/plugins/new-plugin',
          digest: 'a'.repeat(64),
          enabled: false,
          manifest,
        },
      },
    ];
    installFetchWithDisabledManaged(
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) =>
        String(_input) === '/mcp'
          ? disabledMcp()
          : new Response(
              JSON.stringify(
                init?.method === 'POST'
                  ? { ...managedCatalog, result: { generation: 1, unchanged: false, failed: [] } }
                  : { ...managedCatalog, plugins },
              ),
              { status: 200 },
            ),
      ),
    );
    renderPanel();
    fireEvent.click(screen.getByRole('button', { name: '添加面板' }));
    await screen.findByLabelText('1 个插件待审阅');
    fireEvent.click(screen.getByRole('menuitem', { name: /插件/ }));
    expect(screen.getByRole('tab', { name: /插件/ }).textContent).toContain('1');
    await waitFor(() => expect(screen.getByLabelText('1 个插件待审阅')).toBeTruthy());
  });

  it('keeps old-server explicit activation and refresh on GET', async () => {
    const methods: string[] = [];
    installFetchWithDisabledManaged(
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        if (String(_input) === '/mcp') return disabledMcp();
        methods.push(init?.method ?? 'GET');
        return new Response(JSON.stringify({ plugins: [] }), { status: 200 });
      }),
    );
    renderPanel();
    await waitFor(() => expect(methods).toEqual(['GET']));
    addPanel('插件');
    await waitFor(() => expect(methods).toEqual(['GET', 'GET']));
    await waitFor(() =>
      expect(
        (screen.getByRole('button', { name: '刷新插件列表' }) as HTMLButtonElement).disabled,
      ).toBe(false),
    );
    fireEvent.click(screen.getByRole('button', { name: '刷新插件列表' }));
    await waitFor(() => expect(methods).toEqual(['GET', 'GET', 'GET']));
  });
});
