import type { Message, TokenUsage } from '@weave/protocol';
import type { ToolCall } from '@weave/protocol';
import { sessionEventSchema, type SessionEvent } from './events.js';

/**
 * Stable error categories for invalid Session event sequences.
 */
export type SessionProjectionErrorCode =
  'session-projection-invalid-order' | 'session-projection-missing-reference';

/**
 * Error raised when durable events cannot describe a valid Session state.
 */
export class SessionProjectionError extends Error {
  readonly code: SessionProjectionErrorCode;

  constructor(code: SessionProjectionErrorCode, message: string) {
    super(message);
    this.name = 'SessionProjectionError';
    this.code = code;
  }
}

/**
 * A message included in the projected Session read model.
 */
export interface SessionMessage {
  readonly messageId: string;
  readonly message: Message;
  readonly sequence: number;
  readonly occurredAt: string;
  /** Turn that was running when the message was created, if any. */
  readonly turnId?: string | undefined;
}

/**
 * A Step state reconstructed from step events.
 */
export interface SessionStep {
  readonly stepId: string;
  readonly kind: string;
  readonly status: 'running' | 'completed' | 'failed' | 'cancelled';
  readonly startedAt: string;
  readonly completedAt?: string | undefined;
  /** Provider and model of a model step, when recorded. */
  readonly provider?: string | undefined;
  readonly model?: string | undefined;
  /** Provider-reported token usage of a model step, when recorded. */
  readonly usage?: TokenUsage | undefined;
}

/** A durable Tool Call associated with a projected Turn and Step. */
export interface SessionToolCall {
  readonly turnId: string;
  readonly stepId: string;
  readonly toolCall: ToolCall;
}

/** A durable Tool result associated with a projected Tool Call. */
export interface SessionToolResult {
  readonly turnId: string;
  readonly stepId: string;
  readonly toolCallId: string;
  readonly name: string;
  readonly content: string;
  readonly truncated: boolean;
  readonly status: 'completed' | 'failed';
  readonly errorCode?: string | undefined;
}

/**
 * A Turn and its projected Step states.
 */
export interface SessionTurn {
  readonly turnId: string;
  readonly status: 'running' | 'completed' | 'failed' | 'cancelled';
  readonly startedAt: string;
  readonly completedAt?: string | undefined;
  readonly steps: readonly SessionStep[];
  readonly toolCalls: readonly SessionToolCall[];
  readonly toolResults: readonly SessionToolResult[];
}

/**
 * The durable Session state reconstructed from an ordered event list.
 */
export interface SessionProjection {
  readonly sessionId: string;
  readonly title: string | undefined;
  readonly archivedAt: string | undefined;
  readonly deletedAt: string | undefined;
  readonly messages: readonly SessionMessage[];
  readonly turns: readonly SessionTurn[];
  readonly lastSequence: number;
}

interface MutableStep {
  stepId: string;
  kind: string;
  status: SessionStep['status'];
  startedAt: string;
  completedAt?: string | undefined;
  provider?: string | undefined;
  model?: string | undefined;
  usage?: TokenUsage | undefined;
}

interface MutableTurn {
  turnId: string;
  status: SessionTurn['status'];
  startedAt: string;
  completedAt?: string | undefined;
  steps: MutableStep[];
  toolCalls: SessionToolCall[];
  toolResults: SessionToolResult[];
}

function invalidOrder(message: string): SessionProjectionError {
  return new SessionProjectionError('session-projection-invalid-order', message);
}

function missingReference(message: string): SessionProjectionError {
  return new SessionProjectionError('session-projection-missing-reference', message);
}

/**
 * Rebuilds a read model from durable events without touching the Store.
 */
