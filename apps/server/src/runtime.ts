import { createMockLlmClient } from '@weave/llm';
import type { StreamEvent } from '@weave/protocol';
import { createInMemorySessionEventStore } from '@weave/session';
import {
  createRuntime,
  createSessionEventStoreService,
  type Runtime,
  type RuntimeService,
} from '@weave/runtime';

const mockLlmService: RuntimeService<unknown> = {
  key: Symbol('weave.server.mock-llm'),
  create: () => {
    const script: readonly StreamEvent[] = [];
    return createMockLlmClient(script);
  },
};

/** Session Store selected by the local Server composition root. */
export const sessionEventStoreService = createSessionEventStoreService({
  create: () => createInMemorySessionEventStore(),
});

/**
 * Assembles the services used by the local server entry point.
 *
 * The default server intentionally uses a Mock LLM and an In-Memory Session
 * Store so startup and health checks remain deterministic.
 */
export function createServerRuntime(): Runtime {
  return createRuntime({ services: [mockLlmService, sessionEventStoreService] });
}
