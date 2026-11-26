// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const stream = vi.hoisted(() => ({ streamAgentRun: vi.fn() }));
const getExecution = vi.hoisted(() => ({ getAgentExecution: vi.fn() }));

vi.mock('../src/features/agent/agent-stream.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/features/agent/agent-stream.js')>()),
  streamAgentRun: stream.streamAgentRun,
}));
vi.mock('../src/features/agent/agent-execution-client.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/features/agent/agent-execution-client.js')>()),
  getAgentExecution: getExecution.getAgentExecution,
}));

import { useMessageSubmission } from '../src/app/use-message-submission.js';
import type { StudioProject, StudioSession } from '../src/app/app-types.js';

const session = {
  id: 'session-a',
  title: '未命名会话',
  archivedAt: null,
  detailKnown: true,
  messages: [],
  turns: [],
} as unknown as StudioSession;
const project = {
  id: 'project-a',
  name: 'project-a',
  folderPath: '/project-a',
  sessions: [session],
} as unknown as StudioProject;

type DraftOverrides = { text?: string; files?: unknown[]; contexts?: unknown[] };

function setup(
  options: {
    canCompose?: boolean;
    draft?: DraftOverrides;
    admitting?: Record<string, boolean>;
    filePickerHandled?: boolean;
  } = {},
) {
  const draft = {
    text: options.draft?.text ?? '',
    images: [],
    files: options.draft?.files ?? [],
    contexts: options.draft?.contexts ?? [],
    literalSend: true,
    sampling: undefined,
  };
  const composerDraft = {
    draft,
    capture: vi.fn(() => ({ owner: { sessionId: 'session-a' } })),
    read: vi.fn(() => draft),
    isOwnerCurrent: vi.fn(() => true),
    setText: vi.fn(),
    setImages: vi.fn(),
    setFiles: vi.fn(),
    setContexts: vi.fn(),
    setSampling: vi.fn(),
    markLiteral: vi.fn(),
    clearSubmittedDraftIfCurrent: vi.fn(),
  };
  const sessionSkills = {
    draft: { selected: [], revision: 0 },
    clearSent: vi.fn(),
    restore: vi.fn(),
  };
  const executions = {
    runHandles: { current: new Map() },
    observationEpoch: { current: 0 },
    sessionActivityVersions: { current: new Map<string, number>() },
    admitting: options.admitting ?? {},
    setAdmitting: vi.fn(),
    mounted: { current: true },
    sessionRunStatus: vi.fn(() => 'idle'),
    setSessionRunState: vi.fn(),
    updateSessionMessages: vi.fn(),
    updateSessionTurns: vi.fn(),
    finishLiveTurn: vi.fn(),
    setExpandedMessageIds: vi.fn(),
    hasSessionHandles: vi.fn(() => false),
    executionIsCurrent: vi.fn(() => false),
    executionHandlers: vi.fn(() => ({ onEvent: vi.fn() })),
    attachExecution: vi.fn(async () => undefined),
    requestExecutionCancel: vi.fn(async () => undefined),
    reconcileExecution: vi.fn(async () => undefined),
    resumeExecution: vi.fn(async () => undefined),
    handleEvent: vi.fn(),
  };
  const lifecycle = {
    getActiveSessionContext: vi.fn(() => ({
      projectId: 'project-a',
      sessionId: 'session-a',
      session,
    })),
    ensureSessionForMessage: vi.fn(async () => null),
  };
  const setters = {
    setProjects: vi.fn(),
    setSelectedProviderId: vi.fn(),
    setSelectedModel: vi.fn(),
    setReasoningEffortFor: vi.fn(),
    setPermissionMode: vi.fn(),
    rememberPermissionMode: vi.fn(),
    onNotice: vi.fn(),
  };
  const commandPicker = {
    expand: vi.fn((text: string) => text),
    handleKeyDown: vi.fn(() => false),
  };
  const filePicker = { handleKeyDown: vi.fn(() => options.filePickerHandled ?? false) };
  const hook = renderHook(() =>
    useMessageSubmission({
      canCompose: options.canCompose ?? true,
      projects: [project],
      activeSessionId: 'session-a',
      timelineRef: { current: null },
      composerDraft: composerDraft as never,
      commandPicker: commandPicker as never,
      filePicker: filePicker as never,
      sessionSkills: sessionSkills as never,
      latestSessionSkills: { current: sessionSkills as never },
      selectedProviderId: 'provider-a',
      selectedModel: 'model-a',
      selectedProvider: undefined,
      reasoningEffort: 'medium',
      permissionMode: 'ask',
      queueController: { getState: vi.fn(() => undefined), refresh: vi.fn() } as never,
      executions: executions as never,
      lifecycle: lifecycle as never,
      ...setters,
    }),
  );
  return { hook, composerDraft, executions, lifecycle, setters, commandPicker, filePicker };
}

function key(init: Partial<KeyboardEvent> & { key: string }) {
  const preventDefault = vi.fn();
  return {
    event: {
      shiftKey: false,
      keyCode: 13,
      nativeEvent: { isComposing: false },
      preventDefault,
      ...init,
    } as never,
    preventDefault,
  };
}

beforeEach(() => {
  stream.streamAgentRun.mockReset();
  stream.streamAgentRun.mockResolvedValue(undefined);
  getExecution.getAgentExecution.mockReset();
});

