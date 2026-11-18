import { type LlmProviderRegistry } from '@weave/llm';
import {
  createPluginRegistry,
  type PluginRegistry,
  type PluginSnapshot,
  type WeavePlugin,
} from '@weave/plugin';
import type { SessionEventStore } from '@weave/session';
import {
  createApprovalBroker,
  createAgentRunner,
  createCommandTool,
  createRecallTool,
  createSessionRecallResolver,
  createToolPipeline,
  createToolRegistry,
  createRuntime,
  createSessionEventStoreService,
  createWorkspaceFileTools,
  createWorkspacePolicy,
  createWorkspaceSearchTools,
  type AgentRunner,
  type ApprovalBroker,
  type Runtime,
  type RuntimeService,
  type SessionEventStoreFactory,
  type ToolRegistry,
  type WorkspaceResolver,
} from '@weave/runtime';
import { createInMemorySessionEventStore } from '@weave/session';
import { createServerLlmProviders, type ServerLlmProviderSettings } from './llm-providers.js';
import { createAgentInstructions } from './agent-instructions.js';

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
const toolRegistries = new WeakMap<Runtime, ToolRegistry>();
const pluginRegistries = new WeakMap<Runtime, PluginRegistry>();
const workspaceToolsRegistered = new WeakSet<ToolRegistry>();
const recallToolRegistered = new WeakSet<ToolRegistry>();

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
}

/**
 * Assembles the services used by the local server entry point.
 *
 * Without a `sessionStoreFactory` the runtime uses an In-Memory Session Store so
 * unit tests remain deterministic. The process entry point injects SQLite.
 */
export function createServerRuntime(options: ServerRuntimeOptions = {}): Runtime {
  const sessionStoreService =
    options.sessionStoreFactory === undefined
      ? sessionEventStoreService
      : createSessionEventStoreService({ create: options.sessionStoreFactory });
  const providerSettings = options.providerSettings ?? createServerLlmProviders();
  const toolRegistry = createToolRegistry();
  const pluginRegistry = createPluginRegistry({
    toolRegistry,
    providerRegistry: providerSettings.registry,
  });
  const providerRegistryService: RuntimeService<LlmProviderRegistry> = {
    key: Symbol('weave.server.llm-provider-registry'),
    create: () => providerSettings.registry,
  };
  const runtime = createRuntime({
    services: [approvalBrokerService, providerRegistryService, sessionStoreService],
  });
  sessionStoreServices.set(runtime, sessionStoreService);
  providerRegistryServices.set(runtime, providerRegistryService);
  toolRegistries.set(runtime, toolRegistry);
  pluginRegistries.set(runtime, pluginRegistry);
  return runtime;
}

/** Registers trusted in-process plugins before the Server creates its Agent Runner. */
export async function registerServerPlugins(
  runtime: Runtime,
  plugins: readonly WeavePlugin[] = [],
): Promise<readonly PluginSnapshot[]> {
  const pluginRegistry = pluginRegistries.get(runtime);
  if (pluginRegistry === undefined) {
    throw new Error('Server Runtime was not created by createServerRuntime');
  }

  const snapshots: PluginSnapshot[] = [];
  for (const plugin of plugins) {
    snapshots.push(await pluginRegistry.register(plugin));
  }
  return Object.freeze(snapshots);
}

/**
 * Creates the Agent Runner after the Runtime has created its dependencies.
 *
 * The composition root owns this assembly because the current Runtime service
 * factory does not declare dependencies between services.
 *
 * When `resolveWorkspaceRoot` is supplied, the Workspace tools are registered
 * after trusted plugins, in the order the model should reach for them:
 * `list_dir`, `glob`, `grep`, `read_file`, `edit_file`, `write_file`,
 * `run_command`. Each call resolves the Workspace of its Session; a Session
 * whose Project has no folder gets `workspace-file-unavailable`.
 */
