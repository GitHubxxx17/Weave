import { createMockLlmClient, type LlmClient } from '@weave/llm';
import type { StreamEvent } from '@weave/protocol';
import { createInMemorySessionEventStore } from '@weave/session';
import {
  createApprovalBroker,
  createAgentRunner,
  createRuntime,
  createSessionEventStoreService,
  type AgentRunner,
  type ApprovalBroker,
  type Runtime,
  type RuntimeService,
} from '@weave/runtime';

const mockLlmService: RuntimeService<LlmClient> = {
  key: Symbol('weave.server.mock-llm'),
  create: () => {
    const script: readonly StreamEvent[] = [];
    return createMockLlmClient(script);
  },
};

/** Approval Broker used by the local HTTP control plane. */
export const approvalBrokerService: RuntimeService<ApprovalBroker> = {
  key: Symbol('weave.server.approval-broker'),
  create: () => createApprovalBroker(),
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
  return createRuntime({
    services: [mockLlmService, approvalBrokerService, sessionEventStoreService],
  });
}

/**
 * Creates the Agent Runner after the Runtime has created its dependencies.
 *
 * The composition root owns this assembly because the current Runtime service
 * factory does not declare dependencies between services.
 */
export function createServerAgentRunner(runtime: Runtime): AgentRunner {
  return createAgentRunner({
    llm: runtime.get(mockLlmService),
    sessionStore: runtime.get(sessionEventStoreService),
  });
}
