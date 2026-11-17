import { llmRequestSchema } from '@weave/protocol';
import type { FinishReason, LlmRequest, LlmError, StreamEvent, TokenUsage } from '@weave/protocol';
import { z } from 'zod';
import type { LlmClient } from './client.js';
import { createLlmError } from './errors.js';
import { createSseParserState, flushSseParser, pushSseChunk } from './sse-parser.js';
import type { LlmStreamOptions } from './types.js';

export interface OpenAiCompatibleClientOptions {
  /** Base URL of the provider's OpenAI-compatible API. */
  readonly baseUrl: string;
  /** Secret used for the provider Authorization header. */
  readonly apiKey: string;
  /** Injectable fetch implementation for tests and alternate runtimes. */
  readonly fetch?: typeof globalThis.fetch;
  /** Default timeout applied when a stream does not provide one. */
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
        content: z.string().nullable().optional(),
        reasoning_content: z.string().nullable().optional(),
        tool_calls: z.array(providerToolCallSchema).optional(),
      })
      .passthrough()
      .optional(),
    finish_reason: z.string().nullable().optional(),
  })
  .passthrough();

const tokenCountSchema = z.number().int().nonnegative().safe();

const providerUsageSchema = z
  .object({
    prompt_tokens: tokenCountSchema.optional(),
    completion_tokens: tokenCountSchema.optional(),
    total_tokens: tokenCountSchema.optional(),
    prompt_cache_hit_tokens: tokenCountSchema.optional(),
    prompt_cache_miss_tokens: tokenCountSchema.optional(),
    prompt_tokens_details: z
      .object({ cached_tokens: tokenCountSchema.nullable().optional() })
      .passthrough()
      .nullable()
      .optional(),
    completion_tokens_details: z
      .object({ reasoning_tokens: tokenCountSchema.nullable().optional() })
      .passthrough()
      .nullable()
      .optional(),
  })
  .passthrough();

const providerChunkSchema = z
  .object({
    choices: z.array(providerChoiceSchema),
    usage: providerUsageSchema.nullable().optional(),
  })
  .passthrough();

const maxDiagnosticLength = 4_000;
const adapterErrorMarker = Symbol('openai-compatible-adapter-error');

interface AdapterLlmError extends LlmError {
  readonly [adapterErrorMarker]: true;
}

interface ToolCallState {
  id: string | undefined;
  name: string | undefined;
  readonly argumentDeltas: string[];
  started: boolean;
}

interface StreamParseState {
  readonly toolCalls: Map<number, ToolCallState>;
  finishReason: FinishReason | undefined;
  usage: TokenUsage | undefined;
  finishEmitted: boolean;
}

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
    // Without this OpenAI-compatible APIs omit usage from streamed responses.
    stream_options: { include_usage: true },
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
  apiKey?: string,
): AdapterLlmError {
  const error = createLlmError({
    code,
    message: redactSecret(message, apiKey ?? ''),
    provider: 'openai-compatible',
    ...(status === undefined ? {} : { status }),
    ...(retryable === undefined ? {} : { retryable }),
  });
  Object.defineProperty(error, adapterErrorMarker, { value: true });
  return error as AdapterLlmError;
}

function isAdapterError(error: unknown): error is AdapterLlmError {
  return typeof error === 'object' && error !== null && adapterErrorMarker in error;
}

function redactSecret(message: string, secret: string): string {
  return secret.length === 0 ? message : message.split(secret).join('[redacted]');
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === 'string') {
    return error;
  }
  return 'Provider request failed';
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

function createStreamParseState(): StreamParseState {
  return {
    toolCalls: new Map(),
    finishReason: undefined,
    usage: undefined,
    finishEmitted: false,
  };
}

/**
 * Maps provider usage to the protocol contract.
 *
 * Cache hits come from DeepSeek's `prompt_cache_hit_tokens` or OpenAI's
 * `prompt_tokens_details.cached_tokens`; reasoning tokens from
 * `completion_tokens_details.reasoning_tokens`. Fields a provider omits stay
 * absent instead of becoming zero.
 */
