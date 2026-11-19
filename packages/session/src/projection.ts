import type { AgentPlan, ContextBreakdown, Message, TokenUsage } from '@weave/protocol';
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
  /** Deterministic send-window composition of a model step, when recorded. */
  readonly context?: ContextBreakdown | undefined;
  /** Task plan recorded on the tool step of an `update_plan` call. */
  readonly plan?: AgentPlan | undefined;
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
  /** Why the Turn ended, when its `turn.completed` event recorded one. */
  readonly reason?: string | undefined;
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
  context?: ContextBreakdown | undefined;
  plan?: AgentPlan | undefined;
}

interface MutableTurn {
  turnId: string;
  status: SessionTurn['status'];
  reason?: string | undefined;
  startedAt: string;
  completedAt?: string | undefined;
  steps: MutableStep[];
  toolCalls: SessionToolCall[];
  toolResults: SessionToolResult[];
}

/**
 * The resumable accumulation behind {@link projectSession}. Because the Store
 * is append-only, older events never change, so new events can be folded onto
 * this state without replaying the whole log. The state is intentionally
 * internal: callers interact with it through {@link projectSession} or the
 * projection cache, never directly.
 */
export interface ProjectionState {
  started: boolean;
  sessionId: string;
  title: string | undefined;
  archivedAt: string | undefined;
  deletedAt: string | undefined;
  messages: SessionMessage[];
  messageIds: Set<string>;
  turns: MutableTurn[];
  turnById: Map<string, MutableTurn>;
  activeTurnId: string | undefined;
  lastSequence: number;
}

function invalidOrder(message: string): SessionProjectionError {
  return new SessionProjectionError('session-projection-invalid-order', message);
}

function missingReference(message: string): SessionProjectionError {
  return new SessionProjectionError('session-projection-missing-reference', message);
}

/**
 * Creates the empty accumulation for a fresh projection.
 */
export function createProjectionState(): ProjectionState {
  return {
    started: false,
    sessionId: '',
    title: undefined,
    archivedAt: undefined,
    deletedAt: undefined,
    messages: [],
    messageIds: new Set<string>(),
    turns: [],
    turnById: new Map<string, MutableTurn>(),
    activeTurnId: undefined,
    lastSequence: 0,
  };
}

/**
 * Folds one persisted event onto the accumulation, validating order and
 * references. The event is assumed already shape-validated by the Store or
 * caller; this function owns the Agent-order rules, not the payload schema.
 *
 * Validation matches a single full replay: the first event must be
 * `session.created` with sequence 1; every later event must share the session
 * id and continue the sequence; a deleted Session accepts no further events.
 */
