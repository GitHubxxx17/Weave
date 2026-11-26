import {
  useState,
  type Dispatch,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type RefObject,
  type SetStateAction,
} from 'react';

import { AgentStreamError, streamAgentRun } from '../features/agent/agent-stream.js';
import { executionLaunchUnreachableCode } from '../features/agent/agent-stream-error.js';
import { getAgentExecution } from '../features/agent/agent-execution-client.js';
import type { AgentExecutionSnapshot } from '../features/agent/agent-execution-types.js';
import type { useExecutionQueues } from '../features/agent/use-execution-queues.js';
import type { useCommandPicker } from '../features/commands/use-command-picker.js';
import type {
  DraftCapture,
  DraftMigrationTicket,
  useComposerDraft,
} from '../features/composer/use-composer-draft.js';
import type { TimelineHandle } from '../features/conversation/conversation-types.js';
import type { useFilePicker } from '../features/file-context/use-file-picker.js';
import type { useSessionSkills } from '../features/skills/use-session-skills.js';
import { skillRef } from '../features/skills/skill-types.js';
import type { ProviderDescriptor } from '../features/providers/provider-types.js';
import { createWorkspaceApi } from '../features/workspace/workspace-api.js';
import { createId, createSessionTitle, liveTurnIdFor, safeErrorMessage } from './app-helpers.js';
import {
  idleRunState,
  type AgentSubmissionSnapshot,
  type PendingImage,
  type StudioProject,
} from './app-types.js';
import type { PermissionMode } from './composer-preferences.js';
import type { useSessionExecutions } from './use-session-executions.js';
import type { useSessionLifecycle } from './use-session-lifecycle.js';

const workspaceApi = createWorkspaceApi();

/** A send that never reached the Server; "重试" resends the frozen request with the same requestId. */
export type SendFailure = {
  readonly sessionId: string;
  readonly submission: AgentSubmissionSnapshot;
  readonly requestId: string;
  readonly submittedDraft: DraftCapture;
  readonly selectedRevision: number;
  readonly migrationTicket: DraftMigrationTicket | null;
};

export type UseMessageSubmissionOptions = {
  readonly canCompose: boolean;
  readonly projects: readonly StudioProject[];
  readonly setProjects: Dispatch<SetStateAction<readonly StudioProject[]>>;
  readonly activeSessionId: string;
  readonly timelineRef: RefObject<TimelineHandle | null>;
  readonly composerDraft: ReturnType<typeof useComposerDraft>;
  readonly commandPicker: ReturnType<typeof useCommandPicker>;
  readonly filePicker: ReturnType<typeof useFilePicker>;
  readonly sessionSkills: ReturnType<typeof useSessionSkills>;
  /** Always the latest `sessionSkills`, for async code that outlives a render. */
  readonly latestSessionSkills: { readonly current: ReturnType<typeof useSessionSkills> };
  readonly selectedProviderId: string;
  readonly setSelectedProviderId: Dispatch<SetStateAction<string>>;
  readonly selectedModel: string;
  readonly setSelectedModel: Dispatch<SetStateAction<string>>;
  readonly selectedProvider: ProviderDescriptor | undefined;
  readonly reasoningEffort: string;
  readonly setReasoningEffortFor: (provider: string, model: string, value: string) => void;
  readonly permissionMode: PermissionMode;
  readonly setPermissionMode: (mode: PermissionMode) => void;
  readonly rememberPermissionMode: (sessionId: string, mode: PermissionMode) => void;
  readonly queueController: ReturnType<typeof useExecutionQueues>;
  readonly executions: ReturnType<typeof useSessionExecutions>;
  readonly lifecycle: Pick<
    ReturnType<typeof useSessionLifecycle>,
    'getActiveSessionContext' | 'ensureSessionForMessage'
  >;
  /** Shows (or clears with `null`) the App-level notice banner. */
  readonly onNotice: (message: string | null) => void;
};

/**
 * Sending: turns the composer draft (or a retry snapshot) into an execution
 * request, tracks the optimistic Turn and send failures, and copies queued
 * messages back into the draft.
 */
