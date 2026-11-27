// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ChatHeader, type ChatHeaderProps } from '../src/app/chat-header.js';
import { Composer, type ComposerProps } from '../src/app/composer.js';
import { TaskDisclosure } from '../src/app/task-disclosure.js';
import { createConversationStore } from '../src/features/conversation/conversation-store.js';

afterEach(cleanup);

function headerProps(overrides: Partial<ChatHeaderProps> = {}): ChatHeaderProps {
  return {
    activeProject: { id: 'p', name: 'P', folderName: 'weave' } as never,
    activeProjectId: 'p',
    activeSession: { id: 's', title: '我的会话' } as never,
    activeSessionId: 's',
    activeTaskRoot: '',
    activeChildTask: undefined,
    taskState: { pending: new Set<string>(), stop: vi.fn(async () => undefined) } as never,
    openMenu: null,
    isActivityPanelOpen: true,
    setIsActivityPanelOpen: vi.fn(),
    toggleMenu: vi.fn(),
    showNotice: vi.fn(),
    clearActiveRunState: vi.fn(),
    selectProjectSession: vi.fn(),
    ...overrides,
  };
}

describe('ChatHeader', () => {
  it('shows the breadcrumb and toggles the session menu', () => {
    const props = headerProps();
    render(<ChatHeader {...props} />);
    expect(screen.getByText('weave')).toBeTruthy();
    expect(screen.getByText('我的会话')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '更多操作' }));
    expect(props.toggleMenu).toHaveBeenCalledWith('more');
    expect(screen.queryByRole('button', { name: '显示上下文' })).toBeNull();
  });

  it('copies the session id and clears the run state from the open menu', () => {
    const props = headerProps({ openMenu: 'more' });
    render(<ChatHeader {...props} />);
    fireEvent.click(screen.getByRole('menuitem', { name: /复制会话标识/ }));
    expect(props.showNotice).toHaveBeenCalledWith('会话标识：s');
    fireEvent.click(screen.getByRole('menuitem', { name: /清空运行状态/ }));
    expect(props.clearActiveRunState).toHaveBeenCalledTimes(1);
    expect(props.showNotice).toHaveBeenLastCalledWith('运行状态已清空');
  });

  it('offers a parent link for task sessions and a context toggle when collapsed', () => {
    const props = headerProps({
      activeSession: { id: 'child', title: '子会话', taskOrigin: { taskId: 't' } } as never,
      activeTaskRoot: 'root',
      isActivityPanelOpen: false,
    });
    render(<ChatHeader {...props} />);
    fireEvent.click(screen.getByRole('button', { name: '返回父会话' }));
    expect(props.selectProjectSession).toHaveBeenCalledWith('p', 'root');
    fireEvent.click(screen.getByRole('button', { name: '显示上下文' }));
    expect(props.setIsActivityPanelOpen).toHaveBeenCalledWith(true);
  });

  it('stops a running child task and locks the button while it is pending', () => {
    const task = { taskId: 't1', status: 'running' } as never;
    const stop = vi.fn(async () => undefined);
    const props = headerProps({
      activeChildTask: task,
      taskState: { pending: new Set<string>(), stop } as never,
    });
    const { rerender } = render(<ChatHeader {...props} />);
    fireEvent.click(screen.getByRole('button', { name: '停止子任务' }));
    expect(stop).toHaveBeenCalledWith('t1');
    rerender(<ChatHeader {...props} taskState={{ pending: new Set(['t1']), stop } as never} />);
    expect((screen.getByRole('button', { name: '停止子任务' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });
});

describe('TaskDisclosure', () => {
  it('summarizes the task count and pending approvals', () => {
    render(
      <TaskDisclosure
        activeTaskRoot="root"
        taskState={
          {
            tasks: [{ taskId: 't', pendingApprovalCount: 1 }],
            pending: new Set<string>(),
            snapshot: { totalCount: 3 },
            reconnecting: true,
            loadingPage: false,
            nextCursor: undefined,
            error: undefined,
            loadMore: vi.fn(),
            stop: vi.fn(),
          } as never
        }
        openAgentTask={vi.fn(async () => undefined)}
        prepareTaskDraft={vi.fn()}
      />,
    );
    expect(screen.getByText(/并行子任务（3） · 有待审批 · 正在重连…/)).toBeTruthy();
  });
});

function composerProps(overrides: Partial<ComposerProps> = {}): ComposerProps {
  const noop = vi.fn();
  return {
    activeProject: { id: 'p', name: 'P', folderName: 'weave', folderPath: '/w' } as never,
    activeProjectId: 'p',
    activeSessionId: 's',
    activeTaskRoot: '',
    isChildSession: false,
    canCompose: true,
    status: 'idle',
    activeRunState: { status: 'idle', errorMessage: null },
    admitting: {},
    activeQueue: undefined,
    queueController: { pending: {}, cancel: noop, move: noop } as never,
    conversationStore: createConversationStore(),
    taskState: { tasks: [], error: undefined },
    approvals: { pending: [], decide: noop } as never,
    taskForApproval: () => undefined,
    inspectApproval: noop,
    composerDraft: {
      draft: { text: '', files: [], contexts: [], images: [], literalSend: false },
      removeFile: noop,
      removeContext: noop,
    } as never,
    messageInput: '',
    setMessageInput: vi.fn(),
    pendingImages: [],
    commandPicker: { open: false, items: [], activeIndex: 0, close: noop } as never,
    filePicker: {
      open: false,
      buttonMode: false,
      items: [],
      close: noop,
      openFromButton: noop,
      updateSelection: noop,
    } as never,
    sessionSkills: {
      open: false,
      draft: { selected: [], revision: 0 },
      catalogState: { catalog: undefined, loading: false, error: undefined },
      close: noop,
      show: noop,
    } as never,
    messageInputRef: { current: null },
    imageInputRef: { current: null },
    composerIsComposing: { current: false },
    viewerFilePath: null,
    gitChangesAvailability: undefined,
    addComposerContext: noop,
    addViewerFileContext: noop,
    addImageFiles: vi.fn(async () => undefined),
    removePendingImage: noop,
    handleComposerPaste: noop,
    providerSettings: {
      canManage: false,
      defaultProvider: 'p1',
      providers: [{ id: 'p1', label: 'Provider 一', defaultModel: 'm1' }],
    } as never,
    selectedProvider: { id: 'p1', label: 'Provider 一' } as never,
    selectedProviderId: 'p1',
    selectedModel: 'm1',
    reasoningEffort: 'medium',
    setReasoningEffort: noop,
    chooseProvider: noop,
    permissionMode: 'ask',
    setPermissionMode: vi.fn(),
    openMenu: null,
    setOpenMenu: vi.fn(),
    toggleMenu: noop,
    setIsActivityPanelOpen: noop,
    handleSubmit: vi.fn((event: { preventDefault: () => void }) => event.preventDefault()),
    handleMessageKeyDown: noop,
    cancelRun: noop,
    copyQueuedMessage: vi.fn(async () => undefined),
    ...overrides,
  };
}

describe('Composer', () => {
  it('disables sending for an empty draft and enables it with text', () => {
    const { rerender } = render(<Composer {...composerProps()} />);
    expect((screen.getByRole('button', { name: '发送' }) as HTMLButtonElement).disabled).toBe(true);
    rerender(<Composer {...composerProps({ messageInput: '你好' })} />);
    expect((screen.getByRole('button', { name: '发送' }) as HTMLButtonElement).disabled).toBe(
      false,
    );
  });

  it('submits through the form handler and edits the draft', () => {
    const props = composerProps({ messageInput: '你好' });
    render(<Composer {...props} />);
    fireEvent.change(screen.getByLabelText('发送消息'), { target: { value: '改了' } });
    expect(props.setMessageInput).toHaveBeenCalledWith('改了');
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    expect(props.handleSubmit).toHaveBeenCalledTimes(1);
  });

  it('shows the stop button and queue label while a run streams, and stops it', () => {
    const props = composerProps({
      status: 'streaming',
      messageInput: '再来一个',
      activeRunState: { status: 'streaming', errorMessage: null, stopping: true },
    });
    render(<Composer {...props} />);
    expect(screen.getByText('正在停止…')).toBeTruthy();
    expect(screen.getByRole('button', { name: '加入队列' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '停止本轮及派生任务' }));
    expect(props.cancelRun).toHaveBeenCalledTimes(1);
  });

  it('shows a read-only note for child sessions and hides the editor', () => {
    render(<Composer {...composerProps({ canCompose: false, isChildSession: true })} />);
    expect(screen.getByText(/子会话只读/)).toBeTruthy();
    expect(screen.queryByLabelText('发送消息')).toBeNull();
  });

  it('opens the permission menu and applies a choice', () => {
    const props = composerProps({ openMenu: 'permission' });
    render(<Composer {...props} />);
    const options = screen.getAllByRole('menuitem');
    expect(options.length).toBeGreaterThan(0);
    fireEvent.click(options[0] as HTMLElement);
    expect(props.setPermissionMode).toHaveBeenCalledTimes(1);
    expect(props.setOpenMenu).toHaveBeenCalledWith(null);
  });

  it('chooses a model from the model menu', () => {
    const props = composerProps({ openMenu: 'model' });
    render(<Composer {...props} />);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Provider 一' }));
    expect(props.chooseProvider).toHaveBeenCalledWith(props.providerSettings.providers[0]);
  });

  it('keeps one add button and the permission mode as the only left-hand tools', () => {
    const toggleMenu = vi.fn();
    render(<Composer {...composerProps({ toggleMenu })} />);
    fireEvent.click(screen.getByRole('button', { name: '添加内容' }));
    expect(toggleMenu).toHaveBeenCalledWith('context');
    for (const name of ['选择技能', '添加项目文件', '添加图片', '添加上下文'])
      expect(screen.queryByRole('button', { name })).toBeNull();
    expect(screen.getByRole('button', { name: /常规/ })).toBeTruthy();
  });

  it('routes every entry of the add menu', () => {
    const setOpenMenu = vi.fn();
    const filePicker = {
      open: false,
      buttonMode: false,
      items: [],
      close: vi.fn(),
      openFromButton: vi.fn(),
      updateSelection: vi.fn(),
    };
    const commandPicker = { open: false, items: [], activeIndex: 0, close: vi.fn() };
    const sessionSkills = {
      open: false,
      draft: { selected: [], revision: 0 },
      catalogState: { catalog: undefined, loading: false, error: undefined },
      close: vi.fn(),
      show: vi.fn(),
    };
    const addComposerContext = vi.fn();
    render(
      <Composer
        {...composerProps({
          openMenu: 'context',
          setOpenMenu,
          filePicker: filePicker as never,
          commandPicker: commandPicker as never,
          sessionSkills: sessionSkills as never,
          addComposerContext,
        })}
      />,
    );
    const menu = screen.getByRole('menu', { name: '添加内容' });
    expect(
      screen
        .getAllByRole('menuitem')
        .map((item) => item.getAttribute('aria-label') ?? item.textContent),
    ).toEqual(['添加图片', '添加项目文件', '当前文件', 'Git 变更', '项目目录', '选择技能']);
    expect(menu.textContent).toContain('也可粘贴');
    expect(menu.textContent).toContain('输入 @');

    // The hidden file input is attached through the ref, so spy on the real element.
    const imageClick = vi.spyOn(screen.getByLabelText('选择图片文件'), 'click');
    fireEvent.click(screen.getByRole('menuitem', { name: '添加图片' }));
    expect(imageClick).toHaveBeenCalledTimes(1);
    expect(setOpenMenu).toHaveBeenLastCalledWith(null);

    fireEvent.click(screen.getByRole('menuitem', { name: '添加项目文件' }));
    expect(filePicker.openFromButton).toHaveBeenCalledTimes(1);
    expect(commandPicker.close).toHaveBeenCalled();
    expect(sessionSkills.close).toHaveBeenCalled();

    fireEvent.click(screen.getByRole('menuitem', { name: '项目目录' }));
    expect(addComposerContext).toHaveBeenCalledWith('project-tree');

    fireEvent.click(screen.getByRole('menuitem', { name: '选择技能' }));
    expect(sessionSkills.show).toHaveBeenCalledTimes(1);
    expect(filePicker.close).toHaveBeenCalled();
  });

  it('disables choosing skills until a session exists', () => {
    render(<Composer {...composerProps({ openMenu: 'context', activeSessionId: '' })} />);
    const skills = screen.getByRole('menuitem', { name: '选择技能' }) as HTMLButtonElement;
    expect(skills.disabled).toBe(true);
    expect(skills.textContent).toContain('请先新建会话');
  });
});
