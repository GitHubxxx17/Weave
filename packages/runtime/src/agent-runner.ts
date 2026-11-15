import type { LlmRequest, Message } from '@weave/protocol';
import type { NewSessionEvent } from '@weave/session';
import { projectSession } from '@weave/session';
import {
  AgentRunError,
  agentRunRequestSchema,
  type AgentRunner,
  type AgentRunnerOptions,
  type AgentRuntimeEvent,
} from './agent-types.js';

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

/**
 * Creates a Runner for normal, no-tool model turns.
 *
 * The queue is intentionally local to this Runner. The current
 * SessionEventStore contract has no cross-process lease or CAS primitive.
 */
export function createAgentRunner(options: AgentRunnerOptions): AgentRunner {
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
      ): NewSessionEvent[] => {
        const events: NewSessionEvent[] = [];
        if (assistantText !== undefined && assistantText.length > 0) {
          events.push({
            type: 'message.created',
            payload: {
              messageId: crypto.randomUUID(),
              message: {
                role: 'assistant',
                content: [{ type: 'text', text: assistantText }],
              },
            },
          });
        }
        events.push(
          {
            type: 'step.completed',
            payload: {
              turnId: turnId as string,
              stepId: stepId as string,
              status,
            },
          },
          {
            type: 'turn.completed',
            payload: {
              turnId: turnId as string,
              status,
              ...(reason === undefined ? {} : { reason }),
            },
          },
        );
        return events;
      };

      const execute = async (): Promise<void> => {
        let assistantText = '';
        let finishSeen = false;
        try {
          if (!requestResult.success) {
            throw new AgentRunError('agent-invalid-input', 'Agent Run input is invalid');
          }
          const validRequest = requestResult.data;
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
              payload: { turnId, stepId, kind: 'model' },
            },
          ]);
          lifecycleStarted = true;

          const projectedSession = projectSession(
            await options.sessionStore.read(validRequest.sessionId),
          );
          const messages: readonly Message[] = projectedSession.messages.map(
            ({ message }) => message,
          );
          const llmRequest: LlmRequest = {
            provider: validRequest.provider,
            model: validRequest.model,
            messages,
            ...(validRequest.temperature === undefined
              ? {}
              : { temperature: validRequest.temperature }),
            ...(validRequest.maxTokens === undefined ? {} : { maxTokens: validRequest.maxTokens }),
            ...(validRequest.reasoningEffort === undefined
              ? {}
              : { reasoningEffort: validRequest.reasoningEffort }),
          };

          signal.throwIfAborted();
          for await (const event of options.llm.stream(llmRequest, { signal })) {
            if (finishSeen) {
              throw new AgentRunError(
                'agent-stream-protocol',
                'Agent stream emitted events after finish',
              );
            }
            if (event.type === 'text-delta') {
              assistantText += event.text;
              emit(event);
            } else if (event.type === 'reasoning-delta') {
              emit(event);
            } else if (event.type === 'tool-call-start' || event.type === 'tool-call-delta') {
              throw new AgentRunError(
                'agent-tool-call-unsupported',
                'Agent tool calls are not supported',
              );
            } else if (event.type === 'finish') {
              if (event.reason === 'tool-call') {
                throw new AgentRunError(
                  'agent-tool-call-unsupported',
                  'Agent tool calls are not supported',
                );
              }
              finishSeen = true;
            }
          }
          if (!finishSeen) {
            throw new AgentRunError('agent-stream-protocol', 'Agent stream did not finish');
          }

          await appendTerminal(
            terminalEvents('completed', undefined, assistantText),
            undefined,
            false,
            'completed',
          );
          emit({ type: 'completed', turnId });
          finish();
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
