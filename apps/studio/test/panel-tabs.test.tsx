// @vitest-environment jsdom

import { createRef } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';

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

function panelElement(routeHidden = false) {
  return (
    <PluginCatalogProvider store={createPluginCatalogStore()}>
      <PanelContainer
        context={panelContext()}
        collapsed={false}
        routeHidden={routeHidden}
        width={360}
        shellRef={createRef<HTMLElement>()}
        conversationRef={createRef<HTMLElement>()}
        onResize={vi.fn()}
        onCollapse={vi.fn()}
      />
    </PluginCatalogProvider>
  );
}

function renderPanel() {
  return render(panelElement());
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

describe('panel layout migration', () => {
  it('drops legacy and future kinds without resetting surviving ids, order or pins', () => {
    localStorage.setItem(
      'weave.studio.panelTabs.v2',
      JSON.stringify({
        tabs: [
          { id: 'terminal:shell-a', kind: 'terminal' },
          { id: 'plugins', kind: 'plugins' },
          { id: 'preview:site', kind: 'preview' },
          { id: 'future:one', kind: 'future-panel' },
          { id: 'terminal:shell-b', kind: 'terminal' },
        ],
        pinned: ['plugins', 'preview:site', 'terminal:shell-b', 'future:one'],
        active: 'plugins',
      }),
    );
    renderPanel();
    const tablist = screen.getByRole('tablist', { name: '面板标签' });
    expect(
      within(tablist)
        .getAllByRole('tab')
        .map((tab) => tab.textContent),
    ).toEqual(['终端 1', '预览', '终端 2']);
    expect(screen.getByRole('tab', { name: '终端 1' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('button', { name: '关闭终端 1' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: '关闭预览' })).toBeNull();
    expect(screen.queryByRole('button', { name: '关闭终端 2' })).toBeNull();
    fireEvent.click(screen.getByRole('tab', { name: '预览' }));
    expect(JSON.parse(localStorage.getItem('weave.studio.panelTabs.v2') ?? '{}')).toEqual({
      tabs: [
        { id: 'terminal:shell-a', kind: 'terminal' },
        { id: 'preview:site', kind: 'preview' },
        { id: 'terminal:shell-b', kind: 'terminal' },
      ],
      pinned: ['preview:site', 'terminal:shell-b'],
      active: 'preview:site',
    });
  });

  it('preserves an active surviving tab and falls back to defaults when no tabs survive', () => {
    localStorage.setItem(
      'weave.studio.panelTabs.v2',
      JSON.stringify({
        tabs: [
          { id: 'plugins', kind: 'plugins' },
          { id: 'preview:saved', kind: 'preview' },
        ],
        pinned: [],
        active: 'preview:saved',
      }),
    );
    const panel = renderPanel();
    expect(screen.getByRole('tab', { name: '预览' }).getAttribute('aria-selected')).toBe('true');
    panel.unmount();
    localStorage.setItem(
      'weave.studio.panelTabs.v2',
      JSON.stringify({
        tabs: [{ id: 'plugins', kind: 'plugins' }],
        pinned: ['plugins'],
        active: 'plugins',
      }),
    );
    renderPanel();
    expect(screen.getByRole('tab', { name: '概览' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.queryByRole('tab', { name: '插件' })).toBeNull();
    expect(screen.queryByRole('button', { name: '关闭概览' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '添加面板' }));
    expect(screen.queryByRole('menuitem', { name: '插件' })).toBeNull();
    expect(screen.getByRole('menuitem', { name: /终端/ })).toBeTruthy();
  });

  it('hides route-inactive panels and their resizer while retaining live preview nodes', () => {
    const panel = renderPanel();
    addPanel('预览');
    const preview = screen.getByRole('region', { name: '预览' });
    fireEvent.change(within(preview).getByRole('textbox', { name: '预览网址' }), {
      target: { value: 'localhost:5173' },
    });
    fireEvent.click(within(preview).getByRole('button', { name: '打开' }));
    const frame = preview.querySelector('iframe');
    panel.rerender(panelElement(true));
    expect(screen.queryByRole('complementary', { name: '运行活动' })).toBeNull();
    expect(screen.queryByRole('separator', { name: '调整面板宽度' })).toBeNull();
    expect(document.querySelector('.preview-panel iframe')).toBe(frame);
    panel.rerender(panelElement(false));
    expect(screen.getByRole('tab', { name: '预览' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('separator', { name: '调整面板宽度' })).toBeTruthy();
    expect(document.querySelector('.preview-panel iframe')).toBe(frame);
  });
});
