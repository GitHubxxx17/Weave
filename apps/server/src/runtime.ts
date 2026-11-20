import {
  llmRequestHook,
  turnEndHook,
  turnStartHook,
  type KernelPlugin,
  type PluginSnapshot,
  type WeavePlugin,
} from '@weave/plugin';
import type { SessionEventStore } from '@weave/session';
import {
  createApprovalBroker,
  createAgentRunner,
  createToolRegistry,
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
import { createAgentInstructions } from './agent-instructions.js';
import { assembleAgentKernel } from './agent-kernel.js';
import { type CommandListItem, type PluginListItem } from './plugin-catalog.js';
import { createPromptAudit } from './prompt-audit.js';
import { createServerHost, serverHostOf, type ServerRuntime } from './server-host.js';
import { observeTurns } from './turn-observer.js';

export type { ServerRuntime } from './server-host.js';

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

/**
 * Upper bound for one tool call, including the time a protected tool waits for
 * Approval. Without it an unanswered Approval would block the turn forever.
 */
export const defaultToolTimeoutMs = 10 * 60 * 1000;

export interface ServerAgentRunnerOptions {
  /** Returns the absolute Workspace folder of a Session, when its Project has one. */
  readonly resolveWorkspaceRoot?: (sessionId: string) => Promise<string | undefined>;
  /** Overrides {@link defaultToolTimeoutMs}; mainly for tests. */
  readonly toolTimeoutMs?: number;
  /** Model steps allowed per turn; the Runtime default applies when omitted. */
  readonly maxSteps?: number;
  /** Base environment for `run_command`; defaults to the login shell environment. */
  readonly commandEnvironment?: () => NodeJS.ProcessEnv | Promise<NodeJS.ProcessEnv>;
  /**
   * Kernel plugins registered into the per-runner kernel. They may contribute
   * tools to `weave.tools` and observe results through `weave.tools.result`.
   */
  readonly kernelPlugins?: readonly KernelPlugin[];
}

/**
 * Assembles the services used by the local server entry point.
 *
 * Without a `sessionStoreFactory` the runtime uses an In-Memory Session Store so
 * unit tests remain deterministic. The process entry point injects SQLite.
 *
 * The returned Runtime carries the Server's {@link ServerRuntime.serverHost}:
 * the registries, the registered plugins and the kernels of its Agent Runners.
 */
export function createServerRuntime(options: ServerRuntimeOptions = {}): ServerRuntime {
  const sessionStoreService =
    options.sessionStoreFactory === undefined
      ? sessionEventStoreService
      : createSessionEventStoreService({ create: options.sessionStoreFactory });
  const providerSettings = options.providerSettings ?? createServerLlmProviders();
  const serverHost = createServerHost({
    toolRegistry: createToolRegistry(),
    providerRegistry: providerSettings.registry,
    sessionStoreService,
  });
  const runtime = createRuntime({ services: [approvalBrokerService, sessionStoreService] });
  return Object.assign(runtime, { serverHost });
}

/**
 * Registers trusted in-process plugins before the Server creates its Agent Runner.
 *
 * Each plugin is validated now, with the errors the legacy registry raised, but
 * its tools and providers are contributed when the Agent Runner is created, so
 * registering after that point is rejected.
 */
export async function registerServerPlugins(
  runtime: Runtime,
  plugins: readonly WeavePlugin[] = [],
): Promise<readonly PluginSnapshot[]> {
  const host = serverHostOf(runtime);
  const snapshots: PluginSnapshot[] = [];
  for (const plugin of plugins) {
    snapshots.push(await host.registerPlugin(plugin));
  }
  return Object.freeze(snapshots);
}

/**
 * Creates the Agent Runner after the Runtime has started.
 *
 * Tool assembly runs through the plugin kernel ({@link assembleAgentKernel}):
 * the registered plugins and the server's tools are contributed to the shared
 * Tool Registry in model-facing order, and the Tool Pipeline is resolved from the
 * registry and Approval Broker. Plugins may also contribute system-prompt
 * sections, which the Agent's instructions append. Each tool call resolves the
 * Workspace of its Session; a Session whose Project has no folder gets
 * `workspace-file-unavailable`.
 */
export async function createServerAgentRunner(
  runtime: Runtime,
  options: ServerAgentRunnerOptions = {},
): Promise<AgentRunner> {
  const host = serverHostOf(runtime);
  const sessionStore = runtime.get(host.sessionStoreService);
  const resolveWorkspaceRoot = options.resolveWorkspaceRoot;
  const assembled = await assembleAgentKernel({
    toolRegistry: host.toolRegistry,
    providerRegistry: host.providerRegistry,
    approvalBroker: runtime.get(approvalBrokerService),
    sessionStore,
    timeoutMs: options.toolTimeoutMs ?? defaultToolTimeoutMs,
    resolveWorkspaceRoot,
    commandEnvironment: options.commandEnvironment,
    registeredPlugins: host.registeredPlugins(),
    kernelPlugins: options.kernelPlugins,
  });
  host.lockPlugins();
  host.trackKernel(assembled.kernel);
  host.setPlugins(assembled.plugins);
  host.setCommands(assembled.commands);
  const { toolRegistry } = host;
  const { promptSections } = assembled;
  const { hooks } = assembled.kernel;
  // Turns are announced from the Session Store, which records every turn's start
  // and end, so the runner stays unaware of plugins. Without observers the
  // runner keeps the plain store.
  const runnerStore =
    hooks.count(turnStartHook) + hooks.count(turnEndHook) === 0
      ? sessionStore
      : observeTurns(sessionStore, {
          start: (info) => hooks.runObserve(turnStartHook, info),
          end: (info) => hooks.runObserve(turnEndHook, info),
        });
  // What plugins add to the prompt is recorded in the Session, with the Server's
  // own store because these are core events plugins cannot write.
  const promptAudit = createPromptAudit({ store: sessionStore, sections: promptSections });
  const baseInstructions = createAgentInstructions({
    tools: () => toolRegistry.list(),
    resolveWorkspaceRoot,
    extraSections: () => promptSections.map((section) => section.text),
  });

  return createAgentRunner({
    llmRegistry: host.providerRegistry,
    sessionStore: runnerStore,
    toolRegistry,
    toolPipeline: assembled.toolPipeline,
    // Plugins wrap the model stream only when one registered a handler.
    ...(hooks.count(llmRequestHook) === 0
      ? {}
      : {
          llmMiddleware: (call, next) =>
            hooks.runWrap(llmRequestHook, call, async (wrapped) => next(wrapped)),
        }),
    ...(options.maxSteps === undefined ? {} : { maxSteps: options.maxSteps }),
    instructions: async (context) => {
      // The record comes first and a failure fails the turn, so no plugin text
      // reaches a model without being on record.
      await promptAudit.record(context);
      return baseInstructions(context);
    },
  });
}

/** Gets the Session Store owned by a running Server Runtime. */
export function getServerSessionStore(runtime: Runtime): SessionEventStore {
  return runtime.get(serverHostOf(runtime).sessionStoreService);
}

/**
 * Disposes every plugin the Server registered, last registered first, along
 * with the kernels its Agent Runners assembled. Call it before stopping the Runtime.
 */
export async function disposeServerPlugins(runtime: Runtime): Promise<void> {
  await serverHostOf(runtime).dispose();
}

/**
 * Lists the plugins loaded for the most recently created Agent Runner, empty
 * until one exists. This is what `GET /plugins` serves.
 */
export function listServerPlugins(runtime: Runtime): readonly PluginListItem[] {
  return serverHostOf(runtime).plugins();
}

/**
 * Lists the slash commands plugins contributed to the most recently created
 * Agent Runner, empty until one exists. This is what `GET /commands` serves.
 */
export function listServerCommands(runtime: Runtime): readonly CommandListItem[] {
  return serverHostOf(runtime).commands();
}
