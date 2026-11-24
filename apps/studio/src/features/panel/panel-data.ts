import type {
  AgentPlan,
  ContextBreakdown,
  ContextCategories,
  TurnSummary,
  TurnUsage,
} from '../workspace/workspace-types.js';

export type OverviewToolStatus = 'called' | 'executing' | 'completed' | 'failed';

export interface OverviewTool {
  readonly toolCallId: string;
  readonly name: string;
  readonly arguments: string;
  readonly status: OverviewToolStatus;
  readonly result?: string | undefined;
}

export interface OverviewMessage {
  readonly id: string;
  readonly role: 'user' | 'assistant';
  readonly occurredAt: string;
  readonly turnId?: string | undefined;
  readonly tools: readonly OverviewTool[];
}

/** Everything the side panels read; passed once from App into the container. */
export interface PanelContext {
  readonly statusKey: string;
  readonly statusLabel: string;
  readonly isRunning: boolean;
  /** Any Studio-observed Session is streaming, including an inactive Session. */
  readonly hasRunningSessions: boolean;
  readonly sessionLabel: string;
  readonly sessionId?: string;
  readonly folderPath: string | undefined;
  readonly projectId: string | undefined;
  readonly modelLabel: string;
  readonly turns: readonly TurnSummary[];
  readonly messages: readonly OverviewMessage[];
  readonly errorMessage: string | null;
  readonly formatTime: (occurredAt: string) => string;
  readonly onSetFolder: () => void;
  readonly onAddFile?: ((path: string) => void) | undefined;
  readonly selectedFiles?: readonly string[] | undefined;
  readonly fileOwnerKey?: string | undefined;
  readonly onViewerFileChange?: ((path: string | null) => void) | undefined;
  readonly onJumpToMessage: (messageId: string) => void;
}

export interface FileEntry {
  readonly path: string;
  readonly operation: '读取' | '写入';
  readonly state: string;
  readonly ok: boolean;
  readonly messageId: string;
}

function toolPath(tool: OverviewTool): string | undefined {
  try {
    const parsed = JSON.parse(tool.arguments) as unknown;
    if (typeof parsed === 'object' && parsed !== null && 'path' in parsed) {
      const value = (parsed as { path: unknown }).path;
      return typeof value === 'string' ? value : undefined;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

/** Splits `a/b/c.ts` into `c.ts` and `a/b` for a compact two-tone label. */
export function splitPath(path: string): { readonly name: string; readonly directory: string } {
  const trimmed = path.replace(/[\\/]+$/, '');
  const index = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  return index < 0
    ? { name: trimmed, directory: '' }
    : { name: trimmed.slice(index + 1), directory: trimmed.slice(0, index) };
}

/** Latest read or write of each path in the Session, newest first. */
export function collectFiles(messages: readonly OverviewMessage[]): FileEntry[] {
  const byPath = new Map<string, FileEntry>();
  for (const message of messages) {
    for (const tool of message.tools) {
      if (tool.name !== 'read_file' && tool.name !== 'write_file') {
        continue;
      }
      const path = toolPath(tool);
      if (path === undefined) {
        continue;
      }
      const rejected = tool.result?.includes('tool-approval-rejected') === true;
      const state =
        tool.status === 'completed'
          ? tool.name === 'read_file'
            ? '已读取'
            : '已写入'
          : tool.status === 'failed'
            ? rejected
              ? '已拒绝'
              : '失败'
            : '进行中';
      byPath.delete(path);
      byPath.set(path, {
        path,
        operation: tool.name === 'read_file' ? '读取' : '写入',
        state,
        ok: tool.status === 'completed',
        messageId: message.id,
      });
    }
  }
  return [...byPath.values()].reverse();
}

/** Tool calls paired with their message, newest first, for the timeline. */
export function collectTimeline(
  messages: readonly OverviewMessage[],
): { readonly tool: OverviewTool; readonly message: OverviewMessage }[] {
  return messages.flatMap((message) => message.tools.map((tool) => ({ tool, message }))).reverse();
}

/** First assistant message of each Turn, so a usage row can jump to it. */
export function firstAssistantByTurn(messages: readonly OverviewMessage[]): Map<string, string> {
  const byTurn = new Map<string, string>();
  for (const message of messages) {
    if (
      message.role === 'assistant' &&
      message.turnId !== undefined &&
      !byTurn.has(message.turnId)
    ) {
      byTurn.set(message.turnId, message.id);
    }
  }
  return byTurn;
}

export function percentWidth(rate: number | undefined): string {
  return `${Math.round((rate ?? 0) * 100)}%`;
}

/** The four non-overlapping token categories of one usage record. */
export interface UsageComposition {
  readonly cacheRead: number;
  readonly freshInput: number;
  readonly output: number;
  readonly reasoning: number;
  readonly total: number;
}

/**
 * Splits usage into non-overlapping categories whose sum is input + output.
 * `inputTokens` already includes the cached part, and `outputTokens` already
 * includes reasoning, so each larger counter is reduced by its sub-counter.
 */
export function usageComposition(usage: TurnUsage | undefined): UsageComposition {
  const input = usage?.inputTokens ?? 0;
  const output = usage?.outputTokens ?? 0;
  const cacheRead = Math.min(usage?.cacheReadTokens ?? 0, input);
  const reasoning = Math.min(usage?.reasoningTokens ?? 0, output);
  return {
    cacheRead,
    freshInput: Math.max(0, input - cacheRead),
    output: Math.max(0, output - reasoning),
    reasoning,
    total: input + output,
  };
}

/** Category metadata for the composition bar and legend, in stack order. */
export const usageCategories = [
  { key: 'cacheRead', label: '命中缓存' },
  { key: 'freshInput', label: '新输入' },
  { key: 'output', label: '输出' },
  { key: 'reasoning', label: '思考' },
] as const satisfies readonly { key: keyof UsageComposition; label: string }[];

/** Fraction of the model window at which the context panel warns. */
export const contextWarnThreshold = 0.7;

/** Category metadata for the context composition bar and legend, in stack order. */
export const contextCategories = [
  { key: 'system', label: '系统指令' },
  { key: 'tools', label: '工具定义' },
  { key: 'userMessages', label: '用户消息' },
  { key: 'assistantText', label: '助手回复' },
  { key: 'toolCalls', label: '工具调用' },
  { key: 'toolResults', label: '工具结果' },
  { key: 'skeleton', label: '压缩骨架' },
  { key: 'assistantReasoning', label: '思考' },
] as const satisfies readonly { key: keyof ContextCategories; label: string }[];

/** The most recent Turn that recorded a context breakdown, if any. */
export function latestContext(turns: readonly TurnSummary[]): ContextBreakdown | undefined {
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const context = turns[index]?.context;
    if (context !== undefined) {
      return context;
    }
  }
  return undefined;
}

/** The most recent Turn that recorded a task plan, if any. */
export function latestPlan(turns: readonly TurnSummary[]): AgentPlan | undefined {
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const plan = turns[index]?.plan;
    if (plan !== undefined) {
      return plan;
    }
  }
  return undefined;
}

/** Display metadata for each plan item status, in checklist order. */
export const planStatusMeta = {
  completed: { label: '已完成', symbol: '✓' },
  in_progress: { label: '进行中', symbol: '▸' },
  pending: { label: '待办', symbol: '○' },
} as const satisfies Record<
  'pending' | 'in_progress' | 'completed',
  { readonly label: string; readonly symbol: string }
>;
