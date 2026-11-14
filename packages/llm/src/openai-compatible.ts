import { llmRequestSchema } from '@weave/protocol';
import type { FinishReason, LlmRequest, LlmError, StreamEvent, TokenUsage } from '@weave/protocol';
import { z } from 'zod';
import type { LlmClient } from './client.js';
import { createLlmError } from './errors.js';
import { createSseParserState, flushSseParser, pushSseChunk } from './sse-parser.js';
import type { LlmStreamOptions } from './types.js';

export interface OpenAiCompatibleClientOptions {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly defaultTimeoutMs?: number;
}

interface ProviderMessage {
  readonly role: string;
  readonly content: string;
  readonly tool_calls?: readonly ProviderToolCall[];
  readonly tool_call_id?: string;
}

interface ProviderToolCall {
  readonly id: string;
  readonly type: 'function';
  readonly function: {
    readonly name: string;
    readonly arguments: string;
  };
}

const providerToolCallSchema = z
  .object({
    id: z.string().optional(),
    index: z.number().int().nonnegative().optional(),
    function: z
      .object({
        name: z.string().optional(),
        arguments: z.string().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

const providerChoiceSchema = z
  .object({
    delta: z
      .object({
        content: z.string().optional(),
        reasoning_content: z.string().optional(),
        tool_calls: z.array(providerToolCallSchema).optional(),
      })
      .passthrough()
      .optional(),
    finish_reason: z.string().nullable().optional(),
  })
  .passthrough();

const providerUsageSchema = z
  .object({
    prompt_tokens: z.number().int().nonnegative().safe().optional(),
    completion_tokens: z.number().int().nonnegative().safe().optional(),
    total_tokens: z.number().int().nonnegative().safe().optional(),
  })
  .passthrough();

const providerChunkSchema = z
  .object({
    choices: z.array(providerChoiceSchema),
    usage: providerUsageSchema.optional(),
  })
  .passthrough();

const maxDiagnosticLength = 4_000;

function validateTimeout(timeoutMs: number | undefined): void {
  if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs < 0)) {
    throw new RangeError('timeoutMs must be a finite non-negative number');
  }
}

function contentToText(content: LlmRequest['messages'][number]['content']): string {
  return content.map((part) => part.text).join('');
}

function toProviderMessage(message: LlmRequest['messages'][number]): ProviderMessage {
  const providerMessage: ProviderMessage = {
    role: message.role,
    content: contentToText(message.content),
  };

  if (message.role === 'assistant' && message.toolCalls !== undefined) {
    return {
      ...providerMessage,
      tool_calls: message.toolCalls.map((toolCall) => ({
        id: toolCall.id,
        type: 'function',
        function: {
          name: toolCall.name,
          arguments: toolCall.arguments,
        },
      })),
    };
  }

  if (message.role === 'tool') {
    return {
      ...providerMessage,
      tool_call_id: message.toolCallId,
    };
  }

  return providerMessage;
}

function toProviderRequest(request: LlmRequest): Record<string, unknown> {
  const providerRequest: Record<string, unknown> = {
    model: request.model,
    messages: request.messages.map(toProviderMessage),
    stream: true,
  };

  if (request.tools !== undefined) {
    providerRequest.tools = request.tools.map((tool) => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      },
    }));
  }
  if (request.temperature !== undefined) {
    providerRequest.temperature = request.temperature;
  }
  if (request.maxTokens !== undefined) {
    providerRequest.max_tokens = request.maxTokens;
  }
  if (request.reasoningEffort !== undefined) {
    providerRequest.reasoning_effort = request.reasoningEffort;
  }

  return providerRequest;
}

function createProviderError(
  code: LlmError['code'],
  message: string,
  status?: number,
  retryable?: boolean,
): LlmError {
  return createLlmError({
    code,
    message,
    provider: 'openai-compatible',
    ...(status === undefined ? {} : { status }),
    ...(retryable === undefined ? {} : { retryable }),
  });
}

function isLlmError(error: unknown): error is LlmError {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string' &&
    'message' in error &&
    typeof error.message === 'string'
  );
}

function redactSecret(message: string, secret: string): string {
  return secret.length === 0 ? message : message.split(secret).join('[redacted]');
}

