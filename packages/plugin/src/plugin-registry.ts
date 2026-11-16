import { type LlmProviderRegistry, type LlmProviderRegistration } from '@weave/llm';
import { type RegisteredToolDefinition, type ToolRegistry } from '@weave/runtime';
import { z } from 'zod';
import { pluginApiVersion } from './index.js';
import { pluginManifestSchema, type PluginManifest } from './manifest.js';
import { PluginError } from './plugin-errors.js';
import {
  createPluginContext,
  createPluginSnapshot,
  type PluginSnapshot,
  type StagedPluginContext,
  type WeavePlugin,
} from './plugin-types.js';

const pluginDefinitionSchema = z
  .object({
    manifest: z.unknown(),
    setup: z.custom<(...args: never[]) => unknown>((value) => typeof value === 'function'),
    dispose: z
      .custom<(...args: never[]) => unknown>((value) => typeof value === 'function')
      .optional(),
  })
  .strict();

export interface PluginRegistryOptions {
  readonly toolRegistry: ToolRegistry;
  readonly providerRegistry: LlmProviderRegistry;
  readonly apiVersion?: string | undefined;
}

export interface PluginRegistry {
  register(plugin: WeavePlugin): Promise<PluginSnapshot>;
  get(pluginId: string): PluginSnapshot | undefined;
  list(): readonly PluginSnapshot[];
  dispose(): Promise<void>;
}

interface RegisteredPlugin {
  readonly plugin: WeavePlugin;
  readonly snapshot: PluginSnapshot;
}

function parsePlugin(pluginInput: WeavePlugin): WeavePlugin {
  const parsedDefinition = pluginDefinitionSchema.safeParse(pluginInput);
  if (!parsedDefinition.success) {
    throw new PluginError('plugin-invalid-definition', 'Plugin definition is invalid', {
      cause: parsedDefinition.error,
    });
  }

  const parsedManifest = pluginManifestSchema.safeParse(pluginInput.manifest);
  if (!parsedManifest.success) {
    throw new PluginError('plugin-invalid-manifest', 'Plugin Manifest is invalid', {
      cause: parsedManifest.error,
    });
  }

  return {
    ...pluginInput,
    manifest: parsedManifest.data,
  };
}

function createApiVersionError(manifest: PluginManifest, expected: string): PluginError {
  return new PluginError(
    'plugin-api-version-unsupported',
    `Plugin "${manifest.id}" requires API version "${manifest.apiVersion}", expected "${expected}"`,
  );
}

function createConflictError(
  kind: 'Tool' | 'Provider',
  name: string,
  pluginId: string,
): PluginError {
  return new PluginError(
    'plugin-registration-conflict',
    `${kind} "${name}" from plugin "${pluginId}" conflicts with an existing registration`,
  );
}

function createRegistrationError(pluginId: string, cause: unknown): PluginError {
  return new PluginError(
    'plugin-registration-conflict',
    `Plugin "${pluginId}" registrations could not be committed`,
    { cause },
  );
}

function validateHostConflicts(
  plugin: WeavePlugin,
  context: StagedPluginContext,
  toolRegistry: ToolRegistry,
  providerRegistry: LlmProviderRegistry,
): void {
  for (const tool of context.getTools()) {
    if (toolRegistry.get(tool.name) !== undefined) {
      throw createConflictError('Tool', tool.name, plugin.manifest.id);
    }
  }

  for (const provider of context.getProviders()) {
    if (providerRegistry.getDescriptor(provider.id) !== undefined) {
      throw createConflictError('Provider', provider.id, plugin.manifest.id);
    }
  }
}

function commitRegistrations(
  plugin: WeavePlugin,
  context: StagedPluginContext,
  toolRegistry: ToolRegistry,
  providerRegistry: LlmProviderRegistry,
): void {
  try {
    for (const tool of context.getTools()) {
      toolRegistry.register(tool);
    }
    for (const provider of context.getProviders()) {
      providerRegistry.register(provider);
    }
  } catch (error: unknown) {
    throw createRegistrationError(plugin.manifest.id, error);
  }
}

function createRegistrationQueue(): {
  enqueue<T>(operation: () => Promise<T>): Promise<T>;
  wait(): Promise<void>;
} {
  let pending = Promise.resolve();

  return {
    enqueue<T>(operation: () => Promise<T>): Promise<T> {
      const result = pending.then(operation);
      pending = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    },
    wait(): Promise<void> {
      return pending;
    },
  };
}

/** Creates the host-owned registry for trusted in-process plugins. */
export function createPluginRegistry(options: PluginRegistryOptions): PluginRegistry {
  const plugins = new Map<string, RegisteredPlugin>();
  const orderedPlugins: RegisteredPlugin[] = [];
  const registrationQueue = createRegistrationQueue();
  const expectedApiVersion = options.apiVersion ?? pluginApiVersion;

  return {
    register(pluginInput): Promise<PluginSnapshot> {
      return registrationQueue.enqueue(async () => {
        const plugin = parsePlugin(pluginInput);
        const { manifest } = plugin;

        if (manifest.apiVersion !== expectedApiVersion) {
          throw createApiVersionError(manifest, expectedApiVersion);
        }
        if (plugins.has(manifest.id)) {
          throw new PluginError(
            'plugin-duplicate-id',
            `Plugin "${manifest.id}" is already registered`,
          );
        }

        const context = createPluginContext(manifest);
        try {
          await plugin.setup(context);
        } catch (error: unknown) {
          if (error instanceof PluginError) {
            throw error;
          }
          throw new PluginError('plugin-setup-failed', `Plugin "${manifest.id}" setup failed`, {
            cause: error,
          });
        }

        validateHostConflicts(plugin, context, options.toolRegistry, options.providerRegistry);
        commitRegistrations(plugin, context, options.toolRegistry, options.providerRegistry);

        const snapshot = createPluginSnapshot(manifest, context.getTools(), context.getProviders());
        const registeredPlugin = { plugin, snapshot };
        plugins.set(manifest.id, registeredPlugin);
        orderedPlugins.push(registeredPlugin);
        return snapshot;
      });
    },

    get(pluginId): PluginSnapshot | undefined {
      return plugins.get(pluginId)?.snapshot;
    },

    list(): readonly PluginSnapshot[] {
      return Object.freeze(orderedPlugins.map(({ snapshot }) => snapshot));
    },

    async dispose(): Promise<void> {
      await registrationQueue.wait();
      const errors: unknown[] = [];

      for (let index = orderedPlugins.length - 1; index >= 0; index -= 1) {
        const registeredPlugin = orderedPlugins[index];
        if (registeredPlugin === undefined) {
          continue;
        }

        try {
          await registeredPlugin.plugin.dispose?.();
        } catch (error: unknown) {
          errors.push(
            new PluginError(
              'plugin-dispose-failed',
              `Plugin "${registeredPlugin.snapshot.id}" dispose failed`,
              { cause: error },
            ),
          );
        }
      }

      plugins.clear();
      orderedPlugins.length = 0;

      if (errors.length === 1) {
        throw errors[0];
      }
      if (errors.length > 1) {
        throw new AggregateError(errors, 'Plugin disposal failed', {
          cause: errors[0],
        });
      }
    },
  };
}

export type { LlmProviderRegistration, RegisteredToolDefinition };
