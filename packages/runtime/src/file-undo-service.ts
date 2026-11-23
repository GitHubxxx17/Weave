import { z } from 'zod';
import {
  collectSafeFileUndo,
  type SessionEvent,
  type SessionEventStore,
  type FileUndoResult,
} from '@weave/session';
import type { WorkspacePolicy } from './workspace-policy.js';
import { restoreFileSnapshotLocked } from './file-undo.js';
import { withWorkspaceMutation, workspaceRootIdentity } from './workspace-mutation.js';

const id = z.string().min(1).max(128);
const requestSchema = z.object({
  projectId: id,
  sessionId: id,
  turnId: id,
  operationId: id,
  requestId: id,
});
export interface FileUndoReviewInput {
  readonly sessionId: string;
  readonly projectId: string;
  readonly turnId: string;
  readonly workspace: WorkspacePolicy;
  readonly admit?: (() => Promise<void>) | undefined;
}
export interface FileUndoInput extends FileUndoReviewInput {
  readonly operationId: string;
  readonly requestId: string;
  /** Host-only check immediately before each restore filesystem effect. */
  readonly assertMutationCurrent?: (() => void) | undefined;
}
export class FileUndoError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'FileUndoError';
  }
}
export interface FileUndoResponse {
  readonly projectId: string;
  readonly turnId: string;
  readonly operationId: string;
  readonly requestId: string;
  readonly results: readonly FileUndoResult[];
}
function terminal(events: readonly SessionEvent[], turnId: string): void {
  if (
    !events.some((event) => event.type === 'session.created') ||
    events.some((event) => event.type === 'session.deleted')
  )
    throw new FileUndoError('undo-session-not-found', 'Session was not found');
  const running = new Set<string>();
  let completed = false;
  for (const event of events) {
    if (event.type === 'turn.started') running.add(event.payload.turnId);
    if (event.type === 'turn.completed') {
      running.delete(event.payload.turnId);
      if (event.payload.turnId === turnId) completed = true;
    }
  }
  if (!completed)
    throw new FileUndoError('undo-turn-not-terminal', 'Only terminal turns can be undone');
  if (running.size > 0)
    throw new FileUndoError('undo-session-busy', 'Wait for the active turn to finish');
}
export function createFileUndoService({ store }: { readonly store: SessionEventStore }) {
  async function review(input: FileUndoReviewInput) {
    await input.admit?.();
    const events = await store.read(input.sessionId);
    terminal(events, input.turnId);
    const rootIdentity = await workspaceRootIdentity(input.workspace.root);
    const files = collectSafeFileUndo(events, input.turnId).map((file) => ({
      ...file,
      ...(file.rootIdentity !== undefined && file.rootIdentity !== rootIdentity
        ? { unavailableReason: 'workspace-root-changed' }
        : {}),
    }));
    const latest = events
      .filter(
        (event) =>
          event.type === 'workspace.undo-started' &&
          event.payload.turnId === input.turnId &&
          event.payload.projectId === input.projectId,
      )
      .at(-1);
    if (latest?.type !== 'workspace.undo-started')
      return { turnId: input.turnId, files, operation: undefined };
    const completed = events.find(
      (event) =>
        event.type === 'workspace.undo-completed' &&
        event.payload.requestId === latest.payload.requestId,
    );
    const partial = new Map<string, FileUndoResult>();
    for (const event of events)
      if (
        event.type === 'workspace.undo-file' &&
        event.payload.operationId === latest.payload.operationId
      )
        partial.set(event.payload.result.path, event.payload.result);
    const request = {
      projectId: latest.payload.projectId,
      turnId: latest.payload.turnId,
      operationId: latest.payload.operationId,
      requestId: latest.payload.requestId,
    };
    const operation =
      completed?.type === 'workspace.undo-completed'
        ? { ...completed.payload, status: 'completed' as const }
        : { ...request, results: [...partial.values()], status: 'pending' as const };
    return { turnId: input.turnId, files, operation };
  }
  async function undo(input: FileUndoInput): Promise<FileUndoResponse> {
    const parsed = requestSchema.safeParse(input);
    if (!parsed.success)
      throw new FileUndoError('undo-invalid-input', 'Undo identifiers are invalid');
    return withWorkspaceMutation(input.workspace.root, async () => {
      input.assertMutationCurrent?.();
      await input.admit?.();
      const events = await store.read(input.sessionId);
      const request = {
        projectId: parsed.data.projectId,
        turnId: parsed.data.turnId,
        operationId: parsed.data.operationId,
        requestId: parsed.data.requestId,
      };
      const operations = events.filter((event) => event.type === 'workspace.undo-started');
      for (const event of operations) {
        const saved = event.payload;
        if (
          (saved.operationId === request.operationId &&
            (saved.projectId !== request.projectId || saved.turnId !== request.turnId)) ||
          (saved.requestId === request.requestId &&
            (saved.projectId !== request.projectId ||
              saved.turnId !== request.turnId ||
              saved.operationId !== request.operationId))
        )
          throw new FileUndoError(
            'undo-id-conflict',
            'Undo identity was already used for different parameters',
          );
      }
      const saved = events.find(
        (event) =>
          event.type === 'workspace.undo-completed' &&
          event.payload.requestId === request.requestId,
      );
      if (saved?.type === 'workspace.undo-completed') return saved.payload;
      terminal(events, input.turnId);
      const rootIdentity = await workspaceRootIdentity(input.workspace.root);
      const operation = operations.find(
        (event) => event.payload.operationId === request.operationId,
      );
      if (operation !== undefined && operation.payload.rootIdentity !== rootIdentity)
        throw new FileUndoError('undo-root-changed', 'Project folder identity changed');
      input.assertMutationCurrent?.();
      if (!operations.some((event) => event.payload.requestId === request.requestId))
        await store.append(input.sessionId, [
          { type: 'workspace.undo-started', payload: { ...request, rootIdentity } },
        ]);
      const results: FileUndoResult[] = [];
      for (const snapshot of collectSafeFileUndo(events, input.turnId)) {
        const prior = events
          .filter(
            (event) =>
              event.type === 'workspace.undo-file' &&
              event.payload.operationId === request.operationId &&
              event.payload.result.path === snapshot.path,
          )
          .reverse()
          .find(
            (event) =>
              event.type === 'workspace.undo-file' &&
              (event.payload.requestId === request.requestId ||
                event.payload.result.status === 'restored' ||
                event.payload.result.status === 'already-restored'),
          );
        const result =
          prior?.type === 'workspace.undo-file'
            ? prior.payload.result
            : await restoreFileSnapshotLocked(
                snapshot,
                input.workspace,
                input.assertMutationCurrent,
              );
        if (prior === undefined)
          await store.append(input.sessionId, [
            { type: 'workspace.undo-file', payload: { ...request, result } },
          ]);
        results.push(result);
      }
      const response = { ...request, results };
      await store.append(input.sessionId, [
        { type: 'workspace.undo-completed', payload: response },
      ]);
      return response;
    });
  }
  return { review, undo };
}
