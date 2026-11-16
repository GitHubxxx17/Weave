import { ChangeEvent, FormEvent, useEffect, useRef, useState } from 'react';
import {
  Archive,
  Bot,
  Check,
  ChevronDown,
  ChevronRight,
  Circle,
  Copy,
  Eye,
  Files,
  FolderOpen,
  FolderKanban,
  GitBranch,
  History,
  MoreHorizontal,
  PanelRight,
  PanelRightOpen,
  Pencil,
  Plus,
  Search,
  SendHorizontal,
  Settings,
  ShieldCheck,
  Square,
  Sparkles,
  TerminalSquare,
  Trash2,
  RotateCcw,
  Wrench,
  X,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

import { AgentStreamError, streamAgentRun } from '../features/agent/agent-stream.js';
import type { AgentRuntimeEvent } from '../features/agent/agent-types.js';
import { createWorkspaceApi, WorkspaceApiError } from '../features/workspace/workspace-api.js';
import type {
  ProjectWithSessions,
  SessionDetail,
  SessionSummary,
  WorkspaceMessage,
} from '../features/workspace/workspace-types.js';

type RunStatus = 'idle' | 'streaming' | 'completed' | 'error' | 'cancelled';
type ProductView = 'studio' | 'projects' | 'history' | 'archived' | 'settings';
type OpenMenu = 'project' | 'more' | 'context' | 'permission' | 'model' | null;

type ChatMessage = {
  readonly id: string;
  readonly role: 'user' | 'assistant';
  readonly text: string;
};

type StudioSession = {
  readonly id: string;
  readonly title: string;
  readonly lastUsedLabel: string;
  readonly archivedAt: string | null;
  readonly messages: readonly ChatMessage[];
};

type StudioProject = {
  readonly id: string;
  readonly name: string;
  readonly folderName: string;
  readonly sessions: readonly StudioSession[];
};

type ProjectDirectory = {
  readonly name: string;
};

type DirectoryPickerWindow = Window &
  typeof globalThis & {
    readonly showDirectoryPicker?: () => Promise<ProjectDirectory>;
  };

type ToolActivity = {
  readonly toolCallId: string;
  readonly name: string;
  readonly arguments: string;
  readonly status: 'called' | 'executing' | 'completed' | 'failed';
  readonly result?: string;
};

const statusLabels: Record<RunStatus, string> = {
  idle: '就绪',
  streaming: '运行中',
  completed: '已完成',
  error: '出错',
  cancelled: '已取消',
};

const viewLabels: Record<Exclude<ProductView, 'studio'>, { title: string; description: string }> = {
  projects: {
    title: '项目',
    description: '每个项目对应一个本地文件夹，并包含多个 Agent 会话',
  },
  history: {
    title: '历史',
    description: '运行记录和会话时间线将在这里统一展示',
  },
  archived: {
    title: '归档',
    description: '已归档的会话可以恢复，也可以在这里永久删除',
  },
  settings: {
    title: '设置',
    description: '模型、权限和插件配置将在这里集中管理',
  },
};

const contextOptions = [
  ['当前文件', Files],
  ['Git 变更', GitBranch],
  ['项目目录', FolderOpen],
] as const satisfies readonly (readonly [string, LucideIcon])[];

const permissionOptions = [
  ['工作区访问', ShieldCheck],
  ['仅查看', Eye],
] as const satisfies readonly (readonly [string, LucideIcon])[];

let nextId = 0;

const workspaceApi = createWorkspaceApi();

function createId(prefix: string): string {
  nextId += 1;
  return `${prefix}-${nextId}`;
}

function getSessionLabel(sessionId: string): string {
  return sessionId.startsWith('session-') ? sessionId.slice('session-'.length) : sessionId;
}

function createSessionTitle(text: string): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  return normalized.length > 24 ? `${normalized.slice(0, 24)}…` : normalized;
}

function safeErrorMessage(error: unknown): string {
  if (error instanceof AgentStreamError) {
    const separator = error.message.indexOf(': ');
    return separator === -1 ? error.message : error.message.slice(separator + 2);
  }

  return 'Agent run failed';
}

