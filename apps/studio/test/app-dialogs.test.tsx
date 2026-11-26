// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ImagePreviewDialog } from '../src/app/image-preview-dialog.js';
import {
  CreateProjectDialog,
  FolderDialog,
  RenameProjectDialog,
} from '../src/app/project-dialogs.js';
import { ProviderDeleteDialog, ProviderFormDialog } from '../src/app/provider-dialogs.js';
import { QueuedCopyDialog } from '../src/app/queued-copy-dialog.js';
import { DeleteSessionDialog, EditSessionDialog } from '../src/app/session-dialogs.js';
import type { StudioProject } from '../src/app/app-types.js';

afterEach(cleanup);

function backdropMouseDown(container: HTMLElement): void {
  fireEvent.mouseDown(container.querySelector('.dialog-backdrop') as HTMLElement);
}

describe('QueuedCopyDialog', () => {
  it('appends, replaces or cancels', () => {
    const copyRequest = { snapshot: { id: 'snap' }, owner: { id: 'owner' } } as never;
    const applyQueuedCopy = vi.fn();
    const setCopyRequest = vi.fn();
    render(
      <QueuedCopyDialog
        copyRequest={copyRequest}
        applyQueuedCopy={applyQueuedCopy}
        setCopyRequest={setCopyRequest}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: '追加到草稿' }));
    fireEvent.click(screen.getByRole('button', { name: '替换草稿' }));
    fireEvent.click(screen.getByRole('button', { name: '取消复制' }));
    expect(applyQueuedCopy.mock.calls).toEqual([
      [{ id: 'snap' }, { id: 'owner' }, true],
      [{ id: 'snap' }, { id: 'owner' }, false],
    ]);
    expect(setCopyRequest).toHaveBeenCalledWith(null);
  });
});

describe('ImagePreviewDialog', () => {
  it('renders the image and closes from the button or the backdrop', () => {
    const setPreviewImage = vi.fn();
    render(
      <ImagePreviewDialog
        previewImage={{ mediaType: 'image/png', data: 'AAAA' }}
        setPreviewImage={setPreviewImage}
      />,
    );
    expect(screen.getByAltText('图片预览').getAttribute('src')).toBe('data:image/png;base64,AAAA');
    fireEvent.click(screen.getByRole('button', { name: '关闭预览' }));
    fireEvent.mouseDown(screen.getByRole('dialog', { name: '图片预览' }));
    expect(setPreviewImage).toHaveBeenCalledTimes(2);
    expect(setPreviewImage).toHaveBeenCalledWith(null);
  });
});

