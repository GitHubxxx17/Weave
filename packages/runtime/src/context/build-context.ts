import type { ContextBreakdown, ContextCategoryBreakdown, Message } from '@weave/protocol';
import type { ToolDefinition } from '@weave/protocol';
import { estimateMessageTokens, estimateTokens, estimateToolsTokens } from './token-estimate.js';

/** Budget inputs for assembling one model request's send window. */
export interface ContextBudget {
  /** Model context window in tokens. */
  readonly windowTokens: number;
  /** Tokens reserved for the model's output. */
  readonly reserveOutputTokens: number;
  /** Safety margin as a fraction of the window (e.g. 0.05). */
  readonly marginRatio: number;
}

/** Total estimated input budget after output reserve and the safety margin. */
export function usableContextTokens(budget: ContextBudget): number {
  const windowTokens = Math.max(0, Math.floor(budget.windowTokens));
  return Math.floor(windowTokens * (1 - budget.marginRatio)) - budget.reserveOutputTokens;
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
  /** Known durable statuses keyed by the exact history message objects. */
  readonly toolResultStatuses?: ReadonlyMap<Message, 'completed' | 'failed'>;
}

export interface BuildContextResult {
  /** Messages to send (system excluded; caller prepends system). */
  readonly messages: readonly Message[];
  readonly breakdown: ContextBreakdown;
  /** The final faithful candidate exceeds the usable estimated request budget. */
  readonly overflow: boolean;
}

const skeletonMarker =
  '[以下为更早对话的压缩摘要，关键信息已保留；完整原文可用 recall 工具按 toolCallId 或 path 取回]';

/** Concatenated text of a message's text blocks (reasoning is never sent). */
function textOf(message: Message): string {
  return message.content
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('');
}

/**
 * Pulls the target of a tool call out of its JSON arguments, when present:
 * a search `pattern`, else the `path`, else a shortened shell `command`.
 */
function toolCallPath(argumentsText: string): string | undefined {
  try {
    const parsed = JSON.parse(argumentsText) as unknown;
    if (typeof parsed !== 'object' || parsed === null) {
      return undefined;
    }
    const record = parsed as Record<string, unknown>;
    for (const key of ['pattern', 'path', 'command'] as const) {
      const value = record[key];
      if (typeof value === 'string' && value !== '') {
        return value.length > 80 ? `${value.slice(0, 80)}…` : value;
      }
    }
  } catch {
    return undefined;
  }
  return undefined;
}

/** Bound both retained ends and the omission notice with the same estimator. */
function truncateToTokens(text: string, maxTokens: number): { text: string; truncated: boolean } {
  if (estimateTokens(text) <= maxTokens) return { text, truncated: false };
  const characters = Array.from(text);
  const render = (retained: number): string => {
    const head = Math.min(retained - 1, Math.ceil(retained * 0.6));
    const tail = retained - head;
    return `${characters.slice(0, head).join('')}\n…省略 ${characters.length - retained} 字符…\n${characters.slice(characters.length - tail).join('')}`;
  };
  // If the notice and at least one character at each end cannot fit, retain
  // the original; the whole-request gate must fail rather than hide content.
  if (characters.length < 3 || estimateTokens(render(2)) > maxTokens) {
    return { text, truncated: false };
  }
  let low = 2;
  let high = characters.length - 1;
  let best = render(2);
  while (low <= high) {
    const retained = Math.floor((low + high) / 2);
    const candidate = render(retained);
    if (estimateTokens(candidate) <= maxTokens) {
      best = candidate;
      low = retained + 1;
    } else {
      high = retained - 1;
    }
  }
  return { text: best, truncated: true };
}

function withoutReasoning(message: Message): Message {
  return { ...message, content: message.content.filter((part) => part.type !== 'reasoning') };
}