function toTokenUsage(usage: z.infer<typeof providerUsageSchema>): TokenUsage {
  const cacheRead =
    usage.prompt_cache_hit_tokens ?? usage.prompt_tokens_details?.cached_tokens ?? undefined;
  const reasoning = usage.completion_tokens_details?.reasoning_tokens ?? undefined;
  return {
    ...(usage.prompt_tokens === undefined ? {} : { inputTokens: usage.prompt_tokens }),
    ...(usage.completion_tokens === undefined ? {} : { outputTokens: usage.completion_tokens }),
    ...(usage.total_tokens === undefined ? {} : { totalTokens: usage.total_tokens }),
    ...(cacheRead === undefined || cacheRead === null ? {} : { cacheReadTokens: cacheRead }),
    ...(reasoning === undefined || reasoning === null ? {} : { reasoningTokens: reasoning }),
  };
}

function parseProviderChunk(data: string, state: StreamParseState, apiKey: string): StreamEvent[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    throw createProviderError(
      'protocol',
      'Provider returned invalid JSON',
      undefined,
      undefined,
      apiKey,
    );
  }

  const result = providerChunkSchema.safeParse(parsed);
  if (!result.success) {
    throw createProviderError(
      'protocol',
      'Provider returned an invalid response chunk',
      undefined,
      undefined,
      apiKey,
    );
  }

  if (result.data.usage !== undefined && result.data.usage !== null) {
    state.usage = toTokenUsage(result.data.usage);
  }

  const choice = result.data.choices?.[0];
  if (choice === undefined) {
    return [];
  }

  const events: StreamEvent[] = [];
  const delta = choice.delta;
  if (delta?.content !== undefined && delta.content !== null) {
    events.push({ type: 'text-delta', text: delta.content });
  }
  if (delta?.reasoning_content !== undefined && delta.reasoning_content !== null) {
    events.push({ type: 'reasoning-delta', text: delta.reasoning_content });
  }

  // Provider tool calls arrive as indexed fragments. Keep one state object per
  // index so an ID, name, and argument JSON can be assembled independently.
  for (const [position, toolCall] of (delta?.tool_calls ?? []).entries()) {
    const index = toolCall.index ?? position;
    const toolCallState = state.toolCalls.get(index) ?? {
      id: undefined,
      name: undefined,
      argumentDeltas: [],
      started: false,
    };
    state.toolCalls.set(index, toolCallState);

    if (toolCall.id !== undefined) {
      toolCallState.id = toolCall.id;
    }
    const functionName = toolCall.function?.name;
    if (functionName !== undefined) {
      toolCallState.name = functionName;
    }

    if (
      !toolCallState.started &&
      toolCallState.id !== undefined &&
      toolCallState.name !== undefined
    ) {
      toolCallState.started = true;
      events.push({
        type: 'tool-call-start',
        id: toolCallState.id,
        name: toolCallState.name,
      });
      for (const argumentsDelta of toolCallState.argumentDeltas) {
        events.push({
          type: 'tool-call-delta',
          id: toolCallState.id,
          argumentsDelta,
        });
      }
      toolCallState.argumentDeltas.length = 0;
    }

    const argumentsDelta = toolCall.function?.arguments;
    if (argumentsDelta !== undefined) {
      if (toolCallState.started && toolCallState.id !== undefined) {
        events.push({
          type: 'tool-call-delta',
          id: toolCallState.id,
          argumentsDelta,
        });
      } else {
        toolCallState.argumentDeltas.push(argumentsDelta);
      }
    }
  }

  if (choice.finish_reason !== undefined && choice.finish_reason !== null) {
    state.finishReason = mapFinishReason(choice.finish_reason);
  }

  return events;
}

function emitPendingFinish(state: StreamParseState, force: boolean): StreamEvent[] {
  if (state.finishEmitted) {
    return [];
  }
  if (state.finishReason === undefined && state.usage === undefined) {
    return [];
  }
  if (!force && (state.finishReason === undefined || state.usage === undefined)) {
    return [];
  }

  state.finishEmitted = true;
  return [
    {
      type: 'finish',
      reason: state.finishReason ?? 'unknown',
      ...(state.usage === undefined ? {} : { usage: state.usage }),
    },
  ];
}

