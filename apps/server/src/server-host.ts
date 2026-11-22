import { randomBytes } from 'node:crypto';
import { assertPanelCatalogLimits } from './plugin-panel-catalog.js';
import {
  freezePanel,
  type HostPublicationSnapshot,
  type HostUiMemberIdentity,
} from './plugin-panel-types.js';
import { type LlmProviderRegistry } from '@weave/llm';
import {
  adaptLegacyPlugin,
  PluginError,
  type AdaptedLegacyPlugin,
  type KernelPlugin,
  type PluginSnapshot,
  type WeavePlugin,
} from '@weave/plugin';
import { type SessionEventStore } from '@weave/session';
import {
  agentRunRequestSchema,
  AgentRunError,
  type AgentRunRequest,
  type AgentRuntimeEvent,
  type Runtime,
  type RuntimeService,
  type ToolRegistry,
} from '@weave/runtime';
import {
  createGenerationRunner,
  type GenerationCommit,
  type GenerationController,
  type RunnerGeneration,
} from '@weave/plugin-host';
import type { GenerationSkillCatalog } from './skill-catalog.js';
import type { TurnSkillController } from './skill-turns.js';
import type { AssembledAgentKernel } from './agent-kernel.js';
import { createProviderView } from './provider-view.js';
import { type CommandListItem, type PluginListItem } from './plugin-catalog.js';

/** Resources exclusively owned by a sealed Server generation. */
export interface ServerGenerationResources extends AssembledAgentKernel {
  readonly skillCatalog: GenerationSkillCatalog;
  readonly skillController: TurnSkillController;
  readonly toolRegistry: ToolRegistry;
  readonly pluginProviderRegistry: LlmProviderRegistry;
  readonly providerRegistry: LlmProviderRegistry;
}
export type ServerGeneration = RunnerGeneration<
  AgentRunRequest,
  AgentRuntimeEvent,
  ServerGenerationResources
>;
export type ServerGenerationController = GenerationController<
  AgentRunRequest,
  AgentRuntimeEvent,
  ServerGenerationResources
>;

/** Shared Server resources plus the current, atomically published generation. */
export interface ServerHost {
  readonly toolRegistry: ToolRegistry;
  readonly providerRegistry: LlmProviderRegistry;
  readonly hostProviderRegistry: LlmProviderRegistry;
  readonly sessionStoreService: RuntimeService<SessionEventStore>;
  registerPlugin(plugin: WeavePlugin): Promise<PluginSnapshot>;
  registeredPlugins(): readonly KernelPlugin[];
  lockPlugins(): void;
  hostTools(): ToolRegistry;
  /** Reserves a host Provider id while its settings write is pending. */
  reserveProvider(id: string): () => void;
  claimProvider(id: string): void;
  hasProviderClaim(id: string): boolean;
  releaseProviderClaim(id: string): void;
  nextGenerationId(): number;
  controller(): ServerGenerationController | undefined;
  currentPublicationSync(): HostPublicationSnapshot | undefined;
  subscribePublicationSync(listener: (snapshot: HostPublicationSnapshot) => void): () => void;
  hostUiMembersSync(): readonly HostUiMemberIdentity[];
  initializeHostUiMembersSync(ids: readonly string[]): void;
  commit(generation: ServerGeneration, options?: { immediate?: boolean }): GenerationCommit;
  publish(generation: ServerGeneration, options?: { immediate?: boolean }): Promise<void>;
  plugins(): readonly PluginListItem[];
  commands(): readonly CommandListItem[];
  dispose(): Promise<void>;
}

/** A Runtime created by `createServerRuntime`, carrying its {@link ServerHost}. */
export interface ServerRuntime extends Runtime {
  readonly serverHost: ServerHost;
}

export interface ServerHostOptions {
  readonly toolRegistry: ToolRegistry;
  readonly providerRegistry: LlmProviderRegistry;
  readonly sessionStoreService: RuntimeService<SessionEventStore>;
}

function conflict(kind: 'Tool' | 'Provider', name: string, pluginId: string): PluginError {
  return new PluginError(
    'plugin-registration-conflict',
    `${kind} "${name}" from plugin "${pluginId}" conflicts with an existing registration`,
  );
}