export function projectSession(events: readonly SessionEvent[]): SessionProjection {
  if (events.length === 0) {
    throw invalidOrder('Session projection requires a session.created event');
  }

  const parsedEvents = events.map((event) => sessionEventSchema.parse(event));
  const firstEvent = parsedEvents[0];
  if (firstEvent === undefined || firstEvent.type !== 'session.created') {
    throw invalidOrder('The first Session event must be session.created');
  }
  if (firstEvent.sequence !== 1) {
    throw invalidOrder('The first Session event must have sequence 1');
  }

  const sessionId = firstEvent.sessionId;
  let title: string | undefined = firstEvent.payload.title;
  let archivedAt: string | undefined;
  let deletedAt: string | undefined;
  const messages: SessionMessage[] = [];
  const messageIds = new Set<string>();
  const turns: MutableTurn[] = [];
  const turnById = new Map<string, MutableTurn>();
  let activeTurnId: string | undefined;
  let lastSequence = 0;

  for (const [index, event] of parsedEvents.entries()) {
    const expectedSequence = index + 1;
    if (event.sessionId !== sessionId) {
      throw invalidOrder('Session projection cannot combine different session ids');
    }
    if (event.sequence !== expectedSequence) {
      throw invalidOrder('Session event sequences must be continuous and increasing');
    }
    if (event.type === 'session.created') {
      if (index !== 0) {
        throw invalidOrder('session.created can only appear once as the first event');
      }
      title = event.payload.title;
    } else if (deletedAt !== undefined) {
      throw invalidOrder('A deleted Session cannot receive more events');
    } else if (event.type === 'session.renamed') {
      title = event.payload.title;
    } else if (event.type === 'session.archived') {
      if (archivedAt !== undefined) {
        throw invalidOrder('A Session cannot be archived more than once without being restored');
      }
      archivedAt = event.occurredAt;
    } else if (event.type === 'session.restored') {
      if (archivedAt === undefined) {
        throw invalidOrder('Only an archived Session can be restored');
      }
      archivedAt = undefined;
    } else if (event.type === 'session.deleted') {
      deletedAt = event.occurredAt;
    } else if (event.type === 'message.created') {
      if (archivedAt !== undefined) {
        throw invalidOrder('An archived Session cannot receive messages');
      }
      if (messageIds.has(event.payload.messageId)) {
        throw invalidOrder(`Message ${event.payload.messageId} was created more than once`);
      }
      messageIds.add(event.payload.messageId);
      messages.push({
        messageId: event.payload.messageId,
        message: event.payload.message,
        sequence: event.sequence,
        occurredAt: event.occurredAt,
        ...(activeTurnId === undefined ? {} : { turnId: activeTurnId }),
      });
    } else if (event.type === 'turn.started') {
      if (archivedAt !== undefined) {
        throw invalidOrder('An archived Session cannot start a Turn');
      }
      if (turnById.has(event.payload.turnId)) {
        throw invalidOrder(`Turn ${event.payload.turnId} was started more than once`);
      }
      const turn: MutableTurn = {
        turnId: event.payload.turnId,
        status: 'running',
        startedAt: event.occurredAt,
        steps: [],
        toolCalls: [],
        toolResults: [],
      };
      turns.push(turn);
      turnById.set(turn.turnId, turn);
      activeTurnId = turn.turnId;
    } else if (event.type === 'turn.completed') {
      const turn = turnById.get(event.payload.turnId);
      if (turn === undefined) {
        throw missingReference(`Turn ${event.payload.turnId} does not exist`);
      }
      if (turn.status !== 'running') {
        throw invalidOrder(`Turn ${event.payload.turnId} was already completed`);
      }
      turn.status = event.payload.status;
      turn.completedAt = event.occurredAt;
      if (activeTurnId === turn.turnId) {
        activeTurnId = undefined;
      }
    } else if (event.type === 'step.started') {
      if (archivedAt !== undefined) {
        throw invalidOrder('An archived Session cannot start a Step');
      }
      const turn = turnById.get(event.payload.turnId);
      if (turn === undefined) {
        throw missingReference(`Turn ${event.payload.turnId} does not exist`);
      }
      if (turn.status !== 'running') {
        throw invalidOrder(`Turn ${event.payload.turnId} is not running`);
      }
      if (turn.steps.some((step) => step.stepId === event.payload.stepId)) {
        throw invalidOrder(`Step ${event.payload.stepId} was started more than once`);
      }
      turn.steps.push({
        stepId: event.payload.stepId,
        kind: event.payload.kind,
        status: 'running',
        startedAt: event.occurredAt,
        ...(event.payload.provider === undefined ? {} : { provider: event.payload.provider }),
        ...(event.payload.model === undefined ? {} : { model: event.payload.model }),
      });
    } else if (event.type === 'step.completed') {
      if (archivedAt !== undefined) {
        throw invalidOrder('An archived Session cannot complete a Step');
      }
      const turn = turnById.get(event.payload.turnId);
      if (turn === undefined) {
        throw missingReference(`Turn ${event.payload.turnId} does not exist`);
      }
      const step = turn.steps.find((candidate) => candidate.stepId === event.payload.stepId);
      if (step === undefined) {
        throw missingReference(`Step ${event.payload.stepId} does not exist`);
      }
      if (step.status !== 'running') {
        throw invalidOrder(`Step ${event.payload.stepId} was already completed`);
      }
      step.status = event.payload.status;
      step.completedAt = event.occurredAt;
      if (event.payload.usage !== undefined) {
        step.usage = sumTokenUsage([event.payload.usage]);
      }
    } else if (event.type === 'tool-call.created') {
      if (archivedAt !== undefined) {
        throw invalidOrder('An archived Session cannot create a Tool Call');
      }
      const turn = turnById.get(event.payload.turnId);
      if (turn === undefined) {
        throw missingReference(`Turn ${event.payload.turnId} does not exist`);
      }
      const step = turn.steps.find((candidate) => candidate.stepId === event.payload.stepId);
      if (step === undefined) {
        throw missingReference(`Step ${event.payload.stepId} does not exist`);
      }
      if (step.kind !== 'tool') {
        throw invalidOrder(`Step ${event.payload.stepId} is not a tool step`);
      }
      if (turn.toolCalls.some((call) => call.toolCall.id === event.payload.toolCall.id)) {
        throw invalidOrder(`Tool call ${event.payload.toolCall.id} was created more than once`);
      }
      turn.toolCalls.push({
        turnId: event.payload.turnId,
        stepId: event.payload.stepId,
        toolCall: { ...event.payload.toolCall },
      });
    } else if (event.type === 'tool-result.created') {
      if (archivedAt !== undefined) {
        throw invalidOrder('An archived Session cannot create a Tool Result');
      }
      const turn = turnById.get(event.payload.turnId);
      if (turn === undefined) {
        throw missingReference(`Turn ${event.payload.turnId} does not exist`);
      }
      const step = turn.steps.find((candidate) => candidate.stepId === event.payload.stepId);
      if (step === undefined) {
        throw missingReference(`Step ${event.payload.stepId} does not exist`);
      }
      const toolCall = turn.toolCalls.find(
        (candidate) => candidate.toolCall.id === event.payload.toolCallId,
      );
      if (toolCall === undefined) {
        throw missingReference(`Tool call ${event.payload.toolCallId} does not exist`);
      }
      if (toolCall.stepId !== event.payload.stepId) {
        throw invalidOrder(
          `Tool result ${event.payload.toolCallId} does not belong to step ${event.payload.stepId}`,
        );
      }
      if (turn.toolResults.some((result) => result.toolCallId === event.payload.toolCallId)) {
        throw invalidOrder(`Tool result ${event.payload.toolCallId} was created more than once`);
      }
      turn.toolResults.push({
        turnId: event.payload.turnId,
        stepId: event.payload.stepId,
        toolCallId: event.payload.toolCallId,
        name: event.payload.name,
        content: event.payload.content,
        truncated: event.payload.truncated,
        status: event.payload.status,
        ...(event.payload.errorCode === undefined ? {} : { errorCode: event.payload.errorCode }),
      });
    }
    lastSequence = event.sequence;
  }

  return {
    sessionId,
    title,
    archivedAt,
    deletedAt,
    messages: messages.map((message) => ({ ...message })),
    turns: turns.map((turn) => ({
      turnId: turn.turnId,
      status: turn.status,
      startedAt: turn.startedAt,
      ...(turn.completedAt === undefined ? {} : { completedAt: turn.completedAt }),
      steps: turn.steps.map((step) => ({ ...step })),
      toolCalls: turn.toolCalls.map((toolCall) => ({
        ...toolCall,
        toolCall: { ...toolCall.toolCall },
      })),
      toolResults: turn.toolResults.map((toolResult) => ({ ...toolResult })),
    })),
    lastSequence,
  };
}

const usageFields = [
  'inputTokens',
  'outputTokens',
  'totalTokens',
  'cacheReadTokens',
  'cacheWriteTokens',
  'reasoningTokens',
] as const;

type UsageField = (typeof usageFields)[number];

/**
 * Adds token usage field by field. A field is present in the result only when
 * at least one input reported it, so a missing counter never reads as zero.
 * Returns `undefined` when no input carries usage.
 */
export function sumTokenUsage(
  usages: readonly ({ readonly [Field in UsageField]?: number | undefined } | undefined)[],
): TokenUsage | undefined {
  const reported = usages.filter(
    (usage): usage is { readonly [Field in UsageField]?: number | undefined } =>
      usage !== undefined,
  );
  if (reported.length === 0) {
    return undefined;
  }
  const total: Record<string, number> = {};
  for (const usage of reported) {
    for (const field of usageFields) {
      const value = usage[field];
      if (value !== undefined) {
        total[field] = (total[field] ?? 0) + value;
      }
    }
  }
  return total as TokenUsage;
}
