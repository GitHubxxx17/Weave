import { createHash } from 'node:crypto';
import type { FileAttachmentSummary } from '@weave/protocol';
import type { SessionEvent } from './events.js';
import { fileAttachmentSummaries } from './file-context.js';

interface PendingFileBinding {
  readonly executionId: string;
  readonly turnId: string;
  readonly userMessageId: string;
  readonly acceptedMessageDigest: string;
  readonly summaries: readonly FileAttachmentSummary[];
  phase: 'queued' | 'claimed';
  messageDigest?: string;
}

/** Retained by the incremental read model; captured text is never stored here. */
export interface FileContextProjectionState {
  readonly executionIds: Set<string>;
  readonly turnIds: Set<string>;
  readonly userMessageIds: Set<string>;
  readonly capturedExecutionIds: Set<string>;
  readonly capturedTurnIds: Set<string>;
  readonly capturedUserMessageIds: Set<string>;
  readonly pending: Map<string, PendingFileBinding>;
}

export interface FileContextMessageBinding {
  readonly userMessageId: string;
  readonly summaries: readonly FileAttachmentSummary[];
}

export function createFileContextProjectionState(): FileContextProjectionState {
  return {
    executionIds: new Set(),
    turnIds: new Set(),
    userMessageIds: new Set(),
    capturedExecutionIds: new Set(),
    capturedTurnIds: new Set(),
    capturedUserMessageIds: new Set(),
    pending: new Map(),
  };
}

const messageDigest = (message: unknown): string =>
  createHash('sha256').update(JSON.stringify(message)).digest('hex');

export function applyFileContextEvent(
  state: FileContextProjectionState,
  event: SessionEvent,
): FileContextMessageBinding | undefined {
  if (event.type === 'execution.accepted') {
    const { executionId, turnId, userMessageId, fileContext, workspaceContext, input } =
      event.payload;
    if (
      state.executionIds.has(executionId) ||
      state.turnIds.has(turnId) ||
      state.userMessageIds.has(userMessageId)
    ) {
      throw new Error('Execution acceptance identities must have unique ownership');
    }
    state.executionIds.add(executionId);
    state.turnIds.add(turnId);
    state.userMessageIds.add(userMessageId);
    if (fileContext !== undefined || workspaceContext !== undefined) {
      state.capturedExecutionIds.add(executionId);
      state.capturedTurnIds.add(turnId);
      state.capturedUserMessageIds.add(userMessageId);
      state.pending.set(executionId, {
        executionId,
        turnId,
        userMessageId,
        acceptedMessageDigest: messageDigest(input.userMessage),
        summaries: fileContext === undefined ? [] : fileAttachmentSummaries(fileContext),
        phase: 'queued',
      });
    }
  } else if (event.type === 'execution.claimed') {
    const pending = state.pending.get(event.payload.executionId);
    if (pending !== undefined) {
      if (pending.phase !== 'queued') throw new Error('Captured execution was already claimed');
      pending.phase = 'claimed';
    }
  } else if (event.type === 'execution.finished') {
    state.pending.delete(event.payload.executionId);
  } else if (event.type === 'message.created') {
    for (const pending of state.pending.values()) {
      if (pending.userMessageId === event.payload.messageId) {
        pending.messageDigest = messageDigest(event.payload.message);
      }
    }
  } else if (event.type === 'turn.started') {
    const { executionId, turnId, userMessageId } = event.payload;
    const captured =
      (executionId !== undefined && state.capturedExecutionIds.has(executionId)) ||
      state.capturedTurnIds.has(turnId) ||
      (userMessageId !== undefined && state.capturedUserMessageIds.has(userMessageId));
    if (!captured) return undefined;
    const pending = executionId === undefined ? undefined : state.pending.get(executionId);
    if (
      pending === undefined ||
      pending.phase !== 'claimed' ||
      pending.turnId !== turnId ||
      pending.userMessageId !== userMessageId ||
      pending.messageDigest !== pending.acceptedMessageDigest
    )
      throw new Error(
        'Captured Turn requires its exact claimed execution and accepted user message',
      );
    state.pending.delete(pending.executionId);
    return { userMessageId: pending.userMessageId, summaries: pending.summaries };
  }
  return undefined;
}
