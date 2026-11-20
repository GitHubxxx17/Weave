import {
  ChangeEvent,
  type ClipboardEvent as ReactClipboardEvent,
  type CSSProperties,
  FormEvent,
  KeyboardEvent as ReactKeyboardEvent,
  type ReactElement,
  useEffect,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import {
  Archive,
  ArrowDown,
  Bot,
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  Handshake,
  Files,
  FolderOpen,
  FolderCog,
  FolderKanban,
  GitBranch,
  History,
  ImagePlus,
  LoaderCircle,
  MessageSquarePlus,
  MoreHorizontal,
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
  X,
  Zap,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

import { AgentStreamError, streamAgentRun } from '../features/agent/agent-stream.js';
import type { AgentRuntimeEvent } from '../features/agent/agent-types.js';
import { useAutoScroll } from '../features/conversation/use-auto-scroll.js';
import { MarkdownMessage } from '../features/conversation/markdown-message.js';
import { ToolStep } from '../features/conversation/tool-step.js';
import { MessageFooter } from '../features/conversation/message-footer.js';
import { PanelContainer } from '../features/panel/panel-container.js';
import { useSidePanelWidth } from '../features/panel/panel-resizer.js';
import { contextWarnThreshold, latestContext } from '../features/panel/panel-data.js';
import { formatTokens, sumUsage } from '../features/conversation/turn-stats.js';
import { ApprovalPanel, useApprovals } from '../features/approvals/approval-panel.js';
import {
  CommandPickerList,
  commandOptionId,
  commandPickerListId,
} from '../features/commands/command-picker-list.js';
import { useCommandPicker } from '../features/commands/use-command-picker.js';
import { createProviderApi, ProviderApiError } from '../features/providers/provider-api.js';
import {
  customProviderPresetId,
  findModelPresetId,
  findProviderPreset,
  providerPresets,
} from '../features/providers/provider-presets.js';
import type { ProviderDescriptor, ProviderSettings } from '../features/providers/provider-types.js';
import { createWorkspaceApi, WorkspaceApiError } from '../features/workspace/workspace-api.js';
import type {
  ProjectWithSessions,
  SessionDetail,
  SessionSummary,
  TurnSummary,
  TurnUsage,
  WorkspaceMessage,
} from '../features/workspace/workspace-types.js';

type RunStatus = 'idle' | 'streaming' | 'completed' | 'error' | 'cancelled';

/** Reactive run state kept per session so switching sessions never disturbs a run. */
type SessionRunState = {
  readonly status: RunStatus;
  readonly errorMessage: string | null;
};

/** Non-reactive bookkeeping for the single in-flight run of one session. */
type SessionRunHandle = {
  runId: string;
  controller: AbortController;
  assistantId: string;
  tools: readonly ToolActivity[];
};

const idleRunState: SessionRunState = { status: 'idle', errorMessage: null };

type ProductView = 'studio' | 'projects' | 'history' | 'archived' | 'settings';
type OpenMenu = 'project' | 'more' | 'context' | 'permission' | 'model' | null;

type ChatMessage = {
  readonly id: string;
  readonly role: 'user' | 'assistant';
  readonly text: string;
  readonly reasoning: string;
  readonly tools: readonly ToolActivity[];
  readonly occurredAt: string;
  /** Images attached to a user message, base64-encoded. */
  readonly images?: readonly { readonly mediaType: string; readonly data: string }[] | undefined;
  /** Turn that produced an assistant reply; live runs use a temporary id. */
  readonly turnId?: string | undefined;
};

type StudioSession = {
  readonly id: string;
  readonly title: string;
  readonly lastUsedLabel: string;
  readonly archivedAt: string | null;
  readonly messages: readonly ChatMessage[];
  readonly turns: readonly TurnSummary[];
};

type StudioProject = {
  readonly id: string;
  readonly name: string;
  readonly folderName: string;
  readonly folderPath?: string | undefined;
  readonly sessions: readonly StudioSession[];
};

type ProjectDirectory = {
  readonly name: string;
};

/** An image staged in the composer before it is sent, base64-encoded. */
type PendingImage = {
  readonly id: string;
  readonly name: string;
  readonly mediaType: string;
  readonly data: string;
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

type ProviderFormState = {
  readonly mode: 'create' | 'edit';
  readonly editingId: string | null;
  readonly providerPresetId: string;
  readonly modelPresetId: string;
  readonly id: string;
  readonly label: string;
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly defaultModel: string;
  readonly makeDefault: boolean;
  readonly clearApiKey: boolean;
  readonly contextWindowTokens: string;
  readonly temperature: string;
  readonly maxTokens: string;
};

type FormSelectOption = {
  readonly value: string;
  readonly label: string;
};

type FormSelectProps = {
  readonly label: string;
  readonly value: string;
  readonly placeholder: string;
  readonly options: readonly FormSelectOption[];
  readonly onChange: (value: string) => void;
};

type FormSelectMenuPosition = {
  readonly top: number;
  readonly left: number;
  readonly width: number;
  readonly maxHeight: number;
};

/** Result of parsing one optional numeric Provider field from its input string. */
type ParsedNumberField =
  { readonly ok: true; readonly value: number | undefined } | { readonly ok: false };

/**
 * Parses an optional numeric Provider field: an empty string means "unset",
 * otherwise the value must be a finite number in range (temperature 0–2, or a
 * positive integer).
 */
function parseProviderNumberField(
  raw: string,
  kind: 'temperature' | 'positiveInt',
): ParsedNumberField {
  const trimmed = raw.trim();
  if (trimmed === '') {
    return { ok: true, value: undefined };
  }
  const value = Number(trimmed);
  if (!Number.isFinite(value)) {
    return { ok: false };
  }
  if (kind === 'temperature') {
    return value >= 0 && value <= 2 ? { ok: true, value } : { ok: false };
  }
  return Number.isInteger(value) && value > 0 ? { ok: true, value } : { ok: false };
}

/**
 * Renders a keyboard-friendly select menu that matches the Studio visual
 * language instead of relying on the operating system's native select popup.
 */
function FormSelect({
  label,
  value,
  placeholder,
  options,
  onChange,
}: FormSelectProps): ReactElement {
  const [isOpen, setIsOpen] = useState(false);
  const [menuPosition, setMenuPosition] = useState<FormSelectMenuPosition | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const selectedOption = options.find((option) => option.value === value);

  useEffect(() => {
    if (!isOpen) {
      setMenuPosition(null);
      return;
    }

    function updateMenuPosition(): void {
      const trigger = triggerRef.current;
      if (trigger === null) {
        return;
      }

      const triggerRect = trigger.getBoundingClientRect();
      const viewportPadding = 12;
      const optionHeight = 42;
      const desiredHeight = Math.min(240, options.length * optionHeight + 10);
      const spaceBelow = window.innerHeight - triggerRect.bottom - viewportPadding;
      const spaceAbove = triggerRect.top - viewportPadding;
      const shouldOpenAbove = spaceBelow < desiredHeight && spaceAbove > spaceBelow;
      const maxHeight = Math.max(
        120,
        Math.min(desiredHeight, shouldOpenAbove ? spaceAbove : spaceBelow),
      );
      const left = Math.min(
        triggerRect.left,
        Math.max(viewportPadding, window.innerWidth - triggerRect.width - viewportPadding),
      );

      setMenuPosition({
        top: shouldOpenAbove
          ? Math.max(viewportPadding, triggerRect.top - maxHeight - 6)
          : triggerRect.bottom + 6,
        left,
        width: triggerRect.width,
        maxHeight,
      });
    }

    function handlePointerDown(event: PointerEvent): void {
      const target = event.target as Node;
      if (
        containerRef.current?.contains(target) !== true &&
        menuRef.current?.contains(target) !== true
      ) {
        setIsOpen(false);
      }
    }

    function handleKeyDown(event: globalThis.KeyboardEvent): void {
      if (event.key === 'Escape') {
        setIsOpen(false);
      }
    }

    updateMenuPosition();
    window.addEventListener('resize', updateMenuPosition);
    window.addEventListener('scroll', updateMenuPosition, true);
    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('resize', updateMenuPosition);
      window.removeEventListener('scroll', updateMenuPosition, true);
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [isOpen, options.length]);

  function handleButtonKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>): void {
    if (event.key === 'ArrowDown' || event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      setIsOpen(true);
    }
  }

  return (
    <div className={`form-select${isOpen ? ' form-select-open' : ''}`} ref={containerRef}>
      <button
        className="form-select-trigger"
        type="button"
        ref={triggerRef}
        aria-label={label}
        aria-expanded={isOpen}
        aria-haspopup="menu"
        onClick={() => setIsOpen((current) => !current)}
        onKeyDown={handleButtonKeyDown}
      >
        <span className={selectedOption === undefined ? 'form-select-placeholder' : undefined}>
          {selectedOption?.label ?? placeholder}
        </span>
        <ChevronDown aria-hidden="true" />
      </button>
      {isOpen && menuPosition !== null
        ? createPortal(
            <div
              className="form-select-menu"
              ref={menuRef}
              role="menu"
              aria-label={label}
              onPointerDown={(event) => event.stopPropagation()}
              style={{
                top: menuPosition.top,
                left: menuPosition.left,
                width: menuPosition.width,
                maxHeight: menuPosition.maxHeight,
              }}
            >
              {options.map((option) => (
                <button
                  className={`form-select-option${option.value === value ? ' form-select-option-selected' : ''}`}
                  type="button"
                  role="menuitem"
                  key={option.value}
                  onClick={() => {
                    onChange(option.value);
                    setIsOpen(false);
                  }}
                >
                  <span>{option.label}</span>
                  {option.value === value ? <Check aria-hidden="true" /> : null}
                </button>
              ))}
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}

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

type PermissionOption = {
  readonly value: 'ask' | 'trust' | 'yolo';
  readonly label: string;
  readonly description: string;
  readonly icon: LucideIcon;
  readonly danger?: boolean;
};

const permissionOptions: readonly PermissionOption[] = [
  {
    value: 'ask',
    label: '常规',
    description: '每次写文件或运行命令都要你确认',
    icon: ShieldCheck,
  },
  {
    value: 'trust',
    label: '信任',
    description: '本会话自动执行，仅高风险操作才确认',
    icon: Handshake,
  },
  {
    value: 'yolo',
    label: '完全访问',
    description: '全程不确认、直接执行，请谨慎',
    icon: Zap,
    danger: true,
  },
];

/** Model reasoning-effort options; the empty value sends no hint (provider default). */
const reasoningEffortOptions = [
  { value: 'low', label: '低' },
  { value: 'medium', label: '中' },
  { value: 'high', label: '高' },
] as const;

const fallbackProviderSettings: ProviderSettings = {
  providers: [
    {
      id: 'mock',
      label: '本地模型',
      type: 'mock',
      defaultModel: 'weave-local-demo',
      hasApiKey: false,
      editable: false,
    },
  ],
  defaultProvider: 'mock',
  canManage: false,
};

let nextId = 0;

const providerApi = createProviderApi();
const workspaceApi = createWorkspaceApi();

function createId(prefix: string): string {
  nextId += 1;
  return `${prefix}-${nextId}`;
}

function getSessionLabel(sessionId: string): string {
  return sessionId.startsWith('session-') ? sessionId.slice('session-'.length) : sessionId;
}

/** "DeepSeek · deepseek-chat", or only the model when the Provider is named after it. */
function formatModelLabel(providerLabel: string, model: string): string {
  return providerLabel.trim().toLowerCase() === model.trim().toLowerCase()
    ? model
    : `${providerLabel} · ${model}`;
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

const emptyTurns: readonly TurnSummary[] = [];

/** Temporary Turn id used while a run streams, replaced by the durable id on completion. */
function liveTurnIdFor(assistantMessageId: string): string {
  return `live-${assistantMessageId}`;
}

/** Shown when a provider put the whole answer into its reasoning stream. */
const reasoningOnlyPlaceholder =
  '模型没有单独输出正文，回答写在了上方的「思考过程」里，展开即可查看。';

function getAssistantPlaceholder(
  status: RunStatus,
  isLatest: boolean,
  hasReasoning = false,
): string {
  if (hasReasoning && !(isLatest && status === 'streaming')) {
    return reasoningOnlyPlaceholder;
  }
  if (!isLatest) {
    return '暂无回复';
  }

  switch (status) {
    case 'streaming':
      return '正在思考…';
    case 'cancelled':
      return '本次运行已取消';
    case 'error':
      return '本次运行失败，请查看运行错误';
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

function messageReasoning(message: WorkspaceMessage): string {
  return message.content
    .filter((part) => part.type === 'reasoning')
    .map((part) => part.text)
    .join('');
}

function messageImages(
  message: WorkspaceMessage,
): { readonly mediaType: string; readonly data: string }[] {
  return message.content
    .filter((part) => part.type === 'image')
    .map((part) => ({ mediaType: part.mediaType, data: part.data }));
}

/** Reads an image File as base64 (without the `data:` prefix). */
function readImageFile(file: File): Promise<{ mediaType: string; data: string }> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error('image read failed'));
    reader.onload = () => {
      const result = typeof reader.result === 'string' ? reader.result : '';
      const comma = result.indexOf(',');
      resolve({
        mediaType: file.type !== '' ? file.type : 'image/png',
        data: comma === -1 ? '' : result.slice(comma + 1),
      });
    };
    reader.readAsDataURL(file);
  });
}

function messageToolResult(
  messages: readonly WorkspaceMessage[],
  toolCallId: string,
): string | undefined {
  const toolMessage = messages.find(
    (message) => message.role === 'tool' && message.toolCallId === toolCallId,
  );
  return toolMessage === undefined ? undefined : messageText(toolMessage);
}

function toToolActivities(
  message: Extract<WorkspaceMessage, { role: 'assistant' }>,
  messages: readonly WorkspaceMessage[],
  statusByToolCallId: ReadonlyMap<string, 'completed' | 'failed'>,
): ToolActivity[] {
  return (message.toolCalls ?? []).map((toolCall) => {
    const result = messageToolResult(messages, toolCall.id);
    return {
      toolCallId: toolCall.id,
      name: toolCall.name,
      arguments: toolCall.arguments,
      status: statusByToolCallId.get(toolCall.id) ?? 'completed',
      ...(result === undefined ? {} : { result }),
    };
  });
}

/**
 * Builds the conversation view from durable messages.
 *
 * A Turn can span several model steps, each stored as its own assistant
 * message. They are merged into one card per Turn so a refreshed conversation
 * matches what the live run showed: reasoning and tool calls from every step
 * together, with the final step's text as the answer.
 */
function toChatMessages(
  sessionId: string,
  messages: readonly WorkspaceMessage[],
  statusByToolCallId: ReadonlyMap<string, 'completed' | 'failed'>,
): ChatMessage[] {
  const result: ChatMessage[] = [];
  const turnCard = new Map<string, ChatMessage>();

  messages.forEach((message, index) => {
    if (message.role === 'user') {
      result.push({
        id: message.messageId ?? `${sessionId}-message-${index + 1}`,
        role: 'user',
        text: messageText(message),
        reasoning: '',
        tools: [],
        occurredAt: message.occurredAt ?? '',
        images: messageImages(message),
      });
      return;
    }
    if (message.role !== 'assistant') {
      return;
    }

    const text = messageText(message);
    const reasoning = messageReasoning(message);
    const tools = toToolActivities(message, messages, statusByToolCallId);
    const existing = message.turnId === undefined ? undefined : turnCard.get(message.turnId);

    if (existing !== undefined) {
      // Append this step onto the Turn's single card.
      const merged: ChatMessage = {
        ...existing,
        text: existing.text + text,
        reasoning: existing.reasoning + reasoning,
        tools: [...existing.tools, ...tools],
      };
      turnCard.set(existing.turnId as string, merged);
      result.splice(result.indexOf(existing), 1, merged);
      return;
    }

    const card: ChatMessage = {
      id: message.turnId ?? message.messageId ?? `${sessionId}-message-${index + 1}`,
      role: 'assistant',
      text,
      reasoning,
      tools,
      occurredAt: message.occurredAt ?? '',
      ...(message.turnId === undefined ? {} : { turnId: message.turnId }),
    };
    result.push(card);
    if (message.turnId !== undefined) {
      turnCard.set(message.turnId, card);
    }
  });

  return result;
}

function formatMessageTime(occurredAt: string): string {
  const date = new Date(occurredAt);
  if (Number.isNaN(date.getTime())) {
    return '时间未知';
  }

  const now = new Date();
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();
  const time = new Intl.DateTimeFormat('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date);

  return sameDay ? time : `${date.getMonth() + 1}月${date.getDate()}日 ${time}`;
}

function toStudioSession(session: SessionSummary | SessionDetail): StudioSession {
  const turns = 'turns' in session ? session.turns : [];
  const statusByToolCallId = new Map<string, 'completed' | 'failed'>();
  for (const turn of turns) {
    for (const result of turn.toolResults) {
      statusByToolCallId.set(result.toolCallId, result.status);
    }
  }
  return {
    id: session.id,
    title: session.title,
    lastUsedLabel: '最近使用',
    archivedAt: session.archivedAt ?? null,
    messages:
      'messages' in session ? toChatMessages(session.id, session.messages, statusByToolCallId) : [],
    turns,
  };
}

function toStudioProject(project: ProjectWithSessions): StudioProject {
  return {
    id: project.id,
    name: project.name,
    folderName: project.folderName,
    folderPath: project.folderPath,
    // The server returns sessions in creation order; show newest first.
    sessions: [...project.sessions].reverse().map(toStudioSession),
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
    case 'project-folder-invalid':
      return '文件夹路径无效，请填写本机已存在的文件夹绝对路径';
    default:
      return error.message;
  }
}

/** Studio's first local Agent workspace, combining chat state and stream events. */
export function App() {
  const [messageInput, setMessageInput] = useState('');
  const [pendingImages, setPendingImages] = useState<readonly PendingImage[]>([]);
  const [previewImage, setPreviewImage] = useState<{
    readonly mediaType: string;
    readonly data: string;
  } | null>(null);
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
  const [reasoningEffort, setReasoningEffort] = useState('medium');
  const [providerSettings, setProviderSettings] =
    useState<ProviderSettings>(fallbackProviderSettings);
  const [selectedProviderId, setSelectedProviderId] = useState(
    fallbackProviderSettings.defaultProvider,
  );
  const [selectedModel, setSelectedModel] = useState(
    fallbackProviderSettings.providers[0]?.defaultModel ?? '',
  );
  const [selectedContexts, setSelectedContexts] = useState<readonly string[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [providerForm, setProviderForm] = useState<ProviderFormState | null>(null);
  const [providerFormError, setProviderFormError] = useState<string | null>(null);
  const [providerMutation, setProviderMutation] = useState<
    'idle' | 'saving' | 'deleting' | 'defaulting'
  >('idle');
  const [providerToDelete, setProviderToDelete] = useState<ProviderDescriptor | null>(null);
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

  /** Run status of any session; a session without a run is idle. */
  function sessionRunStatus(sessionId: string): RunStatus {
    return runStateBySession[sessionId]?.status ?? 'idle';
  }
  function isSessionStreaming(sessionId: string): boolean {
    return sessionRunStatus(sessionId) === 'streaming';
  }
  function setSessionRunState(sessionId: string, next: SessionRunState): void {
    setRunStateBySession((current) => ({ ...current, [sessionId]: next }));
  }

  // The composer, overview and footer always reflect the active session's run.
  const activeRunState = runStateBySession[activeSessionId] ?? idleRunState;
  const status = activeRunState.status;
  const errorMessage = activeRunState.errorMessage;
  const activeSessionIdRef = useRef('');
  const messageInputRef = useRef<HTMLTextAreaElement | null>(null);
  const commandPicker = useCommandPicker({
    draft: messageInput,
    setDraft: setMessageInput,
    inputRef: messageInputRef,
  });
  const directoryInputRef = useRef<HTMLInputElement | null>(null);
  const imageInputRef = useRef<HTMLInputElement | null>(null);
  const activeProject = projects.find((project) => project.id === activeProjectId);
  const sessions = activeProject?.sessions ?? [];
  const activeSession = sessions.find((session) => session.id === activeSessionId);
  const selectedProvider =
    providerSettings.providers.find((provider) => provider.id === selectedProviderId) ??
    providerSettings.providers[0];
  const messages = activeSession?.messages ?? [];
  const conversationScroll = useAutoScroll<HTMLDivElement>(messages, activeSessionId);
  const approvals = useApprovals(!isLoadingWorkspace);
  const turns = activeSession?.turns ?? emptyTurns;
  const currentContext = latestContext(turns);
  const turnById = new Map(turns.map((turn) => [turn.turnId, turn]));
  const lastTurnId = turns.at(-1)?.turnId;
  const lastReplyIdByTurn = new Map<string, string>();
  for (const message of messages) {
    if (message.role === 'assistant' && message.turnId !== undefined) {
      lastReplyIdByTurn.set(message.turnId, message.id);
    }
  }
  // The viewed session's most recent assistant message drives the live / terminal
  // placeholder and spinner, so it stays correct for any session, including a
  // background one that is still streaming.
  const latestAssistantId =
    [...messages].reverse().find((message) => message.role === 'assistant')?.id ?? null;

  /** Runs the last user message again as a new Turn; history is kept. */
  function retryLastTurn(): void {
    const lastUserMessage = [...messages].reverse().find((message) => message.role === 'user');
    if (lastUserMessage !== undefined && lastUserMessage.text.trim() !== '') {
      void submitMessage(lastUserMessage.text);
    }
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
    const element = document.getElementById(`message-${messageId}`);
    if (element !== null && typeof element.scrollIntoView === 'function') {
      element.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }
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

  function applyProviderSettings(settings: ProviderSettings): void {
    setProviderSettings(settings);
    const nextProvider =
      settings.providers.find((provider) => provider.id === selectedProviderId) ??
      settings.providers.find((provider) => provider.id === settings.defaultProvider) ??
      settings.providers[0];
    if (nextProvider !== undefined) {
      setSelectedProviderId(nextProvider.id);
      setSelectedModel(nextProvider.defaultModel ?? '');
    }
  }

  async function refreshProviderSettings(): Promise<ProviderSettings> {
    const settings = await providerApi.listProviders();
    applyProviderSettings(settings);
    return settings;
  }

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
    let disposed = false;

    async function loadProviders(): Promise<void> {
      try {
        const settings = await providerApi.listProviders();
        if (disposed || settings.providers.length === 0) {
          return;
        }

        const [firstProvider] = settings.providers;
        const defaultProvider =
          settings.providers.find((provider) => provider.id === settings.defaultProvider) ??
          firstProvider;
        if (defaultProvider === undefined) {
          return;
        }
        setProviderSettings(settings);
        setSelectedProviderId(defaultProvider.id);
        setSelectedModel(defaultProvider.defaultModel ?? '');
      } catch (error: unknown) {
        if (!disposed) {
          setNotice(
            error instanceof ProviderApiError && error.code === 'provider-api-network'
              ? '无法连接到本地服务，当前使用本地模型'
              : 'Provider 配置加载失败，当前使用本地模型',
          );
        }
      }
    }

    void loadProviders();
    return () => {
      disposed = true;
    };
  }, []);

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
      if (current[activeSessionId] === undefined) {
        return current;
      }
      return Object.fromEntries(
        Object.entries(current).filter(([sessionId]) => sessionId !== activeSessionId),
      );
    });
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
    // A streaming session's freshest messages live in memory; a server snapshot
    // would clobber its in-flight assistant message, so skip the reload while it runs.
    if (runHandles.current.has(sessionId)) {
      return;
    }
    try {
      const detail = await workspaceApi.getSession(sessionId);
      // A run may have started while the snapshot was in flight; don't clobber it.
      if (runHandles.current.has(sessionId)) {
        return;
      }
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
  };

  function activateSession(projectId: string, session: StudioSession): void {
    setActiveProjectId(projectId);
    activeSessionIdRef.current = session.id;
    setActiveSessionId(session.id);
    setActiveView('studio');
    setExpandedProjectIds((current) =>
      current.includes(projectId) ? current : [...current, projectId],
    );
  }

  async function createSessionForProject(
    projectId: string,
    projectIfMissing?: StudioProject,
  ): Promise<ActiveSessionContext | null> {
    try {
      const detail = await workspaceApi.createSession(projectId);
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
      activateSession(projectId, newSession);
      resetTransientState();
      return { projectId, sessionId: newSession.id, session: newSession };
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
  async function ensureSessionForMessage(): Promise<ActiveSessionContext | null> {
    const activeContext = getActiveSessionContext();
    if (activeContext !== null) {
      return activeContext;
    }

    const project = projects.find((candidate) => candidate.id === activeProjectId);
    if (project !== undefined) {
      return createSessionForProject(project.id);
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
      return createSessionForProject(project.id, project);
    } catch (error: unknown) {
      setNotice(workspaceErrorMessage(error));
      return null;
    }
  }

  /**
   * Sends a message. `retryText` resends an earlier message as a new Turn
   * (the previous Turn stays in history) without touching the draft input.
   */
  async function submitMessage(retryText?: string): Promise<void> {
    const typed = (retryText ?? messageInput).trim();
    // A draft that invokes a slash command is sent as the command's prompt, so
    // the message shown and stored is the text the model receives.
    const text = retryText === undefined ? commandPicker.expand(typed) : typed;
    const images = retryText === undefined ? pendingImages : [];
    if ((text === '' && images.length === 0) || status === 'streaming') {
      return;
    }

    const sessionContext = getActiveSessionContext() ?? (await ensureSessionForMessage());
    if (sessionContext === null) {
      return;
    }
    const { projectId, sessionId } = sessionContext;

    // Persist a generated title on the first message of an untitled session so
    // it survives a reload (the local title update below is only cosmetic).
    const generatedTitle = createSessionTitle(text);
    const existingTitle = projects
      .find((project) => project.id === projectId)
      ?.sessions.find((session) => session.id === sessionId)?.title;
    const shouldPersistTitle =
      retryText === undefined &&
      generatedTitle !== '' &&
      (existingTitle === undefined || existingTitle === '未命名会话' || existingTitle === '');

    const userMessageId = createId('user');
    const assistantId = createId('assistant');
    const liveTurnId = liveTurnIdFor(assistantId);
    const runId = createId('run');
    const requestController = new AbortController();
    const occurredAt = new Date().toISOString();

    runHandles.current.set(sessionId, {
      runId,
      controller: requestController,
      assistantId,
      tools: [],
    });
    conversationScroll.scrollToBottom('auto');
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
        provider: selectedProviderId,
        model: selectedModel,
        modelSteps: [],
        toolResults: [],
        toolCalls: 0,
        failedToolCalls: 0,
      },
    ]);
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
    if (retryText === undefined) {
      setMessageInput('');
      setPendingImages([]);
    }
    if (shouldPersistTitle) {
      void workspaceApi.renameSession(sessionId, generatedTitle).catch(() => undefined);
    }
    setExpandedMessageIds([assistantId]);
    setSessionRunState(sessionId, { status: 'streaming', errorMessage: null });

    try {
      await streamAgentRun(
        {
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
          provider: selectedProviderId,
          model: selectedModel,
          reasoningEffort,
          permissionMode,
        },
        { onEvent: (event) => handleEvent(event, runId, assistantId, projectId, sessionId) },
        { signal: requestController.signal },
      );
    } catch (error: unknown) {
      if (runHandles.current.get(sessionId)?.runId !== runId) {
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
      if (runHandles.current.get(sessionId)?.runId === runId) {
        runHandles.current.delete(sessionId);
      }
    }
  }

  /** Selects a session from any project and keeps the project/session context aligned. */
  function selectProjectSession(projectId: string, sessionId: string): void {
    if (projectId === activeProjectId && sessionId === activeSessionId) {
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

    activeSessionIdRef.current = session.id;
    setActiveProjectId(project.id);
    setActiveSessionId(session.id);
    setActiveView('studio');
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
    setActiveView(view);
    setOpenMenu(null);
    setNotice(null);
  }

  function openProviderForm(provider?: ProviderDescriptor): void {
    setProviderFormError(null);
    const providerPreset = provider === undefined ? undefined : findProviderPreset(provider.id);
    setProviderForm(
      provider === undefined
        ? {
            mode: 'create',
            editingId: null,
            providerPresetId: '',
            modelPresetId: customProviderPresetId,
            id: '',
            label: '',
            baseUrl: '',
            apiKey: '',
            defaultModel: '',
            makeDefault: providerSettings.providers.length === 0,
            clearApiKey: false,
            contextWindowTokens: '',
            temperature: '',
            maxTokens: '',
          }
        : {
            mode: 'edit',
            editingId: provider.id,
            providerPresetId: providerPreset?.id ?? customProviderPresetId,
            modelPresetId: findModelPresetId(providerPreset, provider.defaultModel ?? ''),
            id: provider.id,
            label: provider.label,
            baseUrl: provider.baseUrl ?? '',
            apiKey: '',
            defaultModel: provider.defaultModel ?? '',
            makeDefault: provider.id === providerSettings.defaultProvider,
            clearApiKey: false,
            contextWindowTokens:
              provider.contextWindowTokens === undefined
                ? ''
                : String(provider.contextWindowTokens),
            temperature: provider.temperature === undefined ? '' : String(provider.temperature),
            maxTokens: provider.maxTokens === undefined ? '' : String(provider.maxTokens),
          },
    );
  }

  function closeProviderForm(): void {
    if (providerMutation === 'saving') {
      return;
    }
    setProviderForm(null);
    setProviderFormError(null);
  }

  function updateProviderForm<K extends keyof ProviderFormState>(
    key: K,
    value: ProviderFormState[K],
  ): void {
    setProviderForm((current) => (current === null ? current : { ...current, [key]: value }));
  }

  function chooseProviderPreset(presetId: string): void {
    setProviderForm((current) => {
      if (current === null) {
        return current;
      }

      if (presetId === customProviderPresetId) {
        return {
          ...current,
          providerPresetId: customProviderPresetId,
          modelPresetId: customProviderPresetId,
          id: current.mode === 'create' ? '' : current.id,
          label: current.mode === 'create' ? '' : current.label,
          baseUrl: current.mode === 'create' ? '' : current.baseUrl,
          defaultModel: current.mode === 'create' ? '' : current.defaultModel,
        };
      }

      const preset = findProviderPreset(presetId);
      if (preset === undefined) {
        return current;
      }

      return {
        ...current,
        providerPresetId: preset.id,
        modelPresetId: preset.models[0] ?? customProviderPresetId,
        id: current.mode === 'create' ? preset.id : current.id,
        label: preset.label,
        baseUrl: preset.baseUrl,
        defaultModel: preset.models[0] ?? '',
      };
    });
  }

  function chooseModelPreset(modelPresetId: string): void {
    setProviderForm((current) => {
      if (current === null) {
        return current;
      }

      return {
        ...current,
        modelPresetId,
        defaultModel: modelPresetId === customProviderPresetId ? '' : modelPresetId,
      };
    });
  }

  function providerErrorMessage(error: unknown): string {
    if (!(error instanceof ProviderApiError)) {
      return 'Provider 配置暂时不可用，请稍后重试';
    }
    switch (error.code) {
      case 'provider-settings-secret-unavailable':
        return '系统密钥存储不可用，请在桌面端重试';
      case 'provider-settings-duplicate':
        return 'Provider ID 已存在，请换一个 ID';
      case 'provider-settings-protected':
        return '这个 Provider 由系统或插件管理，不能从此处修改';
      case 'provider-settings-provider-invalid':
        return 'Provider 客户端创建失败，请检查地址和配置';
      case 'provider-settings-api-key-required':
        return '修改了 API 地址，请重新填写 API Key';
      case 'provider-api-network':
        return '无法连接到本地服务，请确认后端已经启动';
      default:
        return error.message;
    }
  }

  async function saveProvider(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const form = providerForm;
    if (form === null) {
      return;
    }
    if (
      form.id.trim() === '' ||
      form.label.trim() === '' ||
      form.baseUrl.trim() === '' ||
      form.defaultModel.trim() === '' ||
      (form.mode === 'create' && form.apiKey.trim() === '')
    ) {
      setProviderFormError('请填写完整的 Provider 信息');
      return;
    }

    const temperature = parseProviderNumberField(form.temperature, 'temperature');
    const maxTokens = parseProviderNumberField(form.maxTokens, 'positiveInt');
    const contextWindowTokens = parseProviderNumberField(form.contextWindowTokens, 'positiveInt');
    if (!temperature.ok || !maxTokens.ok || !contextWindowTokens.ok) {
      setProviderFormError('采样参数格式不对：温度 0–2，最大输出 token 与上下文窗口须为正整数');
      return;
    }

    setProviderMutation('saving');
    setProviderFormError(null);
    try {
      if (form.mode === 'create') {
        await providerApi.createProvider({
          id: form.id.trim(),
          label: form.label.trim(),
          type: 'openai-compatible',
          baseUrl: form.baseUrl.trim(),
          apiKey: form.apiKey,
          defaultModel: form.defaultModel.trim(),
          makeDefault: form.makeDefault,
          ...(contextWindowTokens.value === undefined
            ? {}
            : { contextWindowTokens: contextWindowTokens.value }),
          ...(temperature.value === undefined ? {} : { temperature: temperature.value }),
          ...(maxTokens.value === undefined ? {} : { maxTokens: maxTokens.value }),
        });
      } else if (form.editingId !== null) {
        await providerApi.updateProvider(form.editingId, {
          label: form.label.trim(),
          baseUrl: form.baseUrl.trim(),
          apiKey: form.apiKey,
          defaultModel: form.defaultModel.trim(),
          makeDefault: form.makeDefault,
          contextWindowTokens: contextWindowTokens.value ?? null,
          temperature: temperature.value ?? null,
          maxTokens: maxTokens.value ?? null,
          ...(form.clearApiKey ? { clearApiKey: true } : {}),
        });
      }
      await refreshProviderSettings();
      setProviderForm(null);
      setNotice('Provider 已保存');
    } catch (error: unknown) {
      setProviderFormError(providerErrorMessage(error));
    } finally {
      setProviderMutation('idle');
    }
  }

  async function setDefaultProvider(providerId: string): Promise<void> {
    setProviderMutation('defaulting');
    setNotice(null);
    try {
      const settings = await providerApi.setDefaultProvider(providerId);
      applyProviderSettings(settings);
      setNotice('默认 Provider 已更新');
    } catch (error: unknown) {
      setNotice(providerErrorMessage(error));
    } finally {
      setProviderMutation('idle');
    }
  }

  async function deleteProvider(): Promise<void> {
    const provider = providerToDelete;
    if (provider === null) {
      return;
    }
    setProviderMutation('deleting');
    try {
      await providerApi.deleteProvider(provider.id);
      await refreshProviderSettings();
      setProviderToDelete(null);
      setNotice('Provider 已删除');
    } catch (error: unknown) {
      setNotice(providerErrorMessage(error));
    } finally {
      setProviderMutation('idle');
    }
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

  /** Selects a public Provider and its configured default model for new runs. */
  function chooseProvider(provider: ProviderDescriptor): void {
    setSelectedProviderId(provider.id);
    setSelectedModel(provider.defaultModel ?? '');
    setOpenMenu(null);
  }

  function showNotice(message: string): void {
    setNotice(message);
    setOpenMenu(null);
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    void submitMessage();
  }

  function handleMessageKeyDown(event: ReactKeyboardEvent<HTMLTextAreaElement>): void {
    if (commandPicker.handleKeyDown(event)) {
      return;
    }
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) {
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
    const read = await Promise.all(
      imageFiles.map(async (file) => {
        const { mediaType, data } = await readImageFile(file);
        return { id: createId('img'), name: file.name, mediaType, data };
      }),
    );
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
    const handle = runHandles.current.get(sessionId);
    if (handle === undefined) {
      return;
    }

    runHandles.current.delete(sessionId);
    handle.controller.abort();
    setSessionRunState(sessionId, { status: 'cancelled', errorMessage: null });
    if (activeProjectId !== '' && sessionId !== '') {
      finishLiveTurn(activeProjectId, sessionId, liveTurnIdFor(handle.assistantId), 'cancelled');
    }
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
      className={`studio-shell studio-shell-fixed${activeView === 'studio' && !isActivityPanelOpen ? ' studio-shell-panel-collapsed' : ''}${activeView !== 'studio' && activeView !== 'settings' ? ' studio-shell-context-collapsed' : ''}${activeView === 'settings' ? ' studio-shell-settings' : ''}`}
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
        <aside className="session-rail" aria-label="会话列表">
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

      {activeView === 'studio' ? (
        <section className="chat-column" aria-label="智能对话" ref={chatColumnRef}>
          <header className="chat-header">
            <div className="breadcrumb">
              <span>{activeProject?.folderName ?? 'weave'}</span>
              <span className="breadcrumb-divider" aria-hidden="true">
                /
              </span>
              <strong>{activeSession?.title ?? '未命名会话'}</strong>
            </div>
            <div className="header-actions">
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

          <div className="conversation-viewport">
            <div
              className="message-list conversation-scroll"
              aria-label="Agent 工作流"
              aria-live="polite"
              ref={conversationScroll.ref}
              onScroll={conversationScroll.onScroll}
            >
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
                messages.map((message) => {
                  const isLatestAssistant =
                    message.role === 'assistant' && message.id === latestAssistantId;
                  const hasProcess =
                    message.role === 'assistant' &&
                    (message.reasoning !== '' ||
                      message.tools.length > 0 ||
                      (isLatestAssistant && status === 'streaming'));

                  return (
                    <article
                      className={`timeline-item timeline-item-${message.role}`}
                      id={`message-${message.id}`}
                      key={message.id}
                    >
                      <div className="timeline-content">
                        <div className="message-meta">
                          {message.role === 'assistant' ? (
                            <span className="message-avatar" aria-hidden="true">
                              <Sparkles />
                            </span>
                          ) : null}
                          {message.role === 'user' ? '你' : 'Weave Agent'}
                          <time dateTime={message.occurredAt}>
                            {formatMessageTime(message.occurredAt)}
                          </time>
                        </div>
                        {hasProcess ? (
                          <details
                            className="message-process"
                            role="group"
                            aria-label="本轮过程"
                            open={expandedMessageIds.includes(message.id)}
                            onToggle={(event) => {
                              const isOpen = event.currentTarget.open;
                              setExpandedMessageIds((current) =>
                                isOpen
                                  ? current.includes(message.id)
                                    ? current
                                    : [...current, message.id]
                                  : current.filter((id) => id !== message.id),
                              );
                            }}
                          >
                            <summary>
                              <ChevronRight className="disclosure-icon" aria-hidden="true" />
                              <span className="message-process-title">
                                <TerminalSquare aria-hidden="true" />
                                {message.tools.length > 0
                                  ? `${message.tools.length} 次工具调用`
                                  : '思考过程'}
                              </span>
                              {isLatestAssistant && status === 'streaming' ? (
                                <span className="message-process-state message-process-state-live">
                                  <LoaderCircle className="spin-icon" aria-hidden="true" />
                                  进行中
                                </span>
                              ) : (
                                <span className="message-process-state">已完成</span>
                              )}
                            </summary>
                            <div className="message-process-content">
                              {message.reasoning !== '' ? (
                                <section className="message-process-section" aria-label="思考内容">
                                  <div className="message-process-heading">
                                    <span>思考</span>
                                    {isLatestAssistant && status === 'streaming' ? (
                                      <span className="message-process-live">实时</span>
                                    ) : null}
                                  </div>
                                  <p className="message-process-text">{message.reasoning}</p>
                                </section>
                              ) : null}
                              {message.tools.length > 0 ? (
                                <section className="message-process-section" aria-label="工具步骤">
                                  <div className="message-process-heading">
                                    <span>工具调用</span>
                                    <span>{message.tools.length} 次</span>
                                  </div>
                                  <div className="message-process-tools">
                                    {message.tools.map((tool) => (
                                      <ToolStep tool={tool} key={tool.toolCallId} />
                                    ))}
                                  </div>
                                </section>
                              ) : null}
                              {message.reasoning === '' && message.tools.length === 0 ? (
                                <p className="message-process-placeholder">Agent 正在准备回复…</p>
                              ) : null}
                            </div>
                          </details>
                        ) : null}
                        <div className="message">
                          {message.role === 'assistant' && message.text !== '' ? (
                            <MarkdownMessage text={message.text} />
                          ) : message.text !== '' || message.role === 'assistant' ? (
                            <p>
                              {message.text ||
                                getAssistantPlaceholder(
                                  status,
                                  isLatestAssistant,
                                  message.role === 'assistant' && message.reasoning !== '',
                                )}
                            </p>
                          ) : null}
                          {message.role === 'user' && (message.images?.length ?? 0) > 0 ? (
                            <div className="message-images">
                              {(message.images ?? []).map((image, index) => (
                                <button
                                  key={`${message.id}-${index}`}
                                  type="button"
                                  className="message-image-button"
                                  aria-label="放大查看图片"
                                  onClick={() => setPreviewImage(image)}
                                >
                                  <img
                                    className="message-image"
                                    src={`data:${image.mediaType};base64,${image.data}`}
                                    alt="已发送的图片"
                                  />
                                </button>
                              ))}
                            </div>
                          ) : null}
                        </div>
                        {message.role === 'assistant' &&
                        message.turnId !== undefined &&
                        lastReplyIdByTurn.get(message.turnId) === message.id &&
                        !(isLatestAssistant && status === 'streaming') ? (
                          <MessageFooter
                            turn={turnById.get(message.turnId)}
                            timeLabel={formatMessageTime(message.occurredAt)}
                            text={message.text}
                            canRetry={message.turnId === lastTurnId}
                            disabled={status === 'streaming'}
                            onRetry={() => retryLastTurn()}
                            onQuote={() => quoteReply(message.text)}
                          />
                        ) : null}
                      </div>
                    </article>
                  );
                })
              )}
            </div>
            {!conversationScroll.isAtBottom && messages.length > 0 ? (
              <button
                className="scroll-to-bottom"
                type="button"
                aria-label="回到底部"
                onClick={() => conversationScroll.scrollToBottom()}
              >
                <ArrowDown aria-hidden="true" />
                {status === 'streaming' ? '有新内容' : '回到底部'}
              </button>
            ) : null}
          </div>

          <form className="composer" onSubmit={handleSubmit}>
            <ApprovalPanel
              pending={approvals.pending.filter(
                (approval) =>
                  approval.sessionId === undefined || approval.sessionId === activeSessionId,
              )}
              onDecide={approvals.decide}
            />
            <div className="composer-box">
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
                onChange={(event) => setMessageInput(event.target.value)}
                onKeyDown={handleMessageKeyDown}
                onPaste={handleComposerPaste}
                placeholder="给 Agent 分配一个任务…"
                {...(commandPicker.open
                  ? {
                      'aria-controls': commandPickerListId,
                      'aria-activedescendant': commandOptionId(
                        commandPicker.items[commandPicker.activeIndex]?.name ?? '',
                      ),
                    }
                  : {})}
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
                  {currentContext !== undefined ? (
                    <button
                      type="button"
                      className={`composer-context${
                        currentContext.ratio >= contextWarnThreshold ? ' composer-context-warn' : ''
                      }`}
                      aria-label={`上下文窗口占用 ${Math.round(
                        currentContext.ratio * 100,
                      )}%，点击查看详情`}
                      title={`上下文窗口 ${Math.round(currentContext.ratio * 100)}% · ${formatTokens(
                        currentContext.sentTokens,
                      )} / ${formatTokens(currentContext.windowTokens)} tokens${
                        currentContext.trimmed ? ' · 已压缩' : ''
                      }`}
                      onClick={() => setIsActivityPanelOpen(true)}
                    >
                      <span className="composer-context-track" aria-hidden="true">
                        <span
                          className="composer-context-fill"
                          style={{ width: `${Math.round(currentContext.ratio * 100)}%` }}
                        />
                      </span>
                      <span className="composer-context-value">
                        {Math.round(currentContext.ratio * 100)}%
                      </span>
                    </button>
                  ) : null}
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
                      disabled={messageInput.trim() === '' && pendingImages.length === 0}
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
                          disabled={status === 'streaming'}
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
                            disabled={status === 'streaming'}
                          >
                            <MessageSquarePlus aria-hidden="true" />
                          </button>
                          <button
                            className="project-action-button"
                            type="button"
                            aria-label={`重命名项目 ${project.name}`}
                            title="重命名"
                            onClick={() => openProjectRename(project)}
                            disabled={status === 'streaming'}
                          >
                            <Pencil aria-hidden="true" />
                          </button>
                          <button
                            className="project-action-button"
                            type="button"
                            aria-label={`设置项目 ${project.name} 的文件夹`}
                            title="设置文件夹"
                            onClick={() => openFolderDialog(project)}
                            disabled={status === 'streaming'}
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
                    <p>归档会话不会出现在项目树中，可以恢复或永久删除。</p>
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
      )}

      {activeView === 'studio' ? (
        <PanelContainer
          collapsed={!isActivityPanelOpen}
          width={panelWidth}
          shellRef={shellRef}
          conversationRef={chatColumnRef}
          onResize={setPanelWidth}
          onCollapse={() => setIsActivityPanelOpen(false)}
          context={{
            statusKey: status,
            projectId: activeProjectId,
            statusLabel: statusLabels[status],
            isRunning: status === 'streaming',
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