describe('session dialogs', () => {
  it('edits a title, blocks an empty one and closes from the backdrop', () => {
    const props = {
      sessionTitleInput: '旧标题',
      setSessionTitleInput: vi.fn(),
      setEditingSession: vi.fn(),
      saveSessionTitle: vi.fn(async () => undefined),
    };
    const { container, rerender } = render(<EditSessionDialog {...props} />);
    fireEvent.change(screen.getByLabelText('会话标题'), { target: { value: '新标题' } });
    expect(props.setSessionTitleInput).toHaveBeenCalledWith('新标题');
    fireEvent.click(screen.getByRole('button', { name: '保存标题' }));
    expect(props.saveSessionTitle).toHaveBeenCalledTimes(1);
    backdropMouseDown(container);
    expect(props.setEditingSession).toHaveBeenCalledWith(null);
    rerender(<EditSessionDialog {...props} sessionTitleInput="  " />);
    expect((screen.getByRole('button', { name: '保存标题' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it('confirms a permanent delete or cancels it', () => {
    const props = {
      sessionToDelete: { projectId: 'p', sessionId: 's', title: '会话二' },
      setSessionToDelete: vi.fn(),
      permanentlyDeleteSession: vi.fn(async () => undefined),
    };
    render(<DeleteSessionDialog {...props} />);
    expect(screen.getByText(/会话二/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '确认删除' }));
    expect(props.permanentlyDeleteSession).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    expect(props.setSessionToDelete).toHaveBeenCalledWith(null);
  });
});

describe('provider dialogs', () => {
  const providerForm = {
    mode: 'create',
    editingId: null,
    providerPresetId: 'custom',
    modelPresetId: '',
    id: '',
    label: '',
    baseUrl: '',
    apiKey: '',
    defaultModel: '',
    makeDefault: false,
    clearApiKey: false,
    contextWindowTokens: '',
    temperature: '',
    maxTokens: '',
  } as const;

  function formProps(overrides: Record<string, unknown> = {}) {
    return {
      providerForm,
      providerFormError: null,
      providerMutation: 'idle',
      chooseProviderPreset: vi.fn(),
      chooseModelPreset: vi.fn(),
      closeProviderForm: vi.fn(),
      updateProviderForm: vi.fn(),
      saveProvider: vi.fn(async () => undefined),
      ...overrides,
    };
  }

  it('edits fields, saves and closes the form', () => {
    const props = formProps();
    const { container } = render(<ProviderFormDialog {...(props as never)} />);
    expect(screen.getByRole('heading', { name: '添加 AI 服务' })).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Provider ID'), { target: { value: 'deepseek' } });
    expect(props.updateProviderForm).toHaveBeenCalledWith('id', 'deepseek');
    fireEvent.submit(screen.getByLabelText('Provider ID').closest('form') as HTMLFormElement);
    expect(props.saveProvider).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: '关闭 Provider 表单' }));
    backdropMouseDown(container);
    expect(props.closeProviderForm).toHaveBeenCalledTimes(2);
  });

  it('locks the close button while saving', () => {
    render(<ProviderFormDialog {...(formProps({ providerMutation: 'saving' }) as never)} />);
    expect(
      (screen.getByRole('button', { name: '关闭 Provider 表单' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(screen.getByText('保存中...')).toBeTruthy();
  });

  it('confirms or cancels deleting a provider', () => {
    const props = {
      providerToDelete: { id: 'p1', label: 'Provider 一' },
      providerMutation: 'idle',
      deleteProvider: vi.fn(async () => undefined),
      setProviderToDelete: vi.fn(),
    };
    render(<ProviderDeleteDialog {...(props as never)} />);
    expect(screen.getByText(/Provider 一/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '确认删除' }));
    expect(props.deleteProvider).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    expect(props.setProviderToDelete).toHaveBeenCalledWith(null);
  });
});

describe('project dialogs', () => {
  it('renames a project and blocks an empty name', () => {
    const props = {
      projectRenameInput: '项目 A',
      setProjectRenameInput: vi.fn(),
      setRenamingProjectId: vi.fn(),
      saveProjectName: vi.fn(async () => undefined),
    };
    const { container, rerender } = render(<RenameProjectDialog {...props} />);
    fireEvent.change(screen.getByLabelText('新的项目名称'), { target: { value: '项目 B' } });
    expect(props.setProjectRenameInput).toHaveBeenCalledWith('项目 B');
    fireEvent.submit(screen.getByLabelText('新的项目名称').closest('form') as HTMLFormElement);
    expect(props.saveProjectName).toHaveBeenCalledTimes(1);
    backdropMouseDown(container);
    expect(props.setRenamingProjectId).toHaveBeenCalledWith(null);
    rerender(<RenameProjectDialog {...props} projectRenameInput="" />);
    expect(
      (screen.getByRole('button', { name: '保存项目名称' }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it('sets a project folder and closes', () => {
    const projects = [
      { id: 'project-a', name: '项目 A', folderName: 'project-a' },
    ] as unknown as StudioProject[];
    const props = {
      folderDialogProjectId: 'project-a',
      folderDialogPath: '/work/a',
      folderDialogError: '无法读取该文件夹',
      setFolderDialogPath: vi.fn(),
      setFolderDialogProjectId: vi.fn(),
      pickFolderForDialog: vi.fn(async () => undefined),
      saveProjectFolder: vi.fn(async () => undefined),
      projects,
    };
    const { container } = render(<FolderDialog {...(props as never)} />);
    expect(screen.getByText('无法读取该文件夹')).toBeTruthy();
    backdropMouseDown(container);
    expect(props.setFolderDialogProjectId).toHaveBeenCalledWith(null);
  });

  it('creates a project from a name and a folder', () => {
    const props = {
      projectName: '',
      setProjectName: vi.fn(),
      selectedFolderName: '',
      selectedFolderPath: '',
      setSelectedFolderPath: vi.fn(),
      setIsProjectDialogOpen: vi.fn(),
      chooseProjectFolder: vi.fn(async () => undefined),
      chooseFallbackFolder: vi.fn(),
      createProject: vi.fn(async () => undefined),
      directoryInputRef: { current: null },
    };
    const { container } = render(<CreateProjectDialog {...(props as never)} />);
    backdropMouseDown(container);
    expect(props.setIsProjectDialogOpen).toHaveBeenCalledWith(false);
  });
});
