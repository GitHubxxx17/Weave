import { type LlmProviderRegistry } from '@weave/llm';
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
import { createServerLlmProviders, type ServerLlmProviderSettings } from './llm-providers.js';

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
  readonly providerSettings?: ServerLlmProviderSettings;
}

const sessionStoreServices = new WeakMap<Runtime, RuntimeService<SessionEventStore>>();
const providerRegistryServices = new WeakMap<Runtime, RuntimeService<LlmProviderRegistry>>();

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
  const providerRegistryService: RuntimeService<LlmProviderRegistry> = {
    key: Symbol('weave.server.llm-provider-registry'),
    create: () => options.providerSettings?.registry ?? createServerLlmProviders().registry,
  };
  const runtime = createRuntime({
    services: [approvalBrokerService, providerRegistryService, sessionStoreService],
  });
  sessionStoreServices.set(runtime, sessionStoreService);
  providerRegistryServices.set(runtime, providerRegistryService);
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
  const providerRegistryService = providerRegistryServices.get(runtime);
  if (sessionStoreService === undefined || providerRegistryService === undefined) {
    throw new Error('Server Runtime was not created by createServerRuntime');
  }

  return createAgentRunner({
    llmRegistry: runtime.get(providerRegistryService),
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

/** Gets the Provider Registry owned by a running Server Runtime. */
export function getServerLlmProviderRegistry(runtime: Runtime): LlmProviderRegistry {
  const providerRegistryService = providerRegistryServices.get(runtime);
  if (providerRegistryService === undefined) {
    throw new Error('Server Runtime was not created by createServerRuntime');
  }
  return runtime.get(providerRegistryService);
}
