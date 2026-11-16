import { createMockLlmClient, type LlmClient } from '@weave/llm';
import type { StreamEvent } from '@weave/protocol';
import type { SessionEventStore } from '@weave/session';
import {
  createApprovalBroker,
  createAgentRunner,
  createRuntime,
  createSessionEventStoreService,
  type AgentRunner,
  type ApprovalBroker,
  type Runtime,
  type RuntimeService,
  type SessionEventStoreFactory,
} from '@weave/runtime';
import { createInMemorySessionEventStore } from '@weave/session';

/** Fixed local script used to make the default Studio demo reproducible. */
const localDemoScript: readonly StreamEvent[] = [
  { type: 'text-delta', text: '这是 Weave 的本地 Agent 演示。' },
  { type: 'text-delta', text: ' 当前消息通过 SSE 增量传输。' },
  { type: 'finish', reason: 'stop' },
];

const mockLlmService: RuntimeService<LlmClient> = {
  key: Symbol('weave.server.mock-llm'),
  create: () => createMockLlmClient(localDemoScript),
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

export interface ServerRuntimeOptions {
  readonly sessionStoreFactory?: SessionEventStoreFactory;
}

const sessionStoreServices = new WeakMap<Runtime, RuntimeService<SessionEventStore>>();

/**
 * Assembles the services used by the local server entry point.
 *
 * The default runtime intentionally uses an In-Memory Session Store so unit
 * tests remain deterministic. The process entry point injects a SQLite factory.
 */
export function createServerRuntime(options: ServerRuntimeOptions = {}): Runtime {
  const sessionStoreService =
    options.sessionStoreFactory === undefined
      ? sessionEventStoreService
      : createSessionEventStoreService({ create: options.sessionStoreFactory });
  const runtime = createRuntime({
    services: [mockLlmService, approvalBrokerService, sessionStoreService],
  });
  sessionStoreServices.set(runtime, sessionStoreService);
  return runtime;
}

/**
 * Creates the Agent Runner after the Runtime has created its dependencies.
 *
 * The composition root owns this assembly because the current Runtime service
 * factory does not declare dependencies between services.
 */
export function createServerAgentRunner(runtime: Runtime): AgentRunner {
  const sessionStoreService = sessionStoreServices.get(runtime);
  if (sessionStoreService === undefined) {
    throw new Error('Server Runtime was not created by createServerRuntime');
  }

  return createAgentRunner({
    llm: runtime.get(mockLlmService),
    sessionStore: runtime.get(sessionStoreService),
  });
}

/** Gets the Session Store owned by a running Server Runtime. */
export function getServerSessionStore(runtime: Runtime): SessionEventStore {
  const sessionStoreService = sessionStoreServices.get(runtime);
  if (sessionStoreService === undefined) {
    throw new Error('Server Runtime was not created by createServerRuntime');
  }
  return runtime.get(sessionStoreService);
}
