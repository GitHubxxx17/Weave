import type { ContextBreakdown, ContextCategoryBreakdown, Message } from '@weave/protocol';
import type { ToolDefinition } from '@weave/protocol';
import { estimateTokens, estimateToolsTokens } from './token-estimate.js';

/** Budget inputs for assembling one model request's send window. */
export interface ContextBudget {
  /** Model context window in tokens. */
  readonly windowTokens: number;
  /** Tokens reserved for the model's output. */
  readonly reserveOutputTokens: number;
  /** Safety margin as a fraction of the window (e.g. 0.05). */
  readonly marginRatio: number;
}

export interface BuildContextInput {
  /** System instructions injected each run (never compressed). */
  readonly system: readonly Message[];
  /** Projected conversation messages, oldest first. */
  readonly history: readonly Message[];
  /** Model-visible tool definitions, counted against the budget. */
  readonly tools: readonly ToolDefinition[] | undefined;
  readonly budget: ContextBudget;
  /** A single tool result above this many tokens is head/tail truncated. */
  readonly maxToolResultTokens: number;
}

export interface BuildContextResult {
  /** Messages to send (system excluded; caller prepends system). */
  readonly messages: readonly Message[];
  readonly breakdown: ContextBreakdown;
  /** The mandatory part (system + tools + current turn) does not fit. */
  readonly overflow: boolean;
}

const messageOverheadTokens = 4;
const skeletonMarker =
  '[以下为更早对话的压缩摘要，关键信息已保留；完整原文可用 recall 工具按 toolCallId 或 path 取回]';

/** Concatenated text of a message's text blocks (reasoning is never sent). */
function textOf(message: Message): string {
  return message.content
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('');
}

/** Estimated tokens a message costs when sent (text + tool calls, no reasoning). */
function messageTokens(message: Message): number {
  let total = messageOverheadTokens + estimateTokens(textOf(message));
  if (message.role === 'assistant' && message.toolCalls !== undefined) {
    for (const call of message.toolCalls) {
      total += estimateTokens(call.name) + estimateTokens(call.arguments) + messageOverheadTokens;
    }
  }
  return total;
}

