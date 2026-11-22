import type { LlmClient, LlmProviderDescriptor } from '@weave/llm';
import {
  streamEventSchema,
  type ContextBreakdown,
  type FinishReason,
  type LlmRequest,
  type Message,
  type StreamEvent,
  type TokenUsage,
  type ToolCall,
} from '@weave/protocol';
import type { NewSessionEvent } from '@weave/session';
import { projectSession } from '@weave/session';
import {
  AgentRunError,
  agentRunRequestSchema,
  type AgentRunner,
  type AgentRunnerOptions,
  type AgentRuntimeEvent,
  type LlmCall,
  type LlmMiddleware,
} from './agent-types.js';
import { buildModelContext, type ContextBudget } from './context/build-context.js';
import { parsePlanFromToolCall } from './update-plan-tool.js';
import {
  ToolExecutionError,
  type ToolExecutionResult,
  type ToolPermissionMode,
} from './tool-types.js';

const defaultMaxSteps = 50;

/** Context window used when a Provider descriptor does not declare one. */
const defaultContextWindowTokens = 128_000;
/** Tokens reserved for model output when a request sets no `maxTokens`. */
const defaultReserveOutputTokens = 4096;
/** Safety margin kept free below the window, as a fraction of the window. */
const defaultContextMarginRatio = 0.05;
/** A single tool result above this many tokens is head/tail truncated. */
export const defaultAgentMaxToolResultTokens = 8000;

/** Retry attempts for a model step that fails before emitting any output. */
const maxModelRetries = 2;

/**
 * Runs `request` through `middleware` and checks what comes back.
 *
 * `next` reaches the model with the run's cancellation signal whatever signal
 * the middleware passes, and refuses a request for a different provider or
 * model. Each event the middleware yields must be a valid stream event.
 */
function middlewareStream(
  middleware: LlmMiddleware,
  llm: LlmClient,
  request: LlmRequest,
  signal: AbortSignal,
): AsyncIterable<StreamEvent> {
  return {
    async *[Symbol.asyncIterator]() {
      const next = (call: LlmCall): AsyncIterable<StreamEvent> => {
        if (call.request.provider !== request.provider || call.request.model !== request.model) {
          throw new AgentRunError(
            'agent-stream-protocol',
            'An LLM middleware may not change the provider or model of a request',
          );
        }
        return llm.stream(call.request, { signal: AbortSignal.any([signal, call.signal]) });
      };
      const events = await middleware({ request, signal }, next);
      for await (const event of events) {
        const checked = streamEventSchema.safeParse(event);
        if (!checked.success) {
          throw new AgentRunError(
            'agent-stream-protocol',
            'An LLM middleware emitted an invalid stream event',
            { cause: checked.error },
          );
        }
        yield event;
      }
    },
  };
}

/** Reads the retry hint off a normalized LlmError without importing its type. */
function isRetryableLlmError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'retryable' in error &&
    (error as { retryable?: unknown }).retryable === true
  );
}

/** Exponential backoff that resolves early if the run is aborted. */
function backoffDelay(attempt: number, signal: AbortSignal): Promise<void> {
  const delayMs = Math.min(2000, 250 * 2 ** attempt);
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, delayMs);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

function resolveLlmProvider(
  options: AgentRunnerOptions,
  provider: string,
): { readonly client: LlmClient; readonly descriptor: LlmProviderDescriptor | undefined } {
  const registry = options.llmRegistry;
  if (registry !== undefined) {
    const client = registry.get(provider);
    if (client === undefined) {
      throw new AgentRunError(
        'agent-provider-unavailable',
        `LLM provider "${provider}" is not configured`,
      );
    }
    return { client, descriptor: registry.getDescriptor(provider) };
  }
  if (options.llm !== undefined) {
    return { client: options.llm, descriptor: undefined };
  }
  throw new AgentRunError('agent-provider-unavailable', 'No LLM provider is configured');
}

/** Resolves the context window for one Provider, descriptor first then default. */
function resolveContextWindowTokens(
  options: AgentRunnerOptions,
  descriptor: LlmProviderDescriptor | undefined,
): number {
  const configured = descriptor?.contextWindowTokens;
  if (configured !== undefined && Number.isFinite(configured) && configured > 0) {
    return configured;
  }
  return options.context?.defaultWindowTokens ?? defaultContextWindowTokens;
}

