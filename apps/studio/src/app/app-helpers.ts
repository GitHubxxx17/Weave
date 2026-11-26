import { AgentStreamError } from '../features/agent/agent-stream.js';
import {
  conversationRows,
  projectConversation,
} from '../features/conversation/conversation-model.js';
import { WorkspaceApiError } from '../features/workspace/workspace-api.js';
import type {
  ProjectWithSessions,
  SessionDetail,
  SessionSummary,
  TurnSummary,
} from '../features/workspace/workspace-types.js';
import type { StudioProject, StudioSession, ToolActivity } from './app-types.js';

let nextId = 0;

export function createId(prefix: string): string {
  nextId += 1;
  return `${prefix}-${nextId}`;
}

export function getSessionLabel(sessionId: string): string {
  return sessionId.startsWith('session-') ? sessionId.slice('session-'.length) : sessionId;
}

/** "DeepSeek · deepseek-chat", or only the model when the Provider is named after it. */
export function formatModelLabel(providerLabel: string, model: string): string {
  return providerLabel.trim().toLowerCase() === model.trim().toLowerCase()
    ? model
    : `${providerLabel} · ${model}`;
}

export function createSessionTitle(text: string): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  return normalized.length > 24 ? `${normalized.slice(0, 24)}…` : normalized;
}

export function safeErrorMessage(error: unknown): string {
  if (error instanceof AgentStreamError) {
    const separator = error.message.indexOf(': ');
    return separator === -1 ? error.message : error.message.slice(separator + 2);
  }

  return 'Agent run failed';
}

export function updateToolActivity(
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

export const emptyTurns: readonly TurnSummary[] = [];

/** Temporary Turn id used while a run streams, replaced by the durable id on completion. */
export function liveTurnIdFor(assistantMessageId: string): string {
  return `live-${assistantMessageId}`;
}

/** Reads an image File as base64 (without the `data:` prefix). */
export function readImageFile(file: File): Promise<{ mediaType: string; data: string }> {
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

export function formatMessageTime(occurredAt: string): string {
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

export function toStudioSession(session: SessionSummary | SessionDetail): StudioSession {
  return {
    id: session.id,
    title: session.title,
    lastUsedLabel: '最近使用',
    archivedAt: session.archivedAt ?? null,
    messages: 'messages' in session ? conversationRows(projectConversation(session)) : [],
    turns: 'turns' in session ? session.turns : [],
    detailKnown: 'messages' in session,
    durableSequence: session.lastSequence,
    ...('taskOrigin' in session ? { taskOrigin: session.taskOrigin } : {}),
  };
}

export function toStudioProject(project: ProjectWithSessions): StudioProject {
  return {
    id: project.id,
    name: project.name,
    folderName: project.folderName,
    folderPath: project.folderPath,
    // The server returns sessions in creation order; show newest first.
    sessions: [...project.sessions].reverse().map(toStudioSession),
  };
}

export function workspaceErrorMessage(error: unknown): string {
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