/** Never replace images or protected failure text with a text-only result. */
function truncateToolMessage(message: Message, maxTokens: number): Message {
  if (message.content.some((part) => part.type !== 'text')) return message;
  const result = truncateToTokens(textOf(message), maxTokens);
  return result.truncated
    ? { ...message, content: [{ type: 'text', text: result.text }] }
    : message;
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
      const callIds = new Set(message.toolCalls?.map((call) => call.id));
      const resultIds = messages
        .slice(1)
        .map((result) => (result.role === 'tool' ? result.toolCallId : ''));
      const paired =
        callIds.size === message.toolCalls?.length &&
        resultIds.length === callIds.size &&
        new Set(resultIds).size === resultIds.length &&
        resultIds.every((id) => callIds.has(id));
      groups.push({ kind: paired ? 'tool-cycle' : 'orphan', messages });
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

/** Text-only older groups can be replaced together, never individual results. */
function renderSkeleton(group: Group, failedMessages: ReadonlySet<Message>): Message | undefined {
  if (
    group.kind === 'user' ||
    group.kind === 'orphan' ||
    group.messages.some((message) => message.content.some((part) => part.type !== 'text'))
  ) {
    return undefined;
  }
  const lines: string[] = [];
  const assistant = group.messages[0]!;
  if (group.kind === 'tool-cycle' && assistant.role === 'assistant') {
    for (const call of assistant.toolCalls ?? []) {
      const result = group.messages.find(
        (message) => message.role === 'tool' && message.toolCallId === call.id,
      );
      const path = toolCallPath(call.arguments);
      const head = `· ${call.name}${path === undefined ? '' : ` ${path}`}`;
      if (result === undefined) return undefined;
      lines.push(
        failedMessages.has(result)
          ? `${head} ✗ ${textOf(result)} [recall id=${call.id}]`
          : `${head} ✓ ${textOf(result).length}字符 [recall id=${call.id}]`,
      );
    }
  }
  const text = textOf(assistant);
  if (text !== '') lines.push(`助手：${truncateToTokens(text, 60).text}`);
  if (lines.length === 0) return undefined;
  return { role: 'user', content: [{ type: 'text', text: lines.join('\n') }] };
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
 * deterministic compression (no model call). Keeps system, all user content,
 * and failed tool results in full; only successful current tool results can
 * use the explicit head/tail threshold. Fits recent history
 * within the token budget; skeletonizes older groups (preserving tool
 * names/paths/outcomes and errors) instead of dropping them. Full originals
 * remain in the Session event log and can be recalled.
 */
export function buildModelContext(input: BuildContextInput): BuildContextResult {
  const categories = zeroCategories();
  const { budget, tools, system, maxToolResultTokens } = input;
  const failedMessages = new Set<Message>();
  const history = input.history.map((original) => {
    const message = withoutReasoning(original);
    const status = input.toolResultStatuses?.get(original);
    if (
      original.role === 'tool' &&
      (status === undefined ? /failed|error|rejected/i.test(textOf(original)) : status === 'failed')
    ) {
      failedMessages.add(message);
    }
    return message;
  });
  let truncated = false;
  const fullMessage = (message: Message): Message => {
    const result =
      message.role === 'tool' && !failedMessages.has(message)
        ? truncateToolMessage(message, maxToolResultTokens)
        : message;
    truncated = truncated || result !== message;
    return result;
  };
  const tokens = (messages: readonly Message[]): number =>
    messages.reduce((sum, message) => sum + estimateMessageTokens(message), 0);

  categories.system = tokens(system);
  categories.tools = estimateToolsTokens(tools);
  const fixedTokens = categories.system + categories.tools;
  const windowTokens = Math.max(0, Math.floor(budget.windowTokens));
  const usable = usableContextTokens(budget);
  let pinStart = history.length;
  for (let index = history.length - 1; index >= 0; index -= 1) {
    if (history[index]!.role === 'user') {
      pinStart = index;
      break;
    }
  }
  const pinned = history.slice(pinStart).map(fullMessage);
  const groups = groupHistory(history.slice(0, pinStart)).map((group) => {
    const full = group.messages.map(fullMessage);
    const skeleton = renderSkeleton(group, failedMessages);
    const fullTokens = tokens(full);
    const skeletonTokens = skeleton === undefined ? fullTokens : estimateMessageTokens(skeleton);
    return { full, fullTokens, skeleton, skeletonTokens, compressed: false };
  });
  const marker: Message = { role: 'user', content: [{ type: 'text', text: skeletonMarker }] };
  const markerTokens = estimateMessageTokens(marker);
  let total =
    fixedTokens + tokens(pinned) + groups.reduce((sum, group) => sum + group.fullTokens, 0);
  if (total > usable) {
    // Reserve the complete minimum candidate, including the global marker,
    // before spending any remaining budget on recent full groups.
    let compressedCount = 0;
    for (const group of groups) {
      if (group.skeleton !== undefined && group.skeletonTokens < group.fullTokens) {
        group.compressed = true;
        compressedCount += 1;
        total += group.skeletonTokens - group.fullTokens;
      }
    }
    if (compressedCount > 0) total += markerTokens;
    for (let index = groups.length - 1; index >= 0; index -= 1) {
      const group = groups[index]!;
      if (!group.compressed) continue;
      const restoredTotal =
        total +
        group.fullTokens -
        group.skeletonTokens -
        (compressedCount === 1 ? markerTokens : 0);
      if (restoredTotal <= usable) {
        group.compressed = false;
        compressedCount -= 1;
        total = restoredTotal;
      }
    }
  }

  const messages: Message[] = [];
  const skeletonMessages = new Set<Message>();
  if (groups.some((group) => group.compressed)) {
    messages.push(marker);
    skeletonMessages.add(marker);
  }
  for (const group of groups) {
    if (group.compressed && group.skeleton !== undefined) {
      messages.push(group.skeleton);
      skeletonMessages.add(group.skeleton);
    } else messages.push(...group.full);
  }
  messages.push(...pinned);

  for (const message of messages) {
    const cost = estimateMessageTokens(message);
    if (skeletonMessages.has(message)) categories.skeleton += cost;
    else if (message.role === 'user') categories.userMessages += cost;
    else if (message.role === 'system') categories.system += cost;
    else if (message.role === 'tool') categories.toolResults += cost;
    else {
      const textCost = estimateMessageTokens({ ...message, toolCalls: [] });
      categories.assistantText += textCost;
      categories.toolCalls += cost - textCost;
    }
  }
  const sentTokens = fixedTokens + tokens(messages);
  const trimmed = groups.some((group) => group.compressed) || truncated;
  return {
    messages,
    breakdown: {
      windowTokens,
      sentTokens,
      ratio: windowTokens === 0 ? 0 : Math.min(1, sentTokens / windowTokens),
      trimmed,
      categories,
    },
    overflow: !(sentTokens <= usable),
  };
}