async function readDiagnosticBody(response: Response): Promise<string> {
  if (response.body === null) {
    return '';
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let diagnostic = '';

  try {
    while (diagnostic.length < maxDiagnosticLength) {
      const { done, value } = await reader.read();
      if (done) {
        diagnostic += decoder.decode();
        break;
      }

      const remaining = maxDiagnosticLength - diagnostic.length;
      diagnostic += decoder.decode(value.slice(0, remaining), { stream: true });
      if (value.byteLength > remaining) {
        await reader.cancel();
        break;
      }
    }
  } finally {
    reader.releaseLock();
  }

  return diagnostic.slice(0, maxDiagnosticLength);
}

function classifyHttpStatus(status: number): {
  readonly code: LlmError['code'];
  readonly retryable: boolean;
} {
  if (status === 401 || status === 403) {
    return { code: 'authentication', retryable: false };
  }
  if (status === 429) {
    return { code: 'rate-limit', retryable: true };
  }
  if (status === 400 || status === 422) {
    return { code: 'invalid-request', retryable: false };
  }
  if (status === 413) {
    return { code: 'context-overflow', retryable: false };
  }
  if (status >= 500) {
    return { code: 'provider', retryable: true };
  }
  return { code: 'provider', retryable: false };
}

function mapFinishReason(reason: string): FinishReason {
  switch (reason) {
    case 'stop':
      return 'stop';
    case 'tool_calls':
    case 'function_call':
    case 'tool_call':
      return 'tool-call';
    case 'length':
      return 'length';
    case 'content_filter':
      return 'content-filter';
    default:
      return 'unknown';
  }
}

function toTokenUsage(usage: z.infer<typeof providerUsageSchema>): TokenUsage {
  return {
    ...(usage.prompt_tokens === undefined ? {} : { inputTokens: usage.prompt_tokens }),
    ...(usage.completion_tokens === undefined ? {} : { outputTokens: usage.completion_tokens }),
    ...(usage.total_tokens === undefined ? {} : { totalTokens: usage.total_tokens }),
  };
}

function parseProviderChunk(
  data: string,
  toolCallIds: Map<number, string>,
  toolCallNames: Map<number, string>,
  startedToolCalls: Set<number>,
): StreamEvent[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    throw createProviderError('protocol', 'Provider returned invalid JSON');
  }

  const result = providerChunkSchema.safeParse(parsed);
  if (!result.success) {
    throw createProviderError('protocol', 'Provider returned an invalid response chunk');
  }

  const choice = result.data.choices?.[0];
  if (choice === undefined) {
    return [];
  }

  const events: StreamEvent[] = [];
  const delta = choice.delta;
  if (delta?.content !== undefined) {
    events.push({ type: 'text-delta', text: delta.content });
  }
  if (delta?.reasoning_content !== undefined) {
    events.push({ type: 'reasoning-delta', text: delta.reasoning_content });
  }

  for (const [position, toolCall] of (delta?.tool_calls ?? []).entries()) {
    const index = toolCall.index ?? position;
    if (toolCall.id !== undefined) {
      toolCallIds.set(index, toolCall.id);
    }
    const functionName = toolCall.function?.name;
    if (functionName !== undefined) {
      toolCallNames.set(index, functionName);
    }

    const id = toolCallIds.get(index);
    const name = toolCallNames.get(index);
    if (id !== undefined && name !== undefined && !startedToolCalls.has(index)) {
      startedToolCalls.add(index);
      events.push({ type: 'tool-call-start', id, name });
    }
    const argumentsDelta = toolCall.function?.arguments;
    if (id !== undefined && argumentsDelta !== undefined) {
      events.push({ type: 'tool-call-delta', id, argumentsDelta });
    }
  }

  if (choice.finish_reason !== undefined && choice.finish_reason !== null) {
    const usage = result.data.usage;
    events.push({
      type: 'finish',
      reason: mapFinishReason(choice.finish_reason),
      ...(usage === undefined ? {} : { usage: toTokenUsage(usage) }),
    });
  }

  return events;
}

function parseFrames(
  frames: readonly { readonly data: string }[],
  toolCallIds: Map<number, string>,
  toolCallNames: Map<number, string>,
  startedToolCalls: Set<number>,
): { readonly events: StreamEvent[]; readonly done: boolean } {
  const events: StreamEvent[] = [];
  for (const frame of frames) {
    if (frame.data === '[DONE]') {
      return { events, done: true };
    }
    events.push(...parseProviderChunk(frame.data, toolCallIds, toolCallNames, startedToolCalls));
  }
  return { events, done: false };
}

