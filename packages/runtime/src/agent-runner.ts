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

function throwTerminalPersistenceError(primaryError: unknown, persistenceError: unknown): never {
  throw new AggregateError(
    [primaryError, persistenceError],
    'Agent run and terminal persistence failed',
    { cause: primaryError },
  );
}

/**
 * Creates a Runner for normal, no-tool model turns.
 */
export function createAgentRunner(options: AgentRunnerOptions): AgentRunner {
  return {
    async *run(requestInput): AsyncIterable<AgentRuntimeEvent> {
      const requestResult = agentRunRequestSchema.safeParse(requestInput);
      if (!requestResult.success) {
        throw new AgentRunError('agent-invalid-input', 'Agent Run input is invalid');
      }
      const request = requestResult.data;
      const internalController = new AbortController();
      const signal =
        request.signal === undefined
          ? internalController.signal
          : AbortSignal.any([request.signal, internalController.signal]);

      let storedEvents = await options.sessionStore.read(request.sessionId);
      if (storedEvents.length === 0) {
        await options.sessionStore.append(request.sessionId, [
          {
            type: 'session.created',
            payload: {},
          },
        ]);
        storedEvents = await options.sessionStore.read(request.sessionId);
      }
      projectSession(storedEvents);

      const messageId = crypto.randomUUID();
      const turnId = crypto.randomUUID();
      const stepId = crypto.randomUUID();
      const initializationEvents: readonly NewSessionEvent[] = [
        {
          type: 'message.created',
          payload: {
            messageId,
            message: request.userMessage,
          },
        },
        {
          type: 'turn.started',
          payload: { turnId },
        },
        {
          type: 'step.started',
          payload: {
            turnId,
            stepId,
            kind: 'model',
          },
        },
      ];
      await options.sessionStore.append(request.sessionId, initializationEvents);
      const lifecycleStarted = true;
      let terminalPersisted = false;
      let terminalAppendStarted = false;
      let completed = false;

      const projectedSession = projectSession(await options.sessionStore.read(request.sessionId));
      const messages: readonly Message[] = projectedSession.messages.map(({ message }) => message);
      const llmRequest: LlmRequest = {
        provider: request.provider,
        model: request.model,
        messages,
        ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
        ...(request.maxTokens === undefined ? {} : { maxTokens: request.maxTokens }),
        ...(request.reasoningEffort === undefined
          ? {}
          : { reasoningEffort: request.reasoningEffort }),
      };

      let assistantText = '';
      let finishSeen = false;
      try {
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
            yield event;
          } else if (event.type === 'reasoning-delta') {
            yield event;
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
        const completionEvents: NewSessionEvent[] = [];
        if (assistantText.length > 0) {
          completionEvents.push({
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
        completionEvents.push(
          {
            type: 'step.completed',
            payload: {
              turnId,
              stepId,
              status: 'completed',
            },
          },
          {
            type: 'turn.completed',
            payload: {
              turnId,
              status: 'completed',
            },
          },
        );
        terminalAppendStarted = true;
        await options.sessionStore.append(request.sessionId, completionEvents);
        terminalPersisted = true;
        completed = true;

        yield { type: 'completed', turnId };
      } catch (primaryError: unknown) {
        if (lifecycleStarted && !terminalPersisted && !terminalAppendStarted) {
          const cancelled = isCancellation(primaryError, signal);
          const terminalStatus = cancelled ? 'cancelled' : 'failed';
          const terminalReason = cancelled
            ? 'cancelled'
            : primaryError instanceof AgentRunError
              ? primaryError.code
              : typeof primaryError === 'object' &&
                  primaryError !== null &&
                  'code' in primaryError &&
                  typeof primaryError.code === 'string'
                ? primaryError.code
                : undefined;
          terminalAppendStarted = true;
          try {
            await options.sessionStore.append(request.sessionId, [
              {
                type: 'step.completed',
                payload: {
                  turnId,
                  stepId,
                  status: terminalStatus,
                },
              },
              {
                type: 'turn.completed',
                payload: {
                  turnId,
                  status: terminalStatus,
                  ...(terminalReason === undefined ? {} : { reason: terminalReason }),
                },
              },
            ]);
            terminalPersisted = true;
          } catch (persistenceError: unknown) {
            throwTerminalPersistenceError(primaryError, persistenceError);
          }
        }
        throw primaryError;
      } finally {
        if (lifecycleStarted && !terminalPersisted && !terminalAppendStarted && !completed) {
          await options.sessionStore.append(request.sessionId, [
            {
              type: 'step.completed',
              payload: {
                turnId,
                stepId,
                status: 'cancelled',
              },
            },
            {
              type: 'turn.completed',
              payload: {
                turnId,
                status: 'cancelled',
                reason: 'cancelled',
              },
            },
          ]);
        }
        internalController.abort();
      }
    },
  };
}
