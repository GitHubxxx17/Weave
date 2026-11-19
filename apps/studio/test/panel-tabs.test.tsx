// @vitest-environment jsdom

import { createRef } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';

import { PanelContainer } from '../src/features/panel/panel-container.js';
import type { PanelContext } from '../src/features/panel/panel-data.js';

afterEach(cleanup);
beforeEach(() => {
  localStorage.clear();
});

function panelContext(): PanelContext {
  return {
    statusKey: 'completed',
    statusLabel: '已完成',
    isRunning: false,
    sessionLabel: '会话',
    folderPath: '/Users/me/project',
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
    <PanelContainer
      context={panelContext()}
      collapsed={false}
      width={360}
      shellRef={createRef<HTMLElement>()}
      conversationRef={createRef<HTMLElement>()}
      onResize={vi.fn()}
      onCollapse={vi.fn()}
    />,
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
