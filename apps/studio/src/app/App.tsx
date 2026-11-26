import { useFilePicker } from '../features/file-context/use-file-picker.js';
import { FilePicker } from '../features/file-context/file-picker.js';
import {
  DraftContextAttachments,
  DraftFileAttachments,
} from '../features/file-context/file-attachments.js';
import { fetchContextAvailability } from '../features/file-context/context-availability-api.js';
import type { ExecutionContextKind } from '../features/file-context/execution-context-types.js';
import {
  ChangeEvent,
  type ClipboardEvent as ReactClipboardEvent,
  type CSSProperties,
  FormEvent,
  KeyboardEvent as ReactKeyboardEvent,
  type ReactElement,
  useEffect,
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  Archive,
  Bot,
  BookOpen,
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  Files,
  FolderOpen,
  FolderCog,
  FolderKanban,
  GitBranch,
  History,
  ImagePlus,
  MessageSquarePlus,
  MoreHorizontal,
  PanelRightOpen,
  Pencil,
  Plus,
  Puzzle,
  Search,
  SendHorizontal,
  Settings,
  ShieldCheck,
  Square,
  Sparkles,
  TerminalSquare,
  Trash2,
  RotateCcw,
  X,
} from 'lucide-react';

import { AgentStreamError, streamAgentRun } from '../features/agent/agent-stream.js';
import type { AgentRuntimeEvent } from '../features/agent/agent-types.js';
import type { AgentStreamHandlers } from '../features/agent/agent-types.js';
import {
  cancelAgentExecution,
  getAgentExecution,
  listAgentExecutions,
  observeAgentExecution,
  waitForExecutionRetry,
} from '../features/agent/agent-execution-client.js';
import {
  isTerminalExecution,
  type AgentExecutionSnapshot,
} from '../features/agent/agent-execution-types.js';
import { ExecutionQueueList } from '../features/agent/execution-queue-list.js';
import { useExecutionQueues } from '../features/agent/use-execution-queues.js';
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
  LiveOwner,
} from '../features/conversation/conversation-types.js';
import { createTurnFileReviewStore } from '../features/file-undo/turn-file-review-store.js';
import {
  ConnectedContextMeter,
  ConnectedConversationPanels,
} from '../features/conversation/connected-conversation-panels.js';
import {
  useComposerDraft,
  type DraftCapture,
  type DraftMigrationTicket,
} from '../features/composer/use-composer-draft.js';
import { usePluginPanels } from '../features/panel/use-plugin-panels.js';
import { createPluginCatalogStore } from '../features/plugins/plugin-catalog-store.js';
import {
  PluginCatalogProvider,
  PluginPendingBadge,
  usePluginCatalogStore,
} from '../features/plugins/plugin-catalog-context.js';
import { PluginMarketplacePage } from '../features/plugins/plugin-marketplace-page.js';
import { MemoryPage } from '../features/memory/MemoryPage.js';
import { SearchPage } from '../features/retrieval/SearchPage.js';
import { useSidePanelWidth } from '../features/panel/panel-resizer.js';
import { sumUsage } from '../features/conversation/turn-stats.js';
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
import type {
  SessionDetail,
  TurnSummary,
  TurnUsage,
} from '../features/workspace/workspace-types.js';
import {
  permissionOptions,
  reasoningEffortOptions,
  statusLabels,
  viewLabels,
} from './app-constants.js';
import {
  createId,
  createSessionTitle,
  emptyTurns,
  formatMessageTime,
  formatModelLabel,
  getSessionLabel,
  liveTurnIdFor,
  readImageFile,
  safeErrorMessage,
  toStudioProject,
  toStudioSession,
  updateToolActivity,
  workspaceErrorMessage,
} from './app-helpers.js';
import {
  idleRunState,
  type AgentSubmissionSnapshot,
  type ChatMessage,
  type DirectoryPickerWindow,
  type OpenMenu,
  type PendingImage,
  type ProductView,
  type RunStatus,
  type SessionRunHandle,
  type SessionRunState,
  type StudioProject,
  type StudioSession,
  type TaskTranscriptTarget,
  type ToolActivity,
} from './app-types.js';
import { FormSelect } from './form-select.js';
import { useProviderSettings } from './use-provider-settings.js';

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
  const [isProjectDialogOpen, setIsProjectDialogOpen] = useState(false);
  const [folderDialogProjectId, setFolderDialogProjectId] = useState<string | null>(null);
  const [folderDialogPath, setFolderDialogPath] = useState('');
  const [folderDialogError, setFolderDialogError] = useState<string | null>(null);
  const [projectName, setProjectName] = useState('');
  const [selectedFolderName, setSelectedFolderName] = useState('');
  const [selectedFolderPath, setSelectedFolderPath] = useState('');
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [isActivityPanelOpen, setIsActivityPanelOpen] = useState(true);
  const [panelWidth, setPanelWidth] = useSidePanelWidth();
  const shellRef = useRef<HTMLElement>(null);
  const chatColumnRef = useRef<HTMLElement>(null);
  const [permissionMode, setPermissionMode] = useState<'ask' | 'trust' | 'yolo'>('ask');
  const [viewerFilePath, setViewerFilePath] = useState<string | null>(null);
  // Whether the active project can supply Git changes; read when the context menu opens.
  const [gitChangesAvailability, setGitChangesAvailability] = useState<{
    readonly projectId: string;
    readonly state: 'available' | 'unavailable' | 'unknown';
  } | null>(null);
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
  const [editingSession, setEditingSession] = useState<{
    readonly projectId: string;
    readonly sessionId: string;
  } | null>(null);
  const [sessionTitleInput, setSessionTitleInput] = useState('');
  const [renamingProjectId, setRenamingProjectId] = useState<string | null>(null);
  const [projectRenameInput, setProjectRenameInput] = useState('');
  const [sessionToDelete, setSessionToDelete] = useState<{
    readonly projectId: string;
    readonly sessionId: string;
    readonly title: string;
  } | null>(null);
  const [expandedMessageIds, setExpandedMessageIds] = useState<readonly string[]>([]);
  const [runStateBySession, setRunStateBySession] = useState<Record<string, SessionRunState>>({});
  const runHandles = useRef<Map<string, SessionRunHandle>>(new Map());
  const observationEpoch = useRef(0);
  const sessionActivityVersions = useRef(new Map<string, number>());
  // Deleted IDs cannot be revived by an already admitted HTTP read or observer.
  const deletedSessionIds = useRef(new Set<string>());
  // Durable Session sequences survive navigation and Server epochs; late reads must not roll them back.
  const appliedDurableSequences = useRef(new Map<string, number>());
  const settledExecutionSequences = useRef(new Map<string, number>());
  const [admitting, setAdmitting] = useState<Record<string, boolean>>({});
  const [copyRequest, setCopyRequest] = useState<{
    snapshot: AgentExecutionSnapshot;
    owner: DraftCapture;
  } | null>(null);
  const queueController = useExecutionQueues({
    activeSessionId,
    activeProjectId,
    onActive: (projectId, sessionId, summary) => {
      void attachExecution(projectId, sessionId, summary.executionId);
    },
    onNotice: setNotice,
  });
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      for (const handle of runHandles.current.values()) handle.controller.abort();
      runHandles.current.clear();
      // StrictMode replays setup synchronously; only a real detach disposes timers.
      queueMicrotask(() => {
        if (!mounted.current) {
          conversationStore.dispose();
          fileReviewStore.dispose();
        }
      });
    };
  }, [conversationStore, fileReviewStore]);

  /** Run status of any session; a session without a run is idle. */
  function sessionRunStatus(sessionId: string): RunStatus {
    return runStateBySession[sessionId]?.status ?? 'idle';
  }
  function isSessionStreaming(sessionId: string): boolean {
    return (
      sessionRunStatus(sessionId) === 'streaming' ||
      (queueController.states[sessionId]?.queued.length ?? 0) > 0 ||
      admitting[sessionId] === true
    );
  }
  function setSessionRunState(sessionId: string, next: SessionRunState): void {
    setRunStateBySession((current) => ({ ...current, [sessionId]: next }));
  }

  // The composer, overview and footer always reflect the active session's run.
  const activeRunState = runStateBySession[activeSessionId] ?? idleRunState;
  const status = activeRunState.status;
  const errorMessage = activeRunState.errorMessage;
  const activeQueue = queueController.states[activeSessionId];
  const sessionHasWork = isSessionStreaming(activeSessionId);
  const activeSessionIdRef = useRef('');
  const navigationTicket = useRef(0);
  const lastVerifiedTaskRoot = useRef<{ projectId: string; root: string } | undefined>(undefined);
  const [taskTranscriptTarget, setTaskTranscriptTarget] = useState<TaskTranscriptTarget>();
  useEffect(() => {
    for (const [key, handle] of runHandles.current) {
      if (!handle.observing || handle.sessionId === activeSessionId) continue;
      if (handle.execution !== undefined)
        conversationStore.detachLive(liveOwner(handle.execution, handle.runId));
      handle.controller.abort();
      runHandles.current.delete(key);
    }
  }, [activeSessionId, conversationStore]);
  const messageInputRef = useRef<HTMLTextAreaElement | null>(null);
  const composerIsComposing = useRef(false);
  const directoryInputRef = useRef<HTMLInputElement | null>(null);
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
  const setPendingImages = composerDraft.setImages<PendingImage>;
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

  /** Applies an immutable message update to one local Studio session. */
  function updateSessionMessages(
    projectId: string,
    sessionId: string,
    update: (messages: readonly ChatMessage[]) => readonly ChatMessage[],
  ): void {
    setProjects((current) =>
      current.map((project) =>
        project.id === projectId
          ? {
              ...project,
              sessions: project.sessions.map((session) =>
                session.id === sessionId
                  ? { ...session, messages: update(session.messages) }
                  : session,
              ),
            }
          : project,
      ),
    );
  }

  /** Applies a change to one Session's Turn summaries, including live ones. */
  function updateSessionTurns(
    projectId: string,
    sessionId: string,
    update: (turns: readonly TurnSummary[]) => readonly TurnSummary[],
  ): void {
    setProjects((current) =>
      current.map((project) =>
        project.id === projectId
          ? {
              ...project,
              sessions: project.sessions.map((session) =>
                session.id === sessionId ? { ...session, turns: update(session.turns) } : session,
              ),
            }
          : project,
      ),
    );
  }

  /** Closes a live Turn that ended without a `completed` event. */
  function finishLiveTurn(
    projectId: string,
    sessionId: string,
    liveTurnId: string,
    finalStatus: 'failed' | 'cancelled',
  ): void {
    const completedAt = new Date().toISOString();
    updateSessionTurns(projectId, sessionId, (turns) =>
      turns.map((turn) =>
        turn.turnId === liveTurnId && turn.status === 'running'
          ? { ...turn, status: finalStatus, completedAt }
          : turn,
      ),
    );
  }

  /** Clears run-scoped state when the active session changes. */
  /** Resets view-only state (expanded process panels) when the active session changes. */
  function resetTransientState(): void {
    setExpandedMessageIds([]);
  }

  /** Clears the active session's transient run status and expanded panels. */
  function clearActiveRunState(): void {
    setExpandedMessageIds([]);
    setRunStateBySession((current) => {
      // Clearing presentation must not erase a live stream or its global run signal.
      if (
        current[activeSessionId] === undefined ||
        current[activeSessionId].status === 'streaming'
      ) {
        return current;
      }
      return Object.fromEntries(
        Object.entries(current).filter(([sessionId]) => sessionId !== activeSessionId),
      );
    });
  }

  function applySessionDetail(
    projectId: string,
    detail: SessionDetail,
    addMissing = false,
  ): boolean {
    if (!mounted.current || deletedSessionIds.current.has(detail.id)) return false;
    if (detail.lastSequence < (appliedDurableSequences.current.get(detail.id) ?? 0)) return false;
    appliedDurableSequences.current.set(detail.id, detail.lastSequence);
    conversationStore.hydrate(detail);
    setProjects((current) =>
      current.map((project) =>
        project.id !== projectId
          ? project
          : {
              ...project,
              sessions:
                addMissing && !project.sessions.some((session) => session.id === detail.id)
                  ? [toStudioSession(detail), ...project.sessions]
                  : project.sessions.map((session) =>
                      session.id === detail.id ? toStudioSession(detail) : session,
                    ),
            },
      ),
    );
    return true;
  }

  async function loadSessionDetail(projectId: string, sessionId: string): Promise<void> {
    if (deletedSessionIds.current.has(sessionId)) return;
    // A streaming session's freshest messages live in memory; a server snapshot
    // would clobber its in-flight assistant message, so skip the reload while it runs.
    if (hasSessionHandles(sessionId)) {
      void queueController.open(projectId, sessionId);
      return;
    }
    const activityVersion = sessionActivityVersions.current.get(sessionId) ?? 0;
    try {
      const detail = await workspaceApi.getSession(sessionId);
      if (detail.id !== sessionId) return;
      if ((sessionActivityVersions.current.get(sessionId) ?? 0) !== activityVersion) return;
      // A run may have started while the snapshot was in flight; don't clobber it.
      if (hasSessionHandles(sessionId)) {
        void queueController.open(projectId, sessionId);
        return;
      }
      if (!applySessionDetail(projectId, detail)) return;
      if (sessionRunStatus(sessionId) === 'streaming') {
        const latest = detail.turns.at(-1);
        setSessionRunState(
          sessionId,
          latest?.status === 'completed'
            ? { status: 'completed', errorMessage: null }
            : latest?.status === 'cancelled'
              ? { status: 'cancelled', errorMessage: null }
              : latest?.status === 'failed'
                ? { status: 'error', errorMessage: '本次运行失败，请查看运行错误' }
                : idleRunState,
        );
      }
      await recoverSessionExecution(projectId, sessionId, detail.lastSequence);
    } catch (error: unknown) {
      if (!deletedSessionIds.current.has(sessionId) && activeSessionIdRef.current === sessionId) {
        setNotice(workspaceErrorMessage(error));
      }
    }
  }

  function hasSessionHandles(sessionId: string): boolean {
    return [...runHandles.current.values()].some(
      (handle) => handle.sessionId === sessionId || handle.execution?.sessionId === sessionId,
    );
  }

  function executionHandle(sessionId: string, runId: string): SessionRunHandle | undefined {
    return [...runHandles.current.values()].find(
      (handle) =>
        handle.runId === runId &&
        (handle.execution === undefined || handle.execution.sessionId === sessionId),
    );
  }

  function executionOwnsStatus(sessionId: string, runId: string): boolean {
    const active = queueController.getState(sessionId)?.active;
    const handle = executionHandle(sessionId, runId);
    return (
      handle !== undefined &&
      !(
        handle.execution !== undefined &&
        isTerminalExecution(handle.execution.status) &&
        (handle.execution.durableThroughSequence ?? 0) <
          (settledExecutionSequences.current.get(sessionId) ?? 0)
      ) &&
      (active === undefined ||
        active === null ||
        active.executionId === handle.execution?.executionId) &&
      ![...runHandles.current.values()].some(
        (candidate) =>
          candidate !== handle &&
          candidate.execution?.sessionId === sessionId &&
          !isTerminalExecution(candidate.execution.status) &&
          candidate.execution.status !== 'queued',
      )
    );
  }

  async function attachExecution(
    projectId: string,
    sessionId: string,
    executionId: string,
    supplied?: AgentExecutionSnapshot,
  ): Promise<void> {
    if (deletedSessionIds.current.has(sessionId)) return;
    if (activeSessionIdRef.current !== sessionId) return;
    if (!mounted.current || runHandles.current.has(executionId)) return;
    const handle: SessionRunHandle = {
      runId: createId('observation'),
      observationEpoch: ++observationEpoch.current,
      projectId,
      sessionId,
      assistantId: supplied?.turnId ?? executionId,
      controller: new AbortController(),
      tools: [],
      observing: true,
    };
    runHandles.current.set(executionId, handle);
    if (queueController.getState(sessionId)?.active?.executionId === executionId)
      setSessionRunState(sessionId, { status: 'streaming', errorMessage: null });
    try {
      let snapshot = supplied;
      let attempt = 0;
      while (snapshot === undefined) {
        try {
          snapshot = await getAgentExecution(sessionId, executionId, handle.controller.signal);
        } catch (error: unknown) {
          if (!(error instanceof TypeError)) throw error;
          await waitForExecutionRetry(attempt++, handle.controller.signal);
        }
      }
      if (
        !mounted.current ||
        deletedSessionIds.current.has(sessionId) ||
        runHandles.current.get(executionId) !== handle
      )
        return;
      handle.execution = snapshot;
      handle.assistantId = snapshot.turnId;
      renderExecution(projectId, snapshot, handle.runId);
      if (snapshot.status === 'queued') {
        runHandles.current.delete(executionId);
        return;
      }
      if (executionOwnsStatus(sessionId, handle.runId))
        setSessionRunState(sessionId, {
          status: 'streaming',
          stopping: snapshot.status === 'cancelling',
          errorMessage: snapshot.error?.message ?? null,
        });
      if (handle.pendingCancel) void requestExecutionCancel(projectId, sessionId, handle.runId);
      await resumeExecution(projectId, sessionId, handle.runId);
    } catch (error: unknown) {
      if (runHandles.current.get(executionId) === handle) runHandles.current.delete(executionId);
      if (!handle.controller.signal.aborted && mounted.current)
        setNotice(`无法恢复执行。${safeErrorMessage(error)}`);
    }
  }

  function executionIsCurrent(sessionId: string, runId: string): boolean {
    return mounted.current && executionHandle(sessionId, runId) !== undefined;
  }

  function liveOwner(snapshot: AgentExecutionSnapshot, runId: string): LiveOwner {
    return {
      sessionId: snapshot.sessionId,
      executionId: snapshot.executionId,
      turnId: snapshot.turnId,
      userMessageId: snapshot.userMessageId,
      runId,
      epoch: executionHandle(snapshot.sessionId, runId)?.observationEpoch ?? -1,
    };
  }
  function renderExecution(
    projectId: string,
    snapshot: AgentExecutionSnapshot,
    runId: string,
  ): void {
    void projectId;
    const handle = executionHandle(snapshot.sessionId, runId);
    if (handle === undefined || !executionIsCurrent(snapshot.sessionId, runId)) return;
    handle.execution = snapshot;
    if (snapshot.status !== 'queued')
      conversationStore.replaceLive(liveOwner(snapshot, runId), snapshot);
  }

  function executionHandlers(
    projectId: string,
    sessionId: string,
    runId: string,
  ): AgentStreamHandlers {
    return {
      onSnapshot: (snapshot) => {
        if (!executionIsCurrent(sessionId, runId)) return;
        renderExecution(projectId, snapshot, runId);
        if (isTerminalExecution(snapshot.status))
          void reconcileExecution(projectId, sessionId, runId);
        if (!executionOwnsStatus(sessionId, runId)) return;
        setRunStateBySession((current) => ({
          ...current,
          [sessionId]: {
            ...current[sessionId],
            status: 'streaming',
            errorMessage: snapshot.error?.message ?? null,
            stopping:
              executionHandle(sessionId, runId)?.pendingCancel || snapshot.status === 'cancelling',
          },
        }));
      },
      onEvent: (event) => {
        const handle = executionHandle(sessionId, runId);
        if (handle?.execution === undefined || !executionIsCurrent(sessionId, runId)) return;
        conversationStore.appendLive(liveOwner(handle.execution, runId), event);
      },
      onStatus: (status) => {
        const handle = executionHandle(sessionId, runId);
        if (handle?.execution === undefined || !executionIsCurrent(sessionId, runId)) return;
        handle.execution = { ...handle.execution, ...status };
        conversationStore.updateLiveStatus(liveOwner(handle.execution, runId), status);
        if (isTerminalExecution(status.status))
          void reconcileExecution(projectId, sessionId, runId);
        if (!executionOwnsStatus(sessionId, runId)) return;
        setRunStateBySession((current) => ({
          ...current,
          [sessionId]: {
            ...current[sessionId],
            status: 'streaming',
            errorMessage: status.error?.message ?? null,
            stopping: handle.pendingCancel || status.status === 'cancelling',
          },
        }));
      },
      onConnection: (connection) => {
        if (!executionIsCurrent(sessionId, runId)) return;
        if (!executionOwnsStatus(sessionId, runId)) return;
        setRunStateBySession((current) => ({
          ...current,
          [sessionId]: {
            ...current[sessionId],
            status: 'streaming',
            errorMessage: current[sessionId]?.errorMessage ?? null,
            connection,
          },
        }));
      },
    };
  }

  async function requestExecutionCancel(
    projectId: string,
    sessionId: string,
    runId: string,
  ): Promise<void> {
    const handle = executionHandle(sessionId, runId);
    if (
      handle?.execution === undefined ||
      handle.cancelInFlight ||
      !executionIsCurrent(sessionId, runId)
    )
      return;
    handle.cancelInFlight = true;
    try {
      const snapshot = await cancelAgentExecution(sessionId, handle.execution.executionId);
      if (!executionIsCurrent(sessionId, runId)) return;
      // Cancellation receipts may lag the observation stream; never replace newer output.
      if (!isTerminalExecution(handle.execution.status)) {
        handle.execution = {
          ...handle.execution,
          status: snapshot.status,
          ...(snapshot.durableThroughSequence === undefined
            ? {}
            : { durableThroughSequence: snapshot.durableThroughSequence }),
          ...(snapshot.error === undefined ? {} : { error: snapshot.error }),
        };
        conversationStore.updateLiveStatus(liveOwner(handle.execution, runId), {
          cursor: handle.execution.cursor,
          status: handle.execution.status,
          ...(handle.execution.durableThroughSequence === undefined
            ? {}
            : { durableThroughSequence: handle.execution.durableThroughSequence }),
          ...(handle.execution.error === undefined ? {} : { error: handle.execution.error }),
        });
        if (isTerminalExecution(handle.execution.status))
          void reconcileExecution(projectId, sessionId, runId);
      }
    } catch (error: unknown) {
      if (executionIsCurrent(sessionId, runId) && executionOwnsStatus(sessionId, runId))
        setSessionRunState(sessionId, {
          status: 'streaming',
          stopping: true,
          errorMessage: `停止请求未确认，可再次点击停止。${safeErrorMessage(error)}`,
        });
    } finally {
      handle.cancelInFlight = false;
    }
  }

  async function reconcileExecution(
    projectId: string,
    sessionId: string,
    runId: string,
  ): Promise<void> {
    const reconciliationHandle = executionHandle(sessionId, runId);
    if (reconciliationHandle === undefined || reconciliationHandle.reconciling) return;
    reconciliationHandle.reconciling = true;
    let attempt = 0;
    try {
      while (executionIsCurrent(sessionId, runId)) {
        const handle = executionHandle(sessionId, runId);
        const snapshot = handle?.execution;
        if (handle === undefined || snapshot === undefined || !isTerminalExecution(snapshot.status))
          return;
        try {
          const detail = await workspaceApi.getSession(sessionId);
          if (!executionIsCurrent(sessionId, runId)) return;
          const turn = detail.turns.find(
            (candidate) =>
              candidate.turnId === snapshot.turnId &&
              candidate.userMessageId === snapshot.userMessageId,
          );
          if (
            detail.id === sessionId &&
            snapshot.durableThroughSequence !== undefined &&
            detail.lastSequence >= snapshot.durableThroughSequence &&
            ((turn !== undefined && turn.status !== 'running') ||
              (turn === undefined && snapshot.status !== 'completed'))
          ) {
            const staleHistory =
              detail.lastSequence < (appliedDurableSequences.current.get(sessionId) ?? 0);
            if (!staleHistory) appliedDurableSequences.current.set(sessionId, detail.lastSequence);
            const settlement = conversationStore.settle(liveOwner(snapshot, runId), detail);
            if (!settlement.confirmed) {
              await waitForExecutionRetry(attempt++, handle.controller.signal);
              continue;
            }
            if (!staleHistory) applySessionDetail(projectId, detail);
            const ownsStatus =
              executionOwnsStatus(sessionId, runId) &&
              snapshot.durableThroughSequence >=
                (settledExecutionSequences.current.get(sessionId) ?? 0);
            settledExecutionSequences.current.set(
              sessionId,
              Math.max(
                snapshot.durableThroughSequence,
                settledExecutionSequences.current.get(sessionId) ?? 0,
              ),
            );
            runHandles.current.delete(snapshot.executionId);
            if (runHandles.current.get(sessionId) === handle) runHandles.current.delete(sessionId);
            // Durable settlement releases observation only; it never cancels a producer.
            handle.controller.abort();
            if (!ownsStatus) return;
            setSessionRunState(sessionId, {
              status:
                snapshot.status === 'completed'
                  ? 'completed'
                  : snapshot.status === 'cancelled'
                    ? 'cancelled'
                    : 'error',
              errorMessage:
                snapshot.status === 'failed' || snapshot.status === 'interrupted'
                  ? (snapshot.error?.message ?? '本次运行已中断；会话记录已更新。')
                  : null,
            });
            return;
          }
        } catch (error: unknown) {
          if (!executionIsCurrent(sessionId, runId)) return;
          if (executionOwnsStatus(sessionId, runId))
            setSessionRunState(sessionId, {
              status: 'streaming',
              stopping: handle.pendingCancel,
              connection: 'reconnecting',
              errorMessage: `正在确认持久化会话记录。${workspaceErrorMessage(error)}`,
            });
        }
        await waitForExecutionRetry(attempt++, handle.controller.signal);
      }
    } catch (error: unknown) {
      if (!reconciliationHandle.controller.signal.aborted && mounted.current)
        setNotice(`无法确认执行记录。${safeErrorMessage(error)}`);
    } finally {
      reconciliationHandle.reconciling = false;
    }
  }

  async function resumeExecution(
    projectId: string,
    sessionId: string,
    runId: string,
  ): Promise<void> {
    let attempt = 0;
    while (executionIsCurrent(sessionId, runId)) {
      const handle = executionHandle(sessionId, runId);
      if (handle?.execution === undefined) return;
      try {
        if (!isTerminalExecution(handle.execution.status)) {
          const snapshot =
            attempt === 0
              ? handle.execution
              : await getAgentExecution(
                  sessionId,
                  handle.execution.executionId,
                  handle.controller.signal,
                );
          if (!executionIsCurrent(sessionId, runId)) return;
          if (snapshot.status === 'queued') {
            runHandles.current.delete(snapshot.executionId);
            return;
          }
          await observeAgentExecution(snapshot, executionHandlers(projectId, sessionId, runId), {
            signal: handle.controller.signal,
          });
        }
        await reconcileExecution(projectId, sessionId, runId);
        return;
      } catch (error: unknown) {
        if (!executionIsCurrent(sessionId, runId)) return;
        if (executionOwnsStatus(sessionId, runId))
          setSessionRunState(sessionId, {
            status: 'streaming',
            stopping: handle.pendingCancel,
            connection: 'reconnecting',
            errorMessage: `正在恢复运行连接。${safeErrorMessage(error)}`,
          });
        try {
          await waitForExecutionRetry(attempt++, handle.controller.signal);
        } catch {
          return;
        }
      }
    }
  }

  async function recoverSessionExecution(
    projectId: string,
    sessionId: string,
    lastSequence: number,
    disposed?: () => boolean,
  ): Promise<void> {
    if (deletedSessionIds.current.has(sessionId)) return;
    await queueController.open(projectId, sessionId);
    if (!mounted.current || disposed?.() || deletedSessionIds.current.has(sessionId)) return;
    try {
      const summaries = await listAgentExecutions(sessionId);
      if (!mounted.current || disposed?.() || deletedSessionIds.current.has(sessionId)) return;
      for (const summary of summaries) {
        if (
          (summary.status !== 'queued' && !isTerminalExecution(summary.status)) ||
          (summary.durableThroughSequence !== undefined &&
            summary.durableThroughSequence > lastSequence)
        )
          void attachExecution(projectId, sessionId, summary.executionId);
      }
    } catch {
      /* Queue observation remains authoritative if history metadata is unavailable. */
    }
  }

  function findNextRunnableSession(
    projectId: string,
    excludedSessionId: string,
  ): StudioSession | undefined {
    return projects
      .find((project) => project.id === projectId)
      ?.sessions.find((session) => session.id !== excludedSessionId && session.archivedAt === null);
  }

  function handleEvent(
    event: AgentRuntimeEvent,
    runId: string,
    assistantId: string,
    projectId: string,
    sessionId: string,
  ): void {
    const handle = runHandles.current.get(sessionId);
    if (handle === undefined || handle.runId !== runId) {
      return;
    }

    switch (event.type) {
      case 'text-delta':
        updateSessionMessages(projectId, sessionId, (current) =>
          current.map((message) =>
            message.id === assistantId ? { ...message, text: message.text + event.text } : message,
          ),
        );
        break;
      case 'reasoning-delta':
        updateSessionMessages(projectId, sessionId, (current) =>
          current.map((message) =>
            message.id === assistantId
              ? { ...message, reasoning: message.reasoning + event.text }
              : message,
          ),
        );
        break;
      case 'tool-call':
        handle.tools = updateToolActivity(handle.tools, event.toolCall.id, () => ({
          toolCallId: event.toolCall.id,
          name: event.toolCall.name,
          arguments: event.toolCall.arguments,
          status: 'called',
        }));
        updateSessionMessages(projectId, sessionId, (messages) =>
          messages.map((message) =>
            message.id === assistantId ? { ...message, tools: handle.tools } : message,
          ),
        );
        break;
      case 'tool-executing':
        handle.tools = updateToolActivity(handle.tools, event.toolCall.id, (existing) => {
          const updated: ToolActivity = {
            toolCallId: event.toolCall.id,
            name: event.toolCall.name,
            arguments: event.toolCall.arguments,
            status: 'executing',
          };
          return existing?.result === undefined ? updated : { ...updated, result: existing.result };
        });
        updateSessionMessages(projectId, sessionId, (messages) =>
          messages.map((message) =>
            message.id === assistantId ? { ...message, tools: handle.tools } : message,
          ),
        );
        break;
      case 'tool-result':
        handle.tools = updateToolActivity(handle.tools, event.result.toolCallId, (existing) => ({
          toolCallId: event.result.toolCallId,
          name: event.result.name,
          arguments: existing?.arguments ?? '',
          status: event.status === 'failed' ? 'failed' : 'completed',
          result: event.result.content,
        }));
        updateSessionMessages(projectId, sessionId, (messages) =>
          messages.map((message) =>
            message.id === assistantId ? { ...message, tools: handle.tools } : message,
          ),
        );
        updateSessionTurns(projectId, sessionId, (turns) =>
          turns.map((turn) =>
            turn.turnId === liveTurnIdFor(assistantId)
              ? {
                  ...turn,
                  toolCalls: turn.toolCalls + 1,
                  failedToolCalls: turn.failedToolCalls + (event.status === 'failed' ? 1 : 0),
                }
              : turn,
          ),
        );
        break;
      case 'usage': {
        const completedAt = new Date().toISOString();
        updateSessionTurns(projectId, sessionId, (turns) =>
          turns.map((turn) => {
            if (turn.turnId !== liveTurnIdFor(assistantId)) {
              return turn;
            }
            const usage = Object.fromEntries(
              Object.entries(event.usage).filter(([, value]) => value !== undefined),
            ) as TurnUsage;
            return {
              ...turn,
              provider: event.provider,
              model: event.model,
              usage: sumUsage([turn.usage, usage]),
              modelSteps: [
                ...turn.modelSteps,
                {
                  startedAt: turn.modelSteps.at(-1)?.completedAt ?? turn.startedAt,
                  completedAt,
                  usage,
                },
              ],
            };
          }),
        );
        break;
      }
      case 'context': {
        updateSessionTurns(projectId, sessionId, (turns) =>
          turns.map((turn) =>
            turn.turnId === liveTurnIdFor(assistantId)
              ? { ...turn, provider: event.provider, model: event.model, context: event.breakdown }
              : turn,
          ),
        );
        break;
      }
      case 'plan': {
        updateSessionTurns(projectId, sessionId, (turns) =>
          turns.map((turn) =>
            turn.turnId === liveTurnIdFor(assistantId) ? { ...turn, plan: event.plan } : turn,
          ),
        );
        break;
      }
      case 'completed': {
        setSessionRunState(sessionId, { status: 'completed', errorMessage: null });
        const liveTurnId = liveTurnIdFor(assistantId);
        const completedAt = new Date().toISOString();
        updateSessionTurns(projectId, sessionId, (turns) =>
          turns.map((turn) =>
            turn.turnId === liveTurnId
              ? { ...turn, turnId: event.turnId, status: 'completed', completedAt }
              : turn,
          ),
        );
        updateSessionMessages(projectId, sessionId, (messages) =>
          messages.map((message) =>
            message.turnId === liveTurnId ? { ...message, turnId: event.turnId } : message,
          ),
        );
        break;
      }
    }
  }

  type ActiveSessionContext = {
    readonly projectId: string;
    readonly sessionId: string;
    readonly session: StudioSession;
    readonly migrationTicket?: DraftMigrationTicket | null;
  };

  function activateSession(projectId: string, session: StudioSession, expandProject = true): void {
    if (deletedSessionIds.current.has(session.id)) return;
    navigationTicket.current += 1;
    setTaskTranscriptTarget(undefined);
    setActiveProjectId(projectId);
    activeSessionIdRef.current = session.id;
    setActiveSessionId(session.id);
    setActiveView('studio');
    if (expandProject)
      setExpandedProjectIds((current) =>
        current.includes(projectId) ? current : [...current, projectId],
      );
  }

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

  async function createSessionForProject(
    projectId: string,
    projectIfMissing?: StudioProject,
    submissionDraft?: DraftCapture,
  ): Promise<ActiveSessionContext | null> {
    try {
      const detail = await workspaceApi.createSession(projectId);
      appliedDurableSequences.current.set(detail.id, detail.lastSequence);
      const newSession = toStudioSession(detail);
      setProjects((current) => {
        const project = current.find((candidate) => candidate.id === projectId);
        if (project === undefined) {
          return projectIfMissing === undefined
            ? current
            : [...current, { ...projectIfMissing, sessions: [newSession] }];
        }

        return current.map((candidate) =>
          candidate.id === projectId
            ? { ...candidate, sessions: [newSession, ...candidate.sessions] }
            : candidate,
        );
      });
      const migrationTicket =
        submissionDraft === undefined
          ? null
          : composerDraft.migrateProvisional(
              submissionDraft,
              newSession.id,
              projectId,
              projectIfMissing?.folderPath ??
                projects.find((p) => p.id === projectId)?.folderPath ??
                '',
            );
      if (submissionDraft === undefined || migrationTicket !== null) {
        activateSession(projectId, newSession);
        resetTransientState();
      }
      return { projectId, sessionId: newSession.id, session: newSession, migrationTicket };
    } catch (error: unknown) {
      setNotice(workspaceErrorMessage(error));
      return null;
    }
  }

  function getActiveSessionContext(): ActiveSessionContext | null {
    const project = projects.find((candidate) => candidate.id === activeProjectId);
    const session = project?.sessions.find(
      (candidate) => candidate.id === activeSessionIdRef.current && candidate.archivedAt === null,
    );
    return project === undefined || session === undefined
      ? null
      : { projectId: project.id, sessionId: session.id, session };
  }

  /**
   * Returns the active session, creating the initial local project/session when needed.
   * The returned IDs are used immediately so a first message does not depend on React state timing.
   */
  async function ensureSessionForMessage(
    submissionDraft: DraftCapture,
  ): Promise<ActiveSessionContext | null> {
    const activeContext = getActiveSessionContext();
    if (activeContext !== null) {
      return activeContext;
    }

    const project = projects.find((candidate) => candidate.id === activeProjectId);
    if (project !== undefined) {
      return createSessionForProject(project.id, undefined, submissionDraft);
    }

    try {
      const createdProject = await workspaceApi.createProject({
        name: 'Weave',
        folderName: 'weave',
      });
      const project: StudioProject = {
        ...toStudioProject({ ...createdProject, sessions: [] }),
        sessions: [],
      };
      return createSessionForProject(project.id, project, submissionDraft);
    } catch (error: unknown) {
      setNotice(workspaceErrorMessage(error));
      return null;
    }
  }

  /**
   * Sends a message. A retry snapshot creates a new Turn
   * (the previous Turn stays in history) without touching the draft input.
   */
  async function submitMessage(retry?: AgentSubmissionSnapshot): Promise<void> {
    if (!canCompose) return;
    const submittedDraft = composerDraft.capture();
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
    const selectedRevision = sessionSkills.draft.revision;
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
      requestId: crypto.randomUUID(),
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
      if (retry === undefined) {
        sessionSkills.clearSent(sessionId, selectedRevision, submission.skills);
        composerDraft.clearSubmittedDraftIfCurrent(
          submittedDraft,
          'migrationTicket' in sessionContext ? (sessionContext.migrationTicket ?? null) : null,
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
          requestId: runHandles.current.get(sessionId)?.requestId,
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
            ? '待执行队列已满，请稍后再试。草稿已保留。'
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

  /** Selects a session from any project and keeps the project/session context aligned. */
  function selectProjectSession(projectId: string, sessionId: string): void {
    if (projectId === activeProjectId && sessionId === activeSessionId) {
      return;
    }

    const session = projects
      .find((project) => project.id === projectId)
      ?.sessions.find((entry) => entry.id === sessionId);
    if (session === undefined) return;
    activateSession(projectId, session);
    resetTransientState();
    void loadSessionDetail(projectId, sessionId);
  }

  /** Expands or collapses one project node without changing the active project. */
  function toggleProjectExpanded(projectId: string): void {
    setExpandedProjectIds((current) =>
      current.includes(projectId)
        ? current.filter((id) => id !== projectId)
        : [...current, projectId],
    );
  }

  function openSessionEditor(projectId: string, sessionId: string): void {
    if (sessionRunStatus(sessionId) === 'streaming') {
      return;
    }

    const session = projects
      .find((project) => project.id === projectId)
      ?.sessions.find((candidate) => candidate.id === sessionId);
    if (session === undefined || session.archivedAt !== null) {
      return;
    }

    setEditingSession({ projectId, sessionId });
    setSessionTitleInput(session.title);
  }

  async function saveSessionTitle(): Promise<void> {
    const editing = editingSession;
    const title = sessionTitleInput.trim();
    if (editing === null || title === '' || sessionRunStatus(editing.sessionId) === 'streaming') {
      return;
    }

    try {
      const detail = await workspaceApi.renameSession(editing.sessionId, title);
      applySessionDetail(editing.projectId, detail);
      setEditingSession(null);
    } catch (error: unknown) {
      setNotice(workspaceErrorMessage(error));
    }
  }

  async function archiveSession(projectId: string, sessionId: string): Promise<void> {
    if (sessionRunStatus(sessionId) === 'streaming') {
      return;
    }

    try {
      const detail = await workspaceApi.archiveSession(sessionId);
      sessionSkills.forget(sessionId);
      applySessionDetail(projectId, detail);

      if (projectId === activeProjectId && sessionId === activeSessionId) {
        const nextSession = findNextRunnableSession(projectId, sessionId);
        if (nextSession !== undefined) {
          activeSessionIdRef.current = nextSession.id;
          setActiveSessionId(nextSession.id);
        } else {
          activeSessionIdRef.current = '';
          setActiveSessionId('');
        }
        resetTransientState();
      }
    } catch (error: unknown) {
      setNotice(workspaceErrorMessage(error));
    }
  }

  async function restoreSession(projectId: string, sessionId: string): Promise<void> {
    try {
      const detail = await workspaceApi.restoreSession(sessionId);
      if (!applySessionDetail(projectId, detail)) return;
      activeSessionIdRef.current = sessionId;
      setActiveProjectId(projectId);
      setActiveSessionId(sessionId);
      setActiveView('studio');
      setExpandedProjectIds((current) =>
        current.includes(projectId) ? current : [...current, projectId],
      );
    } catch (error: unknown) {
      setNotice(workspaceErrorMessage(error));
    }
  }

  async function permanentlyDeleteSession(): Promise<void> {
    const session = sessionToDelete;
    if (session === null || sessionRunStatus(session.sessionId) === 'streaming') {
      return;
    }

    const storedSession = projects
      .find((project) => project.id === session.projectId)
      ?.sessions.find((candidate) => candidate.id === session.sessionId);
    if (storedSession?.archivedAt === null || storedSession === undefined) {
      return;
    }

    try {
      await workspaceApi.deleteSession(session.sessionId);
      deletedSessionIds.current.add(session.sessionId);
      sessionActivityVersions.current.set(
        session.sessionId,
        (sessionActivityVersions.current.get(session.sessionId) ?? 0) + 1,
      );
      for (const [key, handle] of runHandles.current) {
        if (
          handle.sessionId !== session.sessionId &&
          handle.execution?.sessionId !== session.sessionId
        )
          continue;
        runHandles.current.delete(key);
        handle.controller.abort();
      }
      setTaskTranscriptTarget((target) =>
        target?.sessionId === session.sessionId ? undefined : target,
      );
      setRunStateBySession((current) =>
        Object.fromEntries(Object.entries(current).filter(([id]) => id !== session.sessionId)),
      );
      conversationStore.removeSession(session.sessionId);
      fileReviewStore.removeSession(session.projectId, session.sessionId);
      appliedDurableSequences.current.delete(session.sessionId);
      settledExecutionSequences.current.delete(session.sessionId);
      sessionSkills.forget(session.sessionId);
      setProjects((current) =>
        current.map((project) =>
          project.id !== session.projectId
            ? project
            : {
                ...project,
                sessions: project.sessions.filter(
                  (candidate) => candidate.id !== session.sessionId,
                ),
              },
        ),
      );
      if (session.projectId === activeProjectId && session.sessionId === activeSessionId) {
        const nextSession = findNextRunnableSession(session.projectId, session.sessionId);
        if (nextSession !== undefined) {
          activeSessionIdRef.current = nextSession.id;
          setActiveSessionId(nextSession.id);
        } else {
          activeSessionIdRef.current = '';
          setActiveSessionId('');
        }
        resetTransientState();
      }
      setSessionToDelete(null);
    } catch (error: unknown) {
      setNotice(workspaceErrorMessage(error));
    }
  }

  /** Creates an empty local session and focuses it in the session rail. */
  async function createSession(): Promise<void> {
    try {
      let project = projects.find((candidate) => candidate.id === activeProjectId);
      if (project === undefined) {
        const createdProject = await workspaceApi.createProject({
          name: 'Weave',
          folderName: 'weave',
        });
        project = {
          ...toStudioProject({ ...createdProject, sessions: [] }),
          sessions: [],
        };
      }
      await createSessionForProject(project.id, project);
    } catch (error: unknown) {
      setNotice(workspaceErrorMessage(error));
    }
  }

  /** Switches the Studio to another local project and its most recent session. */
  function selectProject(projectId: string): void {
    if (projectId === activeProjectId) {
      setOpenMenu(null);
      return;
    }

    const project = projects.find((candidate) => candidate.id === projectId);
    const session = project?.sessions.find((candidate) => candidate.archivedAt === null);
    if (project === undefined || session === undefined) {
      return;
    }

    activateSession(project.id, session, false);
    setOpenMenu(null);
    setSearchQuery('');
    resetTransientState();
    void loadSessionDetail(project.id, session.id);
  }

  /**
   * Opens a project from the projects page. A project without sessions gets a
   * blank workbench; the first message there creates its session.
   */
  function openProject(projectId: string): void {
    const project = projects.find((candidate) => candidate.id === projectId);
    if (project === undefined) {
      return;
    }
    if (projectId === activeProjectId) {
      setActiveView('studio');
      return;
    }
    if (project.sessions.some((candidate) => candidate.archivedAt === null)) {
      selectProject(projectId);
      return;
    }

    activeSessionIdRef.current = '';
    setActiveProjectId(projectId);
    setActiveSessionId('');
    setActiveView('studio');
    setExpandedProjectIds((current) =>
      current.includes(projectId) ? current : [...current, projectId],
    );
    resetTransientState();
  }

  function openProjectRename(project: StudioProject): void {
    setOpenMenu(null);
    setRenamingProjectId(project.id);
    setProjectRenameInput(project.name);
  }

  async function saveProjectName(): Promise<void> {
    const projectId = renamingProjectId;
    const name = projectRenameInput.trim();
    if (projectId === null || name === '') {
      return;
    }
    try {
      const updated = await workspaceApi.renameProject(projectId, name);
      setProjects((current) =>
        current.map((project) =>
          project.id === projectId ? { ...project, name: updated.name } : project,
        ),
      );
      setRenamingProjectId(null);
    } catch (error: unknown) {
      setNotice(workspaceErrorMessage(error));
    }
  }

  function openProjectDialog(): void {
    setOpenMenu(null);
    setProjectName('');
    setSelectedFolderName('');
    setSelectedFolderPath('');
    setIsProjectDialogOpen(true);
  }

  function applySelectedFolder(folderName: string): void {
    const normalized = folderName.trim();
    if (normalized === '') {
      return;
    }

    setSelectedFolderName(normalized);
    setProjectName(normalized);
  }

  /**
   * Desktop uses the system dialog and receives an absolute path. The browser
   * picker only exposes a folder name, so the path must be typed separately.
   */
  async function chooseProjectFolder(): Promise<void> {
    const desktopPicker = window.weaveDesktop?.pickDirectory;
    if (desktopPicker !== undefined) {
      try {
        const picked = await desktopPicker();
        if (picked !== null) {
          applySelectedFolder(picked.name);
          setSelectedFolderPath(picked.path);
        }
      } catch {
        setNotice('无法打开文件夹选择框，请重试');
      }
      return;
    }

    const picker = (window as DirectoryPickerWindow).showDirectoryPicker;
    if (picker === undefined) {
      directoryInputRef.current?.click();
      return;
    }

    try {
      const directory = await picker();
      applySelectedFolder(directory.name);
    } catch (error: unknown) {
      if (!(error instanceof DOMException && error.name === 'AbortError')) {
        setNotice('无法读取所选文件夹，请重试');
      }
    }
  }

  function chooseFallbackFolder(event: ChangeEvent<HTMLInputElement>): void {
    const firstFile = event.target.files?.[0];
    if (firstFile === undefined) {
      return;
    }

    const relativePath = firstFile.webkitRelativePath;
    applySelectedFolder(relativePath.split('/')[0] || firstFile.name);
    event.target.value = '';
  }

  async function createProject(): Promise<void> {
    const name = projectName.trim();
    const folderName = selectedFolderName.trim();
    if (name === '' || folderName === '') {
      return;
    }

    try {
      const folderPath = selectedFolderPath.trim();
      const project = await workspaceApi.createProject({
        name,
        folderName,
        ...(folderPath === '' ? {} : { folderPath }),
      });
      const session = await workspaceApi.createSession(project.id);
      const nextProject: StudioProject = {
        ...toStudioProject({ ...project, sessions: [] }),
        sessions: [toStudioSession(session)],
      };
      setProjects((current) => [...current, nextProject]);
      setExpandedProjectIds((current) => [...current, project.id]);
      setActiveProjectId(project.id);
      activeSessionIdRef.current = session.id;
      setActiveSessionId(session.id);
      setActiveView('studio');
      setIsProjectDialogOpen(false);
      setSearchQuery('');
      resetTransientState();
    } catch (error: unknown) {
      setNotice(workspaceErrorMessage(error));
    }
  }

  function openFolderDialog(project: StudioProject): void {
    setOpenMenu(null);
    setFolderDialogProjectId(project.id);
    setFolderDialogPath(project.folderPath ?? '');
    setFolderDialogError(null);
  }

  async function pickFolderForDialog(): Promise<void> {
    const desktopPicker = window.weaveDesktop?.pickDirectory;
    if (desktopPicker === undefined) {
      return;
    }
    try {
      const picked = await desktopPicker();
      if (picked !== null) {
        setFolderDialogPath(picked.path);
        setFolderDialogError(null);
      }
    } catch {
      setFolderDialogError('无法打开文件夹选择框，请重试');
    }
  }

  /** Saves or clears the folder of an existing Project; the Server validates the path. */
  async function saveProjectFolder(folderPath: string | null): Promise<void> {
    const projectId = folderDialogProjectId;
    if (projectId === null) {
      return;
    }
    try {
      const updated = await workspaceApi.updateProjectFolder(projectId, folderPath);
      setProjects((current) =>
        current.map((project) =>
          project.id === projectId ? { ...project, folderPath: updated.folderPath } : project,
        ),
      );
      setFolderDialogProjectId(null);
      setNotice(folderPath === null ? '已清除项目文件夹' : '项目文件夹已更新');
    } catch (error: unknown) {
      setFolderDialogError(workspaceErrorMessage(error));
    }
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

  useEffect(() => {
    if (openMenu !== 'context' || activeProjectId === '') return undefined;
    const controller = new AbortController();
    void fetchContextAvailability(activeProjectId, { signal: controller.signal })
      .then((availability) =>
        setGitChangesAvailability({
          projectId: activeProjectId,
          state: availability.gitChanges.available ? 'available' : 'unavailable',
        }),
      )
      .catch(() => {
        if (!controller.signal.aborted)
          setGitChangesAvailability({ projectId: activeProjectId, state: 'unknown' });
      });
    return () => controller.abort();
  }, [openMenu, activeProjectId]);

  function addComposerContext(kind: ExecutionContextKind): void {
    composerDraft.addContext(composerDraft.owner, kind);
    setOpenMenu(null);
  }

  function addViewerFileContext(): void {
    if (viewerFilePath !== null) {
      const result = composerDraft.addFile(composerDraft.owner, viewerFilePath);
      if (result === 'full') setNotice('最多添加 8 个文件，请先移除文件。');
    }
    setOpenMenu(null);
  }

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
    setReasoningEffort(snapshot.input.reasoningEffort ?? 'medium');
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

  /** Reads image files from an attach picker or paste into the staged list. */
  async function addImageFiles(files: FileList | null): Promise<void> {
    if (files === null || files.length === 0) {
      return;
    }
    const imageFiles = Array.from(files).filter((file) => file.type.startsWith('image/'));
    if (imageFiles.length === 0) {
      return;
    }
    const imageOwner = composerDraft.owner;
    const read = await Promise.all(
      imageFiles.map(async (file) => {
        const { mediaType, data } = await readImageFile(file);
        return { id: createId('img'), name: file.name, mediaType, data };
      }),
    );
    if (!composerDraft.isOwnerCurrent(imageOwner)) return;
    const added = read.filter((image) => image.data !== '');
    if (added.length === 0) {
      return;
    }
    setPendingImages((current) => [...current, ...added]);
  }

  function removePendingImage(id: string): void {
    setPendingImages((current) => current.filter((image) => image.id !== id));
  }

  function handleComposerPaste(event: ReactClipboardEvent<HTMLTextAreaElement>): void {
    const files = event.clipboardData.files;
    if (files.length === 0 || !Array.from(files).some((file) => file.type.startsWith('image/'))) {
      return;
    }
    event.preventDefault();
    void addImageFiles(files);
  }

  function cancelRun(): void {
    const sessionId = activeSessionId;
    const activeId = queueController.getState(sessionId)?.active?.executionId;
    if (activeId !== undefined && !runHandles.current.has(activeId))
      void attachExecution(activeProjectId, sessionId, activeId);
    const handle =
      activeId !== undefined
        ? runHandles.current.get(activeId)
        : ([...runHandles.current.values()].find(
            (candidate) =>
              candidate.execution?.sessionId === sessionId &&
              !isTerminalExecution(candidate.execution.status) &&
              candidate.execution.status !== 'queued',
          ) ?? runHandles.current.get(sessionId));
    if (handle === undefined) return;
    handle.pendingCancel = true;
    setSessionRunState(sessionId, { status: 'streaming', stopping: true, errorMessage: null });
    if (handle.execution !== undefined)
      void requestExecutionCancel(activeProjectId, sessionId, handle.runId);
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
      <aside className="workspace-nav" aria-label="工作区导航">
        <span className="brand-mark" aria-hidden="true">
          W
        </span>
        <nav className="workspace-nav-list" aria-label="主导航">
          <button
            className={`workspace-nav-button${activeView === 'studio' ? ' workspace-nav-button-active' : ''}`}
            type="button"
            aria-current={activeView === 'studio' ? 'page' : undefined}
            onClick={() => selectProductView('studio')}
          >
            <Sparkles aria-hidden="true" />
            <small>工作台</small>
          </button>
          <button
            className={`workspace-nav-button${activeView === 'projects' ? ' workspace-nav-button-active' : ''}`}
            type="button"
            aria-current={activeView === 'projects' ? 'page' : undefined}
            onClick={() => selectProductView('projects')}
          >
            <FolderKanban aria-hidden="true" />
            <small>项目</small>
          </button>
          <button
            className={`workspace-nav-button${activeView === 'retrieval' ? ' workspace-nav-button-active' : ''}`}
            type="button"
            aria-current={activeView === 'retrieval' ? 'page' : undefined}
            onClick={() => selectProductView('retrieval')}
          >
            <Search aria-hidden="true" />
            <small>搜索</small>
          </button>
          <button
            className={`workspace-nav-button workspace-nav-marketplace${activeView === 'marketplace' ? ' workspace-nav-button-active' : ''}`}
            type="button"
            aria-label="插件市场"
            aria-current={activeView === 'marketplace' ? 'page' : undefined}
            data-plugin-navigation=""
            onClick={() => selectProductView('marketplace')}
          >
            <Puzzle aria-hidden="true" />
            <small>插件市场</small>
            <PluginPendingBadge />
          </button>
          <button
            className={`workspace-nav-button${activeView === 'memory' ? ' workspace-nav-button-active' : ''}`}
            type="button"
            aria-current={activeView === 'memory' ? 'page' : undefined}
            onClick={() => selectProductView('memory')}
          >
            <BookOpen aria-hidden="true" />
            <small>记忆</small>
          </button>
          <button
            className={`workspace-nav-button${activeView === 'history' ? ' workspace-nav-button-active' : ''}`}
            type="button"
            aria-current={activeView === 'history' ? 'page' : undefined}
            onClick={() => selectProductView('history')}
          >
            <History aria-hidden="true" />
            <small>历史</small>
          </button>
          <button
            className={`workspace-nav-button${activeView === 'archived' ? ' workspace-nav-button-active' : ''}`}
            type="button"
            aria-current={activeView === 'archived' ? 'page' : undefined}
            onClick={() => selectProductView('archived')}
          >
            <Archive aria-hidden="true" />
            <small>归档</small>
          </button>
        </nav>
        <button
          className={`workspace-nav-button workspace-nav-settings${activeView === 'settings' ? ' workspace-nav-button-active' : ''}`}
          type="button"
          aria-current={activeView === 'settings' ? 'page' : undefined}
          onClick={() => selectProductView('settings')}
        >
          <Settings aria-hidden="true" />
          <small>设置</small>
        </button>
      </aside>

      {activeView === 'settings' ? (
        <aside className="settings-sidebar" aria-label="设置分类">
          <header className="settings-sidebar-header">
            <Settings aria-hidden="true" />
            <h2>设置</h2>
          </header>
          <div className="settings-sidebar-search">
            <Search aria-hidden="true" />
            <span>搜索设置</span>
          </div>
          <nav className="settings-sidebar-nav" aria-label="设置分类导航">
            <p className="settings-sidebar-label">配置</p>
            <button className="settings-sidebar-item settings-sidebar-item-active" type="button">
              <Bot aria-hidden="true" />
              <span>模型服务</span>
            </button>
            <button className="settings-sidebar-item" type="button" disabled>
              <ShieldCheck aria-hidden="true" />
              <span>运行权限</span>
              <small>即将推出</small>
            </button>
            <p className="settings-sidebar-label">系统</p>
            <button className="settings-sidebar-item" type="button" disabled>
              <FolderOpen aria-hidden="true" />
              <span>数据存储</span>
              <small>即将推出</small>
            </button>
            <button className="settings-sidebar-item" type="button" disabled>
              <Settings aria-hidden="true" />
              <span>界面外观</span>
              <small>即将推出</small>
            </button>
          </nav>
          <div className="settings-sidebar-footer">
            <span className="connection-dot" aria-hidden="true" />
            <span>本地运行时</span>
            <small>已连接</small>
          </div>
        </aside>
      ) : (
        <aside
          className="session-rail"
          aria-label="会话列表"
          hidden={
            activeView === 'marketplace' || activeView === 'memory' || activeView === 'retrieval'
          }
          inert={
            activeView === 'marketplace' || activeView === 'memory' || activeView === 'retrieval'
          }
        >
          <div className={`menu-anchor${openMenu === 'project' ? ' menu-anchor-open' : ''}`}>
            <button
              className="project-switcher"
              type="button"
              aria-label={`${activeProject?.name ?? '当前'} 项目`}
              aria-expanded={openMenu === 'project'}
              onClick={() => toggleMenu('project')}
            >
              <span className="project-avatar" aria-hidden="true">
                {(activeProject?.name ?? 'W').slice(0, 1).toLocaleUpperCase()}
              </span>
              <span className="project-switcher-copy">
                <small>当前项目</small>
                <strong>{activeProject?.name ?? 'Weave'}</strong>
                <span className="project-folder-name">{activeProject?.folderName ?? 'weave'}</span>
              </span>
              <span className="project-chevron" aria-hidden="true">
                <ChevronDown aria-hidden="true" />
              </span>
            </button>
            {openMenu === 'project' ? (
              <div
                className="popup-menu popup-menu-rail project-menu"
                role="menu"
                aria-label="切换项目"
              >
                <p className="menu-section-label">项目</p>
                {projects.map((project) => (
                  <button
                    type="button"
                    role="menuitem"
                    key={project.id}
                    onClick={() => selectProject(project.id)}
                  >
                    <span className="menu-icon">
                      <FolderOpen aria-hidden="true" />
                    </span>
                    <span>
                      <strong>{project.name}</strong>
                      <small>{project.folderName}</small>
                    </span>
                  </button>
                ))}
                <div className="menu-divider" />
                {activeProject === undefined ? null : (
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => openFolderDialog(activeProject)}
                  >
                    <span className="menu-icon">
                      <FolderOpen aria-hidden="true" />
                    </span>
                    <span>
                      <strong>设置文件夹</strong>
                      <small>{activeProject.folderPath ?? '未设置，Agent 不能读写文件'}</small>
                    </span>
                  </button>
                )}
                <button type="button" role="menuitem" onClick={openProjectDialog}>
                  <span className="menu-icon menu-icon-accent">
                    <Plus aria-hidden="true" />
                  </span>
                  创建项目
                </button>
              </div>
            ) : null}
          </div>
          <button className="new-session-button" type="button" onClick={() => void createSession()}>
            <Plus aria-hidden="true" />
            新建会话
          </button>
          {isSearchOpen ? (
            <div className="session-search">
              <Search aria-hidden="true" />
              <input
                type="search"
                aria-label="搜索会话"
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.target.value)}
                autoFocus
              />
              <button
                type="button"
                aria-label="关闭搜索"
                onClick={() => {
                  setIsSearchOpen(false);
                  setSearchQuery('');
                }}
              >
                <X aria-hidden="true" />
              </button>
            </div>
          ) : (
            <button className="search-sessions" type="button" onClick={() => setIsSearchOpen(true)}>
              <Search aria-hidden="true" />
              搜索会话
              <kbd>⌘ K</kbd>
            </button>
          )}
          <nav className="project-tree" aria-label="项目树" role="tree">
            <p className="section-label">项目</p>
            {visibleProjects.map((project) => {
              const isExpanded =
                normalizedSearchQuery !== '' || expandedProjectIds.includes(project.id);

              return (
                <div className="project-tree-node" role="treeitem" key={project.id}>
                  <div className="project-tree-row">
                    <button
                      className="project-tree-toggle"
                      type="button"
                      aria-label={`${isExpanded ? '收起' : '展开'}项目 ${project.name}`}
                      aria-expanded={isExpanded}
                      onClick={() => toggleProjectExpanded(project.id)}
                    >
                      {isExpanded ? (
                        <ChevronDown aria-hidden="true" />
                      ) : (
                        <ChevronRight aria-hidden="true" />
                      )}
                    </button>
                    <button
                      className="project-tree-project"
                      type="button"
                      aria-label={`项目：${project.name}`}
                      onClick={() => selectProject(project.id)}
                    >
                      <FolderOpen aria-hidden="true" />
                      <span>
                        <strong>{project.name}</strong>
                        <small>{project.folderName}</small>
                      </span>
                      <small className="project-session-count">
                        {project.sessions.length} 个会话
                      </small>
                    </button>
                  </div>
                  {isExpanded ? (
                    <div className="project-tree-sessions" role="group">
                      {project.sessions.length > 0 ? (
                        project.sessions.map((session) => (
                          <div
                            className={`session-tree-item${session.id === activeSessionId && project.id === activeProjectId ? ' session-tree-item-active' : ''}`}
                            key={session.id}
                          >
                            <button
                              className="session-item"
                              type="button"
                              aria-label={`会话：${session.title}`}
                              onClick={() => selectProjectSession(project.id, session.id)}
                            >
                              <span>
                                <strong>{session.title}</strong>
                                <small>{session.lastUsedLabel}</small>
                              </span>
                            </button>
                            {isSessionStreaming(session.id) ? (
                              <span
                                className="session-running-dot"
                                aria-label="运行中"
                                title="运行中"
                              />
                            ) : session.id === activeSessionId && project.id === activeProjectId ? (
                              <span className="session-dot" aria-hidden="true" />
                            ) : null}
                            <div className="session-actions" role="group" aria-label="会话操作">
                              <button
                                className="session-action-button"
                                type="button"
                                aria-label="编辑会话"
                                title="编辑会话标题"
                                onClick={() => openSessionEditor(project.id, session.id)}
                                disabled={isSessionStreaming(session.id)}
                              >
                                <Pencil aria-hidden="true" />
                              </button>
                              <button
                                className="session-action-button session-action-button-danger"
                                type="button"
                                aria-label="归档会话"
                                title="归档会话"
                                onClick={() => void archiveSession(project.id, session.id)}
                                disabled={isSessionStreaming(session.id)}
                              >
                                <Archive aria-hidden="true" />
                              </button>
                            </div>
                          </div>
                        ))
                      ) : (
                        <p className="session-empty">暂无聊天</p>
                      )}
                    </div>
                  ) : null}
                </div>
              );
            })}
            {visibleProjects.length === 0 ? <p className="session-empty">没有匹配的会话</p> : null}
          </nav>
          <div className="rail-footer">
            <span className="connection-dot" aria-hidden="true" />
            <span>本地运行时</span>
            <small>已连接</small>
          </div>
        </aside>
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
              <>
                <header className="page-header">
                  <div className="page-header-copy">
                    <h2>项目</h2>
                    <p>每个项目对应一个本地文件夹，Agent 只在该文件夹内读写文件。</p>
                  </div>
                  <div className="page-header-actions">
                    <button className="primary-button" type="button" onClick={openProjectDialog}>
                      <Plus aria-hidden="true" />
                      创建项目
                    </button>
                  </div>
                </header>
                <div className="page-section-heading">
                  <span>全部项目</span>
                  <small>{projects.length} 个</small>
                </div>
                <div className="project-overview-list" aria-label="项目列表">
                  {projects.map((project) => {
                    const isActive = project.id === activeProjectId;
                    const sessionCount = project.sessions.filter(
                      (session) => session.archivedAt === null,
                    ).length;
                    return (
                      <article
                        className={`project-overview-item${isActive ? ' project-overview-item-active' : ''}`}
                        key={project.id}
                      >
                        <button
                          className="project-overview-main"
                          type="button"
                          aria-label={`打开项目 ${project.name}`}
                          onClick={() => openProject(project.id)}
                          disabled={sessionHasWork}
                        >
                          <span className="project-overview-avatar" aria-hidden="true">
                            {project.name.slice(0, 1).toLocaleUpperCase()}
                          </span>
                          <span className="project-overview-copy">
                            <span className="project-overview-title">
                              <strong>{project.name}</strong>
                              {isActive ? (
                                <span className="project-current-badge">当前</span>
                              ) : null}
                            </span>
                            <span className="project-overview-path">
                              <small className="project-folder-name">
                                {project.folderPath ?? project.folderName}
                              </small>
                              {project.folderPath === undefined ? (
                                <small className="project-folder-missing">未设置文件夹路径</small>
                              ) : null}
                            </span>
                          </span>
                          <span className="project-overview-meta">{sessionCount} 个会话</span>
                        </button>
                        <div
                          className="project-overview-actions"
                          role="group"
                          aria-label={`管理项目 ${project.name}`}
                        >
                          <button
                            className="project-action-button"
                            type="button"
                            aria-label={`在 ${project.name} 中新建会话`}
                            title="新建会话"
                            onClick={() => void createSessionForProject(project.id)}
                            disabled={sessionHasWork}
                          >
                            <MessageSquarePlus aria-hidden="true" />
                          </button>
                          <button
                            className="project-action-button"
                            type="button"
                            aria-label={`重命名项目 ${project.name}`}
                            title="重命名"
                            onClick={() => openProjectRename(project)}
                            disabled={sessionHasWork}
                          >
                            <Pencil aria-hidden="true" />
                          </button>
                          <button
                            className="project-action-button"
                            type="button"
                            aria-label={`设置项目 ${project.name} 的文件夹`}
                            title="设置文件夹"
                            onClick={() => openFolderDialog(project)}
                            disabled={sessionHasWork}
                          >
                            <FolderCog aria-hidden="true" />
                          </button>
                        </div>
                      </article>
                    );
                  })}
                </div>
              </>
            ) : activeView === 'archived' ? (
              <>
                <header className="page-header">
                  <div className="page-header-copy">
                    <h2>归档</h2>
                    <p>归档会话不会出现在项目树中，可以恢复或删除。</p>
                  </div>
                </header>
                <div className="archive-overview-list" aria-label="归档会话列表">
                  {archivedProjects.length > 0 ? (
                    archivedProjects.map((project) => (
                      <section className="archive-project-section" key={project.id}>
                        <div className="archive-project-heading">
                          <FolderOpen aria-hidden="true" />
                          <strong>{project.name}</strong>
                          <small>{project.sessions.length} 个归档会话</small>
                        </div>
                        <div className="archive-session-list">
                          {project.sessions.map((session) => (
                            <article className="archive-session-item" key={session.id}>
                              <div>
                                <strong>{session.title}</strong>
                                <small>
                                  {session.archivedAt === null
                                    ? '已归档'
                                    : `归档于 ${formatMessageTime(session.archivedAt)}`}
                                </small>
                              </div>
                              <div className="archive-session-actions">
                                <button
                                  className="secondary-button"
                                  type="button"
                                  aria-label={`恢复会话 ${session.title}`}
                                  onClick={() => void restoreSession(project.id, session.id)}
                                  disabled={sessionHasWork}
                                >
                                  <RotateCcw aria-hidden="true" />
                                  恢复
                                </button>
                                <button
                                  className="danger-button"
                                  type="button"
                                  aria-label={`删除会话 ${session.title}`}
                                  onClick={() =>
                                    setSessionToDelete({
                                      projectId: project.id,
                                      sessionId: session.id,
                                      title: session.title,
                                    })
                                  }
                                  disabled={sessionHasWork}
                                >
                                  <Trash2 aria-hidden="true" />
                                  删除
                                </button>
                              </div>
                            </article>
                          ))}
                        </div>
                      </section>
                    ))
                  ) : (
                    <div className="page-empty">
                      <span className="page-empty-icon" aria-hidden="true">
                        <Archive />
                      </span>
                      <strong>暂无归档会话</strong>
                      <p>在左侧会话列表中归档的会话会显示在这里。</p>
                    </div>
                  )}
                </div>
              </>
            ) : activeView === 'settings' ? (
              <div className="provider-settings-view">
                <div className="product-view-heading provider-settings-heading">
                  <div>
                    <p>配置</p>
                    <h2>模型服务</h2>
                    <span>管理 Weave 使用的 AI 服务和默认模型。</span>
                  </div>
                  {providerSettings.canManage ? (
                    <button
                      className="primary-button"
                      type="button"
                      onClick={() => openProviderForm()}
                      disabled={providerMutation !== 'idle'}
                    >
                      <Plus aria-hidden="true" />
                      添加 AI 服务
                    </button>
                  ) : null}
                </div>
                <div className="provider-settings-section-heading">
                  <div>
                    <h3>已配置的服务</h3>
                    <span>{providerSettings.providers.length} 个服务</span>
                  </div>
                  <span className="provider-settings-section-status">
                    <span className="connection-dot" aria-hidden="true" />
                    本地配置
                  </span>
                </div>
                <div className="provider-settings-list" aria-label="Provider 列表">
                  {providerSettings.providers.map((provider) => (
                    <article
                      className={`provider-settings-item${provider.id === providerSettings.defaultProvider ? ' provider-settings-item-default' : ''}`}
                      key={provider.id}
                    >
                      <div className="provider-settings-main">
                        <div className="provider-settings-icon" aria-hidden="true">
                          <Bot />
                        </div>
                        <div className="provider-settings-copy">
                          <strong>{provider.label}</strong>
                          <span>{provider.id}</span>
                        </div>
                      </div>
                      <div className="provider-settings-details">
                        <div className="provider-detail-row">
                          <span>模型</span>
                          <strong>{provider.defaultModel ?? '未设置默认模型'}</strong>
                        </div>
                        <div className="provider-detail-row">
                          <span>接口</span>
                          <strong>{provider.baseUrl ?? '本地运行时'}</strong>
                        </div>
                      </div>
                      <div className="provider-settings-side">
                        <div className="provider-settings-status">
                          <span
                            className={
                              provider.hasApiKey
                                ? 'provider-status-ready'
                                : 'provider-status-warning'
                            }
                          >
                            <span className="provider-status-dot" aria-hidden="true" />
                            {provider.hasApiKey ? '可用' : '需要配置 API Key'}
                          </span>
                          {provider.id === providerSettings.defaultProvider ? (
                            <span className="provider-default-mark">
                              <Check aria-hidden="true" />
                              默认
                            </span>
                          ) : null}
                        </div>
                        {providerSettings.canManage && provider.editable ? (
                          <div className="provider-settings-actions">
                            {provider.id !== providerSettings.defaultProvider ? (
                              <button
                                className="provider-action-button"
                                type="button"
                                onClick={() => void setDefaultProvider(provider.id)}
                                disabled={providerMutation !== 'idle' || !provider.hasApiKey}
                              >
                                设为默认
                              </button>
                            ) : null}
                            <button
                              className="provider-action-button"
                              type="button"
                              aria-label={`编辑 Provider ${provider.label}`}
                              onClick={() => openProviderForm(provider)}
                              disabled={providerMutation !== 'idle'}
                            >
                              <Pencil aria-hidden="true" />
                              编辑
                            </button>
                            <button
                              className="provider-action-button provider-action-button-danger"
                              type="button"
                              aria-label={`删除 Provider ${provider.label}`}
                              onClick={() => setProviderToDelete(provider)}
                              disabled={providerMutation !== 'idle'}
                            >
                              <Trash2 aria-hidden="true" />
                              删除
                            </button>
                          </div>
                        ) : null}
                      </div>
                    </article>
                  ))}
                </div>
                <p className="provider-settings-note">
                  {providerSettings.canManage
                    ? 'API Key 只保存在本机的系统密钥存储中，页面不会回显已保存的密钥。'
                    : '浏览器开发模式下，Provider 通过 .env 只读配置；需要管理 API Key 时请使用 Desktop。'}
                </p>
              </div>
            ) : (
              <>
                <header className="page-header">
                  <div className="page-header-copy">
                    <h2>{viewLabels[activeView].title}</h2>
                    <p>{viewLabels[activeView].description}。</p>
                  </div>
                </header>
                <div className="page-empty">
                  <span className="page-empty-icon" aria-hidden="true">
                    <History />
                  </span>
                  <strong>暂无历史记录</strong>
                  <p>跨项目的运行记录与会话时间线还在开发中。</p>
                </div>
              </>
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
          <button type="button" aria-label="关闭提示" onClick={() => setNotice(null)}>
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