export function useMessageSubmission({
  canCompose,
  projects,
  setProjects,
  activeSessionId,
  timelineRef,
  composerDraft,
  commandPicker,
  filePicker,
  sessionSkills,
  latestSessionSkills,
  selectedProviderId,
  setSelectedProviderId,
  selectedModel,
  setSelectedModel,
  selectedProvider,
  reasoningEffort,
  setReasoningEffortFor,
  permissionMode,
  setPermissionMode,
  rememberPermissionMode,
  queueController,
  executions,
  lifecycle,
  onNotice: setNotice,
}: UseMessageSubmissionOptions) {
  const messageInput = composerDraft.draft.text;
  const pendingImages = composerDraft.draft.images as readonly PendingImage[];
  const setMessageInput = composerDraft.setText;
  const setPendingImages = composerDraft.setImages<PendingImage>;
  const [sendFailure, setSendFailure] = useState<SendFailure | null>(null);
  const [copyRequest, setCopyRequest] = useState<{
    snapshot: AgentExecutionSnapshot;
    owner: DraftCapture;
  } | null>(null);
  const {
    runHandles,
    observationEpoch,
    sessionActivityVersions,
    admitting,
    setAdmitting,
    mounted,
    sessionRunStatus,
    setSessionRunState,
    updateSessionMessages,
    updateSessionTurns,
    finishLiveTurn,
    setExpandedMessageIds,
    hasSessionHandles,
    executionIsCurrent,
    executionHandlers,
    attachExecution,
    requestExecutionCancel,
    reconcileExecution,
    resumeExecution,
    handleEvent,
  } = executions;
  const { getActiveSessionContext, ensureSessionForMessage } = lifecycle;

  /**
   * Sends a message. A retry snapshot creates a new Turn
   * (the previous Turn stays in history) without touching the draft input.
   */
  async function submitMessage(
    retry?: AgentSubmissionSnapshot,
    resend?: SendFailure,
  ): Promise<void> {
    if (!canCompose) return;
    const submittedDraft = resend?.submittedDraft ?? composerDraft.capture();
    const typed = messageInput.trim();
    // A draft that invokes a slash command is sent as the command's prompt, so
    // the message shown and stored is the text the model receives.
    const text =
      retry === undefined
        ? composerDraft.draft.literalSend
          ? typed
          : commandPicker.expand(typed)
        : retry.userMessage.content
            .filter((part) => part.type === 'text')
            .map((part) => part.text)
            .join('\n');
    const images =
      retry === undefined
        ? pendingImages
        : retry.userMessage.content.filter((part) => part.type === 'image');
    const files = retry === undefined ? composerDraft.draft.files : (retry.files ?? []);
    const contexts = retry === undefined ? composerDraft.draft.contexts : (retry.contexts ?? []);
    const selectedSkills = retry === undefined ? [...sessionSkills.draft.selected] : [];
    const selectedRevision = resend?.selectedRevision ?? sessionSkills.draft.revision;
    const selectedSessionId = activeSessionId;
    const copiedInput = composerDraft.draft.sampling;
    const settings =
      copiedInput !== undefined &&
      copiedInput.provider === selectedProviderId &&
      copiedInput.model === selectedModel
        ? {
            provider: selectedProviderId,
            model: selectedModel,
            ...(copiedInput.useProviderDefaults === undefined
              ? {}
              : { useProviderDefaults: copiedInput.useProviderDefaults }),
            ...(copiedInput.temperature === undefined
              ? {}
              : { temperature: copiedInput.temperature }),
            ...(copiedInput.maxTokens === undefined ? {} : { maxTokens: copiedInput.maxTokens }),
            reasoningEffort,
            permissionMode,
          }
        : {
            provider: selectedProviderId,
            model: selectedModel,
            useProviderDefaults: false,
            ...(selectedProvider?.temperature === undefined
              ? {}
              : { temperature: selectedProvider.temperature }),
            ...(selectedProvider?.maxTokens === undefined
              ? {}
              : { maxTokens: selectedProvider.maxTokens }),
            reasoningEffort,
            permissionMode,
          };
    if ((text === '' && images.length === 0 && files.length === 0) || admitting[activeSessionId]) {
      return;
    }

    const retryProject =
      retry === undefined
        ? undefined
        : projects.find((project) =>
            project.sessions.some((session) => session.id === retry.sessionId),
          );
    const retrySession = retryProject?.sessions.find((session) => session.id === retry?.sessionId);
    const sessionContext =
      retry === undefined
        ? (getActiveSessionContext() ?? (await ensureSessionForMessage(submittedDraft)))
        : retryProject === undefined || retrySession === undefined
          ? null
          : { projectId: retryProject.id, sessionId: retrySession.id, session: retrySession };
    if (sessionContext === null) {
      return;
    }
    const { projectId, sessionId } = sessionContext;
    if (runHandles.current.has(sessionId)) return;
    if (retry === undefined) rememberPermissionMode(sessionId, permissionMode);
    const submission: AgentSubmissionSnapshot = structuredClone(
      retry ?? {
        sessionId,
        userMessage: {
          role: 'user',
          content: [
            ...(text === '' ? [] : [{ type: 'text' as const, text }]),
            ...images.map((image) => ({
              type: 'image' as const,
              mediaType: image.mediaType,
              data: image.data,
            })),
          ],
        },
        ...settings,
        skills: selectedSessionId === sessionId ? selectedSkills.map(skillRef) : [],
        ...(files.length === 0 ? {} : { files }),
        ...(contexts.length === 0 ? {} : { contexts }),
      },
    );

    // Persist a generated title on the first message of an untitled session so
    // it survives a reload (the local title update below is only cosmetic).
    const generatedTitle = createSessionTitle(text);
    const existingTitle = projects
      .find((project) => project.id === projectId)
      ?.sessions.find((session) => session.id === sessionId)?.title;
    const shouldPersistTitle =
      retry === undefined &&
      generatedTitle !== '' &&
      (existingTitle === undefined || existingTitle === '未命名会话' || existingTitle === '');

    const userMessageId = createId('user');
    const assistantId = createId('assistant');
    const liveTurnId = liveTurnIdFor(assistantId);
    const runId = createId('run');
    const requestController = new AbortController();
    // A resend after an unreachable Server reuses the id so the Server can deduplicate.
    const requestId = resend?.requestId ?? crypto.randomUUID();
    setSendFailure(null);
    const occurredAt = new Date().toISOString();
    const queuedAdmission =
      (queueController.getState(sessionId)?.active !== null &&
        queueController.getState(sessionId)?.active !== undefined) ||
      (queueController.getState(sessionId)?.queued.length ?? 0) > 0 ||
      sessionRunStatus(sessionId) === 'streaming';

    sessionActivityVersions.current.set(
      sessionId,
      (sessionActivityVersions.current.get(sessionId) ?? 0) + 1,
    );
    runHandles.current.set(sessionId, {
      runId,
      observationEpoch: ++observationEpoch.current,
      sessionId,
      controller: requestController,
      assistantId,
      tools: [],
      requestId,
    });
    setAdmitting((current) => ({ ...current, [sessionId]: true }));
    timelineRef.current?.scrollToBottom();
    let optimisticInserted = false;
    const ensureOptimistic = (): void => {
      if (optimisticInserted || queuedAdmission) return;
      optimisticInserted = true;
      updateSessionMessages(projectId, sessionId, (current) => [
        ...current,
        {
          id: userMessageId,
          role: 'user',
          text,
          reasoning: '',
          tools: [],
          occurredAt,
          images: images.map((image) => ({ mediaType: image.mediaType, data: image.data })),
          turnId: liveTurnId,
          submission,
          selectedSkills: retry === undefined ? selectedSkills : [],
        },
        {
          id: assistantId,
          role: 'assistant',
          text: '',
          reasoning: '',
          tools: [],
          occurredAt,
          turnId: liveTurnId,
        },
      ]);
      updateSessionTurns(projectId, sessionId, (current) => [
        ...current,
        {
          turnId: liveTurnId,
          status: 'running',
          startedAt: occurredAt,
          provider: submission.provider,
          model: submission.model,
          modelSteps: [],
          toolResults: [],
          toolCalls: 0,
          failedToolCalls: 0,
        },
      ]);
    };
    setProjects((current) =>
      current.map((project) =>
        project.id === projectId
          ? {
              ...project,
              sessions: project.sessions.map((session) =>
                session.id === sessionId
                  ? {
                      ...session,
                      title:
                        session.title === '未命名会话' ? createSessionTitle(text) : session.title,
                      lastUsedLabel: '刚刚使用',
                    }
                  : session,
              ),
            }
          : project,
      ),
    );

    if (shouldPersistTitle) {
      void workspaceApi.renameSession(sessionId, generatedTitle).catch(() => undefined);
    }
    setExpandedMessageIds([assistantId]);
    if (!queuedAdmission)
      setSessionRunState(sessionId, { status: 'streaming', errorMessage: null });

    let receiptObserved = false;
    let productionRunId: string | undefined;
    let completedObserved = false;
    let completedTurnId: string | undefined;
    let accepted = false;
    const accept = (): void => {
      if (accepted || !mounted.current) return;
      accepted = true;
      if (!receiptObserved) ensureOptimistic();
      if (retry === undefined || resend !== undefined) {
        sessionSkills.clearSent(sessionId, selectedRevision, submission.skills);
        composerDraft.clearSubmittedDraftIfCurrent(
          submittedDraft,
          resend !== undefined
            ? resend.migrationTicket
            : 'migrationTicket' in sessionContext
              ? (sessionContext.migrationTicket ?? null)
              : null,
        );
      }
    };
    try {
      await streamAgentRun(
        submission,
        {
          ...executionHandlers(projectId, sessionId, runId),
          onReceipt: (snapshot) => {
            if (!mounted.current) return;
            receiptObserved = true;
            accept();
            const pending = runHandles.current.get(sessionId);
            if (pending?.runId === runId) runHandles.current.delete(sessionId);
            updateSessionMessages(projectId, sessionId, (current) =>
              current.filter((message) => message.turnId !== liveTurnId),
            );
            updateSessionTurns(projectId, sessionId, (current) =>
              current.filter((turn) => turn.turnId !== liveTurnId),
            );
            if (snapshot.status !== 'queued') {
              void attachExecution(projectId, sessionId, snapshot.executionId, snapshot);
              productionRunId = runHandles.current.get(snapshot.executionId)?.runId;
              if (pending?.pendingCancel && productionRunId !== undefined)
                void requestExecutionCancel(projectId, sessionId, productionRunId);
            } else if (
              !hasSessionHandles(sessionId) &&
              queueController.getState(sessionId)?.active == null
            ) {
              setSessionRunState(sessionId, idleRunState);
            }
            void queueController.refresh(projectId, sessionId).catch(() => undefined);
          },
          onAccepted: accept,
          onSnapshot: (snapshot) => {
            if (productionRunId !== undefined)
              executionHandlers(projectId, sessionId, productionRunId).onSnapshot?.(snapshot);
          },
          onStatus: (frame) => {
            if (productionRunId !== undefined)
              executionHandlers(projectId, sessionId, productionRunId).onStatus?.(frame);
          },
          onEvent: (event) => {
            accept();
            if (receiptObserved) {
              if (productionRunId !== undefined)
                executionHandlers(projectId, sessionId, productionRunId).onEvent(event);
              return;
            }
            if (runHandles.current.get(sessionId)?.execution !== undefined) {
              executionHandlers(projectId, sessionId, runId).onEvent(event);
              return;
            }
            if (event.type === 'completed') {
              completedObserved = true;
              completedTurnId = event.turnId;
            }
            handleEvent(event, runId, assistantId, projectId, sessionId);
          },
        },
        {
          signal: requestController.signal,
          requestId,
        },
      );
      if (receiptObserved) return;
      if (runHandles.current.get(sessionId)?.execution !== undefined) {
        await reconcileExecution(projectId, sessionId, runId);
        return;
      }
      accept();
      if (!completedObserved && executionIsCurrent(sessionId, runId)) {
        // Receipt-less integrations cannot establish an execution identity.
        setSessionRunState(sessionId, {
          status: 'error',
          errorMessage: '响应流已结束，无法确认会话终态。请重新打开会话读取最新状态。',
        });
      }
    } catch (error: unknown) {
      if (runHandles.current.get(sessionId)?.runId !== runId) {
        return;
      }

      if (runHandles.current.get(sessionId)?.execution !== undefined) {
        void resumeExecution(projectId, sessionId, runId);
        return;
      }
      if (error instanceof AgentStreamError && error.code === executionLaunchUnreachableCode) {
        updateSessionMessages(projectId, sessionId, (current) =>
          current.filter((message) => message.turnId !== liveTurnId),
        );
        updateSessionTurns(projectId, sessionId, (current) =>
          current.filter((turn) => turn.turnId !== liveTurnId),
        );
        if (!queuedAdmission) setSessionRunState(sessionId, idleRunState);
        setNotice('无法连接到本地 Server，消息未发送，草稿已保留。');
        setSendFailure({
          sessionId,
          submission,
          requestId,
          submittedDraft,
          selectedRevision,
          migrationTicket:
            resend !== undefined
              ? resend.migrationTicket
              : 'migrationTicket' in sessionContext
                ? (sessionContext.migrationTicket ?? null)
                : null,
        });
        return;
      }
      if (
        error instanceof AgentStreamError &&
        ['execution-queue-full', 'execution-queue-conflict', 'execution-request-conflict'].includes(
          error.code,
        )
      ) {
        updateSessionMessages(projectId, sessionId, (current) =>
          current.filter((message) => message.turnId !== liveTurnId),
        );
        updateSessionTurns(projectId, sessionId, (current) =>
          current.filter((turn) => turn.turnId !== liveTurnId),
        );
        if (!queuedAdmission) setSessionRunState(sessionId, idleRunState);
        setNotice(
          error.code === 'execution-queue-full'
            ? '排队消息已满（每个会话最多 10 条，全局最多 100 条），请等待前面的消息完成后再发送。草稿已保留。'
            : '待执行队列已变化，请确认后重新发送。草稿已保留。',
        );
        void queueController.refresh(projectId, sessionId).catch(() => undefined);
        return;
      }
      if (
        error instanceof AgentStreamError &&
        (error.code.startsWith('execution-file-') || error.code.startsWith('execution-context-'))
      ) {
        updateSessionMessages(projectId, sessionId, (current) =>
          current.filter((message) => message.turnId !== liveTurnId),
        );
        updateSessionTurns(projectId, sessionId, (current) =>
          current.filter((turn) => turn.turnId !== liveTurnId),
        );
        if (!queuedAdmission) setSessionRunState(sessionId, idleRunState);
        const messages: Record<string, string> = {
          'execution-file-too-large': '文件超出大小限制，请移除过大的文件后重新发送。草稿已保留。',
          'execution-file-unavailable':
            '无法读取所选文件，请确认项目文件夹并重新添加文件。草稿已保留。',
          'execution-file-invalid-utf8':
            '所选文件不是有效的 UTF-8 文本，请移除该文件后重新发送。草稿已保留。',
          'execution-file-changed': '读取时项目文件已变化，请确认文件后重新发送。草稿已保留。',
          'execution-file-capture-timeout': '文件读取超时，请重试。草稿已保留。',
          'execution-file-capture-failed': '无法读取所选文件，请确认文件后重新发送。草稿已保留。',
          'execution-context-git-unavailable':
            'Git 变更不可用：项目不是 Git 仓库，或还没有任何提交。请移除“Git 变更”后重新发送。草稿已保留。',
          'execution-context-unavailable':
            '无法读取项目目录或 Git 变更，请确认项目文件夹后重新发送。草稿已保留。',
          'execution-context-capture-failed':
            '无法读取所选上下文，请重试，或移除后重新发送。草稿已保留。',
        };
        setNotice(
          messages[error.code] ??
            (error.code.startsWith('execution-context-')
              ? '上下文读取失败，请重试。草稿已保留。'
              : '文件读取失败，请重新添加文件后发送。草稿已保留。'),
        );
        return;
      }
      if (error instanceof DOMException && error.name === 'AbortError') {
        setSessionRunState(sessionId, { status: 'cancelled', errorMessage: null });
        finishLiveTurn(projectId, sessionId, liveTurnId, 'cancelled');
      } else {
        setSessionRunState(sessionId, {
          status: 'error',
          errorMessage: safeErrorMessage(error),
        });
        finishLiveTurn(projectId, sessionId, liveTurnId, 'failed');
      }
    } finally {
      setAdmitting((current) => ({ ...current, [sessionId]: false }));
      if (
        !receiptObserved &&
        runHandles.current.get(sessionId)?.runId === runId &&
        runHandles.current.get(sessionId)?.execution === undefined
      ) {
        runHandles.current.delete(sessionId);
        if (completedTurnId !== undefined)
          void workspaceApi
            .getSession(sessionId)
            .then((detail) => {
              if (detail.id !== sessionId) return;
              // Explicit completed identities support older integrations without inference.
              const knownTurnId = completedTurnId;
              if (knownTurnId === undefined) return;
              const durable = detail.turns.find((turn) => turn.turnId === knownTurnId);
              if (durable === undefined) return;
              updateSessionTurns(projectId, sessionId, (current) =>
                current.map((turn) =>
                  turn.turnId === knownTurnId || turn.turnId === liveTurnId
                    ? { ...turn, ...durable }
                    : turn,
                ),
              );
              updateSessionMessages(projectId, sessionId, (current) =>
                current.map((message) =>
                  message.id === userMessageId || message.id === assistantId
                    ? { ...message, turnId: knownTurnId }
                    : message,
                ),
              );
            })
            .catch(() => undefined);
      }
    }
  }

  async function copyQueuedMessage(executionId: string): Promise<void> {
    const owner = composerDraft.capture();
    try {
      const snapshot = await getAgentExecution(owner.owner.sessionId, executionId);
      if (!composerDraft.isOwnerCurrent(owner.owner)) return;
      const current = composerDraft.read();
      if (
        current.text !== '' ||
        current.images.length > 0 ||
        current.files.length > 0 ||
        current.contexts.length > 0 ||
        latestSessionSkills.current.draft.selected.length > 0
      )
        setCopyRequest({ snapshot, owner });
      else applyQueuedCopy(snapshot, owner, false);
    } catch {
      setNotice('无法复制该消息，请刷新队列后重试。');
    }
  }
  function applyQueuedCopy(
    snapshot: AgentExecutionSnapshot,
    owner: DraftCapture,
    append: boolean,
  ): void {
    if (!composerDraft.isOwnerCurrent(owner.owner)) {
      setCopyRequest(null);
      return;
    }
    const current = composerDraft.read();
    const filePaths = new Set<string>();
    const files = [...(append ? current.files : []), ...(snapshot.input.files ?? [])].filter(
      ({ path }) => {
        if (filePaths.has(path)) return false;
        filePaths.add(path);
        return true;
      },
    );
    if (files.length > 8) {
      setNotice('最多添加 8 个文件，请先移除文件后再复制。');
      setCopyRequest(null);
      return;
    }
    const text = snapshot.input.userMessage.content
      .filter((part) => part.type === 'text')
      .map((part) => part.text)
      .join('\n');
    const images = snapshot.input.userMessage.content
      .filter((part) => part.type === 'image')
      .map((part) => ({
        id: createId('img'),
        name: '队列图片',
        mediaType: part.mediaType,
        data: part.data,
      }));
    composerDraft.setFiles(files);
    const copiedContexts = [
      ...(append ? current.contexts : []),
      ...(snapshot.input.contexts ?? []),
    ];
    composerDraft.setContexts(
      copiedContexts.filter(
        ({ kind }, index) => copiedContexts.findIndex((entry) => entry.kind === kind) === index,
      ),
    );
    setMessageInput((current) => (append && current !== '' ? `${current}\n\n${text}` : text));
    setPendingImages((current) => (append ? [...current, ...images] : images));
    setSelectedProviderId(snapshot.input.provider);
    setSelectedModel(snapshot.input.model);
    setPermissionMode(snapshot.input.permissionMode);
    setReasoningEffortFor(
      snapshot.input.provider,
      snapshot.input.model,
      snapshot.input.reasoningEffort ?? 'medium',
    );
    const { provider, model, useProviderDefaults, temperature, maxTokens } = {
      ...snapshot.input,
      ...snapshot.effectiveSettings,
    };
    composerDraft.setSampling({ provider, model, useProviderDefaults, temperature, maxTokens });
    latestSessionSkills.current.restore(snapshot.input.skills ?? [], append);
    composerDraft.markLiteral();
    setCopyRequest(null);
    setNotice('已复制到草稿，原消息仍在队列中。再次发送会读取当前项目文件。');
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (!canCompose) return;
    void submitMessage();
  }

  function handleMessageKeyDown(event: ReactKeyboardEvent<HTMLTextAreaElement>): void {
    if (!canCompose) return;
    if (filePicker.handleKeyDown(event)) return;
    if (commandPicker.handleKeyDown(event)) {
      return;
    }
    if (
      event.key !== 'Enter' ||
      event.shiftKey ||
      event.nativeEvent.isComposing ||
      event.keyCode === 229
    ) {
      return;
    }

    event.preventDefault();
    void submitMessage();
  }

  return {
    sendFailure,
    setSendFailure,
    copyRequest,
    setCopyRequest,
    submitMessage,
    handleSubmit,
    handleMessageKeyDown,
    copyQueuedMessage,
    applyQueuedCopy,
  };
}
