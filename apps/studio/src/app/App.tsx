import { useFilePicker } from '../features/file-context/use-file-picker.js';
import {
  type CSSProperties,
  type ReactElement,
  useEffect,
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Sparkles, TerminalSquare, RotateCcw, X } from 'lucide-react';

import { type AgentExecutionSnapshot } from '../features/agent/agent-execution-types.js';
import { useExecutionQueues } from '../features/agent/use-execution-queues.js';
import { usePermissionMode } from './composer-preferences.js';
import { useSessionSkills } from '../features/skills/use-session-skills.js';
import { skillRef } from '../features/skills/skill-types.js';
import { ConversationPane } from '../features/conversation/conversation-pane.js';
import { createConversationStore } from '../features/conversation/conversation-store.js';
import { usePendingConversationReveal } from '../features/conversation/use-pending-conversation-reveal.js';
import {
  getConversationRow,
  getConversationRetry,
} from '../features/conversation/conversation-model.js';
import type {
  ConversationAction,
  TimelineHandle,
} from '../features/conversation/conversation-types.js';
import { createTurnFileReviewStore } from '../features/file-undo/turn-file-review-store.js';
import { ConnectedConversationPanels } from '../features/conversation/connected-conversation-panels.js';
import { useComposerDraft } from '../features/composer/use-composer-draft.js';
import { usePluginPanels } from '../features/panel/use-plugin-panels.js';
import { createPluginCatalogStore } from '../features/plugins/plugin-catalog-store.js';
import {
  PluginCatalogProvider,
  usePluginCatalogStore,
} from '../features/plugins/plugin-catalog-context.js';
import { PluginMarketplacePage } from '../features/plugins/plugin-marketplace-page.js';
import { MemoryPage } from '../features/memory/MemoryPage.js';
import { SearchPage } from '../features/retrieval/SearchPage.js';
import { useSidePanelWidth } from '../features/panel/panel-resizer.js';
import { useApprovals } from '../features/approvals/approval-panel.js';
import { useAgentTasks } from '../features/tasks/use-agent-tasks.js';
import type { AgentTaskView } from '../features/tasks/task-types.js';
import type { ApprovalRequest } from '../features/approvals/approval-api.js';
import { useCommandPicker } from '../features/commands/use-command-picker.js';
import type { ProviderDescriptor } from '../features/providers/provider-types.js';
import { createWorkspaceApi } from '../features/workspace/workspace-api.js';
import { statusLabels, viewLabels } from './app-constants.js';
import {
  emptyTurns,
  formatMessageTime,
  formatModelLabel,
  getSessionLabel,
  toStudioProject,
  toStudioSession,
  workspaceErrorMessage,
} from './app-helpers.js';
import {
  type AgentSubmissionSnapshot,
  type OpenMenu,
  type PendingImage,
  type ProductView,
  type StudioProject,
  type TaskTranscriptTarget,
} from './app-types.js';
import { useComposerAttachments } from './use-composer-attachments.js';
import { useProviderSettings } from './use-provider-settings.js';
import { useSessionExecutions } from './use-session-executions.js';
import { ArchivedView } from './archived-view.js';
import { HistoryView } from './history-view.js';
import { ProjectsView } from './projects-view.js';
import { ProviderSettingsView } from './provider-settings-view.js';
import { ImagePreviewDialog } from './image-preview-dialog.js';
import { ProviderDeleteDialog, ProviderFormDialog } from './provider-dialogs.js';
import { CreateProjectDialog, FolderDialog, RenameProjectDialog } from './project-dialogs.js';
import { QueuedCopyDialog } from './queued-copy-dialog.js';
import { DeleteSessionDialog, EditSessionDialog } from './session-dialogs.js';
import { ChatHeader } from './chat-header.js';
import { Composer } from './composer.js';
import { SessionRail } from './session-rail.js';
import { TaskDisclosure } from './task-disclosure.js';
import { SettingsSidebar } from './settings-sidebar.js';
import { WorkspaceNav } from './workspace-nav.js';
import { useMessageSubmission } from './use-message-submission.js';
import { useSessionLifecycle } from './use-session-lifecycle.js';
import { useWorkspaceNavigation } from './use-workspace-navigation.js';

const workspaceApi = createWorkspaceApi();

/** Studio's first local Agent workspace, combining chat state and stream events. */
export function App(): ReactElement {
  const [pluginStore] = useState(createPluginCatalogStore);
  return (
    <PluginCatalogProvider store={pluginStore}>
      <StudioApp />
    </PluginCatalogProvider>
  );
}