describe('useMessageSubmission', () => {
  it('sends the trimmed draft text for the active session with the selected settings', async () => {
    const { hook, executions, setters } = setup({ draft: { text: ' hello ' } });
    await act(() => hook.result.current.submitMessage());
    expect(stream.streamAgentRun).toHaveBeenCalledTimes(1);
    const submission = stream.streamAgentRun.mock.calls[0]?.[0];
    expect(submission).toMatchObject({
      sessionId: 'session-a',
      provider: 'provider-a',
      model: 'model-a',
      permissionMode: 'ask',
      reasoningEffort: 'medium',
      userMessage: { role: 'user', content: [{ type: 'text', text: 'hello' }] },
    });
    expect(setters.rememberPermissionMode).toHaveBeenCalledWith('session-a', 'ask');
    expect(executions.setAdmitting).toHaveBeenCalledTimes(2);
    expect(executions.runHandles.current.size).toBe(0);
  });

  it('does not send an empty draft, while admitting, or when composing is disabled', async () => {
    const empty = setup({ draft: { text: '   ' } });
    await act(() => empty.hook.result.current.submitMessage());
    const busy = setup({ draft: { text: 'hi' }, admitting: { 'session-a': true } });
    await act(() => busy.hook.result.current.submitMessage());
    const locked = setup({ canCompose: false, draft: { text: 'hi' } });
    await act(() => locked.hook.result.current.submitMessage());
    expect(stream.streamAgentRun).not.toHaveBeenCalled();
  });

  it('does not send while the session already has a send in flight', async () => {
    const { hook, executions } = setup({ draft: { text: 'hi' } });
    executions.runHandles.current.set('session-a', { runId: 'other' });
    await act(() => hook.result.current.submitMessage());
    expect(stream.streamAgentRun).not.toHaveBeenCalled();
  });

  it('submits the form without reloading the page and ignores it when composing is disabled', () => {
    const { hook } = setup({ draft: { text: 'hi' } });
    const preventDefault = vi.fn();
    act(() => hook.result.current.handleSubmit({ preventDefault } as never));
    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(stream.streamAgentRun).toHaveBeenCalledTimes(1);
    stream.streamAgentRun.mockClear();
    const locked = setup({ canCompose: false, draft: { text: 'hi' } });
    act(() => locked.hook.result.current.handleSubmit({ preventDefault } as never));
    expect(stream.streamAgentRun).not.toHaveBeenCalled();
  });

  it('sends on Enter but not on Shift+Enter, IME composition or when a picker handles the key', () => {
    const { hook, filePicker } = setup({ draft: { text: 'hi' } });
    const plain = key({ key: 'Enter' });
    act(() => hook.result.current.handleMessageKeyDown(plain.event));
    expect(plain.preventDefault).toHaveBeenCalledTimes(1);
    expect(stream.streamAgentRun).toHaveBeenCalledTimes(1);
    stream.streamAgentRun.mockClear();
    for (const blocked of [
      key({ key: 'Enter', shiftKey: true }),
      key({ key: 'Enter', nativeEvent: { isComposing: true } as never }),
      key({ key: 'Enter', keyCode: 229 }),
      key({ key: 'a' }),
    ]) {
      act(() => hook.result.current.handleMessageKeyDown(blocked.event));
      expect(blocked.preventDefault).not.toHaveBeenCalled();
    }
    filePicker.handleKeyDown.mockReturnValueOnce(true);
    act(() => hook.result.current.handleMessageKeyDown(key({ key: 'Enter' }).event));
    expect(stream.streamAgentRun).not.toHaveBeenCalled();
  });

  it('copies a queued message into an empty draft immediately', async () => {
    const { hook, composerDraft, setters } = setup();
    getExecution.getAgentExecution.mockResolvedValue({
      input: {
        userMessage: { role: 'user', content: [{ type: 'text', text: 'queued text' }] },
        provider: 'provider-b',
        model: 'model-b',
        permissionMode: 'ask',
      },
      effectiveSettings: {},
    });
    await act(() => hook.result.current.copyQueuedMessage('execution-1'));
    expect(hook.result.current.copyRequest).toBeNull();
    expect(composerDraft.setText).toHaveBeenCalledTimes(1);
    expect(setters.setSelectedProviderId).toHaveBeenCalledWith('provider-b');
    expect(setters.setSelectedModel).toHaveBeenCalledWith('model-b');
    expect(setters.onNotice).toHaveBeenCalledWith(
      '已复制到草稿，原消息仍在队列中。再次发送会读取当前项目文件。',
    );
  });

  it('asks before replacing a non-empty draft with a queued message', async () => {
    const { hook, composerDraft } = setup({ draft: { text: 'draft' } });
    composerDraft.read.mockReturnValue({
      text: 'draft',
      images: [],
      files: [],
      contexts: [],
    } as never);
    getExecution.getAgentExecution.mockResolvedValue({
      input: { userMessage: { role: 'user', content: [] } },
    });
    await act(() => hook.result.current.copyQueuedMessage('execution-1'));
    expect(hook.result.current.copyRequest).not.toBeNull();
    expect(composerDraft.setText).not.toHaveBeenCalled();
  });

  it('reports a failed queued-message lookup without touching the draft', async () => {
    const { hook, composerDraft, setters } = setup();
    getExecution.getAgentExecution.mockRejectedValue(new Error('offline'));
    await act(() => hook.result.current.copyQueuedMessage('execution-1'));
    expect(setters.onNotice).toHaveBeenCalledWith('无法复制该消息，请刷新队列后重试。');
    expect(composerDraft.setText).not.toHaveBeenCalled();
  });
});