export function createOpenAiCompatibleClient(options: OpenAiCompatibleClientOptions): LlmClient {
  validateTimeout(options.defaultTimeoutMs);
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const endpoint = `${options.baseUrl.replace(/\/+$/, '')}/chat/completions`;

  return {
    async *stream(
      request: LlmRequest,
      streamOptions?: LlmStreamOptions,
    ): AsyncIterable<StreamEvent> {
      llmRequestSchema.parse(request);
      validateTimeout(streamOptions?.timeoutMs);

      const timeoutMs = streamOptions?.timeoutMs ?? options.defaultTimeoutMs;
      const controller = new AbortController();
      const externalSignal = streamOptions?.signal;
      let timedOut = false;
      const onAbort = (): void => controller.abort();
      if (externalSignal !== undefined) {
        if (externalSignal.aborted) {
          controller.abort();
        } else {
          externalSignal.addEventListener('abort', onAbort, { once: true });
        }
      }
      const timer =
        timeoutMs === undefined
          ? undefined
          : setTimeout(() => {
              timedOut = true;
              controller.abort();
            }, timeoutMs);

      try {
        let response: Response;
        try {
          response = await fetchImpl(endpoint, {
            method: 'POST',
            headers: {
              authorization: `Bearer ${options.apiKey}`,
              'content-type': 'application/json',
            },
            body: JSON.stringify(toProviderRequest(request)),
            signal: controller.signal,
          });
        } catch (error) {
          if (timedOut) {
            throw createProviderError('timeout', 'Provider request timed out');
          }
          if (externalSignal?.aborted) {
            throw createProviderError('cancelled', 'Provider request was cancelled');
          }
          throw createProviderError(
            'network',
            error instanceof Error ? error.message : 'Provider request failed',
          );
        }

        if (timedOut) {
          throw createProviderError('timeout', 'Provider request timed out');
        }
        if (externalSignal?.aborted) {
          throw createProviderError('cancelled', 'Provider request was cancelled');
        }

        if (!response.ok) {
          const classification = classifyHttpStatus(response.status);
          const diagnostic = redactSecret(await readDiagnosticBody(response), options.apiKey);
          const statusText = response.statusText.trim();
          const message = [
            `Provider request failed with HTTP ${response.status}`,
            statusText === '' ? undefined : statusText,
            diagnostic === '' ? undefined : diagnostic,
          ]
            .filter((part): part is string => part !== undefined)
            .join(': ');
          throw createProviderError(
            classification.code,
            message,
            response.status,
            classification.retryable,
          );
        }

        if (response.body === null) {
          throw createProviderError('protocol', 'Provider response did not include a body');
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let parserState = createSseParserState();
        const toolCallIds = new Map<number, string>();
        const toolCallNames = new Map<number, string>();
        const startedToolCalls = new Set<number>();

        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) {
              break;
            }
            const pushed = pushSseChunk(parserState, decoder.decode(value, { stream: true }));
            parserState = pushed.state;
            const parsed = parseFrames(pushed.frames, toolCallIds, toolCallNames, startedToolCalls);
            for (const event of parsed.events) {
              yield event;
            }
            if (parsed.done) {
              return;
            }
          }

          const decodedTail = decoder.decode();
          if (decodedTail !== '') {
            const pushed = pushSseChunk(parserState, decodedTail);
            parserState = pushed.state;
            const parsed = parseFrames(pushed.frames, toolCallIds, toolCallNames, startedToolCalls);
            for (const event of parsed.events) {
              yield event;
            }
            if (parsed.done) {
              return;
            }
          }

          const flushed = flushSseParser(parserState);
          const parsed = parseFrames(flushed.frames, toolCallIds, toolCallNames, startedToolCalls);
          for (const event of parsed.events) {
            yield event;
          }
        } finally {
          reader.releaseLock();
        }
      } catch (error) {
        if (isLlmError(error)) {
          throw error;
        }
        if (timedOut) {
          throw createProviderError('timeout', 'Provider request timed out');
        }
        if (externalSignal?.aborted) {
          throw createProviderError('cancelled', 'Provider request was cancelled');
        }
        throw createProviderError(
          'network',
          error instanceof Error ? error.message : 'Provider stream failed',
        );
      } finally {
        if (timer !== undefined) {
          clearTimeout(timer);
        }
        externalSignal?.removeEventListener('abort', onAbort);
      }
    },
  };
}