function parseFrames(
  frames: readonly { readonly data: string }[],
  state: StreamParseState,
  apiKey: string,
): { readonly events: StreamEvent[]; readonly done: boolean } {
  const events: StreamEvent[] = [];
  for (const frame of frames) {
    if (frame.data === '[DONE]') {
      // [DONE] is the provider's terminal transport marker. Only here can the
      // adapter accept a stream that did not include every optional field.
      events.push(...emitPendingFinish(state, true));
      return { events, done: true };
    }
    events.push(...parseProviderChunk(frame.data, state, apiKey));
    events.push(...emitPendingFinish(state, false));
  }
  return { events, done: false };
}

/**
 * Creates an LLM client for providers implementing the OpenAI chat-completion
 * streaming shape.
 *
 * The adapter owns provider-specific request mapping, SSE decoding, response
 * validation, timeout handling, tool-call fragment assembly, and error
 * normalization. Callers only observe the provider-independent `LlmClient`
 * contract.
 *
 * @param options Provider URL, credentials, and transport controls.
 * @returns A provider-independent streaming client.
 */
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
            throw createProviderError(
              'timeout',
              'Provider request timed out',
              undefined,
              undefined,
              options.apiKey,
            );
          }
          if (externalSignal?.aborted) {
            throw createProviderError(
              'cancelled',
              'Provider request was cancelled',
              undefined,
              undefined,
              options.apiKey,
            );
          }
          throw createProviderError(
            'network',
            errorMessage(error),
            undefined,
            undefined,
            options.apiKey,
          );
        }

        if (timedOut) {
          throw createProviderError(
            'timeout',
            'Provider request timed out',
            undefined,
            undefined,
            options.apiKey,
          );
        }
        if (externalSignal?.aborted) {
          throw createProviderError(
            'cancelled',
            'Provider request was cancelled',
            undefined,
            undefined,
            options.apiKey,
          );
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
            options.apiKey,
          );
        }

        if (response.body === null) {
          throw createProviderError(
            'protocol',
            'Provider response did not include a body',
            undefined,
            undefined,
            options.apiKey,
          );
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let parserState = createSseParserState();
        const streamState = createStreamParseState();
        let normalStreamCompletion = false;

        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) {
              break;
            }
            const pushed = pushSseChunk(parserState, decoder.decode(value, { stream: true }));
            parserState = pushed.state;
            const parsed = parseFrames(pushed.frames, streamState, options.apiKey);
            for (const event of parsed.events) {
              yield event;
            }
            if (parsed.done) {
              normalStreamCompletion = true;
              return;
            }
          }

          const decodedTail = decoder.decode();
          if (decodedTail !== '') {
            const pushed = pushSseChunk(parserState, decodedTail);
            parserState = pushed.state;
            const parsed = parseFrames(pushed.frames, streamState, options.apiKey);
            for (const event of parsed.events) {
              yield event;
            }
            if (parsed.done) {
              normalStreamCompletion = true;
              return;
            }
          }

          const flushed = flushSseParser(parserState);
          const parsed = parseFrames(flushed.frames, streamState, options.apiKey);
          for (const event of parsed.events) {
            yield event;
          }
          if (parsed.done) {
            normalStreamCompletion = true;
            return;
          }
          throw createProviderError(
            'protocol',
            'Provider stream ended before [DONE]',
            undefined,
            undefined,
            options.apiKey,
          );
        } finally {
          if (!normalStreamCompletion) {
            try {
              await reader.cancel();
            } catch {
              // The stream may already be errored or closed; cleanup is best
              // effort and must not hide the original provider error.
            }
            controller.abort();
          }
          reader.releaseLock();
        }
      } catch (error) {
        if (isAdapterError(error)) {
          throw error;
        }
        if (timedOut) {
          throw createProviderError(
            'timeout',
            'Provider request timed out',
            undefined,
            undefined,
            options.apiKey,
          );
        }
        if (externalSignal?.aborted) {
          throw createProviderError(
            'cancelled',
            'Provider request was cancelled',
            undefined,
            undefined,
            options.apiKey,
          );
        }
        throw createProviderError(
          'network',
          errorMessage(error),
          undefined,
          undefined,
          options.apiKey,
        );
      } finally {
        if (timer !== undefined) {
          clearTimeout(timer);
        }
        controller.abort();
        externalSignal?.removeEventListener('abort', onAbort);
      }
    },
  };
}
