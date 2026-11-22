import { sumUsage } from '../conversation/turn-stats.js';
import type { SessionDetail, TurnSummary, WorkspaceMessage } from '../workspace/workspace-types.js';
import type { AgentExecutionSnapshot } from './agent-execution-types.js';
import type { AgentRuntimeEvent } from './agent-types.js';

/** Match Server compaction so a long answer cannot accumulate one object per token. */
export function appendExecutionEvent(
  snapshot: AgentExecutionSnapshot,
  event: AgentRuntimeEvent,
): AgentExecutionSnapshot {
  const previous = snapshot.events.at(-1);
  const events =
    (event.type === 'text-delta' || event.type === 'reasoning-delta') &&
    previous?.type === event.type
      ? [...snapshot.events.slice(0, -1), { ...event, text: previous.text + event.text }]
      : [...snapshot.events, event];
  return { ...snapshot, events };
}

/** Rebuild a complete Turn from one authoritative execution snapshot. */
export function executionTurnView(snapshot: AgentExecutionSnapshot): {
  readonly messages: readonly WorkspaceMessage[];
  readonly turn: TurnSummary;
} {
  let text = '';
  let reasoning = '';
  const calls = new Map<string, { id: string; name: string; arguments: string }>();
  const results = new Map<string, Extract<WorkspaceMessage, { role: 'tool' }>>();
  const toolResults = new Map<string, TurnSummary['toolResults'][number]>();
  let turn: TurnSummary = {
    turnId: snapshot.turnId,
    userMessageId: snapshot.userMessageId,
    status: 'running',
    startedAt: snapshot.createdAt,
    provider: snapshot.input.provider,
    model: snapshot.input.model,
    request: {
      provider: snapshot.input.provider,
      model: snapshot.input.model,
      permissionMode: snapshot.input.permissionMode,
      ...(snapshot.input.temperature === undefined
        ? {}
        : { temperature: snapshot.input.temperature }),
      ...(snapshot.input.maxTokens === undefined ? {} : { maxTokens: snapshot.input.maxTokens }),
      ...(snapshot.input.useProviderDefaults === undefined
        ? {}
        : { useProviderDefaults: snapshot.input.useProviderDefaults }),
      ...(snapshot.input.reasoningEffort === undefined
        ? {}
        : { reasoningEffort: snapshot.input.reasoningEffort }),
    },
    skills: { requested: snapshot.input.skills ?? [], applications: [], failures: [] },
    modelSteps: [],
    toolResults: [],
    toolCalls: 0,
    failedToolCalls: 0,
  };
  for (const event of snapshot.events) {
    switch (event.type) {
      case 'text-delta':
        text += event.text;
        break;
      case 'reasoning-delta':
        reasoning += event.text;
        break;
      case 'tool-call':
      case 'tool-executing':
        calls.set(event.toolCall.id, event.toolCall);
        break;
      case 'tool-result':
        results.set(event.result.toolCallId, {
          role: 'tool',
          turnId: snapshot.turnId,
          toolCallId: event.result.toolCallId,
          content: [{ type: 'text', text: event.result.content }],
        });
        toolResults.set(event.result.toolCallId, {
          toolCallId: event.result.toolCallId,
          status: event.status ?? 'completed',
          ...(event.errorCode === undefined ? {} : { errorCode: event.errorCode }),
        });
        break;
      case 'usage': {
        const usage = Object.fromEntries(
          Object.entries(event.usage).filter(([, count]) => count !== undefined),
        );
        turn = {
          ...turn,
          usage: sumUsage([turn.usage, usage]),
          modelSteps: [...turn.modelSteps, { startedAt: snapshot.createdAt, usage }],
        };
        break;
      }
      case 'context':
        turn = { ...turn, context: event.breakdown };
        break;
      case 'plan':
        turn = { ...turn, plan: event.plan };
        break;
      case 'completed':
        break; // Only execution status plus durable history confirms completion.
    }
  }
  turn = {
    ...turn,
    toolResults: [...toolResults.values()],
    toolCalls: toolResults.size,
    failedToolCalls: [...toolResults.values()].filter((result) => result.status === 'failed')
      .length,
  };
  return {
    turn,
    messages: [
      {
        ...snapshot.input.userMessage,
        messageId: snapshot.userMessageId,
        turnId: snapshot.turnId,
        occurredAt: snapshot.createdAt,
        content: [...snapshot.input.userMessage.content],
        ...(snapshot.fileAttachments === undefined
          ? {}
          : { fileAttachments: snapshot.fileAttachments }),
      },
      {
        role: 'assistant',
        turnId: snapshot.turnId,
        occurredAt: snapshot.createdAt,
        content: [
          ...(text === '' ? [] : [{ type: 'text' as const, text }]),
          ...(reasoning === '' ? [] : [{ type: 'reasoning' as const, text: reasoning }]),
        ],
        toolCalls: [...calls.values()],
      },
      ...results.values(),
    ],
  };
}

export function replaceExecutionTurn(
  detail: SessionDetail,
  snapshot: AgentExecutionSnapshot,
): SessionDetail {
  const view = executionTurnView(snapshot);
  return {
    ...detail,
    messages: [
      ...detail.messages.filter(
        (message) =>
          message.turnId !== snapshot.turnId && message.messageId !== snapshot.userMessageId,
      ),
      ...view.messages,
    ],
    turns: [...detail.turns.filter((turn) => turn.turnId !== snapshot.turnId), view.turn],
  };
}
