// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { StudioProject, StudioSession } from '../src/app/app-types.js';
import { SessionRail, type SessionRailProps } from '../src/app/session-rail.js';
import { SettingsSidebar } from '../src/app/settings-sidebar.js';
import { WorkspaceNav } from '../src/app/workspace-nav.js';
import { PluginCatalogProvider } from '../src/features/plugins/plugin-catalog-context.js';
import { createPluginCatalogStore } from '../src/features/plugins/plugin-catalog-store.js';

afterEach(cleanup);

function session(id: string, title: string): StudioSession {
  return { id, title, lastUsedLabel: '刚刚使用', archivedAt: null } as unknown as StudioSession;
}

const project = {
  id: 'project-a',
  name: '项目 A',
  folderName: 'project-a',
  folderPath: '/project-a',
  sessions: [session('s1', '第一个会话'), session('s2', '第二个会话')],
} as unknown as StudioProject;

function railProps(overrides: Partial<SessionRailProps> = {}): SessionRailProps {
  return {
    activeView: 'studio',
    openMenu: null,
    projects: [project],
    visibleProjects: [project],
    activeProject: project,
    activeProjectId: 'project-a',
    activeSessionId: 's1',
    expandedProjectIds: ['project-a'],
    normalizedSearchQuery: '',
    isSearchOpen: false,
    searchQuery: '',
    setIsSearchOpen: vi.fn(),
    setSearchQuery: vi.fn(),
    isSessionStreaming: () => false,
    toggleMenu: vi.fn(),
    selectProject: vi.fn(),
    openFolderDialog: vi.fn(),
    openProjectDialog: vi.fn(),
    createSession: vi.fn(async () => undefined),
    toggleProjectExpanded: vi.fn(),
    selectProjectSession: vi.fn(),
    openSessionEditor: vi.fn(),
    archiveSession: vi.fn(async () => undefined),
    ...overrides,
  };
}

describe('WorkspaceNav', () => {
  it('marks the active view and reports selections', () => {
    const onSelectView = vi.fn();
    render(
      <PluginCatalogProvider store={createPluginCatalogStore()}>
        <WorkspaceNav activeView="history" onSelectView={onSelectView} />
      </PluginCatalogProvider>,
    );
    expect(screen.getByRole('button', { name: '历史' }).getAttribute('aria-current')).toBe('page');
    expect(screen.getByRole('button', { name: '工作台' }).getAttribute('aria-current')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '插件市场' }));
    fireEvent.click(screen.getByRole('button', { name: '设置' }));
    expect(onSelectView.mock.calls).toEqual([['marketplace'], ['settings']]);
  });
});

describe('SettingsSidebar', () => {
  it('lists the settings categories and enables every one', () => {
    render(<SettingsSidebar />);
    expect(screen.getByRole('button', { name: '模型服务' })).toBeTruthy();
    for (const name of [/运行权限/, /界面外观/]) {
      expect((screen.getByRole('button', { name }) as HTMLButtonElement).disabled).toBe(false);
    }
  });
});

describe('SessionRail', () => {
  it('selects, edits and archives sessions through the callbacks', () => {
    const props = railProps();
    render(<SessionRail {...props} />);
    fireEvent.click(screen.getByRole('button', { name: '会话：第二个会话' }));
    expect(props.selectProjectSession).toHaveBeenCalledWith('project-a', 's2');
    fireEvent.click(screen.getAllByRole('button', { name: '编辑会话' })[0] as HTMLElement);
    expect(props.openSessionEditor).toHaveBeenCalledWith('project-a', 's1');
    fireEvent.click(screen.getAllByRole('button', { name: '归档会话' })[1] as HTMLElement);
    expect(props.archiveSession).toHaveBeenCalledWith('project-a', 's2');
    fireEvent.click(screen.getByRole('button', { name: '新建会话' }));
    expect(props.createSession).toHaveBeenCalledTimes(1);
  });

  it('shows a running dot and disables edit and archive for a streaming session', () => {
    render(<SessionRail {...railProps({ isSessionStreaming: (id) => id === 's2' })} />);
    expect(screen.getAllByLabelText('运行中')).toHaveLength(1);
    const archive = screen.getAllByRole('button', { name: '归档会话' }) as HTMLButtonElement[];
    expect(archive.map((button) => button.disabled)).toEqual([false, true]);
  });

  it('collapses a project and shows the empty search state', () => {
    const props = railProps({ expandedProjectIds: [] });
    const { rerender } = render(<SessionRail {...props} />);
    expect(screen.queryByRole('button', { name: '会话：第一个会话' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '展开项目 项目 A' }));
    expect(props.toggleProjectExpanded).toHaveBeenCalledWith('project-a');
    rerender(<SessionRail {...railProps({ visibleProjects: [], normalizedSearchQuery: 'x' })} />);
    expect(screen.getByText('没有匹配的会话')).toBeTruthy();
  });

  it('is hidden for the full-width product pages and opens the search box', () => {
    const props = railProps({ activeView: 'marketplace' });
    const { container, rerender } = render(<SessionRail {...props} />);
    expect((container.querySelector('.session-rail') as HTMLElement).hidden).toBe(true);
    rerender(<SessionRail {...railProps({ isSearchOpen: true, searchQuery: 'abc' })} />);
    const input = screen.getByLabelText('搜索会话') as HTMLInputElement;
    expect(input.value).toBe('abc');
    fireEvent.click(screen.getByRole('button', { name: '关闭搜索' }));
  });
});