export function applyEvent(state: ProjectionState, event: SessionEvent): void {
  if (!state.started) {
    if (event.type !== 'session.created') {
      throw invalidOrder('The first Session event must be session.created');
    }
    if (event.sequence !== 1) {
      throw invalidOrder('The first Session event must have sequence 1');
    }
    state.started = true;
    state.sessionId = event.sessionId;
    state.title = event.payload.title;
    state.lastSequence = event.sequence;
    return;
  }

  if (event.sessionId !== state.sessionId) {
    throw invalidOrder('Session projection cannot combine different session ids');
  }
  if (event.sequence !== state.lastSequence + 1) {
    throw invalidOrder('Session event sequences must be continuous and increasing');
  }

  if (event.type === 'session.created') {
    throw invalidOrder('session.created can only appear once as the first event');
  } else if (state.deletedAt !== undefined) {
    throw invalidOrder('A deleted Session cannot receive more events');
  } else if (event.type === 'session.renamed') {
    state.title = event.payload.title;
  } else if (event.type === 'session.archived') {
    if (state.archivedAt !== undefined) {
      throw invalidOrder('A Session cannot be archived more than once without being restored');
    }
    state.archivedAt = event.occurredAt;
  } else if (event.type === 'session.restored') {
    if (state.archivedAt === undefined) {
      throw invalidOrder('Only an archived Session can be restored');
    }
    state.archivedAt = undefined;
  } else if (event.type === 'session.deleted') {
    state.deletedAt = event.occurredAt;
  } else if (event.type === 'message.created') {
    if (state.archivedAt !== undefined) {
      throw invalidOrder('An archived Session cannot receive messages');
    }
    if (state.messageIds.has(event.payload.messageId)) {
      throw invalidOrder(`Message ${event.payload.messageId} was created more than once`);
    }
    state.messageIds.add(event.payload.messageId);
    state.messages.push({
      messageId: event.payload.messageId,
      message: event.payload.message,
      sequence: event.sequence,
      occurredAt: event.occurredAt,
      ...(state.activeTurnId === undefined ? {} : { turnId: state.activeTurnId }),
    });
  } else if (event.type === 'turn.started') {
    if (state.archivedAt !== undefined) {
      throw invalidOrder('An archived Session cannot start a Turn');
    }
    if (state.turnById.has(event.payload.turnId)) {
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
    state.turns.push(turn);
    state.turnById.set(turn.turnId, turn);
    state.activeTurnId = turn.turnId;
  } else if (event.type === 'turn.completed') {
    const turn = state.turnById.get(event.payload.turnId);
    if (turn === undefined) {
      throw missingReference(`Turn ${event.payload.turnId} does not exist`);
    }
    if (turn.status !== 'running') {
      throw invalidOrder(`Turn ${event.payload.turnId} was already completed`);
    }
    turn.status = event.payload.status;
    if (event.payload.reason !== undefined) {
      turn.reason = event.payload.reason;
    }
    turn.completedAt = event.occurredAt;
    if (state.activeTurnId === turn.turnId) {
      state.activeTurnId = undefined;
    }
  } else if (event.type === 'step.started') {
    if (state.archivedAt !== undefined) {
      throw invalidOrder('An archived Session cannot start a Step');
    }
    const turn = state.turnById.get(event.payload.turnId);
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
    if (state.archivedAt !== undefined) {
      throw invalidOrder('An archived Session cannot complete a Step');
    }
    const turn = state.turnById.get(event.payload.turnId);
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
    if (event.payload.context !== undefined) {
      step.context = event.payload.context;
    }
    if (event.payload.plan !== undefined) {
      step.plan = event.payload.plan;
    }
  } else if (event.type === 'tool-call.created') {
    if (state.archivedAt !== undefined) {
      throw invalidOrder('An archived Session cannot create a Tool Call');
    }
    const turn = state.turnById.get(event.payload.turnId);
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
    if (state.archivedAt !== undefined) {
      throw invalidOrder('An archived Session cannot create a Tool Result');
    }
    const turn = state.turnById.get(event.payload.turnId);
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

  state.lastSequence = event.sequence;
}

/**
 * Builds the immutable read model from the current accumulation. Each call
 * produces fresh objects so a caller can never mutate the retained state.
 */
export function snapshotProjection(state: ProjectionState): SessionProjection {
  return {
    sessionId: state.sessionId,
    title: state.title,
    archivedAt: state.archivedAt,
    deletedAt: state.deletedAt,
    messages: state.messages.map((message) => ({ ...message })),
    turns: state.turns.map((turn) => ({
      turnId: turn.turnId,
      status: turn.status,
      ...(turn.reason === undefined ? {} : { reason: turn.reason }),
      startedAt: turn.startedAt,
      ...(turn.completedAt === undefined ? {} : { completedAt: turn.completedAt }),
      steps: turn.steps.map((step) => ({ ...step })),
      toolCalls: turn.toolCalls.map((toolCall) => ({
        ...toolCall,
        toolCall: { ...toolCall.toolCall },
      })),
      toolResults: turn.toolResults.map((toolResult) => ({ ...toolResult })),
    })),
    lastSequence: state.lastSequence,
  };
}

/**
 * Rebuilds a read model from durable events without touching the Store.
 */
export function projectSession(events: readonly SessionEvent[]): SessionProjection {
  if (events.length === 0) {
    throw invalidOrder('Session projection requires a session.created event');
  }

  const state = createProjectionState();
  for (const event of events) {
    applyEvent(state, sessionEventSchema.parse(event));
  }
  return snapshotProjection(state);
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
