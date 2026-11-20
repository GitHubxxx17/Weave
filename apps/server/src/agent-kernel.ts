import { type LlmProviderRegistry } from '@weave/llm';
import {
  approvalBrokerRef,
  createPluginEventRegistry,
  createPluginKernel,
  createPluginSessionStore,
  definePlugin,
  llmProviderRegistryRef,
  pluginApiVersion,
  pluginEventsRef,
  promptSectionsExtensionPoint,
  toolAroundHook,
  toolPipelineRef,
  toolPolicyHook,
  toolRegistryRef,
  toolResultHook,
  toolsExtensionPoint,
  type KernelPlugin,
  type PluginKernel,
  type PromptSection,
} from '@weave/plugin';
import {
  createEventRegistryPlugin,
  createProviderRegistryPlugin,
  createToolRegistryPlugin,
  hostServicesPlugin,
} from '@weave/plugin-builtins';
import type { SessionEventStore } from '@weave/session';
import {
  createCommandTool,
  createRecallTool,
  createSessionRecallResolver,
  createToolPipeline,
  createUpdatePlanTool,
  createWorkspaceFileTools,
  createWorkspacePolicy,
  createWorkspaceSearchTools,
  type ApprovalBroker,
  type ToolPipeline,
  type ToolRegistry,
  type WorkspaceResolver,
} from '@weave/runtime';
import { describePlugin, type PluginListItem } from './plugin-catalog.js';

export interface AgentKernelAssembly {
  readonly toolRegistry: ToolRegistry;
  readonly providerRegistry: LlmProviderRegistry;
  readonly approvalBroker: ApprovalBroker;
  readonly sessionStore: SessionEventStore;
  readonly timeoutMs: number;
  readonly resolveWorkspaceRoot?: ((sessionId: string) => Promise<string | undefined>) | undefined;
  readonly commandEnvironment?: (() => NodeJS.ProcessEnv | Promise<NodeJS.ProcessEnv>) | undefined;
  /**
   * Plugins registered through `registerServerPlugins`. They join the kernel
   * before the server's own tools, so their tools come first in the registry.
   */
  readonly registeredPlugins: readonly KernelPlugin[];
  /** Kernel plugins that join after the server's own tools. */
  readonly kernelPlugins?: readonly KernelPlugin[] | undefined;
}

/** What one sealed per-runner kernel contributes to the Agent Runner. */
export interface AssembledAgentKernel {
  /** The kernel, kept so its plugins can be disposed with the Server. */
  readonly kernel: PluginKernel;
  /** The resolved Tool Pipeline, wrapped to fan out `weave.tools.result`. */
  readonly toolPipeline: ToolPipeline;
  /** Plugin-contributed system-prompt sections, ordered by `order` ascending. */
  readonly promptSections: readonly PromptSection[];
  /** The loaded plugins, in registration order, as `GET /plugins` lists them. */
  readonly plugins: readonly PluginListItem[];
}

/**
 * Assembles the per-runner plugin kernel: the Tool Pipeline and the plugin
 * contributions the Agent Runner needs.
 *
 * The Server owns its approval broker, session store and registries, so the
 * builtin plugins only hand them to kernel plugins as services and collect
 * contributions into the registries the Agent Runner reads. The server-tool-host
 * plugin provides the Tool Pipeline from the registry plus the Approval Broker
 * and contributes the server's own tools in the order the model should reach for
 * them: `list_dir`, `glob`, `grep`, `read_file`, `edit_file`, `write_file`,
 * `run_command`, then `recall` and `update_plan`. A tool whose name is already
 * taken keeps the existing one, so re-assembly is idempotent.
 *
 * After sealing, the host collects `weave.prompt.sections` so plugins can add
 * system-prompt sections, and wraps the pipeline to fan completed results out
 * to `weave.tools.result` observers. Plugins can also wrap every execution
 * through `weave.tools.around`, and vote on every call through
 * `weave.tools.policy`, which can only make the outcome stricter; the pipeline
 * applies both itself, around outermost. Plugins record their own Session
 * events (`<pluginId>/<name>`, defined through `env.defineEvent`) in the
 * Session Store they get as `weave.session.store`, which checks each append
 * against the registered definitions and refuses every core event. A failure
 * while assembling disposes the kernel before it propagates.
 */
export async function assembleAgentKernel(
  assembly: AgentKernelAssembly,
): Promise<AssembledAgentKernel> {
  const { toolRegistry, providerRegistry, approvalBroker, sessionStore } = assembly;
  const { timeoutMs, resolveWorkspaceRoot } = assembly;
  const kernel = createPluginKernel();

  // Plugins record their own events through a Session Store that accepts only
  // the events they registered: they cannot write the core events (turns,
  // messages, tool results) that the Runtime alone owns. The server's own
  // tools keep using the real store.
  const pluginEvents = createPluginEventRegistry();
  const owners = [
    createToolRegistryPlugin({ registry: toolRegistry, existing: 'skip' }),
    createProviderRegistryPlugin({ registry: providerRegistry, existing: 'skip' }),
    createEventRegistryPlugin({ registry: pluginEvents }),
    hostServicesPlugin({
      approvalBroker,
      sessionStore: createPluginSessionStore(sessionStore, pluginEvents),
    }),
  ];
  const serverToolHost = definePlugin({
    manifest: {
      id: 'server-tool-host',
      name: 'Server Tool Host',
      version: '1.0.0',
      apiVersion: pluginApiVersion,
      capabilities: ['tool'],
    },
    setup(env) {
      env.provide(toolPipelineRef, {
        deps: { registry: toolRegistryRef, approvalBroker: approvalBrokerRef },
        factory: ({ registry, approvalBroker: broker }) =>
          createToolPipeline({
            registry,
            approvalBroker: broker,
            timeoutMs,
            // The pipeline resolves after every plugin registered, so the
            // handlers are known; without any, the pipeline stays unwrapped.
            ...(kernel.hooks.count(toolAroundHook) === 0
              ? {}
              : {
                  around: (request, next) => kernel.hooks.runWrap(toolAroundHook, request, next),
                }),
            ...(kernel.hooks.count(toolPolicyHook) === 0
              ? {}
              : { policy: (request) => kernel.hooks.runDecide(toolPolicyHook, request) }),
          }),
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
  });
  const builtinIds = new Set([...owners, serverToolHost].map((plugin) => plugin.manifest.id));
  const registeredIds = new Set(assembly.registeredPlugins.map((plugin) => plugin.manifest.id));

  try {
    for (const plugin of owners) {
      await kernel.register(plugin);
    }
    for (const plugin of assembly.registeredPlugins) {
      await kernel.register(plugin);
    }
    await kernel.register(serverToolHost);
    for (const plugin of assembly.kernelPlugins ?? []) {
      await kernel.register(plugin);
    }

    const generation = await kernel.seal();
    const basePipeline = await generation.resolve(toolPipelineRef);
    // Resolving the provider registry collects the providers plugins contributed.
    await generation.resolve(llmProviderRegistryRef);
    // Resolving the event registry collects the events plugins defined, so
    // their appends are accepted from here on.
    await generation.resolve(pluginEventsRef);
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

    // Every owner has collected by now, so what each plugin contributed is known.
    const plugins = generation
      .plugins()
      .map((info) =>
        describePlugin(
          info,
          builtinIds.has(info.manifest.id)
            ? 'builtin'
            : registeredIds.has(info.manifest.id)
              ? 'registered'
              : 'kernel',
        ),
      );

    return { kernel, toolPipeline, promptSections, plugins };
  } catch (error: unknown) {
    await kernel.dispose().catch(() => undefined);
    throw error;
  }
}