/** Creates the {@link ServerHost} for one Server Runtime. */
export function createServerHost(options: ServerHostOptions): ServerHost {
  const { toolRegistry, providerRegistry, sessionStoreService } = options;
  const registered: AdaptedLegacyPlugin[] = [];
  let controller: ServerGenerationController | undefined;
  let generationId = 0;
  let publication: HostPublicationSnapshot | undefined;
  let baseline: readonly HostUiMemberIdentity[] = [];
  let baselineInitialized = false;
  const baselineId = randomBytes(24).toString('base64url');
  const listeners = new Set<(snapshot: HostPublicationSnapshot) => void>();
  const reservedProviders = new Set<string>();
  const claimedProviders = new Set<string>();
  let disposePromise: Promise<void> | undefined;
  let locked = false;
  const currentPlugins = () => controller?.current().resources.pluginProviderRegistry;
  const providers = createProviderView(providerRegistry, currentPlugins, 'host');
  const currentTools = () => controller?.current().resources.toolRegistry ?? toolRegistry;

  let pending: Promise<unknown> = Promise.resolve();

  // Registrations are checked against each other, so they run one at a time.
  const enqueue = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = pending.then(operation);
    pending = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };

  const assertNoConflicts = (snapshot: PluginSnapshot): void => {
    for (const tool of snapshot.tools) {
      if (
        toolRegistry.get(tool) !== undefined ||
        registered.some((other) => other.snapshot.tools.includes(tool))
      ) {
        throw conflict('Tool', tool, snapshot.id);
      }
    }
    for (const provider of snapshot.providers) {
      if (
        providerRegistry.getDescriptor(provider) !== undefined ||
        registered.some((other) => other.snapshot.providers.includes(provider))
      ) {
        throw conflict('Provider', provider, snapshot.id);
      }
    }
  };

  const commit: ServerHost['commit'] = (generation, options) => {
    if (disposePromise !== undefined) throw new Error('Server host is disposed');
    const panels = generation.resources.panels ?? [];
    assertPanelCatalogLimits(panels);
    const nextPublication = freezePanel({
      generationId: generation.id,
      publicationId: randomBytes(24).toString('base64url'),
      panels,
    });
    function published(result: GenerationCommit): GenerationCommit {
      if (controller?.current().id !== generation.id) return result;
      publication = nextPublication;
      for (const listener of listeners) {
        if (controller.current().id !== generation.id) break;
        try {
          listener(nextPublication);
        } catch {
          /* Observation cannot undo a commit. */
        }
      }
      return result;
    }
    for (const descriptor of generation.resources.pluginProviderRegistry.list()) {
      if (
        providerRegistry.getDescriptor(descriptor.id) !== undefined ||
        reservedProviders.has(descriptor.id) ||
        claimedProviders.has(descriptor.id)
      ) {
        const owner = generation.resources.plugins.find((plugin) =>
          plugin.provides.providers.includes(descriptor.id),
        );
        throw new PluginError(
          'plugin-registration-conflict',
          `Provider "${descriptor.id}" conflicts with a host registration`,
          { pluginId: owner?.id },
        );
      }
    }
    if (controller !== undefined) return published(controller.commit(generation, options));
    if (!Number.isSafeInteger(generation.id) || generation.id <= 0) {
      throw new Error('Generation ids must increase monotonically');
    }
    const underlying = createGenerationRunner(generation);
    // The generic GenerationRunner admits later at the Session queue head.
    // Copy structured request data now while preserving the actual AbortSignal.
    const runner: ServerGenerationController['runner'] = {
      run(request) {
        const parsed = agentRunRequestSchema.safeParse(request);
        if (!parsed.success)
          return {
            [Symbol.asyncIterator]() {
              return {
                next: async () => {
                  throw new AgentRunError('agent-invalid-input', 'Agent run request is invalid');
                },
              };
            },
          };
        return underlying.runner.run(parsed.data);
      },
    };
    controller = { ...underlying, runner };
    locked = true;
    return published({ retirement: Promise.resolve() });
  };

  return {
    toolRegistry: {
      register: (tool) => currentTools().register(tool),
      get: (name) => currentTools().get(name),
      list: () => currentTools().list(),
    },
    providerRegistry: providers,
    hostProviderRegistry: Object.freeze({
      ...providers,
      get: (id: string) => providerRegistry.get(id),
      getDescriptor: (id: string) => providerRegistry.getDescriptor(id),
      list: () => providerRegistry.list(),
    }),
    sessionStoreService,

    registerPlugin: (plugin) =>
      enqueue(async () => {
        if (locked) {
          throw new Error('Plugins must be registered before the Agent Runner is created');
        }
        const adapted = await adaptLegacyPlugin(plugin, {
          beforeSetup: (manifest) => {
            if (registered.some((other) => other.snapshot.id === manifest.id)) {
              throw new PluginError(
                'plugin-duplicate-id',
                `Plugin "${manifest.id}" is already registered`,
              );
            }
          },
        });
        try {
          assertNoConflicts(adapted.snapshot);
        } catch (error: unknown) {
          await adapted.plugin.dispose?.();
          throw error;
        }
        registered.push(adapted);
        return adapted.snapshot;
      }),

    // Each kernel borrows a fresh wrapper; only ServerHost owns legacy disposal.
    registeredPlugins: () =>
      registered.map(({ plugin }) => ({
        manifest: plugin.manifest,
        setup: (env) => plugin.setup(env),
      })),
    lockPlugins() {
      locked = true;
    },
    hostTools: () => toolRegistry,
    reserveProvider(id) {
      if (
        providers.getDescriptor(id) !== undefined ||
        reservedProviders.has(id) ||
        claimedProviders.has(id)
      ) {
        throw new Error(`Provider "${id}" is already registered or reserved`);
      }
      reservedProviders.add(id);
      let released = false;
      return () => {
        if (!released) {
          released = true;
          reservedProviders.delete(id);
        }
      };
    },
    claimProvider(id) {
      if (currentPlugins()?.getDescriptor(id) !== undefined)
        throw new Error(`Provider "${id}" belongs to a plugin`);
      claimedProviders.add(id);
    },
    hasProviderClaim: (id) => claimedProviders.has(id),
    releaseProviderClaim(id) {
      claimedProviders.delete(id);
    },
    nextGenerationId: () => ++generationId,
    controller: () => controller,
    currentPublicationSync: () => (disposePromise === undefined ? publication : undefined),
    hostUiMembersSync: () => baseline,
    initializeHostUiMembersSync(ids) {
      if (controller !== undefined) throw new Error('Host baseline must precede publication');
      if (baselineInitialized) {
        const previous = baseline.map((member) => member.pluginId);
        if (JSON.stringify(previous) !== JSON.stringify([...new Set(ids)]))
          throw new Error('Host baseline cannot be expanded after initialization');
        return;
      }
      baselineInitialized = true;
      baseline = freezePanel(
        [...new Set(ids)].map((pluginId) => ({ kind: 'host' as const, pluginId, baselineId })),
      );
    },
    subscribePublicationSync(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    commit,
    async publish(generation, publishOptions) {
      await commit(generation, publishOptions).retirement;
    },
    plugins: () => controller?.current().resources.plugins ?? [],
    commands: () => controller?.current().resources.commands ?? [],

    dispose() {
      if (disposePromise !== undefined) return disposePromise;
      disposePromise = (async () => {
        locked = true;
        await pending;
        const errors: unknown[] = [];
        const attempt = async (operation: () => void | Promise<void>): Promise<void> => {
          try {
            await operation();
          } catch (error: unknown) {
            errors.push(error);
          }
        };

        if (controller !== undefined) {
          const activeController = controller;
          await attempt(() => activeController.dispose());
        }
        for (let index = registered.length - 1; index >= 0; index -= 1) {
          const adapted = registered[index];
          if (adapted !== undefined) {
            await attempt(async () => {
              try {
                await adapted.plugin.dispose?.();
              } catch (error: unknown) {
                throw new PluginError(
                  'plugin-dispose-failed',
                  `Plugin "${adapted.snapshot.id}" dispose failed`,
                  { cause: error },
                );
              }
            });
          }
        }
        registered.length = 0;

        if (errors.length === 1) {
          throw errors[0];
        }
        if (errors.length > 1) {
          throw new AggregateError(errors, 'Plugin disposal failed', { cause: errors[0] });
        }
      })();
      return disposePromise;
    },
  };
}

/** Gets the {@link ServerHost} of a Runtime created by `createServerRuntime`. */
export function serverHostOf(runtime: Runtime): ServerHost {
  const host = (runtime as Partial<ServerRuntime>).serverHost;
  if (host === undefined) {
    throw new Error('Server Runtime was not created by createServerRuntime');
  }
  return host;
}
