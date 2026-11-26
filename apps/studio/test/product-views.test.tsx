// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ArchivedView } from '../src/app/archived-view.js';
import type { StudioProject } from '../src/app/app-types.js';
import { HistoryView } from '../src/app/history-view.js';
import { ProjectsView } from '../src/app/projects-view.js';
import { ProviderSettingsView } from '../src/app/provider-settings-view.js';
import type { ProviderDescriptor } from '../src/features/providers/provider-types.js';

afterEach(cleanup);

const project = {
  id: 'project-a',
  name: '项目 A',
  folderName: 'project-a',
  folderPath: '/work/project-a',
  sessions: [
    { id: 's1', title: '会话一', archivedAt: null },
    { id: 's2', title: '会话二', archivedAt: '2026-11-20T08:00:00.000Z' },
  ],
} as unknown as StudioProject;
const noFolderProject = {
  id: 'project-b',
  name: '项目 B',
  folderName: 'project-b',
  sessions: [],
} as unknown as StudioProject;

describe('ProjectsView', () => {
  function renderView(sessionHasWork = false) {
    const props = {
      projects: [project, noFolderProject],
      activeProjectId: 'project-a',
      sessionHasWork,
      openProjectDialog: vi.fn(),
      openProject: vi.fn(),
      createSessionForProject: vi.fn(async () => undefined),
      openProjectRename: vi.fn(),
      openFolderDialog: vi.fn(),
    };
    render(<ProjectsView {...props} />);
    return props;
  }

  it('lists projects, marks the current one and reports actions', () => {
    const props = renderView();
    expect(screen.getByText('当前')).toBeTruthy();
    expect(screen.getByText('1 个会话')).toBeTruthy();
    expect(screen.getByText('未设置文件夹路径')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '打开项目 项目 B' }));
    expect(props.openProject).toHaveBeenCalledWith('project-b');
    fireEvent.click(screen.getByRole('button', { name: '在 项目 A 中新建会话' }));
    expect(props.createSessionForProject).toHaveBeenCalledWith('project-a');
    fireEvent.click(screen.getByRole('button', { name: '重命名项目 项目 A' }));
    expect(props.openProjectRename).toHaveBeenCalledWith(project);
    fireEvent.click(screen.getByRole('button', { name: '设置项目 项目 A 的文件夹' }));
    expect(props.openFolderDialog).toHaveBeenCalledWith(project);
    fireEvent.click(screen.getByRole('button', { name: '创建项目' }));
    expect(props.openProjectDialog).toHaveBeenCalledTimes(1);
  });

  it('locks project actions while the active session has work', () => {
    renderView(true);
    const locked = screen
      .getAllByRole('button')
      .filter((button) => (button.getAttribute('aria-label') ?? '').includes('项目 A'));
    expect(locked.length).toBeGreaterThan(0);
    expect(locked.every((button) => (button as HTMLButtonElement).disabled)).toBe(true);
  });
});

describe('ArchivedView', () => {
  it('shows the empty state without archived sessions', () => {
    render(
      <ArchivedView
        archivedProjects={[]}
        sessionHasWork={false}
        restoreSession={vi.fn(async () => undefined)}
        setSessionToDelete={vi.fn()}
      />,
    );
    expect(screen.getByText('暂无归档会话')).toBeTruthy();
  });

  it('restores or requests deletion of an archived session', () => {
    const restoreSession = vi.fn(async () => undefined);
    const setSessionToDelete = vi.fn();
    const archived = {
      ...project,
      sessions: [{ id: 's2', title: '会话二', archivedAt: '2026-11-20T08:00:00.000Z' }],
    } as unknown as StudioProject;
    render(
      <ArchivedView
        archivedProjects={[archived]}
        sessionHasWork={false}
        restoreSession={restoreSession}
        setSessionToDelete={setSessionToDelete}
      />,
    );
    expect(screen.getByText('1 个归档会话')).toBeTruthy();
    expect(screen.getByText(/^归档于 /)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '恢复会话 会话二' }));
    expect(restoreSession).toHaveBeenCalledWith('project-a', 's2');
    fireEvent.click(screen.getByRole('button', { name: '删除会话 会话二' }));
    expect(setSessionToDelete).toHaveBeenCalledWith({
      projectId: 'project-a',
      sessionId: 's2',
      title: '会话二',
    });
  });

  it('disables restore and delete while the active session has work', () => {
    render(
      <ArchivedView
        archivedProjects={[project]}
        sessionHasWork
        restoreSession={vi.fn(async () => undefined)}
        setSessionToDelete={vi.fn()}
      />,
    );
    expect(
      (screen.getByRole('button', { name: '恢复会话 会话二' }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });
});

describe('ProviderSettingsView', () => {
  const providers = [
    { id: 'p1', label: 'Provider 一', defaultModel: 'm1', hasApiKey: true, editable: true },
    { id: 'p2', label: 'Provider 二', hasApiKey: false, editable: true },
  ] as unknown as ProviderDescriptor[];

  function renderView(canManage: boolean, providerMutation: 'idle' | 'saving' = 'idle') {
    const props = {
      providerSettings: { canManage, defaultProvider: 'p1', providers },
      providerMutation,
      openProviderForm: vi.fn(),
      setDefaultProvider: vi.fn(async () => undefined),
      setProviderToDelete: vi.fn(),
    };
    render(<ProviderSettingsView {...(props as never)} />);
    return props;
  }

  it('shows status, default mark and management actions when providers are managed', () => {
    const props = renderView(true);
    expect(screen.getByText('默认')).toBeTruthy();
    expect(screen.getByText('需要配置 API Key')).toBeTruthy();
    expect(screen.getByText('未设置默认模型')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '添加 AI 服务' }));
    expect(props.openProviderForm).toHaveBeenCalledWith();
    fireEvent.click(screen.getByRole('button', { name: '编辑 Provider Provider 二' }));
    expect(props.openProviderForm).toHaveBeenCalledWith(providers[1]);
    fireEvent.click(screen.getByRole('button', { name: '删除 Provider Provider 一' }));
    expect(props.setProviderToDelete).toHaveBeenCalledWith(providers[0]);
    const makeDefault = screen.getByRole('button', { name: '设为默认' }) as HTMLButtonElement;
    expect(makeDefault.disabled).toBe(true);
  });

  it('is read-only without management and locks actions during a mutation', () => {
    renderView(false);
    expect(screen.queryByRole('button', { name: '添加 AI 服务' })).toBeNull();
    expect(screen.getByText(/浏览器开发模式下/)).toBeTruthy();
    cleanup();
    renderView(true, 'saving');
    expect(
      (screen.getByRole('button', { name: '添加 AI 服务' }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });
});

describe('HistoryView', () => {
  it('renders the page heading and the placeholder', () => {
    render(<HistoryView title="历史" description="运行记录和会话时间线将在这里统一展示" />);
    expect(screen.getByRole('heading', { name: '历史' })).toBeTruthy();
    expect(screen.getByText('暂无历史记录')).toBeTruthy();
  });
});
