import { z } from 'zod';
import { pluginApiVersion } from './constants.js';
import { assertEngineSupported } from './declaration.js';
import { type KernelPlugin } from './kernel.js';
import { pluginManifestSchema, type PluginManifest } from './manifest.js';
import { PluginError } from './plugin-errors.js';
import {
  createPluginContext,
  createPluginSnapshot,
  type PluginSnapshot,
  type WeavePlugin,
} from './plugin-types.js';
import { llmProvidersExtensionPoint, toolsExtensionPoint } from './seams.js';

const pluginDefinitionSchema = z
  .object({
    manifest: z.unknown(),
    setup: z.custom<(...args: never[]) => unknown>((value) => typeof value === 'function'),
    dispose: z
      .custom<(...args: never[]) => unknown>((value) => typeof value === 'function')
      .optional(),
  })
  .strict();

/** Validates a legacy plugin's shape and manifest, returning it with the parsed manifest. */
export function parseLegacyPlugin(pluginInput: WeavePlugin): WeavePlugin {
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

/** The error for a plugin built against a different Plugin API version. */
export function createApiVersionError(manifest: PluginManifest, expected: string): PluginError {
  return new PluginError(
    'plugin-api-version-unsupported',
    `Plugin "${manifest.id}" requires API version "${manifest.apiVersion}", expected "${expected}"`,
  );
}

export interface AdaptLegacyPluginOptions {
  readonly apiVersion?: string | undefined;
  /** The host's Weave version, a full `x.y.z`, checked against `engines.weave`. */
  readonly hostVersion?: string | undefined;
  /**
   * Runs with the parsed manifest before `setup`, so a host can reject a
   * duplicate id before any plugin code executes.
   */
  readonly beforeSetup?: ((manifest: PluginManifest) => void) | undefined;
}

/** A legacy plugin re-expressed as a kernel plugin, with what it registered. */
export interface AdaptedLegacyPlugin {
  /** Contributes the staged tools and providers through the kernel's extension points. */
  readonly plugin: KernelPlugin;
  /** What the legacy registry would have returned for this plugin. */
  readonly snapshot: PluginSnapshot;
}

/**
 * Re-expresses a legacy `registerTool` / `registerProvider` plugin as a kernel
 * plugin whose registrations are extension-point contributions.
 *
 * The legacy `setup` runs once, here, against the staged Context, so every
 * check the legacy registry made at registration time (definition, manifest,
 * API version, engines, capability, `contributes`, duplicates inside the
 * plugin) still fails now with the same error code. The returned kernel
 * plugin only replays what was staged, so registering it into several kernels
 * never runs the legacy `setup` again, and its `dispose` runs at most once.
 */
export async function adaptLegacyPlugin(
  input: WeavePlugin,
  options: AdaptLegacyPluginOptions = {},
): Promise<AdaptedLegacyPlugin> {
  const legacy = parseLegacyPlugin(input);
  const { manifest } = legacy;
  const expectedApiVersion = options.apiVersion ?? pluginApiVersion;

  if (manifest.apiVersion !== expectedApiVersion) {
    throw createApiVersionError(manifest, expectedApiVersion);
  }
  assertEngineSupported(manifest, options.hostVersion);
  options.beforeSetup?.(manifest);

  const context = createPluginContext(manifest);
  try {
    await legacy.setup(context);
  } catch (error: unknown) {
    if (error instanceof PluginError) {
      throw error;
    }
    throw new PluginError('plugin-setup-failed', `Plugin "${manifest.id}" setup failed`, {
      cause: error,
    });
  }

  const tools = context.getTools();
  const providers = context.getProviders();
  let disposed = false;

  const plugin: KernelPlugin = {
    manifest,
    setup(env) {
      if (tools.length > 0) {
        env.contribute(toolsExtensionPoint, (api) => {
          for (const tool of tools) {
            api.addTool(tool);
          }
        });
      }
      if (providers.length > 0) {
        env.contribute(llmProvidersExtensionPoint, (api) => {
          for (const provider of providers) {
            api.addProvider(provider);
          }
        });
      }
    },
    ...(legacy.dispose === undefined
      ? {}
      : {
          async dispose(): Promise<void> {
            if (disposed) {
              return;
            }
            disposed = true;
            await legacy.dispose?.();
          },
        }),
  };

  return { plugin, snapshot: createPluginSnapshot(manifest, tools, providers) };
}