export function createServerAgentRunner(
  runtime: Runtime,
  options: ServerAgentRunnerOptions = {},
): AgentRunner {
  const sessionStoreService = sessionStoreServices.get(runtime);
  const providerRegistryService = providerRegistryServices.get(runtime);
  const toolRegistry = toolRegistries.get(runtime);
  if (
    sessionStoreService === undefined ||
    providerRegistryService === undefined ||
    toolRegistry === undefined
  ) {
    throw new Error('Server Runtime was not created by createServerRuntime');
  }

  const resolveWorkspaceRoot = options.resolveWorkspaceRoot;
  if (resolveWorkspaceRoot !== undefined && !workspaceToolsRegistered.has(toolRegistry)) {
    const resolveWorkspace: WorkspaceResolver = async ({ sessionId }) => {
      if (sessionId === undefined) {
        return undefined;
      }
      const root = await resolveWorkspaceRoot(sessionId);
      return root === undefined ? undefined : createWorkspacePolicy({ root });
    };
    const fileTools = createWorkspaceFileTools({ resolveWorkspace });
    const searchTools = createWorkspaceSearchTools({ resolveWorkspace });
    const commandTool = createCommandTool({
      resolveWorkspace,
      ...(options.commandEnvironment === undefined
        ? {}
        : { environment: options.commandEnvironment }),
    });
    const workspaceToolNames = [
      searchTools.listDir,
      searchTools.glob,
      searchTools.grep,
      fileTools.readFile,
      fileTools.editFile,
      fileTools.writeFile,
      commandTool,
    ].map((tool) => tool.name);
    for (const name of workspaceToolNames) {
      if (toolRegistry.get(name) !== undefined) {
        throw new Error(`Tool "${name}" is already registered by a plugin`);
      }
    }
    toolRegistry.register(searchTools.listDir);
    toolRegistry.register(searchTools.glob);
    toolRegistry.register(searchTools.grep);
    toolRegistry.register(fileTools.readFile);
    toolRegistry.register(fileTools.editFile);
    toolRegistry.register(fileTools.writeFile);
    toolRegistry.register(commandTool);
    workspaceToolsRegistered.add(toolRegistry);
  }

  if (!recallToolRegistered.has(toolRegistry)) {
    const recallTool = createRecallTool({
      resolve: createSessionRecallResolver(runtime.get(sessionStoreService)),
    });
    if (toolRegistry.get(recallTool.name) === undefined) {
      toolRegistry.register(recallTool);
    }
    recallToolRegistered.add(toolRegistry);
  }

  const toolPipeline = createToolPipeline({
    registry: toolRegistry,
    approvalBroker: runtime.get(approvalBrokerService),
    timeoutMs: options.toolTimeoutMs ?? defaultToolTimeoutMs,
  });

  return createAgentRunner({
    llmRegistry: runtime.get(providerRegistryService),
    sessionStore: runtime.get(sessionStoreService),
    toolRegistry,
    toolPipeline,
    ...(options.maxSteps === undefined ? {} : { maxSteps: options.maxSteps }),
    instructions: createAgentInstructions({
      tools: () => toolRegistry.list(),
      resolveWorkspaceRoot,
    }),
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

/** Gets the Tool Registry receiving explicit Server plugin registrations. */
export function getServerToolRegistry(runtime: Runtime): ToolRegistry {
  const toolRegistry = toolRegistries.get(runtime);
  if (toolRegistry === undefined) {
    throw new Error('Server Runtime was not created by createServerRuntime');
  }
  return toolRegistry;
}

/** Gets the Plugin Registry attached to one Server Runtime. */
export function getServerPluginRegistry(runtime: Runtime): PluginRegistry {
  const pluginRegistry = pluginRegistries.get(runtime);
  if (pluginRegistry === undefined) {
    throw new Error('Server Runtime was not created by createServerRuntime');
  }
  return pluginRegistry;
}
