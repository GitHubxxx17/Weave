import { type LlmProviderRegistry } from '@weave/llm';
import {
  approvalBrokerRef,
  createPluginKernel,
  createPluginRegistry,
  definePlugin,
  pluginApiVersion,
  promptSectionsExtensionPoint,
  toolPipelineRef,
  toolRegistryRef,
  toolResultHook,
  toolsExtensionPoint,
  type KernelPlugin,
  type PluginRegistry,
  type PluginSnapshot,
  type PromptSection,
  type WeavePlugin,
} from '@weave/plugin';
import type { SessionEventStore } from '@weave/session';
import {
  createApprovalBroker,
  createAgentRunner,
  createCommandTool,
  createRecallTool,
  createSessionRecallResolver,
  createUpdatePlanTool,
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
  type ToolPipeline,
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
   * Kernel plugins registered into the per-run tool kernel. They may contribute
   * tools to `weave.tools` and observe results through `weave.tools.result`.
   */
  readonly kernelPlugins?: readonly KernelPlugin[];
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

interface AgentToolAssembly {
  readonly toolRegistry: ToolRegistry;
  readonly approvalBroker: ApprovalBroker;
  readonly sessionStore: SessionEventStore;
  readonly timeoutMs: number;
  readonly resolveWorkspaceRoot?: ((sessionId: string) => Promise<string | undefined>) | undefined;
  readonly commandEnvironment?: (() => NodeJS.ProcessEnv | Promise<NodeJS.ProcessEnv>) | undefined;
  readonly kernelPlugins?: readonly KernelPlugin[] | undefined;
}

/** What one sealed per-run kernel contributes to the Agent Runner. */
interface AssembledAgentKernel {
  /** The resolved Tool Pipeline, wrapped to fan out `weave.tools.result`. */
  readonly toolPipeline: ToolPipeline;
  /** Plugin-contributed system-prompt sections, ordered by `order` ascending. */
  readonly promptSections: readonly PromptSection[];
}

/**
 * Assembles the per-run plugin kernel: the Tool Pipeline and the plugin
 * contributions the Agent Runner needs.
 *
 * A single server-host plugin owns the `weave.tools` extension point over the
 * shared Tool Registry (so tools already registered by trusted plugins are
 * kept) and provides the Tool Pipeline from the registry plus the Approval
 * Broker. The server's own tools are contributed in the order the model should
 * reach for them — `list_dir`, `glob`, `grep`, `read_file`, `edit_file`,
 * `write_file`, `run_command`, then `recall` and `update_plan`. Contributing a
 * tool whose name is already taken is skipped, so re-assembly is idempotent.
 *
 * After sealing, the host collects `weave.prompt.sections` so plugins can add
 * system-prompt sections, and wraps the pipeline to fan completed results out
 * to `weave.tools.result` observers.
 */
async function assembleAgentKernel(assembly: AgentToolAssembly): Promise<AssembledAgentKernel> {
  const { toolRegistry, approvalBroker, sessionStore, timeoutMs, resolveWorkspaceRoot } = assembly;
  const kernel = createPluginKernel();
  await kernel.register(
    definePlugin({
      manifest: {
        id: 'server-tool-host',
        name: 'Server Tool Host',
        version: '1.0.0',
        apiVersion: pluginApiVersion,
        capabilities: ['tool'],
      },
      setup(env) {
        env.provide(approvalBrokerRef, { factory: () => approvalBroker });
        env.provide(toolRegistryRef, {
          factory: (_deps, context) => {
            context.collect(toolsExtensionPoint, {
              addTool: (tool) => {
                if (toolRegistry.get(tool.name) === undefined) {
                  toolRegistry.register(tool);
                }
              },
            });
            return toolRegistry;
          },
        });
        env.provide(toolPipelineRef, {
          deps: { registry: toolRegistryRef, approvalBroker: approvalBrokerRef },
          factory: ({ registry, approvalBroker: broker }) =>
            createToolPipeline({ registry, approvalBroker: broker, timeoutMs }),
        });
        env.contribute(toolsExtensionPoint, (api) => {
          if (resolveWorkspaceRoot !== undefined) {
            const resolveWorkspace: WorkspaceResolver = async ({ sessionId }) => {
              if (sessionId === undefined) {
                return undefined;
              }
              const root = await resolveWorkspaceRoot(sessionId);
              return root === undefined ? undefined : createWorkspacePolicy({ root });
            };
            const fileTools = createWorkspaceFileTools({
              resolveWorkspace,
              onFileSnapshot: async ({ sessionId, path, existedBefore, previousContent }) => {
                if (sessionId === undefined) {
                  return;
                }
                await sessionStore.append(sessionId, [
                  {
                    type: 'workspace.file-snapshot',
                    payload: { path, existedBefore, previousContent },
                  },
                ]);
              },
            });
            const searchTools = createWorkspaceSearchTools({ resolveWorkspace });
            const commandTool = createCommandTool({
              resolveWorkspace,
              ...(assembly.commandEnvironment === undefined
                ? {}
                : { environment: assembly.commandEnvironment }),
            });
            api.addTool(searchTools.listDir);
            api.addTool(searchTools.glob);
            api.addTool(searchTools.grep);
            api.addTool(fileTools.readFile);
            api.addTool(fileTools.editFile);
            api.addTool(fileTools.writeFile);
            api.addTool(commandTool);
          }
          api.addTool(createRecallTool({ resolve: createSessionRecallResolver(sessionStore) }));
          api.addTool(createUpdatePlanTool());
        });
      },
    }),
  );
  for (const plugin of assembly.kernelPlugins ?? []) {
    await kernel.register(plugin);
  }
  const generation = await kernel.seal();
  const basePipeline = await generation.resolve(toolPipelineRef);
  // A plugin observes completed tool results; observation is read-only and its
  // failures are isolated, so the pipeline's result is returned unchanged.
  const toolPipeline: ToolPipeline =
    kernel.hooks.count(toolResultHook) === 0
      ? basePipeline
      : {
          async execute(request) {
            const result = await basePipeline.execute(request);
            await kernel.hooks.runObserve(toolResultHook, result);
            return result;
          },
        };

  // The host owns prompt assembly for now, so it collects the contributed
  // sections directly and orders them; `createAgentInstructions` appends them.
  const collected: PromptSection[] = [];
  kernel.extensions.collect(promptSectionsExtensionPoint, {
    addSection: (section) => collected.push(section),
  });
  const promptSections = Object.freeze(
    [...collected].sort((left, right) => left.order - right.order),
  );

  return { toolPipeline, promptSections };
}

/**
 * Creates the Agent Runner after the Runtime has started.
 *
 * Tool assembly runs through the plugin kernel ({@link assembleAgentKernel}):
 * the server's tools are contributed to the shared Tool Registry in model-facing
 * order, and the Tool Pipeline is resolved from the registry and Approval
 * Broker. Plugins may also contribute system-prompt sections, which the Agent's
 * instructions append. Each tool call resolves the Workspace of its Session; a
 * Session whose Project has no folder gets `workspace-file-unavailable`.
 */
export async function createServerAgentRunner(
  runtime: Runtime,
  options: ServerAgentRunnerOptions = {},
): Promise<AgentRunner> {
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

  const sessionStore = runtime.get(sessionStoreService);
  const resolveWorkspaceRoot = options.resolveWorkspaceRoot;
  const { toolPipeline, promptSections } = await assembleAgentKernel({
    toolRegistry,
    approvalBroker: runtime.get(approvalBrokerService),
    sessionStore,
    timeoutMs: options.toolTimeoutMs ?? defaultToolTimeoutMs,
    resolveWorkspaceRoot,
    commandEnvironment: options.commandEnvironment,
    kernelPlugins: options.kernelPlugins,
  });

  return createAgentRunner({
    llmRegistry: runtime.get(providerRegistryService),
    sessionStore,
    toolRegistry,
    toolPipeline,
    ...(options.maxSteps === undefined ? {} : { maxSteps: options.maxSteps }),
    instructions: createAgentInstructions({
      tools: () => toolRegistry.list(),
      resolveWorkspaceRoot,
      extraSections: () => promptSections.map((section) => section.text),
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
