import type { LlmClient } from '@weave/llm';
import type { FinishReason, LlmRequest, Message, TokenUsage, ToolCall } from '@weave/protocol';
import type { NewSessionEvent } from '@weave/session';
import { projectSession } from '@weave/session';
import {
  AgentRunError,
  agentRunRequestSchema,
  type AgentRunner,
  type AgentRunnerOptions,
  type AgentRuntimeEvent,
} from './agent-types.js';
import { ToolExecutionError, type ToolExecutionResult } from './tool-types.js';

const defaultMaxSteps = 8;

/** Retry attempts for a model step that fails before emitting any output. */
const maxModelRetries = 2;

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

function resolveLlm(options: AgentRunnerOptions, provider: string): LlmClient {
  if (options.llmRegistry !== undefined) {
    const client = options.llmRegistry.get(provider);
    if (client === undefined) {
      throw new AgentRunError(
        'agent-provider-unavailable',
        `LLM provider "${provider}" is not configured`,
      );
    }
    return client;
  }
  if (options.llm !== undefined) {
    return options.llm;
  }
  throw new AgentRunError('agent-provider-unavailable', 'No LLM provider is configured');
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
          const llm = resolveLlm(options, validRequest.provider);
          sessionId = validRequest.sessionId;
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
            { type: 'turn.started', payload: { turnId } },
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
          lifecycleStarted = true;

          let projectedSession = projectSession(
            await options.sessionStore.read(validRequest.sessionId),
          );
          let messages: readonly Message[] = projectedSession.messages.map(
            ({ message }) => message,
          );
          const tools =
            options.toolRegistry === undefined
              ? undefined
              : protocolToolDefinitions(options.toolRegistry);
          const instructionText =
            options.instructions === undefined
              ? undefined
              : await options.instructions({ sessionId: validRequest.sessionId });
          const systemMessages: readonly Message[] =
            instructionText === undefined || instructionText.trim() === ''
              ? []
              : [{ role: 'system', content: [{ type: 'text', text: instructionText }] }];

          while (true) {
            if (modelSteps >= maxSteps) {
              throw new AgentRunError(
                'agent-step-limit',
                `Agent reached the maximum of ${maxSteps} model steps`,
              );
            }
            modelSteps += 1;

            if (modelSteps > 1) {
              stepId = crypto.randomUUID();
              activeStepStatus = 'running';
              activeStepUsage = undefined;
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
            const llmRequest: LlmRequest = {
              provider: validRequest.provider,
              model: validRequest.model,
              messages: [...systemMessages, ...messages],
              ...(tools === undefined ? {} : { tools }),
              ...(validRequest.temperature === undefined
                ? {}
                : { temperature: validRequest.temperature }),
              ...(validRequest.maxTokens === undefined
                ? {}
                : { maxTokens: validRequest.maxTokens }),
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
                for await (const event of llm.stream(llmRequest, { signal })) {
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
                },
              },
            ]);
            activeStepStatus = 'completed';
            activeStepUsage = undefined;

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
                  },
                },
              ]);
              activeStepStatus = 'completed';
              emit({ type: 'tool-result', result });
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
          if (executionPromise !== undefined) {
            await executionPromise;
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
