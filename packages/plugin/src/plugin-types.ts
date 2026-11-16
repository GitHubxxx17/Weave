import {
  type LlmClient,
  type LlmProviderRegistration,
  type LlmProviderType,
} from '@weave/llm';
import {
  toolDefinitionSchema,
  type RegisteredToolDefinition,
  type ToolDefinition,
} from '@weave/runtime';
import { z } from 'zod';
import {
  PluginError,
  type PluginErrorCode,
} from './plugin-errors.js';
import {
  type PluginCapability,
  type PluginManifest,
} from './manifest.js';

/** Methods exposed to a trusted plugin during setup. */
export interface PluginContext {
  /** Adds a validated Tool definition to the plugin's pending registrations. */
  registerTool<TInput, TOutput>(tool: ToolDefinition<TInput, TOutput>): void;
  /** Adds a validated LLM Provider to the plugin's pending registrations. */
  registerProvider(provider: LlmProviderRegistration): void;
}

/** Internal Context view used by Plugin Registry before committing registrations. */
export interface StagedPluginContext extends PluginContext {
  readonly getTools: () => readonly RegisteredToolDefinition[];
  readonly getProviders: () => readonly LlmProviderRegistration[];
}

/** Plugin lifecycle implementation supplied by a trusted host module. */
export interface WeavePlugin {
  readonly manifest: PluginManifest;
  setup(context: PluginContext): void | Promise<void>;
  dispose?(): void | Promise<void>;
}

/** Secret-free snapshot exposed by Plugin Registry queries. */
export interface PluginSnapshot {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly apiVersion: string;
  readonly description?: string | undefined;
  readonly capabilities: readonly PluginCapability[];
  readonly tools: readonly string[];
  readonly providers: readonly string[];
}

const providerTypeSchema = z.enum(['mock', 'openai-compatible']);
const providerRegistrationSchema = z
  .object({
    id: z.string().trim().min(1),
    label: z.string().trim().min(1),
    type: providerTypeSchema,
    client: z.custom<LlmClient>(
      (value) =>
        typeof value === 'object' &&
        value !== null &&
        'stream' in value &&
        typeof value.stream === 'function',
    ),
    defaultModel: z.string().trim().min(1).optional(),
  })
  .strict();

function createInvalidDefinitionError(
  kind: 'Tool' | 'Provider',
  pluginId: string,
  cause: unknown,
): PluginError {
  return new PluginError(
    'plugin-invalid-definition',
    `${kind} definition for plugin "${pluginId}" is invalid`,
    { cause },
  );
}

function createCapabilityError(
  capability: PluginCapability,
  pluginId: string,
): PluginError {
  return new PluginError(
    'plugin-capability-not-declared',
    `Plugin "${pluginId}" did not declare "${capability}" capability`,
  );
}

function createDuplicateRegistrationError(
  kind: 'Tool' | 'Provider',
  name: string,
  pluginId: string,
): PluginError {
  return new PluginError(
    'plugin-invalid-definition',
    `${kind} "${name}" is registered more than once by plugin "${pluginId}"`,
  );
}

/**
 * Creates the private staged Context used by Plugin Registry.
 *
 * The returned Context only collects validated registrations. It has no access
 * to host services, filesystem APIs, HTTP objects or Runtime internals.
 */
export function createPluginContext(manifest: PluginManifest): StagedPluginContext {
  const tools: RegisteredToolDefinition[] = [];
  const providers: LlmProviderRegistration[] = [];

  return {
    registerTool<TInput, TOutput>(tool: ToolDefinition<TInput, TOutput>): void {
      if (!manifest.capabilities.includes('tool')) {
        throw createCapabilityError('tool', manifest.id);
      }

      const parsed = toolDefinitionSchema.safeParse(tool);
      if (!parsed.success) {
        throw createInvalidDefinitionError('Tool', manifest.id, parsed.error);
      }
      if (tools.some((registered) => registered.name === tool.name)) {
        throw createDuplicateRegistrationError('Tool', tool.name, manifest.id);
      }

      tools.push(tool as unknown as RegisteredToolDefinition);
    },

    registerProvider(provider: LlmProviderRegistration): void {
      if (!manifest.capabilities.includes('llm-provider')) {
        throw createCapabilityError('llm-provider', manifest.id);
      }

      const parsed = providerRegistrationSchema.safeParse(provider);
      if (!parsed.success) {
        throw createInvalidDefinitionError('Provider', manifest.id, parsed.error);
      }
      if (providers.some((registered) => registered.id === provider.id)) {
        throw createDuplicateRegistrationError('Provider', provider.id, manifest.id);
      }

      providers.push(provider);
    },

    getTools(): readonly RegisteredToolDefinition[] {
      return Object.freeze([...tools]);
    },

    getProviders(): readonly LlmProviderRegistration[] {
      return Object.freeze([...providers]);
    },
  };
}

/** Creates a secret-free immutable snapshot after host registration succeeds. */
export function createPluginSnapshot(
  manifest: PluginManifest,
  tools: readonly RegisteredToolDefinition[],
  providers: readonly LlmProviderRegistration[],
): PluginSnapshot {
  return Object.freeze({
    id: manifest.id,
    name: manifest.name,
    version: manifest.version,
    apiVersion: manifest.apiVersion,
    ...(manifest.description === undefined ? {} : { description: manifest.description }),
    capabilities: Object.freeze([...manifest.capabilities]),
    tools: Object.freeze(tools.map((tool) => tool.name)),
    providers: Object.freeze(providers.map((provider) => provider.id)),
  });
}

export type { LlmProviderType };
export type { PluginErrorCode };