function StudioApp(): ReactElement {
  const pluginStore = usePluginCatalogStore();
  const [previewImage, setPreviewImage] = useState<{
    readonly mediaType: string;
    readonly data: string;
  } | null>(null);
  const [projects, setProjects] = useState<readonly StudioProject[]>([]);
  const [conversationStore] = useState(createConversationStore);
  const [fileReviewStore] = useState(createTurnFileReviewStore);
  const timelineRef = useRef<TimelineHandle>(null);
  useLayoutEffect(() => {
    for (const project of projects)
      for (const session of project.sessions) {
        conversationStore.hydrateView({
          sessionId: session.id,
          messages: session.messages,
          turns: session.turns,
          detailKnown: session.detailKnown,
          ...(session.durableSequence === undefined
            ? {}
            : { durableSequence: session.durableSequence }),
        });
      }
  }, [conversationStore, projects]);
  const [activeProjectId, setActiveProjectId] = useState('');
  const [expandedProjectIds, setExpandedProjectIds] = useState<readonly string[]>([]);
  const [activeSessionId, setActiveSessionId] = useState('');
  const [isLoadingWorkspace, setIsLoadingWorkspace] = useState(true);
  const [workspaceError, setWorkspaceError] = useState<string | null>(null);
  const [workspaceLoadKey, setWorkspaceLoadKey] = useState(0);
  const [activeView, setActiveView] = useState<ProductView>('studio');
  const [openMenu, setOpenMenu] = useState<OpenMenu>(null);
  const [isActivityPanelOpen, setIsActivityPanelOpen] = useState(true);
  const [panelWidth, setPanelWidth] = useSidePanelWidth();
  const shellRef = useRef<HTMLElement>(null);
  const chatColumnRef = useRef<HTMLElement>(null);
  const { permissionMode, setPermissionMode, rememberPermissionMode } =
    usePermissionMode(activeSessionId);
  const [notice, setNotice] = useState<string | null>(null);
  const {
    providerSettings,
    selectedProviderId,
    setSelectedProviderId,
    selectedModel,
    setSelectedModel,
    selectedProvider,
    reasoningEffort,
    setReasoningEffort,
    setReasoningEffortFor,
    providerForm,
    providerFormError,
    providerMutation,
    providerToDelete,
    setProviderToDelete,
    openProviderForm,
    closeProviderForm,
    updateProviderForm,
    chooseProviderPreset,
    chooseModelPreset,
    saveProvider,
    setDefaultProvider,
    deleteProvider,
  } = useProviderSettings({ onNotice: setNotice });
  const [sessionToDelete, setSessionToDelete] = useState<{
    readonly projectId: string;
    readonly sessionId: string;
    readonly title: string;
  } | null>(null);
  const activeSessionIdRef = useRef('');
  const attachExecutionRef = useRef<
    (
      projectId: string,
      sessionId: string,
      executionId: string,
      supplied?: AgentExecutionSnapshot,
    ) => Promise<void>
  >(async () => {});
  const queueController = useExecutionQueues({
    activeSessionId,
    activeProjectId,
    onActive: (projectId, sessionId, summary) => {
      void attachExecutionRef.current(projectId, sessionId, summary.executionId);
    },
    onNotice: setNotice,
  });
  const sessionExecutions = useSessionExecutions({
    conversationStore,
    fileReviewStore,
    queueController,
    setProjects,
    activeProjectId,
    activeSessionId,
    activeSessionIdRef,
    onNotice: setNotice,
  });
  const {
    expandedMessageIds,
    runStateBySession,
    deletedSessionIds,
    appliedDurableSequences,
    admitting,
    mounted,
    activeRunState,
    sessionRunStatus,
    isSessionStreaming,
    resetTransientState,
    clearActiveRunState,
    applySessionDetail,
    loadSessionDetail,
    hasSessionHandles,
    attachExecution,
    recoverSessionExecution,
    cancelRun,
    releaseSessionRuntime,
  } = sessionExecutions;
  attachExecutionRef.current = attachExecution;
  const status = activeRunState.status;
  const errorMessage = activeRunState.errorMessage;
  const activeQueue = queueController.states[activeSessionId];
  const sessionHasWork = isSessionStreaming(activeSessionId);
  const navigationTicket = useRef(0);
  const lastVerifiedTaskRoot = useRef<{ projectId: string; root: string } | undefined>(undefined);
  const [taskTranscriptTarget, setTaskTranscriptTarget] = useState<TaskTranscriptTarget>();
  const messageInputRef = useRef<HTMLTextAreaElement | null>(null);
  const composerIsComposing = useRef(false);
  const directoryInputRef = useRef<HTMLInputElement | null>(null);
  const {
    isProjectDialogOpen,
    setIsProjectDialogOpen,
    folderDialogProjectId,
    setFolderDialogProjectId,
    folderDialogPath,
    setFolderDialogPath,
    folderDialogError,
    projectName,
    setProjectName,
    selectedFolderName,
    selectedFolderPath,
    setSelectedFolderPath,
    isSearchOpen,
    setIsSearchOpen,
    searchQuery,
    setSearchQuery,
    editingSession,
    setEditingSession,
    sessionTitleInput,
    setSessionTitleInput,
    renamingProjectId,
    setRenamingProjectId,
    projectRenameInput,
    setProjectRenameInput,
    openSessionEditor,
    saveSessionTitle,
    openProjectRename,
    saveProjectName,
    openProjectDialog,
    chooseProjectFolder,
    chooseFallbackFolder,
    createProject,
    openFolderDialog,
    pickFolderForDialog,
    saveProjectFolder,
  } = useWorkspaceNavigation({
    projects,
    setProjects,
    setOpenMenu,
    onNotice: setNotice,
    directoryInputRef,
    getSessionRunStatus: sessionRunStatus,
    applySessionDetail,
    onProjectCreated: (project, session) => {
      setProjects((current) => [...current, project]);
      setExpandedProjectIds((current) => [...current, project.id]);
      setActiveProjectId(project.id);
      activeSessionIdRef.current = session.id;
      setActiveSessionId(session.id);
      setActiveView('studio');
      resetTransientState();
    },
  });
  const imageInputRef = useRef<HTMLInputElement | null>(null);
  const activeProject = projects.find((project) => project.id === activeProjectId);
  const sessions = activeProject?.sessions ?? [];
  const activeSession = sessions.find((session) => session.id === activeSessionId);
  const isChildSession = activeSession?.taskOrigin !== undefined;
  const canCompose =
    activeSessionId === '' || (activeSession?.detailKnown === true && !isChildSession);
  const activeTaskRoot =
    activeSession?.detailKnown === true
      ? (activeSession.taskOrigin?.rootSessionId ?? activeSessionId)
      : '';
  if (activeTaskRoot !== '') {
    lastVerifiedTaskRoot.current = { projectId: activeProjectId, root: activeTaskRoot };
  } else if (
    activeSession === undefined ||
    lastVerifiedTaskRoot.current?.projectId !== activeProjectId
  ) {
    lastVerifiedTaskRoot.current = undefined;
  }
  const taskState = useAgentTasks(
    activeView === 'studio' ? (lastVerifiedTaskRoot.current?.root ?? '') : '',
  );
  const activeChildTask = isChildSession
    ? taskState.tasks.find(
        (task) =>
          task.taskId === activeSession.taskOrigin?.taskId &&
          task.childSessionId === activeSessionId,
      )
    : undefined;
  const composerDraft = useComposerDraft({
    sessionId: activeSessionId,
    projectId: activeProjectId,
    rootKey: activeProject?.folderPath ?? '',
    inputRef: messageInputRef,
  });
  const messageInput = composerDraft.draft.text;
  const pendingImages = composerDraft.draft.images as readonly PendingImage[];
  const setMessageInput = composerDraft.setText;
  const commandPicker = useCommandPicker({
    draft: messageInput,
    setDraft: setMessageInput,
    inputRef: messageInputRef,
    onSelect: composerDraft.resetLiteral,
  });
  const pluginPanels = usePluginPanels(pluginStore, composerDraft.invalidatePanel);
  const sessionSkills = useSessionSkills(
    activeSessionId,
    `${activeProjectId}:${activeProject?.folderPath ?? ''}`,
  );
  useEffect(() => {
    if (commandPicker.open) sessionSkills.close();
  }, [commandPicker.open]);
  const latestSessionSkills = useRef(sessionSkills);
  latestSessionSkills.current = sessionSkills;
  const filePicker = useFilePicker({
    owner: composerDraft.owner,
    inputRef: messageInputRef,
    text: messageInput,
    setText: setMessageInput,
    projectId: activeProjectId,
    rootKey: activeProject?.folderPath ?? '',
    disabled: !canCompose || commandPicker.open || sessionSkills.open,
    onSelect: (path, owner) => {
      const result = composerDraft.addFile(owner, path);
      if (result === 'full') setNotice('最多添加 8 个文件，请先移除文件。');
      return result;
    },
  });
  useEffect(() => {
    if (composerDraft.rootChanged) setNotice('项目文件夹已变化，请重新添加文件');
  }, [composerDraft.rootChanged]);
  const {
    activateSession,
    createSessionForProject,
    getActiveSessionContext,
    ensureSessionForMessage,
    selectProjectSession,
    toggleProjectExpanded,
    archiveSession,
    restoreSession,
    permanentlyDeleteSession,
    createSession,
    selectProject,
    openProject,
  } = useSessionLifecycle({
    projects,
    setProjects,
    activeProjectId,
    setActiveProjectId,
    activeSessionId,
    setActiveSessionId,
    activeSessionIdRef,
    navigationTicket,
    setExpandedProjectIds,
    setActiveView,
    setOpenMenu,
    setSearchQuery,
    setTaskTranscriptTarget,
    sessionToDelete,
    setSessionToDelete,
    composerDraft,
    sessionSkills,
    executions: {
      appliedDurableSequences,
      deletedSessionIds,
      sessionRunStatus,
      applySessionDetail,
      loadSessionDetail,
      resetTransientState,
      releaseSessionRuntime,
    },
    onNotice: setNotice,
  });
  const {
    sendFailure,
    setSendFailure,
    copyRequest,
    setCopyRequest,
    submitMessage,
    handleSubmit,
    handleMessageKeyDown,
    copyQueuedMessage,
    applyQueuedCopy,
  } = useMessageSubmission({
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
    executions: sessionExecutions,
    lifecycle: { getActiveSessionContext, ensureSessionForMessage },
    onNotice: setNotice,
  });
  const messages = activeSession?.messages ?? [];
  const approvals = useApprovals(!isLoadingWorkspace);
  function taskForApproval(approval: ApprovalRequest): AgentTaskView | undefined {
    return taskState.tasks.find(
      (task) =>
        approval.sessionId === task.childSessionId &&
        approval.executionId === task.childExecutionId &&
        approval.turnId === task.childTurnId,
    );
  }
  const turns = activeSession?.turns ?? emptyTurns;
  function submissionForTurn(turnId: string): AgentSubmissionSnapshot | undefined {
    const projected = getConversationRetry(conversationStore.getSnapshot(activeSessionId), turnId);
    if (projected !== undefined) return projected;
    const turn = turns.find((entry) => entry.turnId === turnId);
    const message = messages.find(
      (entry) =>
        entry.role === 'user' &&
        (entry.turnId === turnId ||
          (turn?.userMessageId !== undefined && entry.id === turn.userMessageId)),
    );
    if (message?.submission !== undefined) return message.submission;
    if (
      turn?.request === undefined ||
      turn.request.useProviderDefaults !== false ||
      message === undefined
    )
      return undefined;
    return {
      sessionId: activeSessionId,
      userMessage: message.originalUserMessage ?? { role: 'user', content: [] },
      ...turn.request,
      skills: (turn.skills?.requested ?? []).map(skillRef),
      ...(message.fileAttachments === undefined
        ? {}
        : { files: message.fileAttachments.map(({ path }) => ({ path })) }),
    };
  }

  /** Repeats the exact original message, refs and settings as a new Turn. */
  function retryTurn(turnId: string): void {
    const submission = submissionForTurn(turnId);
    if (submission !== undefined) void submitMessage(submission);
  }

  /** Inserts a reply as a Markdown quote at the top of the draft. */
  function quoteReply(text: string): void {
    const quoted = text
      .split('\n')
      .map((line) => `> ${line}`)
      .join('\n');
    setMessageInput((current) => (current === '' ? `${quoted}\n\n` : `${quoted}\n\n${current}`));
    messageInputRef.current?.focus();
  }

  function jumpToMessage(messageId: string): void {
    void timelineRef.current?.reveal({ kind: 'row', sessionId: activeSessionId, rowId: messageId });
  }
  function inspectToolCall(toolCallId: string, turnId?: string): boolean {
    if (turnId === undefined) return false;
    void timelineRef.current?.reveal({
      kind: 'tool',
      sessionId: activeSessionId,
      turnId,
      toolCallId,
    });
    return true;
  }
  const conversationActionHandler = useRef<(action: ConversationAction) => void>(() => {});
  conversationActionHandler.current = (action) => {
    if (action.type === 'image') {
      setPreviewImage(action.image);
      return;
    }
    if (action.sessionId !== activeSessionId || !canCompose) return;
    if (action.type === 'retry') retryTurn(action.turnId);
    if (action.type === 'quote') {
      const row = getConversationRow(conversationStore.getSnapshot(action.sessionId), action.rowId);
      if (row !== undefined) quoteReply(row.text);
    }
  };
  const onConversationAction = useCallback(
    (action: ConversationAction) => conversationActionHandler.current(action),
    [],
  );
  const suggestionHandler = useRef<(text: string) => void>(() => {});
  suggestionHandler.current = fillSuggestion;
  const showEmptyConversation = messages.length === 0;
  const emptyConversation = useMemo(
    () =>
      showEmptyConversation ? (
        <div className="empty-chat">
          <div className="empty-orbit" aria-hidden="true">
            <Sparkles aria-hidden="true" />
          </div>
          <p className="empty-kicker">WEAVE</p>
          <h3>今天想完成什么？</h3>
          <p>当前项目 {activeProject?.name ?? 'Weave'} · 本地运行时已连接</p>
          <div className="suggestion-list" aria-label="对话示例">
            <button
              type="button"
              onClick={() => suggestionHandler.current('介绍一下 Weave 的架构')}
            >
              <Sparkles aria-hidden="true" />
              介绍一下 Weave 的架构
            </button>
            <button type="button" onClick={() => suggestionHandler.current('帮我梳理当前项目状态')}>
              <TerminalSquare aria-hidden="true" />
              梳理当前项目状态
            </button>
          </div>
        </div>
      ) : undefined,
    [showEmptyConversation, activeProject?.name],
  );
  const pendingConversationTarget = useMemo(() => {
    if (taskTranscriptTarget === undefined) return undefined;
    return 'result' in taskTranscriptTarget
      ? {
          kind: 'durable-message' as const,
          sessionId: taskTranscriptTarget.sessionId,
          turnId: taskTranscriptTarget.result.turnId,
          messageId: taskTranscriptTarget.result.messageId,
        }
      : {
          kind: 'tool' as const,
          sessionId: taskTranscriptTarget.sessionId,
          turnId: taskTranscriptTarget.turnId,
          toolCallId: taskTranscriptTarget.toolCallId,
        };
  }, [taskTranscriptTarget]);
  const clearTranscriptTarget = useCallback(() => setTaskTranscriptTarget(undefined), []);
  usePendingConversationReveal(
    conversationStore,
    activeSessionId,
    pendingConversationTarget,
    timelineRef,
    clearTranscriptTarget,
  );
  const normalizedSearchQuery = searchQuery.trim().toLocaleLowerCase();
  const visibleProjects = projects
    .map((project) => ({
      ...project,
      sessions: project.sessions.filter(
        (session) =>
          session.archivedAt === null &&
          (normalizedSearchQuery === '' ||
            session.title.toLocaleLowerCase().includes(normalizedSearchQuery)),
      ),
    }))
    .filter((project) => normalizedSearchQuery === '' || project.sessions.length > 0);
  const archivedProjects = projects
    .map((project) => ({
      ...project,
      sessions: project.sessions.filter((session) => session.archivedAt !== null),
    }))
    .filter((project) => project.sessions.length > 0);

  useEffect(() => {
    let disposed = false;

    async function loadWorkspace(): Promise<void> {
      setIsLoadingWorkspace(true);
      setWorkspaceError(null);
      try {
        const response = await workspaceApi.listProjects({ includeArchived: true });
        if (disposed) {
          return;
        }

        const loadedProjects = response.projects.map((project) =>
          toStudioProject({
            ...project,
            sessions: project.sessions.filter(
              (session) => !deletedSessionIds.current.has(session.id),
            ),
          }),
        );
        setProjects((current) =>
          loadedProjects.map((project) => {
            const previous = current.find((entry) => entry.id === project.id);
            return {
              ...project,
              sessions: project.sessions.map((session) => {
                const known = previous?.sessions.find((entry) => entry.id === session.id);
                return known === undefined
                  ? session
                  : { ...known, title: session.title, archivedAt: session.archivedAt };
              }),
            };
          }),
        );
        setExpandedProjectIds(loadedProjects.map((project) => project.id));

        const firstProject = loadedProjects[0];
        const firstSession = firstProject?.sessions.find((session) => session.archivedAt === null);
        if (firstProject === undefined || firstSession === undefined) {
          activeSessionIdRef.current = '';
          setActiveProjectId(firstProject?.id ?? '');
          setActiveSessionId('');
          return;
        }

        activeSessionIdRef.current = firstSession.id;
        setActiveProjectId(firstProject.id);
        setActiveSessionId(firstSession.id);
        const detail = await workspaceApi.getSession(firstSession.id);
        if (disposed) {
          return;
        }
        if (detail.id !== firstSession.id) throw new Error('会话不匹配');
        applySessionDetail(firstProject.id, detail);
        await recoverSessionExecution(
          firstProject.id,
          firstSession.id,
          detail.lastSequence,
          () => disposed,
        );
      } catch (error: unknown) {
        if (!disposed) {
          setWorkspaceError(workspaceErrorMessage(error));
        }
      } finally {
        if (!disposed) {
          setIsLoadingWorkspace(false);
        }
      }
    }

    void loadWorkspace();
    return () => {
      disposed = true;
    };
  }, [workspaceLoadKey]);

  useEffect(() => {
    function handleEscape(event: KeyboardEvent): void {
      if (event.key === 'Escape') {
        setOpenMenu(null);
        setIsSearchOpen(false);
        setIsProjectDialogOpen(false);
        setEditingSession(null);
        setSessionToDelete(null);
        setPreviewImage(null);
      }

      if ((event.metaKey || event.ctrlKey) && event.key.toLocaleLowerCase() === 'k') {
        event.preventDefault();
        setIsSearchOpen(true);
      }
    }

    window.addEventListener('keydown', handleEscape);
    return () => window.removeEventListener('keydown', handleEscape);
  }, []);

  function prepareTaskDraft(prompt: string, access: AgentTaskView['access']): void {
    if (!canCompose || activeTaskRoot === '') return;
    const permission = access === 'read-only' ? '只读（read-only）' : '共享工作区（workspace）';
    const instruction = `请将以下工作委派给子任务，访问权限为${permission}。\n${prompt}`;
    setMessageInput((current) => (current === '' ? instruction : `${current}\n\n${instruction}`));
    composerDraft.markLiteral();
    messageInputRef.current?.focus();
  }

  async function openAgentTask(task: AgentTaskView, target?: TaskTranscriptTarget): Promise<void> {
    if (task.rootSessionId !== activeTaskRoot || activeProject === undefined) return;
    const ticket = ++navigationTicket.current;
    const source = activeSessionId;
    const project = activeProject;
    const stillCurrent = () =>
      mounted.current &&
      !deletedSessionIds.current.has(task.childSessionId) &&
      navigationTicket.current === ticket &&
      activeSessionIdRef.current === source;
    try {
      const detail = await workspaceApi.getSession(task.childSessionId);
      if (!stillCurrent()) return;
      const origin = detail.taskOrigin;
      if (
        detail.id !== task.childSessionId ||
        origin?.taskId !== task.taskId ||
        origin.rootSessionId !== task.rootSessionId ||
        origin.parentSessionId !== task.parentSessionId
      )
        throw new Error('子会话归属不匹配');
      if (
        target !== undefined &&
        'result' in target &&
        !detail.messages.some(
          (message) =>
            message.role === 'assistant' &&
            message.messageId === target.result.messageId &&
            message.turnId === target.result.turnId,
        )
      )
        throw new Error('子任务答复暂不可用');
      if (
        !hasSessionHandles(detail.id) ||
        !project.sessions.some((session) => session.id === detail.id && session.detailKnown)
      )
        applySessionDetail(project.id, detail, true);
      activateSession(project.id, toStudioSession(detail));
      resetTransientState();
      setTaskTranscriptTarget(target);
      void recoverSessionExecution(project.id, detail.id, detail.lastSequence);
    } catch {
      if (stillCurrent()) setNotice('无法打开子会话，请稍后重试');
    }
  }

  function inspectApproval(approval: ApprovalRequest): void {
    const { toolCallId } = approval;
    const task = taskForApproval(approval);
    if (task !== undefined && task.childSessionId !== activeSessionId) {
      void openAgentTask(task, {
        sessionId: task.childSessionId,
        toolCallId,
        turnId: task.childTurnId,
      });
      return;
    }
    inspectToolCall(toolCallId, approval.turnId);
  }

  /** Switches the visible Studio product area without changing session state. */
  function selectProductView(view: ProductView): void {
    navigationTicket.current += 1;
    setTaskTranscriptTarget(undefined);
    setActiveView(view);
    setOpenMenu(null);
    setNotice(null);
    if (view === 'marketplace') void pluginStore.refresh().catch(() => undefined);
  }

  function toggleMenu(menu: Exclude<OpenMenu, null>): void {
    setOpenMenu((current) => (current === menu ? null : menu));
    setNotice(null);
  }

  const {
    viewerFilePath,
    setViewerFilePath,
    gitChangesAvailability,
    addComposerContext,
    addViewerFileContext,
    addImageFiles,
    removePendingImage,
    handleComposerPaste,
  } = useComposerAttachments({
    composerDraft,
    openMenu,
    activeProjectId,
    setOpenMenu,
    onNotice: setNotice,
  });

  function fillSuggestion(text: string): void {
    if (!canCompose) return;
    setMessageInput(text);
    requestAnimationFrame(() => messageInputRef.current?.focus());
  }

  /** Selects a public Provider and its configured default model for new runs. */
  function chooseProvider(provider: ProviderDescriptor): void {
    composerDraft.setSampling(undefined);
    setSelectedProviderId(provider.id);
    setSelectedModel(provider.defaultModel ?? '');
    setOpenMenu(null);
  }

  function showNotice(message: string): void {
    setNotice(message);
    setOpenMenu(null);
  }

  if (isLoadingWorkspace) {
    return (
      <main className="studio-shell studio-shell-loading">
        <section className="workspace-loading" aria-live="polite">
          <Sparkles aria-hidden="true" />
          <h1>正在加载工作区</h1>
          <p>正在读取项目和会话...</p>
        </section>
      </main>
    );
  }

  if (workspaceError !== null) {
    return (
      <main className="studio-shell studio-shell-loading">
        <section className="workspace-loading workspace-loading-error" role="alert">
          <X aria-hidden="true" />
          <h1>工作区加载失败</h1>
          <p>{workspaceError}</p>
          <button
            className="primary-button"
            type="button"
            onClick={() => setWorkspaceLoadKey((current) => current + 1)}
          >
            <RotateCcw aria-hidden="true" />
            重试加载
          </button>
        </section>
      </main>
    );
  }

  return (
    <main
      ref={shellRef}
      className={`studio-shell studio-shell-fixed${activeView === 'studio' && !isActivityPanelOpen ? ' studio-shell-panel-collapsed' : ''}${activeView !== 'studio' && activeView !== 'settings' ? ' studio-shell-context-collapsed' : ''}${activeView === 'settings' ? ' studio-shell-settings' : ''}${activeView === 'marketplace' || activeView === 'memory' || activeView === 'retrieval' ? ' studio-shell-marketplace' : ''}`}
      style={{ '--panel-width': `${panelWidth}px` } as CSSProperties}
    >
      {openMenu !== null ? (
        <button
          className="menu-scrim"
          type="button"
          aria-label="关闭菜单"
          onClick={() => setOpenMenu(null)}
        />
      ) : null}
      <WorkspaceNav activeView={activeView} onSelectView={selectProductView} />

      {activeView === 'settings' ? (
        <SettingsSidebar />
      ) : (
        <SessionRail
          activeView={activeView}
          openMenu={openMenu}
          projects={projects}
          visibleProjects={visibleProjects}
          activeProject={activeProject}
          activeProjectId={activeProjectId}
          activeSessionId={activeSessionId}
          expandedProjectIds={expandedProjectIds}
          normalizedSearchQuery={normalizedSearchQuery}
          isSearchOpen={isSearchOpen}
          searchQuery={searchQuery}
          setIsSearchOpen={setIsSearchOpen}
          setSearchQuery={setSearchQuery}
          isSessionStreaming={isSessionStreaming}
          toggleMenu={toggleMenu}
          selectProject={selectProject}
          openFolderDialog={openFolderDialog}
          openProjectDialog={openProjectDialog}
          createSession={createSession}
          toggleProjectExpanded={toggleProjectExpanded}
          selectProjectSession={selectProjectSession}
          openSessionEditor={openSessionEditor}
          archiveSession={archiveSession}
        />
      )}

      <section
        className="chat-column"
        aria-label="智能对话"
        ref={chatColumnRef}
        hidden={activeView !== 'studio'}
        inert={activeView !== 'studio'}
      >
        <ChatHeader
          activeProject={activeProject}
          activeProjectId={activeProjectId}
          activeSession={activeSession}
          activeSessionId={activeSessionId}
          activeTaskRoot={activeTaskRoot}
          activeChildTask={activeChildTask}
          taskState={taskState}
          openMenu={openMenu}
          isActivityPanelOpen={isActivityPanelOpen}
          setIsActivityPanelOpen={setIsActivityPanelOpen}
          toggleMenu={toggleMenu}
          showNotice={showNotice}
          clearActiveRunState={clearActiveRunState}
          selectProjectSession={selectProjectSession}
        />

        {!isChildSession && activeTaskRoot !== '' ? (
          <TaskDisclosure
            activeTaskRoot={activeTaskRoot}
            taskState={taskState}
            openAgentTask={openAgentTask}
            prepareTaskDraft={prepareTaskDraft}
          />
        ) : null}

        <ConversationPane
          ref={timelineRef}
          store={conversationStore}
          sessionId={activeSessionId}
          projectId={activeProjectId}
          status={status}
          sessionHasWork={sessionHasWork}
          canCompose={canCompose}
          isChildSession={isChildSession}
          onAction={onConversationAction}
          fileReviewStore={fileReviewStore}
          expandedMessageId={expandedMessageIds.at(-1)}
          emptyContent={emptyConversation}
        />

        <Composer
          activeProject={activeProject}
          activeProjectId={activeProjectId}
          activeSessionId={activeSessionId}
          activeTaskRoot={activeTaskRoot}
          isChildSession={isChildSession}
          canCompose={canCompose}
          status={status}
          activeRunState={activeRunState}
          admitting={admitting}
          activeQueue={activeQueue}
          queueController={queueController}
          conversationStore={conversationStore}
          taskState={taskState}
          approvals={approvals}
          taskForApproval={taskForApproval}
          inspectApproval={inspectApproval}
          composerDraft={composerDraft}
          messageInput={messageInput}
          setMessageInput={setMessageInput}
          pendingImages={pendingImages}
          commandPicker={commandPicker}
          filePicker={filePicker}
          sessionSkills={sessionSkills}
          messageInputRef={messageInputRef}
          imageInputRef={imageInputRef}
          composerIsComposing={composerIsComposing}
          viewerFilePath={viewerFilePath}
          gitChangesAvailability={gitChangesAvailability}
          addComposerContext={addComposerContext}
          addViewerFileContext={addViewerFileContext}
          addImageFiles={addImageFiles}
          removePendingImage={removePendingImage}
          handleComposerPaste={handleComposerPaste}
          providerSettings={providerSettings}
          selectedProvider={selectedProvider}
          selectedProviderId={selectedProviderId}
          selectedModel={selectedModel}
          reasoningEffort={reasoningEffort}
          setReasoningEffort={setReasoningEffort}
          chooseProvider={chooseProvider}
          permissionMode={permissionMode}
          setPermissionMode={setPermissionMode}
          openMenu={openMenu}
          setOpenMenu={setOpenMenu}
          toggleMenu={toggleMenu}
          setIsActivityPanelOpen={setIsActivityPanelOpen}
          handleSubmit={handleSubmit}
          handleMessageKeyDown={handleMessageKeyDown}
          cancelRun={cancelRun}
          copyQueuedMessage={copyQueuedMessage}
        />
      </section>
      {activeView === 'retrieval' ? (
        <SearchPage selectedProjectId={activeProjectId} projects={projects} />
      ) : activeView === 'memory' ? (
        <MemoryPage
          selectedProjectId={activeProjectId}
          verifiedSessionIds={projects.flatMap((project) =>
            project.sessions
              .filter((session) => session.archivedAt === null)
              .map((session) => session.id),
          )}
          onNavigateSession={(sessionId) => {
            const project = projects.find((candidate) =>
              candidate.sessions.some(
                (session) => session.id === sessionId && session.archivedAt === null,
              ),
            );
            if (project === undefined) return;
            selectProjectSession(project.id, sessionId);
            setActiveView('studio');
          }}
        />
      ) : activeView === 'marketplace' ? (
        <PluginMarketplacePage
          hasRunningSessions={Object.values(runStateBySession).some(
            (run) => run.status === 'streaming',
          )}
        />
      ) : activeView !== 'studio' ? (
        <section
          className={activeView === 'settings' ? 'product-view product-view-settings' : 'page-view'}
          aria-label={viewLabels[activeView].title}
        >
          <div className={activeView === 'settings' ? 'product-view-content' : 'page-content'}>
            {activeView === 'projects' ? (
              <ProjectsView
                projects={projects}
                activeProjectId={activeProjectId}
                sessionHasWork={sessionHasWork}
                openProjectDialog={openProjectDialog}
                openProject={openProject}
                createSessionForProject={createSessionForProject}
                openProjectRename={openProjectRename}
                openFolderDialog={openFolderDialog}
              />
            ) : activeView === 'archived' ? (
              <ArchivedView
                archivedProjects={archivedProjects}
                sessionHasWork={sessionHasWork}
                restoreSession={restoreSession}
                setSessionToDelete={setSessionToDelete}
              />
            ) : activeView === 'settings' ? (
              <ProviderSettingsView
                providerSettings={providerSettings}
                providerMutation={providerMutation}
                openProviderForm={openProviderForm}
                setDefaultProvider={setDefaultProvider}
                setProviderToDelete={setProviderToDelete}
              />
            ) : (
              <HistoryView
                title={viewLabels[activeView].title}
                description={viewLabels[activeView].description}
              />
            )}
          </div>
        </section>
      ) : null}

      <ConnectedConversationPanels
        store={conversationStore}
        sessionId={activeSessionId}
        pluginPanels={pluginPanels}
        {...(canCompose ? { composerDraft } : {})}
        routeHidden={activeView !== 'studio'}
        collapsed={!isActivityPanelOpen}
        width={panelWidth}
        shellRef={shellRef}
        conversationRef={chatColumnRef}
        onResize={setPanelWidth}
        onCollapse={() => setIsActivityPanelOpen(false)}
        context={{
          fileOwnerKey: JSON.stringify(composerDraft.owner),
          onViewerFileChange: setViewerFilePath,
          selectedFiles: composerDraft.draft.files.map(({ path }) => path),
          ...(canCompose
            ? {
                onAddFile: ((owner) => (path: string) => {
                  const result = composerDraft.addFile(owner, path);
                  if (result === 'full') setNotice('最多添加 8 个文件，请先移除文件。');
                })(composerDraft.owner),
              }
            : {}),
          statusKey: status,
          projectId: activeProjectId,
          statusLabel: activeRunState.stopping
            ? '正在停止'
            : activeRunState.connection === 'reconnecting'
              ? '正在重连'
              : statusLabels[status],
          isRunning: status === 'streaming',
          hasRunningSessions: Object.values(runStateBySession).some(
            (run) => run.status === 'streaming',
          ),
          sessionLabel: getSessionLabel(activeSessionId),
          folderPath: activeProject?.folderPath,
          modelLabel: formatModelLabel(
            selectedProvider?.label ?? selectedProviderId,
            selectedModel,
          ),
          turns,
          messages,
          errorMessage,
          formatTime: formatMessageTime,
          onSetFolder: () => {
            if (activeProject !== undefined) {
              openFolderDialog(activeProject);
            }
          },
          onJumpToMessage: jumpToMessage,
        }}
      />
      {canCompose && copyRequest !== null ? (
        <QueuedCopyDialog
          copyRequest={copyRequest}
          applyQueuedCopy={applyQueuedCopy}
          setCopyRequest={setCopyRequest}
        />
      ) : null}
      {notice !== null ? (
        <div className="studio-notice" role="status">
          {notice}
          {sendFailure !== null ? (
            <button
              type="button"
              onClick={() => {
                const failure = sendFailure;
                setNotice(null);
                void submitMessage(failure.submission, failure);
              }}
            >
              重试
            </button>
          ) : null}
          <button
            type="button"
            aria-label="关闭提示"
            onClick={() => {
              setNotice(null);
              setSendFailure(null);
            }}
          >
            <X aria-hidden="true" />
          </button>
        </div>
      ) : null}
      {providerForm !== null ? (
        <ProviderFormDialog
          providerForm={providerForm}
          providerFormError={providerFormError}
          providerMutation={providerMutation}
          chooseProviderPreset={chooseProviderPreset}
          chooseModelPreset={chooseModelPreset}
          closeProviderForm={closeProviderForm}
          updateProviderForm={updateProviderForm}
          saveProvider={saveProvider}
        />
      ) : null}
      {providerToDelete !== null ? (
        <ProviderDeleteDialog
          providerToDelete={providerToDelete}
          providerMutation={providerMutation}
          deleteProvider={deleteProvider}
          setProviderToDelete={setProviderToDelete}
        />
      ) : null}
      {editingSession !== null ? (
        <EditSessionDialog
          sessionTitleInput={sessionTitleInput}
          setSessionTitleInput={setSessionTitleInput}
          setEditingSession={setEditingSession}
          saveSessionTitle={saveSessionTitle}
        />
      ) : null}
      {renamingProjectId !== null ? (
        <RenameProjectDialog
          projectRenameInput={projectRenameInput}
          setProjectRenameInput={setProjectRenameInput}
          setRenamingProjectId={setRenamingProjectId}
          saveProjectName={saveProjectName}
        />
      ) : null}
      {sessionToDelete !== null ? (
        <DeleteSessionDialog
          sessionToDelete={sessionToDelete}
          setSessionToDelete={setSessionToDelete}
          permanentlyDeleteSession={permanentlyDeleteSession}
        />
      ) : null}
      {folderDialogProjectId === null ? null : (
        <FolderDialog
          folderDialogProjectId={folderDialogProjectId}
          folderDialogPath={folderDialogPath}
          folderDialogError={folderDialogError}
          setFolderDialogPath={setFolderDialogPath}
          setFolderDialogProjectId={setFolderDialogProjectId}
          pickFolderForDialog={pickFolderForDialog}
          saveProjectFolder={saveProjectFolder}
          projects={projects}
        />
      )}
      {isProjectDialogOpen ? (
        <CreateProjectDialog
          projectName={projectName}
          setProjectName={setProjectName}
          selectedFolderName={selectedFolderName}
          selectedFolderPath={selectedFolderPath}
          setSelectedFolderPath={setSelectedFolderPath}
          setIsProjectDialogOpen={setIsProjectDialogOpen}
          chooseProjectFolder={chooseProjectFolder}
          chooseFallbackFolder={chooseFallbackFolder}
          createProject={createProject}
          directoryInputRef={directoryInputRef}
        />
      ) : null}
      {previewImage !== null ? (
        <ImagePreviewDialog previewImage={previewImage} setPreviewImage={setPreviewImage} />
      ) : null}
    </main>
  );
}
