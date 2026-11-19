import { llmRequestSchema, streamEventSchema } from '@weave/protocol';
import type { LlmRequest, Message, StreamEvent, ToolMessage } from '@weave/protocol';
import type { LlmClient } from './client.js';
import { createLlmError } from './errors.js';
import type { LlmStreamOptions } from './types.js';

function abortError(): DOMException {
  return new DOMException('The operation was aborted', 'AbortError');
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw abortError();
  }
}

function wait(delayMs: number, signal: AbortSignal | undefined): Promise<void> {
  throwIfAborted(signal);

  return new Promise((resolve, reject) => {
    const cleanup = (): void => {
      signal?.removeEventListener('abort', onAbort);
    };
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, delayMs);
    const onAbort = (): void => {
      clearTimeout(timer);
      cleanup();
      reject(abortError());
    };

    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function validateDelay(delayMs: number): void {
  if (!Number.isFinite(delayMs) || delayMs < 0) {
    throw new RangeError('delayMs must be a finite non-negative number');
  }
}

/** Emits validated events in order, honouring the delay and cancellation. */
async function* replay(
  events: readonly StreamEvent[],
  delayMs: number,
  signal: AbortSignal | undefined,
): AsyncIterable<StreamEvent> {
  for (const event of events) {
    throwIfAborted(signal);
    if (delayMs > 0) {
      await wait(delayMs, signal);
    }
    throwIfAborted(signal);
    const result = streamEventSchema.safeParse(event);
    if (!result.success) {
      throw createLlmError({
        code: 'protocol',
        message: 'Mock provider script contains an invalid stream event',
        provider: 'mock',
      });
    }
    yield event;
  }
}

/**
 * Creates a deterministic LLM client for local development and tests.
 *
 * The client replays a validated event script instead of contacting a real
 * provider. Optional delays make cancellation and streaming behavior
 * observable without introducing network-dependent tests.
 *
 * @param script Normalized events to emit in order.
 * @param options Optional delay between emitted events.
 * @returns An LLM client that replays the supplied script.
 */
export function createMockLlmClient(
  script: readonly StreamEvent[],
  options?: { readonly delayMs?: number },
): LlmClient {
  const delayMs = options?.delayMs ?? 0;
  validateDelay(delayMs);

  return {
    async *stream(
      request: LlmRequest,
      streamOptions?: LlmStreamOptions,
    ): AsyncIterable<StreamEvent> {
      llmRequestSchema.parse(request);
      yield* replay(script, delayMs, streamOptions?.signal);
    },
  };
}

/** Options for {@link createToolCommandMockLlmClient}. */
export interface ToolCommandMockOptions {
  /** Events replayed for requests that are neither `/tool` commands nor tool results. */
  readonly fallback: readonly StreamEvent[];
  /** Optional delay between emitted events. */
  readonly delayMs?: number;
}

interface ToolCommand {
  readonly name: string;
  readonly argumentsText: string;
}

const toolCommandLinePattern = /^\/tool(?:\s+(.*))?$/;
const toolNamePattern = /^[A-Za-z0-9_.-]+$/;
const maxSummaryLineLength = 160;
const mockLabel = '（本地演示）';
const usageLines = [
  '格式：/tool 工具名 JSON参数，一行一个调用；参数写在同一行，换行写成 \\n。例如：',
  '/tool run_command {"command":"echo hello"}',
];

function messageText(message: Message): string {
  return message.content
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('');
}

/** Reads `/tool <name> [json]` lines; other lines are ignored. */
function parseToolCommands(text: string): {
  readonly commands: readonly ToolCommand[];
  readonly invalid: readonly string[];
} {
  const commands: ToolCommand[] = [];
  const invalid: string[] = [];
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    const match = toolCommandLinePattern.exec(line);
    if (match === null) {
      continue;
    }
    const rest = (match[1] ?? '').trim();
    const separator = rest.search(/\s/);
    const name = separator === -1 ? rest : rest.slice(0, separator);
    const argumentsText = separator === -1 ? '' : rest.slice(separator).trim();
    if (!toolNamePattern.test(name)) {
      invalid.push(line);
      continue;
    }
    commands.push({ name, argumentsText: argumentsText === '' ? '{}' : argumentsText });
  }
  return { commands, invalid };
}

function firstLine(text: string): string {
  const line =
    text
      .split('\n')
      .map((part) => part.trim())
      .find((part) => part !== '') ?? '';
  if (line === '') {
    return '（没有内容）';
  }
  return line.length > maxSummaryLineLength ? `${line.slice(0, maxSummaryLineLength)}…` : line;
}

/** Summarizes the tool results that end the conversation, when it ends with any. */
function summarizeTrailingToolResults(messages: readonly Message[]): string | undefined {
  const results: ToolMessage[] = [];
  let index = messages.length - 1;
  while (index >= 0) {
    const message = messages[index];
    if (message === undefined || message.role !== 'tool') {
      break;
    }
    results.unshift(message);
    index -= 1;
  }
  if (results.length === 0) {
    return undefined;
  }

  const names = new Map<string, string>();
  const assistant = messages[index];
  if (assistant?.role === 'assistant') {
    for (const call of assistant.toolCalls ?? []) {
      names.set(call.id, call.name);
    }
  }
  return [
    `${mockLabel}收到 ${results.length} 个工具结果：`,
    ...results.map(
      (result) =>
        `- ${names.get(result.toolCallId) ?? result.toolCallId}：${firstLine(messageText(result))}`,
    ),
  ].join('\n');
}

function textReply(text: string): readonly StreamEvent[] {
  return [
    { type: 'text-delta', text },
    { type: 'finish', reason: 'stop' },
  ];
}

function toolCallReply(commands: readonly ToolCommand[]): readonly StreamEvent[] {
  const events: StreamEvent[] = [];
  for (const command of commands) {
    const id = `mock-call-${crypto.randomUUID()}`;
    events.push({ type: 'tool-call-start', id, name: command.name });
    events.push({ type: 'tool-call-delta', id, argumentsDelta: command.argumentsText });
  }
  events.push({ type: 'finish', reason: 'tool-call' });
  return events;
}

function planReply(request: LlmRequest, fallback: readonly StreamEvent[]): readonly StreamEvent[] {
  const summary = summarizeTrailingToolResults(request.messages);
  if (summary !== undefined) {
    return textReply(summary);
  }
  const last = request.messages.at(-1);
  if (last?.role !== 'user') {
    return fallback;
  }
  const { commands, invalid } = parseToolCommands(messageText(last));
  if (commands.length === 0 && invalid.length === 0) {
    return fallback;
  }
  if (invalid.length > 0) {
    return textReply(
      [`${mockLabel}无法识别这些 /tool 指令：`, ...invalid, '', ...usageLines].join('\n'),
    );
  }
  if (request.tools === undefined) {
    return textReply(`${mockLabel}本轮没有可用的工具，/tool 指令无法执行。`);
  }
  return toolCallReply(commands);
}

/**
 * Creates a mock client that can call tools on request, for testing tool and
 * Approval flows without a real model.
 *
 * When the latest user message contains lines of the form
 * `/tool <name> [json arguments]`, it emits one tool call per line (the
 * arguments are passed through verbatim, `{}` when omitted). When the request
 * ends with tool results, it replies with one summary line per result. Any
 * other request replays `fallback`, exactly like {@link createMockLlmClient}.
 *
 * @param options Fallback script and optional delay between events.
 * @returns An LLM client for local development and tests.
 */
export function createToolCommandMockLlmClient(options: ToolCommandMockOptions): LlmClient {
  const delayMs = options.delayMs ?? 0;
  validateDelay(delayMs);

  return {
    async *stream(
      request: LlmRequest,
      streamOptions?: LlmStreamOptions,
    ): AsyncIterable<StreamEvent> {
      llmRequestSchema.parse(request);
      yield* replay(planReply(request, options.fallback), delayMs, streamOptions?.signal);
    },
  };
}
