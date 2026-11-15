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
      for await (const event of options.llm.stream(
        llmRequest,
        request.signal === undefined ? {} : { signal: request.signal },
      )) {
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
      await options.sessionStore.append(request.sessionId, completionEvents);

      yield { type: 'completed', turnId };
    },
  };
}
