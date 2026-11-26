// @vitest-environment jsdom

import { act, cleanup, renderHook } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, expect, it, vi } from 'vitest';

import type { OpenMenu, StudioProject } from '../src/app/app-types.js';
import { useWorkspaceNavigation } from '../src/app/use-workspace-navigation.js';
import { WorkspaceApiError } from '../src/features/workspace/workspace-api.js';

const api = vi.hoisted(() => ({
  createProject: vi.fn(),
  createSession: vi.fn(),
  renameProject: vi.fn(),
  renameSession: vi.fn(),
  updateProjectFolder: vi.fn(),
}));

vi.mock('../src/features/workspace/workspace-api.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/features/workspace/workspace-api.js')>()),
  createWorkspaceApi: () => api,
}));

const project: StudioProject = {
  id: 'project-1',
  name: 'Weave',
  folderName: 'weave',
  folderPath: '/work/weave',
  sessions: [
    {
      id: 'session-1',
      title: '第一个会话',
      lastUsedLabel: '最近使用',
      archivedAt: null,
      messages: [],
      turns: [],
      detailKnown: true,
    },
  ],
};

function setup(overrides: { runStatus?: 'idle' | 'streaming' } = {}) {
  const onNotice = vi.fn();
  const onProjectCreated = vi.fn();
  const applySessionDetail = vi.fn(() => true);
  const hook = renderHook(() => {
    const [projects, setProjects] = useState<readonly StudioProject[]>([project]);
    const [, setOpenMenu] = useState<OpenMenu>('more');
    const navigation = useWorkspaceNavigation({
      projects,
      setProjects,
      setOpenMenu,
      onNotice,
      directoryInputRef: { current: null },
      getSessionRunStatus: () => overrides.runStatus ?? 'idle',
      applySessionDetail,
      onProjectCreated,
    });
    return { projects, ...navigation };
  });
  return { ...hook, onNotice, onProjectCreated, applySessionDetail };
}

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

it('renames a session through the editor and applies the returned detail', async () => {
  const { result, applySessionDetail } = setup();
  const detail = { id: 'session-1', title: '新标题' };
  api.renameSession.mockResolvedValue(detail);

  act(() => result.current.openSessionEditor('project-1', 'session-1'));
  expect(result.current.editingSession).toEqual({ projectId: 'project-1', sessionId: 'session-1' });
  expect(result.current.sessionTitleInput).toBe('第一个会话');

  act(() => result.current.setSessionTitleInput('  新标题  '));
  await act(async () => {
    await result.current.saveSessionTitle();
  });

  expect(api.renameSession).toHaveBeenCalledWith('session-1', '新标题');
  expect(applySessionDetail).toHaveBeenCalledWith('project-1', detail);
  expect(result.current.editingSession).toBeNull();
});

it('does not open the session editor while the session is streaming', () => {
  const { result } = setup({ runStatus: 'streaming' });
  act(() => result.current.openSessionEditor('project-1', 'session-1'));
  expect(result.current.editingSession).toBeNull();
});

it('renames a project in the list and reports API failures as a notice', async () => {
  const { result, onNotice } = setup();
  api.renameProject.mockResolvedValue({ ...project, name: '改名后' });

  act(() => result.current.openProjectRename(project));
  expect(result.current.projectRenameInput).toBe('Weave');
  act(() => result.current.setProjectRenameInput('改名后'));
  await act(async () => {
    await result.current.saveProjectName();
  });
  expect(result.current.projects[0]?.name).toBe('改名后');
  expect(result.current.renamingProjectId).toBeNull();

  api.renameProject.mockRejectedValue(new WorkspaceApiError('session-not-found', 'x', 404));
  act(() => result.current.openProjectRename(project));
  await act(async () => {
    await result.current.saveProjectName();
  });
  expect(onNotice).toHaveBeenCalledWith('会话不存在，请重新加载工作区');
  expect(result.current.renamingProjectId).toBe('project-1');
});

it('creates a project with its first session and hands it to the App', async () => {
  const { result, onProjectCreated } = setup();
  api.createProject.mockResolvedValue({
    id: 'project-2',
    name: 'Docs',
    folderName: 'docs',
    folderPath: '/work/docs',
  });
  api.createSession.mockResolvedValue({
    id: 'session-9',
    title: '新会话',
    archivedAt: null,
    lastSequence: 0,
    messages: [],
    turns: [],
  });

  act(() => result.current.openProjectDialog());
  expect(result.current.isProjectDialogOpen).toBe(true);
  act(() => result.current.setSearchQuery('abc'));

  // Without folder info nothing is created.
  await act(async () => {
    await result.current.createProject();
  });
  expect(api.createProject).not.toHaveBeenCalled();

  act(() => result.current.setProjectName('Docs'));
  act(() => result.current.setSelectedFolderPath('/work/docs'));
  const input = document.createElement('input');
  Object.defineProperty(input, 'files', {
    value: [{ webkitRelativePath: 'docs/readme.md', name: 'readme.md' }],
  });
  act(() => result.current.chooseFallbackFolder({ target: input } as never));
  expect(result.current.selectedFolderName).toBe('docs');

  await act(async () => {
    await result.current.createProject();
  });

  expect(api.createProject).toHaveBeenCalledWith({
    name: 'docs',
    folderName: 'docs',
    folderPath: '/work/docs',
  });
  expect(onProjectCreated).toHaveBeenCalledTimes(1);
  const [created, session] = onProjectCreated.mock.calls[0] as [
    StudioProject,
    StudioProject['sessions'][number],
  ];
  expect(created.id).toBe('project-2');
  expect(created.sessions.map((entry) => entry.id)).toEqual(['session-9']);
  expect(session.id).toBe('session-9');
  expect(result.current.isProjectDialogOpen).toBe(false);
  expect(result.current.searchQuery).toBe('');
});

it('saves and clears a project folder, keeping the dialog open on failure', async () => {
  const { result, onNotice } = setup();
  api.updateProjectFolder.mockResolvedValue({ ...project, folderPath: '/other' });

  act(() => result.current.openFolderDialog(project));
  expect(result.current.folderDialogPath).toBe('/work/weave');
  await act(async () => {
    await result.current.saveProjectFolder('/other');
  });
  expect(result.current.projects[0]?.folderPath).toBe('/other');
  expect(result.current.folderDialogProjectId).toBeNull();
  expect(onNotice).toHaveBeenCalledWith('项目文件夹已更新');

  api.updateProjectFolder.mockRejectedValue(
    new WorkspaceApiError('project-folder-invalid', 'x', 400),
  );
  act(() => result.current.openFolderDialog(project));
  await act(async () => {
    await result.current.saveProjectFolder('/bad');
  });
  expect(result.current.folderDialogError).toBe('文件夹路径无效，请填写本机已存在的文件夹绝对路径');
  expect(result.current.folderDialogProjectId).toBe('project-1');
});
