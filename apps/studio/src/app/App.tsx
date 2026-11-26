import { useFilePicker } from '../features/file-context/use-file-picker.js';
import { FilePicker } from '../features/file-context/file-picker.js';
import {
  DraftContextAttachments,
  DraftFileAttachments,
} from '../features/file-context/file-attachments.js';
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
import {
  Bot,
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  Files,
  FolderOpen,
  FolderKanban,
  GitBranch,
  ImagePlus,
  MoreHorizontal,
  PanelRightOpen,
  Pencil,
  Plus,
  SendHorizontal,
  Square,
  Sparkles,
  TerminalSquare,
  Trash2,
  RotateCcw,
  X,
} from 'lucide-react';

import { type AgentExecutionSnapshot } from '../features/agent/agent-execution-types.js';
import { ExecutionQueueList } from '../features/agent/execution-queue-list.js';
import { useExecutionQueues } from '../features/agent/use-execution-queues.js';
import { usePermissionMode } from './composer-preferences.js';
import { useSessionSkills } from '../features/skills/use-session-skills.js';
import { SkillPicker } from '../features/skills/skill-picker.js';
import { sameSkill, skillRef } from '../features/skills/skill-types.js';
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
import {
  ConnectedContextMeter,
  ConnectedConversationPanels,
} from '../features/conversation/connected-conversation-panels.js';
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
import { ApprovalPanel, useApprovals } from '../features/approvals/approval-panel.js';
import { AgentTaskPanel, isSettledTask } from '../features/tasks/task-panel.js';
import { useAgentTasks } from '../features/tasks/use-agent-tasks.js';
import type { AgentTaskView } from '../features/tasks/task-types.js';
import type { ApprovalRequest } from '../features/approvals/approval-api.js';
import {
  CommandPickerList,
  commandOptionId,
  commandPickerListId,
} from '../features/commands/command-picker-list.js';
import { useCommandPicker } from '../features/commands/use-command-picker.js';
import {
  customProviderPresetId,
  findProviderPreset,
  providerPresets,
} from '../features/providers/provider-presets.js';
import type { ProviderDescriptor } from '../features/providers/provider-types.js';
import { createWorkspaceApi } from '../features/workspace/workspace-api.js';
import {
  permissionOptions,
  reasoningEffortOptions,
  statusLabels,
  viewLabels,
} from './app-constants.js';
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
import { FormSelect } from './form-select.js';
import { useComposerAttachments } from './use-composer-attachments.js';
import { useProviderSettings } from './use-provider-settings.js';
import { useSessionExecutions } from './use-session-executions.js';
import { ArchivedView } from './archived-view.js';
import { HistoryView } from './history-view.js';
import { ProjectsView } from './projects-view.js';
import { ProviderSettingsView } from './provider-settings-view.js';
import { SessionRail } from './session-rail.js';
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
        <header className="chat-header">
          <div className="breadcrumb">
            <span>{activeProject?.folderName ?? 'weave'}</span>
            <span className="breadcrumb-divider" aria-hidden="true">
              /
            </span>
            {activeSession?.taskOrigin !== undefined ? (
              <>
                <button
                  className="task-parent-link"
                  type="button"
                  onClick={() => selectProjectSession(activeProjectId, activeTaskRoot)}
                >
                  返回父会话
                </button>
                <span className="breadcrumb-divider" aria-hidden="true">
                  /
                </span>
              </>
            ) : null}
            <strong>{activeSession?.title ?? '未命名会话'}</strong>
          </div>
          <div className="header-actions">
            {activeChildTask !== undefined && !isSettledTask(activeChildTask) ? (
              <button
                className="icon-button"
                type="button"
                aria-label="停止子任务"
                title="停止子任务"
                disabled={
                  taskState.pending.has(activeChildTask.taskId) ||
                  activeChildTask.status === 'cancelling'
                }
                onClick={() => void taskState.stop(activeChildTask.taskId)}
              >
                <Square aria-hidden="true" />
              </button>
            ) : null}
            <div className={`menu-anchor${openMenu === 'more' ? ' menu-anchor-open' : ''}`}>
              <button
                className="icon-button"
                type="button"
                aria-label="更多操作"
                title="更多操作"
                aria-expanded={openMenu === 'more'}
                onClick={() => toggleMenu('more')}
              >
                <MoreHorizontal aria-hidden="true" />
              </button>
              {openMenu === 'more' ? (
                <div className="popup-menu popup-menu-right" role="menu" aria-label="会话操作">
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => showNotice(`会话标识：${activeSessionId}`)}
                  >
                    <span className="menu-icon">
                      <Copy aria-hidden="true" />
                    </span>
                    复制会话标识
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      clearActiveRunState();
                      showNotice('运行状态已清空');
                    }}
                  >
                    <span className="menu-icon">
                      <Trash2 aria-hidden="true" />
                    </span>
                    清空运行状态
                  </button>
                </div>
              ) : null}
            </div>
            {!isActivityPanelOpen ? (
              <button
                className="icon-button"
                type="button"
                aria-label="显示上下文"
                title="显示上下文"
                onClick={() => setIsActivityPanelOpen(true)}
              >
                <PanelRightOpen aria-hidden="true" />
              </button>
            ) : null}
          </div>
        </header>

        {!isChildSession && activeTaskRoot !== '' ? (
          <details className="task-disclosure" key={activeTaskRoot}>
            <summary>
              并行子任务
              {taskState.snapshot === undefined ? '' : `（${taskState.snapshot.totalCount}）`}
              {taskState.tasks.some((task) => task.pendingApprovalCount > 0) ? ' · 有待审批' : ''}
              {taskState.reconnecting && taskState.snapshot !== undefined ? ' · 正在重连…' : ''}
            </summary>
            <AgentTaskPanel
              tasks={taskState.tasks}
              pending={taskState.pending}
              totalCount={taskState.snapshot?.totalCount}
              loadingPage={taskState.loadingPage}
              hasMore={taskState.nextCursor !== undefined}
              onLoadMore={() => void taskState.loadMore()}
              onStop={(taskId) => void taskState.stop(taskId)}
              onOpen={(task, result) =>
                void openAgentTask(
                  task,
                  result === undefined ? undefined : { sessionId: task.childSessionId, result },
                )
              }
              error={taskState.error}
              onPrepare={prepareTaskDraft}
            />
          </details>
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

        <form className="composer" onSubmit={handleSubmit}>
          {canCompose && activeQueue !== undefined ? (
            <ExecutionQueueList
              state={activeQueue}
              pending={queueController.pending[activeSessionId] ?? false}
              onCancel={(id) => void queueController.cancel(activeSessionId, id)}
              onMove={(id) => void queueController.move(activeSessionId, id)}
              onCopy={(id) => void copyQueuedMessage(id)}
            />
          ) : null}
          <ApprovalPanel
            pending={approvals.pending.filter(
              (approval) =>
                approval.sessionId === activeSessionId ||
                (canCompose && approval.sessionId === undefined) ||
                (activeTaskRoot === activeSessionId && taskForApproval(approval) !== undefined),
            )}
            onDecide={approvals.decide}
            onInspectApproval={inspectApproval}
            taskTitleForApproval={(approval) => taskForApproval(approval)?.title}
          />
          {!canCompose ? (
            <p className="composer-readonly-note" role="status">
              {isChildSession ? '子会话只读。返回父会话继续发送。' : '正在读取会话详情…'}
              {isChildSession && taskState.error !== undefined ? ` ${taskState.error}` : ''}
            </p>
          ) : (
            <div className="composer-box">
              {sessionSkills.open && !commandPicker.open && activeSessionId !== '' ? (
                <SkillPicker
                  key={`${activeSessionId}:${activeProject?.folderPath ?? ''}`}
                  sessionId={activeSessionId}
                  catalog={sessionSkills.catalogState.catalog}
                  loading={sessionSkills.catalogState.loading}
                  error={sessionSkills.catalogState.error}
                  selected={sessionSkills.draft.selected}
                  onToggle={sessionSkills.toggle}
                  onRefresh={() => void sessionSkills.refresh()}
                  onClose={sessionSkills.close}
                />
              ) : null}
              <FilePicker picker={filePicker} />
              {commandPicker.open ? (
                <CommandPickerList
                  commands={commandPicker.items}
                  activeIndex={commandPicker.activeIndex}
                  onSelect={commandPicker.select}
                  onHover={commandPicker.setActiveIndex}
                />
              ) : null}
              <label className="sr-only" htmlFor="message-input">
                发送消息
              </label>
              <textarea
                id="message-input"
                name="message"
                rows={2}
                ref={messageInputRef}
                value={messageInput}
                onChange={(event) => {
                  setMessageInput(event.target.value);
                  if (
                    !composerIsComposing.current &&
                    !(event.nativeEvent as InputEvent).isComposing
                  )
                    filePicker.updateSelection(
                      event.target.value,
                      event.target.selectionStart,
                      event.target.selectionEnd,
                    );
                }}
                onSelect={(event) =>
                  !composerIsComposing.current &&
                  filePicker.updateSelection(
                    event.currentTarget.value,
                    event.currentTarget.selectionStart,
                    event.currentTarget.selectionEnd,
                  )
                }
                onCompositionStart={() => {
                  composerIsComposing.current = true;
                  filePicker.close();
                }}
                onCompositionEnd={(event) => {
                  composerIsComposing.current = false;
                  filePicker.updateSelection(
                    event.currentTarget.value,
                    event.currentTarget.selectionStart,
                    event.currentTarget.selectionEnd,
                  );
                }}
                onKeyDown={handleMessageKeyDown}
                onPaste={handleComposerPaste}
                placeholder="给 Agent 分配一个任务…"
                {...(filePicker.open && !filePicker.buttonMode
                  ? {
                      'aria-controls': filePicker.listId,
                      ...(filePicker.items.length === 0
                        ? {}
                        : { 'aria-activedescendant': filePicker.optionId(filePicker.activeIndex) }),
                    }
                  : {})}
                {...(commandPicker.open
                  ? {
                      'aria-controls': commandPickerListId,
                      'aria-activedescendant': commandOptionId(
                        commandPicker.items[commandPicker.activeIndex]?.name ?? '',
                      ),
                    }
                  : {})}
              />
              {composerDraft.draft.literalSend ? (
                <p className="composer-prepared-status" role="status">
                  已准备文本，请检查并点击发送
                </p>
              ) : null}
              <DraftFileAttachments
                files={composerDraft.draft.files}
                onRemove={composerDraft.removeFile}
              />
              <DraftContextAttachments
                contexts={composerDraft.draft.contexts}
                onRemove={composerDraft.removeContext}
              />
              {pendingImages.length > 0 ? (
                <div className="composer-attachments" aria-label="待发送图片">
                  {pendingImages.map((image) => (
                    <span className="composer-attachment" key={image.id}>
                      <img
                        className="composer-attachment-thumb"
                        src={`data:${image.mediaType};base64,${image.data}`}
                        alt={image.name}
                      />
                      <button
                        type="button"
                        aria-label={`移除图片 ${image.name}`}
                        onClick={() => removePendingImage(image.id)}
                      >
                        <X aria-hidden="true" />
                      </button>
                    </span>
                  ))}
                </div>
              ) : null}
              {sessionSkills.draft.selected.length > 0 ? (
                <div className="skill-chips" aria-label="待发送技能">
                  {sessionSkills.draft.selected.map((skill) => {
                    const latest = sessionSkills.catalogState.catalog?.entries.find(
                      (entry) => entry.id === skill.id,
                    );
                    const stale =
                      latest !== undefined
                        ? !sameSkill(latest, skill)
                        : sessionSkills.catalogState.catalog?.complete === true;
                    return (
                      <span
                        className={`skill-chip${stale ? ' skill-warning' : ''}`}
                        key={skill.id}
                        title={`${skill.source.label} · ${skill.id}`}
                      >
                        <span>
                          {skill.name}
                          {stale ? ' · 内容已变化，请重新选择' : ''}
                        </span>
                        <button
                          type="button"
                          aria-label={`移除技能 ${skill.name}`}
                          onClick={() => sessionSkills.remove(skill.id)}
                        >
                          ×
                        </button>
                      </span>
                    );
                  })}
                </div>
              ) : null}
              <div className="composer-toolbar">
                <div className="composer-tools">
                  <button
                    className="composer-tool-button"
                    type="button"
                    aria-label="选择技能"
                    title={activeSessionId === '' ? '请先新建会话以选择技能' : '为本轮选择技能'}
                    disabled={activeSessionId === ''}
                    aria-expanded={sessionSkills.open}
                    onClick={() => {
                      filePicker.close();
                      commandPicker.close();
                      if (sessionSkills.open) sessionSkills.close();
                      else sessionSkills.show();
                    }}
                  >
                    <Sparkles aria-hidden="true" />
                  </button>
                  <div
                    className={`menu-anchor${openMenu === 'context' ? ' menu-anchor-open' : ''}`}
                  >
                    <button
                      className="composer-tool-button"
                      type="button"
                      aria-label="添加上下文"
                      aria-expanded={openMenu === 'context'}
                      onClick={() => toggleMenu('context')}
                    >
                      <Plus aria-hidden="true" />
                    </button>
                    {openMenu === 'context' ? (
                      <div
                        className="popup-menu popup-menu-composer"
                        role="menu"
                        aria-label="添加上下文"
                      >
                        <button
                          type="button"
                          role="menuitem"
                          disabled={
                            viewerFilePath === null ||
                            composerDraft.draft.files.length >= 8 ||
                            composerDraft.draft.files.some((file) => file.path === viewerFilePath)
                          }
                          title={viewerFilePath ?? '先在文件面板打开文件'}
                          onClick={addViewerFileContext}
                        >
                          <span className="menu-icon">
                            <Files aria-hidden="true" />
                          </span>
                          当前文件
                          {viewerFilePath !== null &&
                          composerDraft.draft.files.some((file) => file.path === viewerFilePath) ? (
                            <Check className="menu-check" aria-hidden="true" />
                          ) : null}
                        </button>
                        <button
                          type="button"
                          role="menuitem"
                          disabled={
                            gitChangesAvailability?.projectId !== activeProjectId ||
                            gitChangesAvailability.state !== 'available' ||
                            composerDraft.draft.contexts.some(({ kind }) => kind === 'git-changes')
                          }
                          title={
                            gitChangesAvailability?.projectId === activeProjectId &&
                            gitChangesAvailability.state === 'unavailable'
                              ? '项目不是 Git 仓库，或还没有任何提交'
                              : gitChangesAvailability?.projectId === activeProjectId &&
                                  gitChangesAvailability.state === 'unknown'
                                ? '无法检查 Git 状态'
                                : undefined
                          }
                          onClick={() => addComposerContext('git-changes')}
                        >
                          <span className="menu-icon">
                            <GitBranch aria-hidden="true" />
                          </span>
                          Git 变更
                          {composerDraft.draft.contexts.some(
                            ({ kind }) => kind === 'git-changes',
                          ) ? (
                            <Check className="menu-check" aria-hidden="true" />
                          ) : gitChangesAvailability?.projectId === activeProjectId &&
                            gitChangesAvailability.state === 'unavailable' ? (
                            <small>需要有提交的 Git 仓库</small>
                          ) : gitChangesAvailability?.projectId === activeProjectId &&
                            gitChangesAvailability.state === 'unknown' ? (
                            <small>无法检查 Git 状态</small>
                          ) : null}
                        </button>
                        <button
                          type="button"
                          role="menuitem"
                          disabled={
                            activeProjectId === '' ||
                            composerDraft.draft.contexts.some(({ kind }) => kind === 'project-tree')
                          }
                          onClick={() => addComposerContext('project-tree')}
                        >
                          <span className="menu-icon">
                            <FolderOpen aria-hidden="true" />
                          </span>
                          项目目录
                          {composerDraft.draft.contexts.some(
                            ({ kind }) => kind === 'project-tree',
                          ) ? (
                            <Check className="menu-check" aria-hidden="true" />
                          ) : null}
                        </button>
                      </div>
                    ) : null}
                  </div>
                  <div
                    className={`menu-anchor${openMenu === 'permission' ? ' menu-anchor-open' : ''}`}
                  >
                    <button
                      className="permission-button"
                      type="button"
                      aria-expanded={openMenu === 'permission'}
                      onClick={() => toggleMenu('permission')}
                    >
                      {permissionOptions.find((option) => option.value === permissionMode)?.label ??
                        '常规'}
                      <ChevronDown aria-hidden="true" />
                    </button>
                    {openMenu === 'permission' ? (
                      <div
                        className="popup-menu popup-menu-composer"
                        role="menu"
                        aria-label="权限模式"
                      >
                        {permissionOptions.map((option) => (
                          <button
                            type="button"
                            role="menuitem"
                            key={option.value}
                            className={
                              option.danger === true ? 'permission-option-danger' : undefined
                            }
                            onClick={() => {
                              setPermissionMode(option.value);
                              setOpenMenu(null);
                            }}
                          >
                            <span className="menu-icon">
                              <option.icon aria-hidden="true" />
                            </span>
                            <span className="provider-menu-copy">
                              <strong>{option.label}</strong>
                              <small>{option.description}</small>
                            </span>
                            {permissionMode === option.value ? (
                              <Check className="menu-check" aria-hidden="true" />
                            ) : null}
                          </button>
                        ))}
                      </div>
                    ) : null}
                  </div>
                  <button
                    className="composer-tool-button"
                    type="button"
                    aria-label="添加项目文件"
                    onClick={() => {
                      commandPicker.close();
                      sessionSkills.close();
                      filePicker.openFromButton();
                    }}
                  >
                    <Files aria-hidden="true" />
                  </button>
                  <button
                    className="composer-tool-button"
                    type="button"
                    aria-label="添加图片"
                    onClick={() => imageInputRef.current?.click()}
                  >
                    <ImagePlus aria-hidden="true" />
                  </button>
                  <input
                    className="sr-only"
                    ref={imageInputRef}
                    type="file"
                    accept="image/*"
                    aria-label="选择图片文件"
                    multiple
                    onChange={(event) => {
                      void addImageFiles(event.target.files);
                      event.target.value = '';
                    }}
                  />
                </div>
                <div className="composer-controls">
                  <ConnectedContextMeter
                    store={conversationStore}
                    sessionId={activeSessionId}
                    onOpen={() => setIsActivityPanelOpen(true)}
                  />
                  <div className={`menu-anchor${openMenu === 'model' ? ' menu-anchor-open' : ''}`}>
                    <button
                      className="model-button"
                      type="button"
                      aria-expanded={openMenu === 'model'}
                      aria-label="模型与强度"
                      onClick={() => toggleMenu('model')}
                    >
                      <span className="model-button-label">
                        {selectedProvider?.label ?? selectedModel}
                      </span>
                      <span className="model-button-strength">
                        ·{' '}
                        {reasoningEffortOptions.find((option) => option.value === reasoningEffort)
                          ?.label ?? '默认'}
                      </span>
                      <ChevronDown aria-hidden="true" />
                    </button>
                    {openMenu === 'model' ? (
                      <div
                        className="popup-menu popup-menu-composer popup-menu-right"
                        role="menu"
                        aria-label="选择模型"
                      >
                        {providerSettings.providers.map((provider) => (
                          <button
                            type="button"
                            role="menuitem"
                            aria-label={provider.label}
                            key={provider.id}
                            onClick={() => chooseProvider(provider)}
                          >
                            <span className="menu-icon">
                              <Bot aria-hidden="true" />
                            </span>
                            <span className="provider-menu-copy">
                              <strong>{provider.label}</strong>
                              {provider.defaultModel !== undefined ? (
                                <small>{provider.defaultModel}</small>
                              ) : null}
                            </span>
                            {selectedProviderId === provider.id ? (
                              <Check className="menu-check" aria-hidden="true" />
                            ) : null}
                          </button>
                        ))}
                        <div className="menu-divider" />
                        <div className="model-strength" role="group" aria-label="模型强度">
                          <div className="model-strength-head">
                            <span>强度</span>
                            <small>
                              {reasoningEffortOptions.find(
                                (option) => option.value === reasoningEffort,
                              )?.label ?? '默认'}
                            </small>
                          </div>
                          <input
                            type="range"
                            className="model-strength-slider"
                            min={0}
                            max={reasoningEffortOptions.length - 1}
                            step={1}
                            value={Math.max(
                              0,
                              reasoningEffortOptions.findIndex(
                                (option) => option.value === reasoningEffort,
                              ),
                            )}
                            aria-label="模型强度"
                            onChange={(event) =>
                              setReasoningEffort(
                                reasoningEffortOptions[Number(event.target.value)]?.value ??
                                  'medium',
                              )
                            }
                          />
                          <div className="model-strength-scale" aria-hidden="true">
                            <span>更快</span>
                            <span>更聪明</span>
                          </div>
                        </div>
                      </div>
                    ) : null}
                  </div>
                  {status === 'streaming' ? (
                    <span className="execution-connection-status" role="status">
                      {activeRunState.stopping
                        ? '正在停止…'
                        : activeRunState.connection === 'reconnecting'
                          ? '连接已断开，正在重连…'
                          : activeRunState.connection === 'connecting'
                            ? '正在连接…'
                            : '运行中'}
                    </span>
                  ) : null}
                  {status === 'streaming' ? (
                    <button
                      className="send-button send-button-cancel"
                      type="button"
                      onClick={cancelRun}
                      aria-label="停止本轮及派生任务"
                      title="停止本轮及派生任务"
                    >
                      <Square aria-hidden="true" />
                    </button>
                  ) : null}
                  <button
                    className="send-button"
                    type="submit"
                    disabled={
                      admitting[activeSessionId] ||
                      (messageInput.trim() === '' &&
                        pendingImages.length === 0 &&
                        composerDraft.draft.files.length === 0)
                    }
                    aria-label={
                      status === 'streaming' || (activeQueue?.queued.length ?? 0) > 0
                        ? '加入队列'
                        : '发送'
                    }
                  >
                    <SendHorizontal aria-hidden="true" />
                  </button>
                </div>
              </div>
            </div>
          )}
        </form>
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
        <div className="modal-backdrop">
          <section
            className="queue-copy-dialog"
            role="dialog"
            aria-modal="true"
            aria-label="复制队列消息"
          >
            <h2>保留当前草稿</h2>
            <p>请选择追加或替换；原消息仍在队列中。</p>
            <div className="queue-copy-dialog-actions">
              <button
                type="button"
                onClick={() => applyQueuedCopy(copyRequest.snapshot, copyRequest.owner, true)}
              >
                追加到草稿
              </button>
              <button
                type="button"
                onClick={() => applyQueuedCopy(copyRequest.snapshot, copyRequest.owner, false)}
              >
                替换草稿
              </button>
              <button type="button" onClick={() => setCopyRequest(null)}>
                取消复制
              </button>
            </div>
          </section>
        </div>
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
        <div
          className="dialog-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) {
              closeProviderForm();
            }
          }}
        >
          <section
            className="project-dialog provider-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="provider-dialog-title"
          >
            <header className="project-dialog-header">
              <div>
                <p>模型服务</p>
                <h2 id="provider-dialog-title">
                  {providerForm.mode === 'create' ? '添加 AI 服务' : '编辑 Provider'}
                </h2>
              </div>
              <button
                className="icon-button"
                type="button"
                aria-label="关闭 Provider 表单"
                onClick={closeProviderForm}
                disabled={providerMutation === 'saving'}
              >
                <X aria-hidden="true" />
              </button>
            </header>
            <form className="project-dialog-form" onSubmit={(event) => void saveProvider(event)}>
              <label className="provider-form-field">
                <span>供应商</span>
                <FormSelect
                  label="供应商"
                  value={providerForm.providerPresetId}
                  placeholder="选择常见供应商"
                  options={[
                    ...providerPresets.map((preset) => ({
                      value: preset.id,
                      label: preset.label,
                    })),
                    { value: customProviderPresetId, label: '自定义供应商' },
                  ]}
                  onChange={chooseProviderPreset}
                />
              </label>
              <div className="provider-form-grid">
                <label className="provider-form-field">
                  <span>
                    {providerForm.providerPresetId === customProviderPresetId
                      ? '自定义供应商名称'
                      : '显示名称'}
                  </span>
                  <input
                    aria-label={
                      providerForm.providerPresetId === customProviderPresetId
                        ? '自定义供应商名称'
                        : '显示名称'
                    }
                    value={providerForm.label}
                    onChange={(event) => updateProviderForm('label', event.target.value)}
                    placeholder="例如 DeepSeek"
                    autoFocus
                  />
                </label>
                <label className="provider-form-field">
                  <span>Provider ID</span>
                  <input
                    aria-label="Provider ID"
                    value={providerForm.id}
                    onChange={(event) => updateProviderForm('id', event.target.value)}
                    placeholder="例如 deepseek"
                    disabled={providerForm.mode === 'edit'}
                  />
                </label>
              </div>
              <label className="provider-form-field">
                <span>API 地址</span>
                <input
                  aria-label="API 地址"
                  type="url"
                  value={providerForm.baseUrl}
                  onChange={(event) => updateProviderForm('baseUrl', event.target.value)}
                  placeholder="https://api.deepseek.com"
                />
              </label>
              <label className="provider-form-field">
                <span>API Key</span>
                <input
                  aria-label="API Key"
                  type="password"
                  value={providerForm.apiKey}
                  onChange={(event) => updateProviderForm('apiKey', event.target.value)}
                  placeholder={
                    providerForm.mode === 'edit' ? '留空表示保持当前密钥' : '输入 API Key'
                  }
                  autoComplete="new-password"
                />
              </label>
              {findProviderPreset(providerForm.providerPresetId) !== undefined ? (
                <label className="provider-form-field">
                  <span>默认模型</span>
                  <FormSelect
                    label="默认模型"
                    value={providerForm.modelPresetId}
                    placeholder="选择默认模型"
                    options={[
                      ...(findProviderPreset(providerForm.providerPresetId)?.models ?? []).map(
                        (model) => ({
                          value: model,
                          label: model,
                        }),
                      ),
                      { value: customProviderPresetId, label: '自定义模型' },
                    ]}
                    onChange={chooseModelPreset}
                  />
                </label>
              ) : null}
              {findProviderPreset(providerForm.providerPresetId) !== undefined &&
              providerForm.modelPresetId === customProviderPresetId ? (
                <label className="provider-form-field">
                  <span>自定义模型</span>
                  <input
                    aria-label="自定义模型"
                    value={providerForm.defaultModel}
                    onChange={(event) => updateProviderForm('defaultModel', event.target.value)}
                    placeholder="输入模型名称"
                  />
                </label>
              ) : null}
              {findProviderPreset(providerForm.providerPresetId) === undefined ? (
                <label className="provider-form-field">
                  <span>
                    {providerForm.providerPresetId === customProviderPresetId
                      ? '自定义模型'
                      : '默认模型'}
                  </span>
                  <input
                    aria-label={
                      providerForm.providerPresetId === customProviderPresetId
                        ? '自定义模型'
                        : '默认模型'
                    }
                    value={providerForm.defaultModel}
                    onChange={(event) => updateProviderForm('defaultModel', event.target.value)}
                    placeholder="例如 deepseek-flash"
                  />
                </label>
              ) : null}
              <div className="provider-form-grid">
                <label className="provider-form-field">
                  <span>Temperature（可选）</span>
                  <input
                    aria-label="Temperature"
                    type="number"
                    min={0}
                    max={2}
                    step={0.1}
                    value={providerForm.temperature}
                    onChange={(event) => updateProviderForm('temperature', event.target.value)}
                    placeholder="默认 1.0"
                  />
                </label>
                <label className="provider-form-field">
                  <span>最大输出 token（可选）</span>
                  <input
                    aria-label="最大输出 token"
                    type="number"
                    min={1}
                    step={1}
                    value={providerForm.maxTokens}
                    onChange={(event) => updateProviderForm('maxTokens', event.target.value)}
                    placeholder="默认 4096"
                  />
                </label>
              </div>
              <label className="provider-form-field">
                <span>上下文窗口 token（可选）</span>
                <input
                  aria-label="上下文窗口 token"
                  type="number"
                  min={1}
                  step={1}
                  value={providerForm.contextWindowTokens}
                  onChange={(event) =>
                    updateProviderForm('contextWindowTokens', event.target.value)
                  }
                  placeholder="默认 128000"
                />
              </label>
              <p className="project-dialog-note">
                留空即用默认：温度与最大输出跟随模型（常见 1.0 / 4096），上下文窗口为
                128000；设置后仅作用于该 Provider，对话未显式指定时才生效。
              </p>
              <label className="provider-checkbox-field">
                <input
                  type="checkbox"
                  checked={providerForm.makeDefault}
                  onChange={(event) => updateProviderForm('makeDefault', event.target.checked)}
                />
                <span>设为默认 Provider</span>
              </label>
              {providerForm.mode === 'edit' ? (
                <label className="provider-checkbox-field provider-checkbox-danger">
                  <input
                    type="checkbox"
                    checked={providerForm.clearApiKey}
                    onChange={(event) => updateProviderForm('clearApiKey', event.target.checked)}
                  />
                  <span>清除当前密钥</span>
                </label>
              ) : null}
              {providerForm.mode === 'edit' ? (
                <p className="project-dialog-note">
                  留空表示保持当前密钥，修改 API 地址时需要重新填写；清除密钥后 Provider
                  将不能用于对话。
                </p>
              ) : null}
              {providerFormError !== null ? (
                <p className="provider-form-error" role="alert">
                  {providerFormError}
                </p>
              ) : null}
              <footer className="project-dialog-actions">
                <button
                  className="secondary-button"
                  type="button"
                  onClick={closeProviderForm}
                  disabled={providerMutation === 'saving'}
                >
                  取消
                </button>
                <button
                  className="primary-button"
                  type="submit"
                  disabled={providerMutation === 'saving'}
                >
                  {providerMutation === 'saving' ? '保存中...' : '保存 Provider'}
                </button>
              </footer>
            </form>
          </section>
        </div>
      ) : null}
      {providerToDelete !== null ? (
        <div
          className="dialog-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) {
              setProviderToDelete(null);
            }
          }}
        >
          <section
            className="project-dialog session-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="delete-provider-dialog-title"
          >
            <header className="project-dialog-header">
              <div>
                <p>删除确认</p>
                <h2 id="delete-provider-dialog-title">删除 Provider</h2>
              </div>
              <button
                className="icon-button"
                type="button"
                aria-label="关闭删除确认"
                onClick={() => setProviderToDelete(null)}
                disabled={providerMutation === 'deleting'}
              >
                <X aria-hidden="true" />
              </button>
            </header>
            <div className="project-dialog-form">
              <p className="delete-session-warning">
                确定删除「{providerToDelete.label}」吗？已保存的密钥和配置会从本机移除。
              </p>
              <footer className="project-dialog-actions">
                <button
                  className="secondary-button"
                  type="button"
                  onClick={() => setProviderToDelete(null)}
                  disabled={providerMutation === 'deleting'}
                >
                  取消
                </button>
                <button
                  className="danger-button"
                  type="button"
                  onClick={() => void deleteProvider()}
                  disabled={providerMutation === 'deleting'}
                >
                  <Trash2 aria-hidden="true" />
                  {providerMutation === 'deleting' ? '删除中...' : '确认删除'}
                </button>
              </footer>
            </div>
          </section>
        </div>
      ) : null}
      {editingSession !== null ? (
        <div
          className="dialog-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) {
              setEditingSession(null);
            }
          }}
        >
          <section
            className="project-dialog session-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="edit-session-dialog-title"
          >
            <header className="project-dialog-header">
              <div>
                <p>会话设置</p>
                <h2 id="edit-session-dialog-title">编辑会话</h2>
              </div>
              <button
                className="icon-button"
                type="button"
                aria-label="关闭编辑会话"
                onClick={() => setEditingSession(null)}
              >
                <X aria-hidden="true" />
              </button>
            </header>
            <form
              className="project-dialog-form"
              onSubmit={(event) => {
                event.preventDefault();
                void saveSessionTitle();
              }}
            >
              <label className="project-name-field">
                <span>会话标题</span>
                <div>
                  <Pencil aria-hidden="true" />
                  <input
                    type="text"
                    aria-label="会话标题"
                    value={sessionTitleInput}
                    onChange={(event) => setSessionTitleInput(event.target.value)}
                    autoFocus
                  />
                </div>
              </label>
              <footer className="project-dialog-actions">
                <button
                  className="secondary-button"
                  type="button"
                  onClick={() => setEditingSession(null)}
                >
                  取消
                </button>
                <button
                  className="primary-button"
                  type="submit"
                  aria-label="保存标题"
                  disabled={sessionTitleInput.trim() === ''}
                >
                  保存
                </button>
              </footer>
            </form>
          </section>
        </div>
      ) : null}
      {renamingProjectId !== null ? (
        <div
          className="dialog-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) {
              setRenamingProjectId(null);
            }
          }}
        >
          <section
            className="project-dialog session-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="rename-project-dialog-title"
          >
            <header className="project-dialog-header">
              <div>
                <p>项目设置</p>
                <h2 id="rename-project-dialog-title">重命名项目</h2>
              </div>
              <button
                className="icon-button"
                type="button"
                aria-label="关闭重命名项目"
                onClick={() => setRenamingProjectId(null)}
              >
                <X aria-hidden="true" />
              </button>
            </header>
            <form
              className="project-dialog-form"
              onSubmit={(event) => {
                event.preventDefault();
                void saveProjectName();
              }}
            >
              <label className="project-name-field">
                <span>项目名称</span>
                <div>
                  <FolderKanban aria-hidden="true" />
                  <input
                    type="text"
                    aria-label="新的项目名称"
                    value={projectRenameInput}
                    onChange={(event) => setProjectRenameInput(event.target.value)}
                    autoFocus
                  />
                </div>
              </label>
              <p className="project-dialog-note">只修改显示名称，项目文件夹和会话保持不变。</p>
              <footer className="project-dialog-actions">
                <button
                  className="secondary-button"
                  type="button"
                  onClick={() => setRenamingProjectId(null)}
                >
                  取消
                </button>
                <button
                  className="primary-button"
                  type="submit"
                  aria-label="保存项目名称"
                  disabled={projectRenameInput.trim() === ''}
                >
                  保存
                </button>
              </footer>
            </form>
          </section>
        </div>
      ) : null}
      {sessionToDelete !== null ? (
        <div
          className="dialog-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) {
              setSessionToDelete(null);
            }
          }}
        >
          <section
            className="project-dialog session-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="delete-session-dialog-title"
          >
            <header className="project-dialog-header">
              <div>
                <p>归档会话</p>
                <h2 id="delete-session-dialog-title">删除会话</h2>
              </div>
              <button
                className="icon-button"
                type="button"
                aria-label="关闭删除确认"
                onClick={() => setSessionToDelete(null)}
              >
                <X aria-hidden="true" />
              </button>
            </header>
            <div className="project-dialog-form">
              <p className="delete-session-warning">
                确定要删除“{sessionToDelete.title}
                ”吗？删除后无法在界面中恢复。会话的历史记录仍保留在本机数据文件中。
              </p>
              <footer className="project-dialog-actions">
                <button
                  className="secondary-button"
                  type="button"
                  onClick={() => setSessionToDelete(null)}
                >
                  取消
                </button>
                <button
                  className="danger-button"
                  type="button"
                  aria-label="确认删除"
                  onClick={() => void permanentlyDeleteSession()}
                >
                  <Trash2 aria-hidden="true" />
                  删除
                </button>
              </footer>
            </div>
          </section>
        </div>
      ) : null}
      {folderDialogProjectId === null ? null : (
        <div
          className="dialog-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) {
              setFolderDialogProjectId(null);
            }
          }}
        >
          <section
            className="project-dialog"
            role="dialog"
            aria-modal="true"
            aria-label="设置项目文件夹"
          >
            <header className="project-dialog-header">
              <div>
                <p>本地项目</p>
                <h2>设置项目文件夹</h2>
              </div>
              <button
                className="icon-button"
                type="button"
                aria-label="关闭设置项目文件夹"
                onClick={() => setFolderDialogProjectId(null)}
              >
                <X aria-hidden="true" />
              </button>
            </header>
            <form
              className="project-dialog-form"
              onSubmit={(event) => {
                event.preventDefault();
                const folderPath = folderDialogPath.trim();
                if (folderPath !== '') {
                  void saveProjectFolder(folderPath);
                }
              }}
            >
              {window.weaveDesktop?.pickDirectory === undefined ? (
                <label className="project-name-field">
                  <span>文件夹绝对路径</span>
                  <div>
                    <FolderOpen aria-hidden="true" />
                    <input
                      type="text"
                      aria-label="项目文件夹绝对路径"
                      placeholder="例如 /Users/me/projects/demo"
                      value={folderDialogPath}
                      onChange={(event) => setFolderDialogPath(event.target.value)}
                    />
                  </div>
                </label>
              ) : (
                <div className="project-folder-field">
                  <span>项目文件夹</span>
                  <button
                    className={`folder-picker${folderDialogPath === '' ? '' : ' folder-picker-selected'}`}
                    type="button"
                    aria-label="选择项目文件夹"
                    onClick={() => void pickFolderForDialog()}
                  >
                    <span className="folder-picker-icon" aria-hidden="true">
                      <FolderOpen />
                    </span>
                    <span>
                      <strong className="selected-folder-name">
                        {folderDialogPath === '' ? '选择本地文件夹' : folderDialogPath}
                      </strong>
                      <small>Agent 将在该文件夹中读写文件</small>
                    </span>
                    <ChevronRight aria-hidden="true" />
                  </button>
                </div>
              )}
              <p className="project-dialog-note">
                Agent 可以读取该文件夹中的文本文件；写入文件前会请你确认。
              </p>
              {folderDialogError === null ? null : (
                <p className="project-dialog-note approval-card-error" role="alert">
                  {folderDialogError}
                </p>
              )}
              <footer className="project-dialog-actions">
                {projects.find((project) => project.id === folderDialogProjectId)?.folderPath ===
                undefined ? null : (
                  <button
                    className="secondary-button"
                    type="button"
                    onClick={() => void saveProjectFolder(null)}
                  >
                    清除文件夹
                  </button>
                )}
                <button
                  className="secondary-button"
                  type="button"
                  onClick={() => setFolderDialogProjectId(null)}
                >
                  取消
                </button>
                <button
                  className="primary-button"
                  type="submit"
                  disabled={folderDialogPath.trim() === ''}
                >
                  保存
                </button>
              </footer>
            </form>
          </section>
        </div>
      )}
      {isProjectDialogOpen ? (
        <div
          className="dialog-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) {
              setIsProjectDialogOpen(false);
            }
          }}
        >
          <section
            className="project-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="project-dialog-title"
          >
            <header className="project-dialog-header">
              <div>
                <p>本地项目</p>
                <h2 id="project-dialog-title">创建项目</h2>
              </div>
              <button
                className="icon-button"
                type="button"
                aria-label="关闭创建项目"
                onClick={() => setIsProjectDialogOpen(false)}
              >
                <X aria-hidden="true" />
              </button>
            </header>
            <form
              className="project-dialog-form"
              onSubmit={(event) => {
                event.preventDefault();
                void createProject();
              }}
            >
              <label className="project-name-field">
                <span>项目名称</span>
                <div>
                  <FolderKanban aria-hidden="true" />
                  <input
                    type="text"
                    aria-label="项目名称"
                    placeholder="选择文件夹后自动生成"
                    value={projectName}
                    onChange={(event) => setProjectName(event.target.value)}
                  />
                </div>
              </label>
              <div className="project-folder-field">
                <span>项目文件夹</span>
                <button
                  className={`folder-picker${selectedFolderName === '' ? '' : ' folder-picker-selected'}`}
                  type="button"
                  aria-label="选择文件夹"
                  onClick={() => void chooseProjectFolder()}
                >
                  <span className="folder-picker-icon" aria-hidden="true">
                    <FolderOpen />
                  </span>
                  {selectedFolderName === '' ? (
                    <span>
                      <strong>选择本地文件夹</strong>
                      <small>项目将使用该文件夹作为工作目录</small>
                    </span>
                  ) : (
                    <span>
                      <strong className="selected-folder-name">{selectedFolderName}</strong>
                      <small>已选择本地文件夹</small>
                    </span>
                  )}
                  <ChevronRight aria-hidden="true" />
                </button>
                <input
                  {...({ webkitdirectory: '', directory: '' } as Record<string, string>)}
                  className="sr-only"
                  ref={directoryInputRef}
                  type="file"
                  aria-label="选择项目文件夹"
                  multiple
                  onChange={chooseFallbackFolder}
                />
              </div>
              {window.weaveDesktop?.pickDirectory === undefined ? (
                <label className="project-name-field">
                  <span>文件夹绝对路径（可选）</span>
                  <div>
                    <FolderOpen aria-hidden="true" />
                    <input
                      type="text"
                      aria-label="文件夹绝对路径"
                      placeholder="例如 /Users/me/projects/demo，填写后 Agent 可读写其中文件"
                      value={selectedFolderPath}
                      onChange={(event) => setSelectedFolderPath(event.target.value)}
                    />
                  </div>
                </label>
              ) : selectedFolderPath === '' ? null : (
                <p className="project-dialog-note project-folder-path">{selectedFolderPath}</p>
              )}
              <p className="project-dialog-note">
                {selectedFolderPath.trim() === ''
                  ? '未设置文件夹路径时，Agent 不能读写项目文件。'
                  : 'Agent 可以读取该文件夹中的文本文件；写入文件前会请你确认。'}
              </p>
              <footer className="project-dialog-actions">
                <button
                  className="secondary-button"
                  type="button"
                  onClick={() => setIsProjectDialogOpen(false)}
                >
                  取消
                </button>
                <button
                  className="primary-button"
                  type="submit"
                  disabled={projectName.trim() === '' || selectedFolderName === ''}
                >
                  创建项目
                </button>
              </footer>
            </form>
          </section>
        </div>
      ) : null}
      {previewImage !== null ? (
        <div
          className="image-preview-backdrop"
          role="dialog"
          aria-modal="true"
          aria-label="图片预览"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) {
              setPreviewImage(null);
            }
          }}
        >
          <button
            className="image-preview-close"
            type="button"
            aria-label="关闭预览"
            onClick={() => setPreviewImage(null)}
          >
            <X aria-hidden="true" />
          </button>
          <img
            className="image-preview-image"
            src={`data:${previewImage.mediaType};base64,${previewImage.data}`}
            alt="图片预览"
          />
        </div>
      ) : null}
    </main>
  );
}