/** Pulls a `path` argument out of a tool call's JSON arguments, when present. */
function toolCallPath(argumentsText: string): string | undefined {
  try {
    const parsed = JSON.parse(argumentsText) as unknown;
    if (typeof parsed === 'object' && parsed !== null && 'path' in parsed) {
      const value = (parsed as { path: unknown }).path;
      return typeof value === 'string' ? value : undefined;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

/** Head/tail truncation of a long string to roughly `maxTokens`, keeping both ends. */
function truncateToTokens(text: string, maxTokens: number): { text: string; truncated: boolean } {
  if (estimateTokens(text) <= maxTokens) {
    return { text, truncated: false };
  }
  // Rough char budget; ASCII ~4 chars/token, CJK ~1. Use 3 as a safe middle.
  const charBudget = Math.max(200, maxTokens * 3);
  const head = Math.floor(charBudget * 0.6);
  const tail = charBudget - head;
  const omitted = text.length - head - tail;
  if (omitted <= 0) {
    return { text, truncated: false };
  }
  return {
    text: `${text.slice(0, head)}\n…省略 ${omitted} 字符…\n${text.slice(text.length - tail)}`,
    truncated: true,
  };
}

/** Returns a copy of a tool message whose content is truncated when oversized. */
function truncateToolMessage(
  message: Extract<Message, { role: 'tool' }>,
  maxTokens: number,
): { message: Message; truncated: boolean } {
  const original = textOf(message);
  const { text, truncated } = truncateToTokens(original, maxTokens);
  if (!truncated) {
    return { message, truncated: false };
  }
  return {
    message: { ...message, content: [{ type: 'text', text }] },
    truncated: true,
  };
}

type Group =
  | { readonly kind: 'user'; readonly messages: readonly Message[] }
  | { readonly kind: 'assistant-text'; readonly messages: readonly Message[] }
  | { readonly kind: 'tool-cycle'; readonly messages: readonly Message[] }
  | { readonly kind: 'orphan'; readonly messages: readonly Message[] };

/** Splits older history into turn-aligned groups so pairing stays intact. */
function groupHistory(history: readonly Message[]): Group[] {
  const groups: Group[] = [];
  let index = 0;
  while (index < history.length) {
    const message = history[index]!;
    if (message.role === 'assistant' && (message.toolCalls?.length ?? 0) > 0) {
      const messages: Message[] = [message];
      index += 1;
      while (index < history.length && history[index]!.role === 'tool') {
        messages.push(history[index]!);
        index += 1;
      }
      groups.push({ kind: 'tool-cycle', messages });
    } else if (message.role === 'user') {
      groups.push({ kind: 'user', messages: [message] });
      index += 1;
    } else if (message.role === 'assistant') {
      groups.push({ kind: 'assistant-text', messages: [message] });
      index += 1;
    } else {
      groups.push({ kind: 'orphan', messages: [message] });
      index += 1;
    }
  }
  return groups;
}

/** Deterministic, fidelity-preserving skeleton for compressed older groups. */
function renderSkeleton(groups: readonly Group[]): string {
  const lines: string[] = [skeletonMarker];
  for (const group of groups) {
    if (group.kind === 'user') {
      lines.push(`用户：${textOf(group.messages[0]!)}`);
      continue;
    }
    if (group.kind === 'assistant-text') {
      const { text } = truncateToTokens(textOf(group.messages[0]!), 60);
      lines.push(`助手：${text}`);
      continue;
    }
    // tool-cycle / orphan: keep what each tool call did and whether it failed.
    const assistant = group.messages.find(
      (message): message is Extract<Message, { role: 'assistant' }> => message.role === 'assistant',
    );
    const resultByCallId = new Map<string, string>();
    for (const message of group.messages) {
      if (message.role === 'tool') {
        resultByCallId.set(message.toolCallId, textOf(message));
      }
    }
    for (const call of assistant?.toolCalls ?? []) {
      const path = toolCallPath(call.arguments);
      const result = resultByCallId.get(call.id);
      const failed = result !== undefined && /failed|error|rejected/i.test(result);
      const location = path === undefined ? '' : ` ${path}`;
      const head = `· ${call.name}${location}`;
      if (result === undefined) {
        lines.push(`${head}（无结果）`);
      } else if (failed) {
        // Failed results keep their full error text (fidelity tier A).
        lines.push(`${head} ✗ ${truncateToTokens(result, 80).text}`);
      } else {
        // Successful bodies are omitted but recallable by id (or path).
        lines.push(`${head} ✓ ${result.length}字符 [recall id=${call.id}]`);
      }
    }
    if (assistant !== undefined && textOf(assistant) !== '') {
      lines.push(`助手：${truncateToTokens(textOf(assistant), 60).text}`);
    }
  }
  return lines.join('\n');
}

/** Mutable working copy of the category tally, frozen into the result. */
type MutableCategories = { -readonly [Key in keyof ContextCategoryBreakdown]: number };

function zeroCategories(): MutableCategories {
  return {
    system: 0,
    tools: 0,
    userMessages: 0,
    assistantText: 0,
    assistantReasoning: 0,
    toolCalls: 0,
    toolResults: 0,
    skeleton: 0,
  };
}

/**
 * Builds the send window for one model request with fidelity-preserving,
 * deterministic compression (no model call). Keeps system, the current turn,
 * all user messages, and failed tool results in full; fits recent history
 * within the token budget; skeletonizes older groups (preserving tool
 * names/paths/outcomes and errors) instead of dropping them. Full originals
 * remain in the Session event log and can be recalled.
 */
export function buildModelContext(input: BuildContextInput): BuildContextResult {
  const categories = zeroCategories();
  const { budget, tools, history, system, maxToolResultTokens } = input;

  categories.system = system.reduce((sum, message) => sum + messageTokens(message), 0);
  categories.tools = estimateToolsTokens(tools);

  const windowTokens = Math.max(0, Math.floor(budget.windowTokens));
  const usable = Math.floor(windowTokens * (1 - budget.marginRatio)) - budget.reserveOutputTokens;
  const available = usable - categories.system - categories.tools;

  // Pin the current turn: the last user message onward.
  let pinStart = history.length;
  for (let index = history.length - 1; index >= 0; index -= 1) {
    if (history[index]!.role === 'user') {
      pinStart = index;
      break;
    }
  }
  const pinned = history.slice(pinStart);
  const older = history.slice(0, pinStart);

  let trimmed = false;
  const accountFull = (message: Message): Message => {
    if (message.role === 'tool') {
      const result = truncateToolMessage(message, maxToolResultTokens);
      trimmed = trimmed || result.truncated;
      categories.toolResults += messageTokens(result.message);
      return result.message;
    }
    if (message.role === 'user') {
      categories.userMessages += messageTokens(message);
      return message;
    }
    if (message.role === 'assistant') {
      categories.assistantText += messageOverheadTokens + estimateTokens(textOf(message));
      for (const call of message.toolCalls ?? []) {
        categories.toolCalls +=
          estimateTokens(call.name) + estimateTokens(call.arguments) + messageOverheadTokens;
      }
      return message;
    }
    categories.toolResults += messageTokens(message);
    return message;
  };

  const pinnedTokens = pinned.reduce((sum, message) => sum + messageTokens(message), 0);
  const overflow = available <= 0 || pinnedTokens > available;

  // Fit older groups newest-first within the remaining budget.
  const groups = groupHistory(older);
  let remaining = Math.max(0, available - pinnedTokens);
  const keepFromIndex = (() => {
    let index = groups.length;
    for (let i = groups.length - 1; i >= 0; i -= 1) {
      const cost = groups[i]!.messages.reduce((sum, message) => sum + messageTokens(message), 0);
      if (cost <= remaining) {
        remaining -= cost;
        index = i;
      } else {
        break;
      }
    }
    return index;
  })();

  const compressed = groups.slice(0, keepFromIndex);
  const kept = groups.slice(keepFromIndex);

  const messages: Message[] = [];
  if (compressed.length > 0) {
    trimmed = true;
    const skeletonText = renderSkeleton(compressed);
    categories.skeleton = messageOverheadTokens + estimateTokens(skeletonText);
    messages.push({ role: 'user', content: [{ type: 'text', text: skeletonText }] });
  }
  for (const group of kept) {
    for (const message of group.messages) {
      messages.push(accountFull(message));
    }
  }
  for (const message of pinned) {
    messages.push(accountFull(message));
  }

  const sentTokens =
    categories.system +
    categories.tools +
    categories.userMessages +
    categories.assistantText +
    categories.assistantReasoning +
    categories.toolCalls +
    categories.toolResults +
    categories.skeleton;

  const breakdown: ContextBreakdown = {
    windowTokens,
    sentTokens,
    ratio: windowTokens === 0 ? 0 : Math.min(1, sentTokens / windowTokens),
    trimmed,
    categories,
  };

  return { messages, breakdown, overflow };
}
