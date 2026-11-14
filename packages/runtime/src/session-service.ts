import type { SessionEventStore } from '@weave/session';
import type { RuntimeContext, RuntimeService } from './types.js';

/**
 * Creates a Session Event Store for one Runtime startup attempt.
 */
export type SessionEventStoreFactory = (
  context: RuntimeContext,
) => SessionEventStore | Promise<SessionEventStore>;

/**
 * Configuration for the Runtime-owned Session Event Store adapter.
 */
export interface SessionEventStoreServiceOptions {
  /** Factory used by Runtime to create the selected Store implementation. */
  readonly create: SessionEventStoreFactory;
}

/**
 * Adapts a Session Event Store to the Runtime service lifecycle.
 *
 * Storage selection stays in the composition root while Runtime owns creation
 * and disposal ordering.
 */
export function createSessionEventStoreService(
  options: SessionEventStoreServiceOptions,
): RuntimeService<SessionEventStore> {
  return {
    key: Symbol('weave.runtime.session-event-store'),
    create: options.create,
    dispose: (store) => store.close(),
  };
}
