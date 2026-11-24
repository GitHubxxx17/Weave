import type { AgentExecutionSnapshot } from './agent-execution-types.js';
import type { AgentRuntimeEvent } from './agent-types.js';
import type { TurnSummary } from '../workspace/workspace-types.js';
import type {
  ConversationProjection,
  ConversationRow,
  LiveOwner,
} from '../conversation/conversation-types.js';
import type { ToolStepData, ToolStepStatus } from '../conversation/tool-step.js';
import { durableMessageKey, toolIdentityKey } from '../conversation/conversation-model.js';
import { sumUsage } from '../conversation/turn-stats.js';

export interface LiveTurnProjector {
  readonly owner: LiveOwner;
  append(event: AgentRuntimeEvent): void;
  getProjection(): ConversationProjection;
}

/** Mutable, execution-local accumulator. Accepted events are reduced exactly once. */
export function createLiveTurnProjector(
  owner: LiveOwner,
  source: AgentExecutionSnapshot,
): LiveTurnProjector {
  const userMessage = {
    role: 'user' as const,
    content: source.input.userMessage.content.filter(
      (part): part is Extract<typeof part, { type: 'text' | 'image' }> =>
        part.type === 'text' || part.type === 'image',
    ),
  };
  const captured = {
    ...source.input,
    sessionId: owner.sessionId,
    skills: source.input.skills ?? [],
    userMessage,
  };
  const user: ConversationRow = {
    id: source.userMessageId,
    role: 'user',
    text: userMessage.content
      .filter((part) => part.type === 'text')
      .map((part) => part.text)
      .join(''),
    reasoning: '',
    tools: [],
    occurredAt: source.createdAt,
    originalUserMessage: userMessage,
    images: userMessage.content
      .filter((part) => part.type === 'image')
      .map(({ mediaType, data }) => ({ mediaType, data })),
    ...(source.fileAttachments === undefined ? {} : { fileAttachments: source.fileAttachments }),
    submission: captured,
    turnId: source.turnId,
  };
  let turn: TurnSummary = {
    turnId: source.turnId,
    userMessageId: source.userMessageId,
    status: 'running',
    startedAt: source.createdAt,
    provider: source.input.provider,
    model: source.input.model,
    request: {
      provider: source.input.provider,
      model: source.input.model,
      permissionMode: source.input.permissionMode,
      ...(source.input.temperature === undefined ? {} : { temperature: source.input.temperature }),
      ...(source.input.maxTokens === undefined ? {} : { maxTokens: source.input.maxTokens }),
      ...(source.input.useProviderDefaults === undefined
        ? {}
        : { useProviderDefaults: source.input.useProviderDefaults }),
      ...(source.input.reasoningEffort === undefined
        ? {}
        : { reasoningEffort: source.input.reasoningEffort }),
    },
    skills: { requested: source.input.skills ?? [], applications: [], failures: [] },
    modelSteps: [],
    toolResults: [],
    toolCalls: 0,
    failedToolCalls: 0,
  };
  let text = '';
  let reasoning = '';
  const calls = new Map<
    string,
    { readonly id: string; readonly name: string; readonly arguments: string }
  >();
  const results = new Map<
    string,
    {
      readonly content: string;
      readonly status: 'completed' | 'failed';
      readonly errorCode?: string;
    }
  >();
  const statuses = new Map<string, ToolStepStatus>();
  let dirty = true;
  let toolsDirty = true;
  let turnDirty = true;
  let projection: ConversationProjection | undefined;
  let tools: readonly ToolStepData[] = [];
  let toolOwnerByKey: ReadonlyMap<string, string> = new Map();
  let turnById: ReadonlyMap<string, TurnSummary> = new Map();
  const rowIds = [user.id, source.turnId];
  const userByTurn = new Map([[source.turnId, user]]);
  const lastReplyIdByTurn = new Map([[source.turnId, source.turnId]]);
  const retryByTurn = new Map([[source.turnId, captured]]);
  const durableOwnerByKey = new Map([
    [
      durableMessageKey({ sessionId: owner.sessionId, turnId: source.turnId, messageId: user.id }),
      user.id,
    ],
  ]);
  const append = (event: AgentRuntimeEvent): void => {
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
        statuses.set(event.toolCall.id, event.type === 'tool-call' ? 'called' : 'executing');
        toolsDirty = true;
        break;
      case 'tool-result':
        results.set(event.result.toolCallId, {
          content: event.result.content,
          status: event.status ?? 'completed',
          ...(event.errorCode === undefined ? {} : { errorCode: event.errorCode }),
        });
        statuses.set(event.result.toolCallId, event.status ?? 'completed');
        toolsDirty = true;
        turnDirty = true;
        break;
      case 'usage': {
        const usage = Object.fromEntries(
          Object.entries(event.usage).filter(([, value]) => value !== undefined),
        );
        turn = {
          ...turn,
          modelSteps: [...turn.modelSteps, { startedAt: source.createdAt, usage }],
          usage: sumUsage([turn.usage, usage]),
        };
        turnDirty = true;
        break;
      }
      case 'context':
        turn = { ...turn, context: event.breakdown };
        turnDirty = true;
        break;
      case 'plan':
        turn = { ...turn, plan: event.plan };
        turnDirty = true;
        break;
      case 'completed':
        return; // Runtime events cannot confirm durable completion.
    }
    dirty = true;
  };
  for (const event of source.events) append(event);
  return {
    owner,
    append,
    getProjection() {
      if (!dirty && projection !== undefined) return projection;
      if (toolsDirty) {
        tools = [...calls.values()].map((call) => {
          const result = results.get(call.id);
          return {
            toolCallId: call.id,
            name: call.name,
            arguments: call.arguments,
            status: statuses.get(call.id) ?? 'called',
            ...(result === undefined ? {} : { result: result.content }),
          };
        });
        toolOwnerByKey = new Map(
          tools.map((tool) => [
            toolIdentityKey({
              sessionId: owner.sessionId,
              turnId: owner.turnId,
              toolCallId: tool.toolCallId,
            }),
            source.turnId,
          ]),
        );
        toolsDirty = false;
      }
      if (turnDirty) {
        const toolResults = [...results.entries()].map(([toolCallId, result]) => ({
          toolCallId,
          status: result.status,
          ...(result.errorCode === undefined ? {} : { errorCode: result.errorCode }),
        }));
        turn = {
          ...turn,
          toolResults,
          toolCalls: toolResults.length,
          failedToolCalls: toolResults.filter((result) => result.status === 'failed').length,
        };
        turnById = new Map([[source.turnId, turn]]);
        turnDirty = false;
      }
      const assistant: ConversationRow = {
        id: source.turnId,
        role: 'assistant',
        text,
        reasoning,
        tools,
        occurredAt: source.createdAt,
        turnId: source.turnId,
        durableMessageIds: [],
      };
      projection = {
        sessionId: owner.sessionId,
        rowIds,
        rowsById: new Map([
          [user.id, user],
          [assistant.id, assistant],
        ]),
        turnById,
        userByTurn,
        lastReplyIdByTurn,
        retryByTurn,
        toolOwnerByKey,
        durableOwnerByKey,
        latestAssistantId: assistant.id,
      };
      dirty = false;
      return projection;
    },
  };
}