/** Builds the send-window budget for one model step from options and request. */
function resolveContextBudget(
  options: AgentRunnerOptions,
  descriptor: LlmProviderDescriptor | undefined,
  maxTokens: number | undefined,
): ContextBudget {
  return {
    windowTokens: resolveContextWindowTokens(options, descriptor),
    reserveOutputTokens:
      maxTokens ?? options.context?.reserveOutputTokens ?? defaultReserveOutputTokens,
    marginRatio: options.context?.marginRatio ?? defaultContextMarginRatio,
  };
}

/** True when a thrown value carries the given stable LLM error code. */
function hasLlmErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === code
  );
}

function isCancellation(error: unknown, signal: AbortSignal): boolean {
  return (
    signal.aborted ||
    (error instanceof DOMException && error.name === 'AbortError') ||
    (typeof error === 'object' && error !== null && 'code' in error && error.code === 'cancelled')
  );
}

function createTerminalPersistenceError(
  primaryError: unknown,
  persistenceError: unknown,
): AggregateError {
  return new AggregateError(
    [primaryError, persistenceError],
    'Agent run and terminal persistence failed',
    { cause: primaryError },
  );
}

function createAbortError(): DOMException {
  return new DOMException('The operation was aborted', 'AbortError');
}

function protocolToolDefinitions(
  registry: NonNullable<AgentRunnerOptions['toolRegistry']>,
): NonNullable<LlmRequest['tools']> {
  return registry.list().map(({ name, description, parameters }) => ({
    name,
    description,
    parameters,
  }));
}

interface ToolCallState {
  readonly id: string;
  readonly name: string;
  arguments: string;
}

function createToolMessage(result: ToolExecutionResult): Message {
  return {
    role: 'tool',
    toolCallId: result.toolCallId,
    content: [{ type: 'text', text: result.content }],
  };
}

/**
 * Tool failures the model can react to; the turn continues with the error as
 * the tool result. Cancellation and assembly errors still end the turn.
 */
const recoverableToolErrorCodes: ReadonlySet<string> = new Set([
  'tool-not-found',
  'tool-not-permitted',
  'tool-denied',
  'tool-invalid-json',
  'tool-invalid-arguments',
  'tool-execution-failed',
  'tool-timeout',
  'tool-result-serialization-failed',
  'tool-approval-rejected',
  'tool-approval-expired',
]);

function isRecoverableToolError(error: unknown): error is ToolExecutionError {
  return error instanceof ToolExecutionError && recoverableToolErrorCodes.has(error.code);
}

function readErrorCode(value: unknown): string | undefined {
  return typeof value === 'object' &&
    value !== null &&
    'code' in value &&
    typeof value.code === 'string'
    ? value.code
    : undefined;
}

/**
 * Builds the model-facing description of a failed tool call.
 *
 * It names the tool, the stable error code, and the error message of the tool
 * implementation when one exists. It never includes arguments or file content.
 */
function describeToolFailure(toolName: string, error: ToolExecutionError): string {
  const cause = error.cause;
  const causeCode = readErrorCode(cause);
  const detail =
    cause instanceof Error && causeCode !== undefined
      ? `${causeCode}: ${cause.message}`
      : error.message;
  return `Tool "${toolName}" failed (${error.code}). ${detail}`;
}

/**
 * Creates a Runner for one Session turn, with optional sequential Tool Calls.
 *
 * The queue is intentionally local to this Runner. The current
 * SessionEventStore contract has no cross-process lease or CAS primitive.
 */
