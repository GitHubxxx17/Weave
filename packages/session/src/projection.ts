import type { Message } from '@weave/protocol';
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
}

/**
 * A Step state reconstructed from step events.
 */
export interface SessionStep {
  readonly stepId: string;
  readonly kind: string;
  readonly status: 'running' | 'completed' | 'failed' | 'cancelled';
}

/**
 * A Turn and its projected Step states.
 */
export interface SessionTurn {
  readonly turnId: string;
  readonly status: 'running' | 'completed' | 'failed' | 'cancelled';
  readonly steps: readonly SessionStep[];
}

/**
 * The durable Session state reconstructed from an ordered event list.
 */
export interface SessionProjection {
  readonly sessionId: string;
  readonly title: string | undefined;
  readonly messages: readonly SessionMessage[];
  readonly turns: readonly SessionTurn[];
  readonly lastSequence: number;
}

interface MutableStep {
  stepId: string;
  kind: string;
  status: SessionStep['status'];
}

interface MutableTurn {
  turnId: string;
  status: SessionTurn['status'];
  steps: MutableStep[];
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
  const messages: SessionMessage[] = [];
  const messageIds = new Set<string>();
  const turns: MutableTurn[] = [];
  const turnById = new Map<string, MutableTurn>();
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
    } else if (event.type === 'message.created') {
      if (messageIds.has(event.payload.messageId)) {
        throw invalidOrder(`Message ${event.payload.messageId} was created more than once`);
      }
      messageIds.add(event.payload.messageId);
      messages.push({
        messageId: event.payload.messageId,
        message: event.payload.message,
        sequence: event.sequence,
      });
    } else if (event.type === 'turn.started') {
      if (turnById.has(event.payload.turnId)) {
        throw invalidOrder(`Turn ${event.payload.turnId} was started more than once`);
      }
      const turn: MutableTurn = {
        turnId: event.payload.turnId,
        status: 'running',
        steps: [],
      };
      turns.push(turn);
      turnById.set(turn.turnId, turn);
    } else if (event.type === 'turn.completed') {
      const turn = turnById.get(event.payload.turnId);
      if (turn === undefined) {
        throw missingReference(`Turn ${event.payload.turnId} does not exist`);
      }
      if (turn.status !== 'running') {
        throw invalidOrder(`Turn ${event.payload.turnId} was already completed`);
      }
      turn.status = event.payload.status;
    } else if (event.type === 'step.started') {
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
      });
    } else if (event.type === 'step.completed') {
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
    }
    lastSequence = event.sequence;
  }

  return {
    sessionId,
    title,
    messages: messages.map((message) => ({ ...message })),
    turns: turns.map((turn) => ({
      turnId: turn.turnId,
      status: turn.status,
      steps: turn.steps.map((step) => ({ ...step })),
    })),
    lastSequence,
  };
}