function updateToolActivity(
  activities: readonly ToolActivity[],
  toolCallId: string,
  update: (activity: ToolActivity | undefined) => ToolActivity,
): ToolActivity[] {
  const existing = activities.find((activity) => activity.toolCallId === toolCallId);
  const updated = update(existing);

  if (existing === undefined) {
    return [...activities, updated];
  }

  return activities.map((activity) => (activity.toolCallId === toolCallId ? updated : activity));
}

function getAssistantPlaceholder(status: RunStatus, isLatest: boolean): string {
  if (!isLatest) {
    return '暂无回复';
  }

  switch (status) {
    case 'streaming':
      return '正在思考…';
    case 'cancelled':
      return '本次运行已取消';
    case 'error':
      return '暂无回复';
    case 'completed':
      return 'Agent 没有返回文本';
    case 'idle':
      return '暂无回复';
  }
}

function messageText(message: WorkspaceMessage): string {
  return message.content
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('');
}

function toChatMessages(sessionId: string, messages: readonly WorkspaceMessage[]): ChatMessage[] {
  return messages.flatMap((message, index) => {
    if (message.role !== 'user' && message.role !== 'assistant') {
      return [];
    }
    return [
      {
        id: `${sessionId}-message-${index + 1}`,
        role: message.role,
        text: messageText(message),
      },
    ];
  });
}

function toStudioSession(session: SessionSummary | SessionDetail): StudioSession {
  return {
    id: session.id,
    title: session.title,
    lastUsedLabel: '最近使用',
    archivedAt: session.archivedAt ?? null,
    messages: 'messages' in session ? toChatMessages(session.id, session.messages) : [],
  };
}

function toStudioProject(project: ProjectWithSessions): StudioProject {
  return {
    id: project.id,
    name: project.name,
    folderName: project.folderName,
    sessions: project.sessions.map(toStudioSession),
  };
}

function workspaceErrorMessage(error: unknown): string {
  if (!(error instanceof WorkspaceApiError)) {
    return '工作区服务暂时不可用，请稍后重试';
  }

  switch (error.code) {
    case 'workspace-project-not-found':
      return '项目不存在，请重新加载工作区';
    case 'session-not-found':
      return '会话不存在，请重新加载工作区';
    case 'session-deleted':
      return '会话已经删除';
    case 'session-archived':
      return '归档会话不能执行当前操作';
    case 'workspace-api-network':
      return '无法连接到本地服务，请确认后端已经启动';
    default:
      return error.message;
  }
}