export function createAgentRunner(options: AgentRunnerOptions): AgentRunner {
  if (options.llm === undefined && options.llmRegistry === undefined) {
    throw new Error('llm or llmRegistry must be provided');
  }
  const hasToolRegistry = options.toolRegistry !== undefined;
  const hasToolPipeline = options.toolPipeline !== undefined;
  if (hasToolRegistry !== hasToolPipeline) {
    throw new Error('toolRegistry and toolPipeline must be provided together');
  }
  const maxSteps = options.maxSteps ?? defaultMaxSteps;
  if (!Number.isInteger(maxSteps) || maxSteps <= 0) {
    throw new RangeError('maxSteps must be a positive integer');
  }

  const sessionQueues = new Map<string, Promise<void>>();

  const enqueueSessionExecution = (
    sessionId: string,
    shouldRun: () => boolean,
    task: () => Promise<void>,
  ): Promise<void> => {
    const previous = sessionQueues.get(sessionId) ?? Promise.resolve();
    const execution = previous.then(async () => {
      if (shouldRun()) {
        await task();
      }
    });
    const tracked = execution.then(
      () => {
        if (sessionQueues.get(sessionId) === tracked) {
          sessionQueues.delete(sessionId);
        }
      },
      () => {
        if (sessionQueues.get(sessionId) === tracked) {
          sessionQueues.delete(sessionId);
        }
      },
    );
    sessionQueues.set(sessionId, tracked);
    return execution;
  };

  return {
    run(requestInput): AsyncIterable<AgentRuntimeEvent> {
      const requestResult = agentRunRequestSchema.safeParse(requestInput);
      const request = requestResult.success ? requestResult.data : undefined;
      const internalController = new AbortController();
      const signal =
        request?.signal === undefined
          ? internalController.signal
          : AbortSignal.any([request.signal, internalController.signal]);

      const queuedEvents: AgentRuntimeEvent[] = [];
      const pendingNext: Array<{
        readonly reject: (error: unknown) => void;
        readonly resolve: (result: IteratorResult<AgentRuntimeEvent>) => void;
      }> = [];
      let started = false;
      let stopped = false;
      let finished = false;
      let executionError: unknown;
      let hasExecutionError = false;
      let hasCompletionPersistenceError = false;
      let executionPromise: Promise<void> | undefined;
      let lifecycleStarted = false;
      let terminalPersisted = false;
      let terminalAppendPromise: Promise<void> | undefined;
      let terminalOutcome: 'completed' | 'failed' | 'cancelled' | undefined;
      let sessionId: string | undefined;
      let turnId: string | undefined;
      let stepId: string | undefined;
      let activeStepStatus: 'running' | 'completed' = 'running';
      /** Usage reported by the model step that is currently open, if any. */
      let activeStepUsage: TokenUsage | undefined;
      /** Estimated send-window composition of the currently open model step. */
      let activeStepContext: ContextBreakdown | undefined;

      const settlePending = (): void => {
        if (!finished) {
          return;
        }
        while (pendingNext.length > 0) {
          const pending = pendingNext.shift();
          if (pending === undefined) {
            continue;
          }
          if (hasExecutionError && !stopped) {
            pending.reject(executionError);
          } else {
            pending.resolve({ done: true, value: undefined });
          }
        }
      };

      const finish = (error?: unknown, hasError = false): void => {
        if (finished) {
          return;
        }
        executionError = error;
        hasExecutionError = hasError;
        finished = true;
        settlePending();
      };

      const emit = (event: AgentRuntimeEvent): void => {
        if (stopped || finished) {
          return;
        }
        const pending = pendingNext.shift();
        if (pending !== undefined) {
          pending.resolve({ done: false, value: event });
        } else {
          queuedEvents.push(event);
        }
      };

      const appendTerminal = async (
        events: readonly NewSessionEvent[],
        primaryError?: unknown,
        hasPrimaryError = false,
        outcome: 'completed' | 'failed' | 'cancelled' = 'failed',
      ): Promise<void> => {
        if (!lifecycleStarted || terminalPersisted || sessionId === undefined) {
          return;
        }
        if (terminalAppendPromise !== undefined) {
          return terminalAppendPromise;
        }
        if (terminalOutcome !== undefined) {
          return;
        }
        const activeSessionId = sessionId;
        terminalOutcome = outcome;
        const appendPromise = Promise.resolve()
          .then(() => options.sessionStore.append(activeSessionId, events))
          .then(() => {
            terminalPersisted = true;
          });
        terminalAppendPromise = appendPromise;
        try {
          await appendPromise;
        } catch (persistenceError: unknown) {
          if (hasPrimaryError) {
            throw createTerminalPersistenceError(primaryError, persistenceError);
          }
          throw persistenceError;
        } finally {
          if (terminalAppendPromise === appendPromise) {
            terminalAppendPromise = undefined;
          }
        }
      };

      const terminalEvents = (
        status: 'completed' | 'failed' | 'cancelled',
        reason?: string,
        assistantText?: string,
        assistantReasoning?: string,
      ): NewSessionEvent[] => {
        const events: NewSessionEvent[] = [];
        if (
          (assistantText !== undefined && assistantText.length > 0) ||
          (assistantReasoning !== undefined && assistantReasoning.length > 0)
        ) {
          events.push({
            type: 'message.created',
            payload: {
              messageId: crypto.randomUUID(),
              message: {
                role: 'assistant',
                content: [
                  ...(assistantReasoning === undefined || assistantReasoning.length === 0
                    ? []
                    : [{ type: 'reasoning' as const, text: assistantReasoning }]),
                  ...(assistantText === undefined || assistantText.length === 0
                    ? []
                    : [{ type: 'text' as const, text: assistantText }]),
                ],
              },
            },
          });
        }
        if (activeStepStatus === 'running') {
          events.push({
            type: 'step.completed',
            payload: {
              turnId: turnId as string,
              stepId: stepId as string,
              status,
              ...(activeStepUsage === undefined ? {} : { usage: activeStepUsage }),
              ...(activeStepContext === undefined ? {} : { context: activeStepContext }),
            },
          });
        }
        events.push({
          type: 'turn.completed',
          payload: {
            turnId: turnId as string,
            status,
            ...(reason === undefined ? {} : { reason }),
          },
        });
        return events;
      };

      const execute = async (): Promise<void> => {
        let modelSteps = 0;
        try {
          if (!requestResult.success) {
            throw new AgentRunError('agent-invalid-input', 'Agent Run input is invalid');
          }
          const validRequest = requestResult.data;
          // Provider settings may change while the turn is awaiting the session store or a tool.
          const { client: llm, descriptor } = resolveLlmProvider(options, validRequest.provider);
          const effectiveTemperature =
            validRequest.temperature ??
            (validRequest.useProviderDefaults === false ? undefined : descriptor?.temperature);
          const effectiveMaxTokens =
            validRequest.maxTokens ??
            (validRequest.useProviderDefaults === false ? undefined : descriptor?.maxTokens);
          sessionId = validRequest.sessionId;
          const startTurn = async (): Promise<void> => {
            if (signal.aborted) throw createAbortError();
            let storedEvents = await options.sessionStore.read(validRequest.sessionId);
            if (storedEvents.length === 0) {
              await options.sessionStore.append(validRequest.sessionId, [
                { type: 'session.created', payload: {} },
              ]);
              storedEvents = await options.sessionStore.read(validRequest.sessionId);
            }
            projectSession(storedEvents);

            const messageId = crypto.randomUUID();
            turnId = crypto.randomUUID();
            stepId = crypto.randomUUID();
            await options.sessionStore.append(validRequest.sessionId, [
              {
                type: 'message.created',
                payload: { messageId, message: validRequest.userMessage },
              },
              {
                type: 'turn.started',
                payload: {
                  turnId,
                  userMessageId: messageId,
                  request: {
                    provider: validRequest.provider,
                    model: validRequest.model,
                    permissionMode: validRequest.permissionMode ?? 'ask',
                    useProviderDefaults: false,
                    ...(effectiveTemperature === undefined
                      ? {}
                      : { temperature: effectiveTemperature }),
                    ...(effectiveMaxTokens === undefined ? {} : { maxTokens: effectiveMaxTokens }),
                    ...(validRequest.reasoningEffort === undefined
                      ? {}
                      : { reasoningEffort: validRequest.reasoningEffort }),
                  },
                },
              },
              {
                type: 'step.started',
                payload: {
                  turnId,
                  stepId,
                  kind: 'model',
                  provider: validRequest.provider,
                  model: validRequest.model,
                },
              },
              ...(validRequest.skills === undefined
                ? []
                : [
                    {
                      type: 'skill.requested' as const,
                      payload: {
                        turnId,
                        userMessageId: messageId,
                        skills: [...validRequest.skills],
                      },
                    },
                  ]),
            ]);
          };
          if (options.turnAdmission === undefined) await startTurn();
          else await options.turnAdmission(validRequest.sessionId, startTurn);
          if (turnId === undefined || stepId === undefined)
            throw new Error('Turn admission did not start the turn');
          lifecycleStarted = true;

          let projectedSession = projectSession(
            await options.sessionStore.read(validRequest.sessionId),
          );
          let messages: readonly Message[] = projectedSession.messages.map(
            ({ message }) => message,
          );
          const permissionMode: ToolPermissionMode = validRequest.permissionMode ?? 'ask';
          const tools =
            options.toolRegistry === undefined
              ? undefined
              : protocolToolDefinitions(options.toolRegistry);
          const instructionText =
            options.instructions === undefined
              ? undefined
              : await options.instructions({
                  sessionId: validRequest.sessionId,
                  permissionMode,
                  turnId,
                  skills: Object.freeze(
                    (validRequest.skills ?? []).map((ref) => Object.freeze({ ...ref })),
                  ),
                  signal,
                  maxToolResultTokens:
                    options.context?.maxToolResultTokens ?? defaultAgentMaxToolResultTokens,
                });
          const systemMessages: readonly Message[] =
            instructionText === undefined || instructionText.trim() === ''
              ? []
              : [{ role: 'system', content: [{ type: 'text', text: instructionText }] }];

          while (true) {
            if (modelSteps >= maxSteps) {
              // Completed tool results stay in the Session; the user can ask the
              // Agent to continue instead of losing the turn to a failure.
              await appendTerminal(
                terminalEvents('completed', 'agent-step-limit'),
                undefined,
                false,
                'completed',
              );
              emit({ type: 'completed', turnId, reason: 'agent-step-limit' });
              finish();
              return;
            }
            modelSteps += 1;

            if (modelSteps > 1) {
              stepId = crypto.randomUUID();
              activeStepStatus = 'running';
              activeStepUsage = undefined;
              activeStepContext = undefined;
              await options.sessionStore.append(validRequest.sessionId, [
                {
                  type: 'step.started',
                  payload: {
                    turnId,
                    stepId,
                    kind: 'model',
                    provider: validRequest.provider,
                    model: validRequest.model,
                  },
                },
              ]);
            }

            let assistantText = '';
            let assistantReasoning = '';
            let finishSeen = false;
            let finishReason: FinishReason | undefined;
            let toolCalls = new Map<string, ToolCallState>();
            const budget = resolveContextBudget(options, descriptor, effectiveMaxTokens);
            const built = buildModelContext({
              system: systemMessages,
              history: messages,
              tools,
              budget,
              maxToolResultTokens:
                options.context?.maxToolResultTokens ?? defaultAgentMaxToolResultTokens,
            });
            activeStepContext = built.breakdown;
            emit({
              type: 'context',
              breakdown: built.breakdown,
              provider: validRequest.provider,
              model: validRequest.model,
            });
            if (built.overflow) {
              throw new AgentRunError(
                'agent-context-overflow',
                'The conversation exceeds the selected model context window',
              );
            }
            const llmRequest: LlmRequest = {
              provider: validRequest.provider,
              model: validRequest.model,
              messages: [...systemMessages, ...built.messages],
              ...(tools === undefined ? {} : { tools }),
              ...(effectiveTemperature === undefined ? {} : { temperature: effectiveTemperature }),
              ...(effectiveMaxTokens === undefined ? {} : { maxTokens: effectiveMaxTokens }),
              ...(validRequest.reasoningEffort === undefined
                ? {}
                : { reasoningEffort: validRequest.reasoningEffort }),
            };

            // Retry a model step only while nothing has reached the consumer or
            // been persisted; once a delta is emitted a retry would duplicate it.
            for (let attempt = 0; ; attempt += 1) {
              assistantText = '';
              assistantReasoning = '';
              finishSeen = false;
              finishReason = undefined;
              toolCalls = new Map<string, ToolCallState>();
              activeStepUsage = undefined;
              let emittedDelta = false;

              signal.throwIfAborted();
              try {
                const stream =
                  options.llmMiddleware === undefined
                    ? llm.stream(llmRequest, { signal })
                    : middlewareStream(options.llmMiddleware, llm, llmRequest, signal);
                for await (const event of stream) {
                  if (finishSeen) {
                    throw new AgentRunError(
                      'agent-stream-protocol',
                      'Agent stream emitted events after finish',
                    );
                  }
                  if (event.type === 'text-delta') {
                    assistantText += event.text;
                    emittedDelta = true;
                    emit(event);
                  } else if (event.type === 'reasoning-delta') {
                    assistantReasoning += event.text;
                    emittedDelta = true;
                    emit(event);
                  } else if (event.type === 'tool-call-start') {
                    if (options.toolPipeline === undefined || options.toolRegistry === undefined) {
                      throw new AgentRunError(
                        'agent-tool-call-unsupported',
                        'Agent tool calls are not supported',
                      );
                    }
                    if (toolCalls.has(event.id)) {
                      throw new AgentRunError(
                        'agent-tool-call-invalid',
                        `Tool call "${event.id}" was started more than once`,
                      );
                    }
                    toolCalls.set(event.id, {
                      id: event.id,
                      name: event.name,
                      arguments: '',
                    });
                  } else if (event.type === 'tool-call-delta') {
                    if (options.toolPipeline === undefined || options.toolRegistry === undefined) {
                      throw new AgentRunError(
                        'agent-tool-call-unsupported',
                        'Agent tool calls are not supported',
                      );
                    }
                    const toolCall = toolCalls.get(event.id);
                    if (toolCall === undefined) {
                      throw new AgentRunError(
                        'agent-tool-call-invalid',
                        `Tool call "${event.id}" received a delta before start`,
                      );
                    }
                    toolCall.arguments += event.argumentsDelta;
                  } else if (event.type === 'finish') {
                    finishSeen = true;
                    finishReason = event.reason;
                    if (event.usage !== undefined) {
                      activeStepUsage = event.usage;
                      emit({
                        type: 'usage',
                        usage: event.usage,
                        provider: validRequest.provider,
                        model: validRequest.model,
                      });
                    }
                  }
                }
                if (!finishSeen) {
                  throw new AgentRunError('agent-stream-protocol', 'Agent stream did not finish');
                }
                break;
              } catch (streamError: unknown) {
                if (
                  !emittedDelta &&
                  !signal.aborted &&
                  attempt < maxModelRetries &&
                  isRetryableLlmError(streamError)
                ) {
                  await backoffDelay(attempt, signal);
                  continue;
                }
                if (hasLlmErrorCode(streamError, 'context-overflow')) {
                  throw new AgentRunError(
                    'agent-context-overflow',
                    'The selected model rejected the request as too large for its context window',
                    { cause: streamError },
                  );
                }
                throw streamError;
              }
            }

            const completeToolCalls: ToolCall[] = [...toolCalls.values()].map((toolCall) => ({
              id: toolCall.id,
              name: toolCall.name,
              arguments: toolCall.arguments,
            }));
            if (completeToolCalls.length > 0 && finishReason !== 'tool-call') {
              throw new AgentRunError(
                'agent-tool-call-invalid',
                'Agent stream emitted tool calls with a non-tool finish reason',
              );
            }

            if (finishReason !== 'tool-call') {
              await appendTerminal(
                terminalEvents('completed', undefined, assistantText, assistantReasoning),
                undefined,
                false,
                'completed',
              );
              activeStepStatus = 'completed';
              emit({ type: 'completed', turnId });
              finish();
              return;
            }

            if (options.toolPipeline === undefined || options.toolRegistry === undefined) {
              throw new AgentRunError(
                'agent-tool-call-unsupported',
                'Agent tool calls are not supported',
              );
            }
            if (completeToolCalls.length === 0) {
              throw new AgentRunError(
                'agent-tool-call-invalid',
                'Agent tool-call finish did not contain a tool call',
              );
            }

            const assistantMessage: Message = {
              role: 'assistant',
              content: [
                ...(assistantReasoning.length === 0
                  ? []
                  : [{ type: 'reasoning' as const, text: assistantReasoning }]),
                ...(assistantText.length === 0
                  ? []
                  : [{ type: 'text' as const, text: assistantText }]),
              ],
              toolCalls: completeToolCalls.map(({ id, name, arguments: toolArguments }) => ({
                id,
                name,
                arguments: toolArguments,
              })),
            };
            await options.sessionStore.append(validRequest.sessionId, [
              {
                type: 'message.created',
                payload: {
                  messageId: crypto.randomUUID(),
                  message: assistantMessage,
                },
              },
              {
                type: 'step.completed',
                payload: {
                  turnId,
                  stepId,
                  status: 'completed',
                  ...(activeStepUsage === undefined ? {} : { usage: activeStepUsage }),
                  ...(activeStepContext === undefined ? {} : { context: activeStepContext }),
                },
              },
            ]);
            activeStepStatus = 'completed';
            activeStepUsage = undefined;
            activeStepContext = undefined;

            for (const toolCall of completeToolCalls) {
              const toolStepId = crypto.randomUUID();
              stepId = toolStepId;
              activeStepStatus = 'running';
              await options.sessionStore.append(validRequest.sessionId, [
                {
                  type: 'step.started',
                  payload: { turnId, stepId: toolStepId, kind: 'tool' },
                },
                {
                  type: 'tool-call.created',
                  payload: {
                    turnId,
                    stepId: toolStepId,
                    toolCall: {
                      id: toolCall.id,
                      name: toolCall.name,
                      arguments: toolCall.arguments,
                    },
                  },
                },
              ]);
              emit({ type: 'tool-call', toolCall });
              emit({ type: 'tool-executing', toolCall });

              let result: ToolExecutionResult;
              try {
                result = await options.toolPipeline.execute({
                  toolCallId: toolCall.id,
                  name: toolCall.name,
                  arguments: toolCall.arguments,
                  sessionId: validRequest.sessionId,
                  turnId,
                  permissionMode,
                  signal,
                });
              } catch (error: unknown) {
                const cancelled = isCancellation(error, signal);
                const errorCode =
                  error instanceof ToolExecutionError ? error.code : 'tool-execution-failed';
                const errorContent =
                  error instanceof ToolExecutionError ? error.message : 'Tool execution failed';

                if (!cancelled && isRecoverableToolError(error)) {
                  const failure: ToolExecutionResult = {
                    toolCallId: toolCall.id,
                    name: toolCall.name,
                    content: describeToolFailure(toolCall.name, error),
                    truncated: false,
                  };
                  await options.sessionStore.append(validRequest.sessionId, [
                    {
                      type: 'tool-result.created',
                      payload: {
                        turnId,
                        stepId: toolStepId,
                        toolCallId: toolCall.id,
                        name: toolCall.name,
                        content: failure.content,
                        truncated: false,
                        status: 'failed',
                        errorCode,
                      },
                    },
                    {
                      type: 'message.created',
                      payload: {
                        messageId: crypto.randomUUID(),
                        message: createToolMessage(failure),
                      },
                    },
                    {
                      type: 'step.completed',
                      payload: { turnId, stepId: toolStepId, status: 'failed' },
                    },
                  ]);
                  activeStepStatus = 'completed';
                  emit({ type: 'tool-result', result: failure, status: 'failed', errorCode });
                  continue;
                }

                await appendTerminal(
                  [
                    {
                      type: 'tool-result.created',
                      payload: {
                        turnId,
                        stepId: toolStepId,
                        toolCallId: toolCall.id,
                        name: toolCall.name,
                        content: errorContent,
                        truncated: false,
                        status: 'failed',
                        errorCode,
                      },
                    },
                    ...terminalEvents(cancelled ? 'cancelled' : 'failed', errorCode),
                  ],
                  error,
                  true,
                  cancelled ? 'cancelled' : 'failed',
                );
                throw error;
              }

              const plan = parsePlanFromToolCall(toolCall);
              await options.sessionStore.append(validRequest.sessionId, [
                {
                  type: 'tool-result.created',
                  payload: {
                    turnId,
                    stepId: toolStepId,
                    toolCallId: result.toolCallId,
                    name: result.name,
                    content: result.content,
                    truncated: result.truncated,
                    status: 'completed',
                  },
                },
                {
                  type: 'message.created',
                  payload: {
                    messageId: crypto.randomUUID(),
                    message: createToolMessage(result),
                  },
                },
                {
                  type: 'step.completed',
                  payload: {
                    turnId,
                    stepId: toolStepId,
                    status: 'completed',
                    ...(plan === undefined ? {} : { plan }),
                  },
                },
              ]);
              activeStepStatus = 'completed';
              emit({ type: 'tool-result', result });
              if (plan !== undefined) {
                emit({ type: 'plan', plan });
              }
            }

            projectedSession = projectSession(
              await options.sessionStore.read(validRequest.sessionId),
            );
            messages = projectedSession.messages.map(({ message }) => message);
          }
        } catch (primaryError: unknown) {
          const completionPersistenceFailed = terminalOutcome === 'completed';
          if (completionPersistenceFailed) {
            hasCompletionPersistenceError = true;
            terminalOutcome = undefined;
          }
          if (lifecycleStarted && !terminalPersisted && terminalOutcome === undefined) {
            const cancelled = !completionPersistenceFailed && isCancellation(primaryError, signal);
            try {
              await appendTerminal(
                terminalEvents(
                  cancelled ? 'cancelled' : 'failed',
                  cancelled
                    ? 'cancelled'
                    : primaryError instanceof AgentRunError
                      ? primaryError.code
                      : typeof primaryError === 'object' &&
                          primaryError !== null &&
                          'code' in primaryError &&
                          typeof primaryError.code === 'string'
                        ? primaryError.code
                        : undefined,
                ),
                primaryError,
                true,
                cancelled ? 'cancelled' : 'failed',
              );
            } catch (persistenceError: unknown) {
              finish(persistenceError, true);
              return;
            }
          }
          finish(primaryError, true);
        } finally {
          internalController.abort();
        }
      };

      const start = (): void => {
        if (started) {
          return;
        }
        started = true;
        executionPromise =
          request === undefined
            ? execute()
            : enqueueSessionExecution(request.sessionId, () => !stopped, execute);
        void executionPromise;
      };

      const iterator: AsyncIterator<AgentRuntimeEvent> = {
        next(): Promise<IteratorResult<AgentRuntimeEvent>> {
          if (stopped) {
            return Promise.resolve({ done: true, value: undefined });
          }
          start();
          const event = queuedEvents.shift();
          if (event !== undefined) {
            return Promise.resolve({ done: false, value: event });
          }
          if (finished) {
            if (hasExecutionError && !stopped) {
              return Promise.reject(executionError);
            }
            return Promise.resolve({ done: true, value: undefined });
          }
          return new Promise<IteratorResult<AgentRuntimeEvent>>((resolve, reject) => {
            pendingNext.push({ resolve, reject });
          });
        },
        async return(): Promise<IteratorResult<AgentRuntimeEvent>> {
          if (finished) {
            stopped = true;
            queuedEvents.length = 0;
            return { done: true, value: undefined };
          }
          stopped = true;
          queuedEvents.length = 0;
          internalController.abort(createAbortError());
          // Abort is immediate, but already accepted instructions/tool/audit
          // persistence must settle before the terminal fact closes the Turn.
          // execute owns its terminal append; only then is fallback safe.
          if (executionPromise !== undefined) {
            await executionPromise;
          }
          let returnError: unknown;
          let hasReturnError = false;
          if (
            lifecycleStarted &&
            !terminalPersisted &&
            terminalAppendPromise === undefined &&
            terminalOutcome === undefined
          ) {
            try {
              await appendTerminal(
                terminalEvents('cancelled', 'cancelled'),
                createAbortError(),
                true,
                'cancelled',
              );
            } catch (error: unknown) {
              returnError = error;
              hasReturnError = true;
            }
          }
          if (hasReturnError) {
            finish(returnError, true);
            throw returnError;
          }
          if (hasExecutionError && (hasCompletionPersistenceError || !terminalPersisted)) {
            throw executionError;
          }
          finish();
          return { done: true, value: undefined };
        },
      };

      return {
        [Symbol.asyncIterator](): AsyncIterator<AgentRuntimeEvent> {
          return iterator;
        },
      };
    },
  };
}