/** Studio's first local Agent workspace, combining chat state and stream events. */
export function App() {
  const [messageInput, setMessageInput] = useState('');
  const [projects, setProjects] = useState<readonly StudioProject[]>([]);
  const [activeProjectId, setActiveProjectId] = useState('');
  const [expandedProjectIds, setExpandedProjectIds] = useState<readonly string[]>([]);
  const [activeSessionId, setActiveSessionId] = useState('');
  const [isLoadingWorkspace, setIsLoadingWorkspace] = useState(true);
  const [workspaceError, setWorkspaceError] = useState<string | null>(null);
  const [workspaceLoadKey, setWorkspaceLoadKey] = useState(0);
  const [activeView, setActiveView] = useState<ProductView>('studio');
  const [openMenu, setOpenMenu] = useState<OpenMenu>(null);
  const [isProjectDialogOpen, setIsProjectDialogOpen] = useState(false);
  const [projectName, setProjectName] = useState('');
  const [selectedFolderName, setSelectedFolderName] = useState('');
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [isActivityPanelOpen, setIsActivityPanelOpen] = useState(true);
  const [permissionMode, setPermissionMode] = useState('工作区访问');
  const [selectedModel, setSelectedModel] = useState('本地模型');
  const [selectedContexts, setSelectedContexts] = useState<readonly string[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [editingSession, setEditingSession] = useState<{
    readonly projectId: string;
    readonly sessionId: string;
  } | null>(null);
  const [sessionTitleInput, setSessionTitleInput] = useState('');
  const [sessionToDelete, setSessionToDelete] = useState<{
    readonly projectId: string;
    readonly sessionId: string;
    readonly title: string;
  } | null>(null);
  const [tools, setTools] = useState<readonly ToolActivity[]>([]);
  const [reasoning, setReasoning] = useState('');
  const [status, setStatus] = useState<RunStatus>('idle');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const latestAssistantMessageId = useRef<string | null>(null);
  const controller = useRef<AbortController | null>(null);
  const activeRunId = useRef<string | null>(null);
  const activeSessionIdRef = useRef('');
  const messageInputRef = useRef<HTMLTextAreaElement | null>(null);
  const directoryInputRef = useRef<HTMLInputElement | null>(null);
  const activeProject = projects.find((project) => project.id === activeProjectId);
  const sessions = activeProject?.sessions ?? [];
  const activeSession = sessions.find((session) => session.id === activeSessionId);
  const messages = activeSession?.messages ?? [];
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

        const loadedProjects = response.projects.map(toStudioProject);
        setProjects(loadedProjects);
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
        setProjects((current) =>
          current.map((project) =>
            project.id === firstProject.id
              ? {
                  ...project,
                  sessions: project.sessions.map((session) =>
                    session.id === firstSession.id ? toStudioSession(detail) : session,
                  ),
                }
              : project,
          ),
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
    sessionId: string,
    update: (messages: readonly ChatMessage[]) => readonly ChatMessage[],
  ): void {
    setProjects((current) =>
      current.map((project) =>
        project.id === activeProjectId
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

  /** Clears run-scoped state when the active session changes. */
  function resetTransientState(): void {
    latestAssistantMessageId.current = null;
    setTools([]);
    setReasoning('');
    setErrorMessage(null);
    setStatus('idle');
  }

  function applySessionDetail(projectId: string, detail: SessionDetail): void {
    setProjects((current) =>
      current.map((project) =>
        project.id !== projectId
          ? project
          : {
              ...project,
              sessions: project.sessions.map((session) =>
                session.id === detail.id ? toStudioSession(detail) : session,
              ),
            },
      ),
    );
  }

  async function loadSessionDetail(projectId: string, sessionId: string): Promise<void> {
    try {
      const detail = await workspaceApi.getSession(sessionId);
      applySessionDetail(projectId, detail);
    } catch (error: unknown) {
      if (activeSessionIdRef.current === sessionId) {
        setNotice(workspaceErrorMessage(error));
      }
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
    sessionId: string,
  ): void {
    if (activeRunId.current !== runId) {
      return;
    }

    switch (event.type) {
      case 'text-delta':
        updateSessionMessages(sessionId, (current) =>
          current.map((message) =>
            message.id === assistantId ? { ...message, text: message.text + event.text } : message,
          ),
        );
        break;
      case 'reasoning-delta':
        setReasoning((current) => current + event.text);
        break;
      case 'tool-call':
        setTools((current) =>
          updateToolActivity(current, event.toolCall.id, () => ({
            toolCallId: event.toolCall.id,
            name: event.toolCall.name,
            arguments: event.toolCall.arguments,
            status: 'called',
          })),
        );
        break;
      case 'tool-executing':
        setTools((current) =>
          updateToolActivity(current, event.toolCall.id, (existing) => {
            const updated: ToolActivity = {
              toolCallId: event.toolCall.id,
              name: event.toolCall.name,
              arguments: event.toolCall.arguments,
              status: 'executing',
            };
            return existing?.result === undefined
              ? updated
              : { ...updated, result: existing.result };
          }),
        );
        break;
      case 'tool-result':
        setTools((current) =>
          updateToolActivity(current, event.result.toolCallId, (existing) => ({
            toolCallId: event.result.toolCallId,
            name: event.result.name,
            arguments: existing?.arguments ?? '',
            status: 'completed',
            result: event.result.content,
          })),
        );
        break;
      case 'completed':
        setStatus('completed');
        break;
    }
  }

  async function submitMessage(): Promise<void> {
    const text = messageInput.trim();
    if (text === '' || status === 'streaming') {
      return;
    }

    const sessionId = activeSessionIdRef.current;
    const session = activeProject?.sessions.find((candidate) => candidate.id === sessionId);
    if (session === undefined) {
      return;
    }

    const userMessageId = createId('user');
    const assistantId = createId('assistant');
    const runId = createId('run');
    const requestController = new AbortController();

    latestAssistantMessageId.current = assistantId;
    activeRunId.current = runId;
    controller.current = requestController;
    updateSessionMessages(sessionId, (current) => [
      ...current,
      { id: userMessageId, role: 'user', text },
      { id: assistantId, role: 'assistant', text: '' },
    ]);
    setProjects((current) =>
      current.map((project) =>
        project.id === activeProjectId
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
    setMessageInput('');
    setReasoning('');
    setTools([]);
    setErrorMessage(null);
    setStatus('streaming');

    try {
      await streamAgentRun(
        {
          sessionId,
          userMessage: {
            role: 'user',
            content: [{ type: 'text', text }],
          },
          provider: 'mock',
          model: 'weave-local-demo',
        },
        { onEvent: (event) => handleEvent(event, runId, assistantId, sessionId) },
        { signal: requestController.signal },
      );
    } catch (error: unknown) {
      if (activeRunId.current !== runId) {
        return;
      }

      if (error instanceof DOMException && error.name === 'AbortError') {
        setStatus('cancelled');
      } else {
        setErrorMessage(safeErrorMessage(error));
        setStatus('error');
      }
    } finally {
      if (activeRunId.current === runId) {
        activeRunId.current = null;
        controller.current = null;
      }
    }
  }

  /** Selects a session from any project and keeps the project/session context aligned. */
  function selectProjectSession(projectId: string, sessionId: string): void {
    if (
      status === 'streaming' ||
      (projectId === activeProjectId && sessionId === activeSessionId)
    ) {
      return;
    }

    const project = projects.find((candidate) => candidate.id === projectId);
    if (project === undefined || !project.sessions.some((session) => session.id === sessionId)) {
      return;
    }

    setExpandedProjectIds((current) =>
      current.includes(projectId) ? current : [...current, projectId],
    );
    setActiveProjectId(projectId);
    activeSessionIdRef.current = sessionId;
    setActiveSessionId(sessionId);
    setActiveView('studio');
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
    if (status === 'streaming') {
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
    if (editing === null || title === '' || status === 'streaming') {
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
    if (status === 'streaming') {
      return;
    }

    try {
      const detail = await workspaceApi.archiveSession(sessionId);
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
      applySessionDetail(projectId, detail);
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
    if (session === null || status === 'streaming') {
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
    if (status === 'streaming') {
      return;
    }

    if (activeProjectId === '') {
      return;
    }

    try {
      const detail = await workspaceApi.createSession(activeProjectId);
      const newSession = toStudioSession(detail);
      setProjects((current) =>
        current.map((project) =>
          project.id === activeProjectId
            ? { ...project, sessions: [newSession, ...project.sessions] }
            : project,
        ),
      );
      activeSessionIdRef.current = newSession.id;
      setActiveSessionId(newSession.id);
      setActiveView('studio');
      resetTransientState();
    } catch (error: unknown) {
      setNotice(workspaceErrorMessage(error));
    }
  }

  /** Switches the Studio to another local project and its most recent session. */
  function selectProject(projectId: string): void {
    if (status === 'streaming' || projectId === activeProjectId) {
      setOpenMenu(null);
      return;
    }

    const project = projects.find((candidate) => candidate.id === projectId);
    const session = project?.sessions.find((candidate) => candidate.archivedAt === null);
    if (project === undefined || session === undefined) {
      return;
    }

    activeSessionIdRef.current = session.id;
    setActiveProjectId(project.id);
    setActiveSessionId(session.id);
    setActiveView('studio');
    setOpenMenu(null);
    setSearchQuery('');
    resetTransientState();
    void loadSessionDetail(project.id, session.id);
  }

  function openProjectDialog(): void {
    if (status === 'streaming') {
      return;
    }

    setOpenMenu(null);
    setProjectName('');
    setSelectedFolderName('');
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

  /** Opens the browser directory picker without claiming durable filesystem access. */
  async function chooseProjectFolder(): Promise<void> {
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
    if (name === '' || folderName === '' || status === 'streaming') {
      return;
    }

    try {
      const project = await workspaceApi.createProject({ name, folderName });
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

  /** Switches the visible Studio product area without changing session state. */
  function selectProductView(view: ProductView): void {
    setActiveView(view);
    setOpenMenu(null);
    setNotice(null);
  }

  function toggleMenu(menu: Exclude<OpenMenu, null>): void {
    setOpenMenu((current) => (current === menu ? null : menu));
    setNotice(null);
  }

  function chooseContext(context: string): void {
    setSelectedContexts((current) => (current.includes(context) ? current : [...current, context]));
    setOpenMenu(null);
  }

  function fillSuggestion(text: string): void {
    setMessageInput(text);
    requestAnimationFrame(() => messageInputRef.current?.focus());
  }

  function showNotice(message: string): void {
    setNotice(message);
    setOpenMenu(null);
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    void submitMessage();
  }

  function cancelRun(): void {
    const requestController = controller.current;
    if (requestController === null) {
      return;
    }

    activeRunId.current = null;
    controller.current = null;
    requestController.abort();
    setStatus('cancelled');
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
      className={`studio-shell${!isActivityPanelOpen || activeView !== 'studio' ? ' studio-shell-context-collapsed' : ''}`}
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

      <aside className="session-rail" aria-label="会话列表">
        <div className={`menu-anchor${openMenu === 'project' ? ' menu-anchor-open' : ''}`}>
          <button
            className="project-switcher"
            type="button"
            aria-label={`${activeProject?.name ?? '当前'} 项目`}
            aria-expanded={openMenu === 'project'}
            disabled={status === 'streaming'}
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
              <button type="button" role="menuitem" onClick={openProjectDialog}>
                <span className="menu-icon menu-icon-accent">
                  <Plus aria-hidden="true" />
                </span>
                创建项目
              </button>
            </div>
          ) : null}
        </div>
        <button
          className="new-session-button"
          type="button"
          onClick={() => void createSession()}
          disabled={status === 'streaming'}
        >
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
                    disabled={status === 'streaming'}
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
                    disabled={status === 'streaming'}
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
                            disabled={status === 'streaming'}
                          >
                            <span>
                              <strong>{session.title}</strong>
                              <small>{session.lastUsedLabel}</small>
                            </span>
                          </button>
                          {session.id === activeSessionId && project.id === activeProjectId ? (
                            <span className="session-dot" aria-hidden="true" />
                          ) : null}
                          <div className="session-actions" role="group" aria-label="会话操作">
                            <button
                              className="session-action-button"
                              type="button"
                              aria-label="编辑会话"
                              title="编辑会话标题"
                              onClick={() => openSessionEditor(project.id, session.id)}
                              disabled={status === 'streaming'}
                            >
                              <Pencil aria-hidden="true" />
                            </button>
                            <button
                              className="session-action-button session-action-button-danger"
                              type="button"
                              aria-label="归档会话"
                              title="归档会话"
                              onClick={() => void archiveSession(project.id, session.id)}
                              disabled={status === 'streaming'}
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

      {activeView === 'studio' ? (
        <section className="chat-column" aria-label="智能对话">
          <header className="chat-header">
            <div className="chat-header-title">
              <div className="breadcrumb">
                <span>{activeProject?.folderName ?? 'weave'}</span>
                <span className="breadcrumb-divider" aria-hidden="true">
                  /
                </span>
                <strong>{activeSession?.title ?? '未命名会话'}</strong>
              </div>
              <div className="chat-title-row">
                <h2>Agent 工作台</h2>
                <span className="runtime-chip">
                  <Circle aria-hidden="true" />
                  本地运行时
                </span>
              </div>
            </div>
            <div className="header-actions">
              <span className="branch-chip">
                <GitBranch aria-hidden="true" />
                feat/studio-ui-polish
              </span>
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
                        resetTransientState();
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

          <div className="message-list" aria-label="Agent 工作流" aria-live="polite">
            {messages.length === 0 ? (
              <div className="empty-chat">
                <div className="empty-orbit" aria-hidden="true">
                  <Sparkles aria-hidden="true" />
                </div>
                <p className="empty-kicker">WEAVE</p>
                <h3>今天想完成什么？</h3>
                <p>当前项目 {activeProject?.name ?? 'Weave'} · 本地运行时已连接</p>
                <div className="suggestion-list" aria-label="对话示例">
                  <button type="button" onClick={() => fillSuggestion('介绍一下 Weave 的架构')}>
                    <Sparkles aria-hidden="true" />
                    介绍一下 Weave 的架构
                  </button>
                  <button type="button" onClick={() => fillSuggestion('帮我梳理当前项目状态')}>
                    <TerminalSquare aria-hidden="true" />
                    梳理当前项目状态
                  </button>
                </div>
              </div>
            ) : (
              messages.map((message) => (
                <article className={`timeline-item timeline-item-${message.role}`} key={message.id}>
                  <div className="timeline-content">
                    <div className="message-meta">
                      {message.role === 'assistant' ? (
                        <span className="message-avatar" aria-hidden="true">
                          <Sparkles />
                        </span>
                      ) : null}
                      {message.role === 'user' ? '你' : 'Weave Agent'}
                      <time>刚刚</time>
                    </div>
                    <div className="message">
                      <p>
                        {message.text ||
                          getAssistantPlaceholder(
                            status,
                            message.id === latestAssistantMessageId.current,
                          )}
                      </p>
                    </div>
                  </div>
                </article>
              ))
            )}
          </div>

          <form className="composer" onSubmit={handleSubmit}>
            <div className="composer-box">
              <label className="sr-only" htmlFor="message-input">
                发送消息
              </label>
              <textarea
                id="message-input"
                name="message"
                rows={2}
                ref={messageInputRef}
                value={messageInput}
                onChange={(event) => setMessageInput(event.target.value)}
                placeholder="给 Agent 分配一个任务…"
              />
              <div className="composer-toolbar">
                <div className="composer-tools">
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
                        {contextOptions.map(([label, Icon]) => (
                          <button
                            type="button"
                            role="menuitem"
                            key={label}
                            onClick={() => chooseContext(label)}
                          >
                            <span className="menu-icon">
                              <Icon aria-hidden="true" />
                            </span>
                            {label}
                            {selectedContexts.includes(label) ? (
                              <Check className="menu-check" aria-hidden="true" />
                            ) : null}
                          </button>
                        ))}
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
                      {permissionMode}
                      <ChevronDown aria-hidden="true" />
                    </button>
                    {openMenu === 'permission' ? (
                      <div
                        className="popup-menu popup-menu-composer"
                        role="menu"
                        aria-label="权限模式"
                      >
                        {permissionOptions.map(([label, Icon]) => (
                          <button
                            type="button"
                            role="menuitem"
                            key={label}
                            onClick={() => {
                              setPermissionMode(label);
                              setOpenMenu(null);
                            }}
                          >
                            <span className="menu-icon">
                              <Icon aria-hidden="true" />
                            </span>
                            {label}
                            {permissionMode === label ? (
                              <Check className="menu-check" aria-hidden="true" />
                            ) : null}
                          </button>
                        ))}
                      </div>
                    ) : null}
                  </div>
                  {selectedContexts.map((context) => (
                    <span className="context-chip" key={context}>
                      {context}
                      <button
                        type="button"
                        aria-label={`移除${context}`}
                        onClick={() =>
                          setSelectedContexts((current) =>
                            current.filter((item) => item !== context),
                          )
                        }
                      >
                        <X aria-hidden="true" />
                      </button>
                    </span>
                  ))}
                </div>
                <div className="composer-controls">
                  <div className={`menu-anchor${openMenu === 'model' ? ' menu-anchor-open' : ''}`}>
                    <button
                      className="model-button"
                      type="button"
                      aria-expanded={openMenu === 'model'}
                      onClick={() => toggleMenu('model')}
                    >
                      {selectedModel}
                      <ChevronDown aria-hidden="true" />
                    </button>
                    {openMenu === 'model' ? (
                      <div
                        className="popup-menu popup-menu-composer popup-menu-right"
                        role="menu"
                        aria-label="选择模型"
                      >
                        {['本地模型', 'DeepSeek', 'OpenAI'].map((model) => (
                          <button
                            type="button"
                            role="menuitem"
                            key={model}
                            onClick={() => {
                              setSelectedModel(model);
                              setOpenMenu(null);
                            }}
                          >
                            <span className="menu-icon">
                              <Bot aria-hidden="true" />
                            </span>
                            {model}
                            {selectedModel === model ? (
                              <Check className="menu-check" aria-hidden="true" />
                            ) : null}
                          </button>
                        ))}
                      </div>
                    ) : null}
                  </div>
                  {status === 'streaming' ? (
                    <button
                      className="send-button send-button-cancel"
                      type="button"
                      onClick={cancelRun}
                      aria-label="停止运行"
                    >
                      <Square aria-hidden="true" />
                    </button>
                  ) : (
                    <button
                      className="send-button"
                      type="submit"
                      disabled={messageInput.trim() === ''}
                      aria-label="发送"
                    >
                      <SendHorizontal aria-hidden="true" />
                    </button>
                  )}
                </div>
              </div>
            </div>
          </form>
        </section>
      ) : (
        <section className="product-view" aria-label={viewLabels[activeView].title}>
          <div className="product-view-content">
            {activeView === 'projects' ? (
              <>
                <div className="product-view-heading">
                  <div>
                    <p>WEAVE STUDIO</p>
                    <h2>项目</h2>
                    <span>每个项目对应一个本地文件夹，并包含多个 Agent 会话。</span>
                  </div>
                  <button className="primary-button" type="button" onClick={openProjectDialog}>
                    <Plus aria-hidden="true" />
                    创建项目
                  </button>
                </div>
                <div className="project-overview-list" aria-label="项目列表">
                  {projects.map((project) => (
                    <button
                      className="project-overview-item"
                      type="button"
                      key={project.id}
                      onClick={() => selectProject(project.id)}
                      disabled={status === 'streaming'}
                    >
                      <span className="project-overview-avatar" aria-hidden="true">
                        {project.name.slice(0, 1).toLocaleUpperCase()}
                      </span>
                      <span>
                        <strong>{project.name}</strong>
                        <small className="project-folder-name">{project.folderName}</small>
                      </span>
                      <span className="project-overview-meta">
                        <small>
                          {project.sessions.filter((session) => session.archivedAt === null).length}{' '}
                          个会话
                        </small>
                      </span>
                    </button>
                  ))}
                </div>
              </>
            ) : activeView === 'archived' ? (
              <>
                <div className="product-view-heading">
                  <div>
                    <p>WEAVE STUDIO</p>
                    <h2>归档</h2>
                    <span>归档会话不会出现在项目树中，可以恢复或永久删除。</span>
                  </div>
                </div>
                <div className="archive-overview-list" aria-label="归档会话列表">
                  {archivedProjects.length > 0 ? (
                    archivedProjects.map((project) => (
                      <section className="archive-project-section" key={project.id}>
                        <div className="archive-project-heading">
                          <FolderOpen aria-hidden="true" />
                          <strong>{project.name}</strong>
                          <small>{project.folderName}</small>
                        </div>
                        <div className="archive-session-list">
                          {project.sessions.map((session) => (
                            <article className="archive-session-item" key={session.id}>
                              <div>
                                <strong>{session.title}</strong>
                                <small>已归档</small>
                              </div>
                              <div className="archive-session-actions">
                                <button
                                  className="secondary-button"
                                  type="button"
                                  aria-label={`恢复会话 ${session.title}`}
                                  onClick={() => void restoreSession(project.id, session.id)}
                                  disabled={status === 'streaming'}
                                >
                                  <RotateCcw aria-hidden="true" />
                                  恢复
                                </button>
                                <button
                                  className="danger-button"
                                  type="button"
                                  aria-label={`永久删除会话 ${session.title}`}
                                  onClick={() =>
                                    setSessionToDelete({
                                      projectId: project.id,
                                      sessionId: session.id,
                                      title: session.title,
                                    })
                                  }
                                  disabled={status === 'streaming'}
                                >
                                  <Trash2 aria-hidden="true" />
                                  永久删除
                                </button>
                              </div>
                            </article>
                          ))}
                        </div>
                      </section>
                    ))
                  ) : (
                    <p className="archive-empty">暂无归档会话</p>
                  )}
                </div>
              </>
            ) : (
              <>
                <span className="product-view-icon" aria-hidden="true">
                  {activeView === 'history' ? <History /> : <Settings />}
                </span>
                <p>WEAVE STUDIO</p>
                <h2>{viewLabels[activeView].title}</h2>
                <span>{viewLabels[activeView].description}</span>
              </>
            )}
          </div>
        </section>
      )}

      {activeView === 'studio' && isActivityPanelOpen ? (
        <aside className="activity-panel" aria-label="运行活动">
          <header className="activity-header">
            <div>
              <h2>会话状态</h2>
            </div>
            <button
              className="icon-button"
              type="button"
              aria-label="收起上下文"
              title="收起上下文"
              onClick={() => setIsActivityPanelOpen(false)}
            >
              <PanelRight aria-hidden="true" />
            </button>
          </header>
          <div className="context-summary">
            <div className="context-status">
              <span className={`status-pulse status-pulse-${status}`} aria-hidden="true" />
              <div>
                <strong className={`run-status run-status-${status}`}>
                  {statusLabels[status]}
                </strong>
                <small aria-label={`会话 #${getSessionLabel(activeSessionId)}`}>
                  会话 #{getSessionLabel(activeSessionId)}
                </small>
              </div>
            </div>
            <div className="context-stat">
              <strong>{tools.length}</strong>
              <small>工具调用</small>
            </div>
          </div>

          {errorMessage !== null ? (
            <section className="activity-section error-section" aria-label="运行错误">
              <div className="activity-section-heading">
                <h3>运行错误</h3>
                <span className="status-badge status-failed">错误</span>
              </div>
              <p className="error-message">{errorMessage}</p>
            </section>
          ) : null}

          <section className="activity-section reasoning-section" aria-label="思考过程">
            <div className="activity-section-heading">
              <h3>思考过程</h3>
              <span className="activity-state">{reasoning === '' ? '等待中' : '实时'}</span>
            </div>
            <p className="reasoning-text">
              {reasoning || 'Agent 开始运行后，思考过程会显示在这里。'}
            </p>
          </section>

          <section className="activity-section" aria-label="工具调用">
            <div className="activity-section-heading">
              <h3>工具调用</h3>
              <span className="activity-state">{tools.length} 次</span>
            </div>
            {tools.length === 0 ? (
              <div className="activity-empty">
                <span className="activity-empty-icon" aria-hidden="true">
                  <Wrench aria-hidden="true" />
                </span>
                <p>当前还没有工具调用</p>
              </div>
            ) : (
              <div className="tool-list">
                {tools.map((tool) => (
                  <article className="tool-activity" key={tool.toolCallId}>
                    <div className="tool-heading">
                      <strong>{tool.name}</strong>
                      <span className={`status-badge status-${tool.status}`}>
                        {tool.status === 'called'
                          ? '已调用'
                          : tool.status === 'executing'
                            ? '执行中'
                            : tool.status === 'completed'
                              ? '已完成'
                              : '失败'}
                      </span>
                    </div>
                    <pre>{tool.arguments}</pre>
                    {tool.result !== undefined ? (
                      <p className="tool-result">{tool.result}</p>
                    ) : null}
                  </article>
                ))}
              </div>
            )}
          </section>
        </aside>
      ) : null}
      {notice !== null ? (
        <div className="studio-notice" role="status">
          {notice}
          <button type="button" aria-label="关闭提示" onClick={() => setNotice(null)}>
            <X aria-hidden="true" />
          </button>
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
                <h2 id="delete-session-dialog-title">永久删除会话</h2>
              </div>
              <button
                className="icon-button"
                type="button"
                aria-label="关闭永久删除确认"
                onClick={() => setSessionToDelete(null)}
              >
                <X aria-hidden="true" />
              </button>
            </header>
            <div className="project-dialog-form">
              <p className="delete-session-warning">
                确定要永久删除“{sessionToDelete.title}”吗？删除后无法恢复。
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
                  aria-label="确认永久删除"
                  onClick={() => void permanentlyDeleteSession()}
                >
                  <Trash2 aria-hidden="true" />
                  永久删除
                </button>
              </footer>
            </div>
          </section>
        </div>
      ) : null}
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
              <p className="project-dialog-note">
                当前版本只在 Studio 前端保存项目名称和目录显示信息，不会伪造持久化文件权限。
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
    </main>
  );
}
