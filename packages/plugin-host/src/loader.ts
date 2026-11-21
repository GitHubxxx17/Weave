import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

import {
  createPluginSdk,
  definePlugin,
  type KernelPlugin,
  type PluginEnv,
  type PluginFactory,
  type PluginModule,
  type PluginSdk,
} from '@weave/plugin';
import { z } from 'zod';

import { computeDirectoryDigest, type DigestLimits } from './digest.js';
import { describeError, PluginHostError } from './errors.js';
import type { ReadyLocalPlugin } from './discovery.js';

/** Options of {@link loadLocalPlugin}. */
export interface LoadLocalPluginOptions {
  /** The digest the user trusted. The directory must still hash to it. */
  readonly trustedDigest: string;
  /** What the plugin's factory is given. Defaults to a new {@link createPluginSdk}. */
  readonly sdk?: PluginSdk | undefined;
  /** Replaces `import()`, for tests. */
  readonly importModule?: ((specifier: string) => Promise<unknown>) | undefined;
  readonly limits?: Partial<DigestLimits> | undefined;
  readonly signal?: AbortSignal | undefined;
}

/** The part of a discovered plugin the loader needs. */
export type LocalPluginSource = Pick<ReadyLocalPlugin, 'id' | 'directory' | 'entry' | 'manifest'>;

const pluginModuleSchema = z.object({
  setup: z.custom<PluginModule['setup']>((value) => typeof value === 'function', {
    message: 'setup must be a function',
  }),
  dispose: z
    .custom<NonNullable<PluginModule['dispose']>>((value) => typeof value === 'function', {
      message: 'dispose must be a function',
    })
    .optional(),
  // Checked against the descriptor below, not here.
  manifest: z.unknown().optional(),
});

function summarize(error: z.ZodError): string {
  return error.issues
    .map(
      (issue) => `${issue.path.length === 0 ? '(module)' : issue.path.join('.')}: ${issue.message}`,
    )
    .join('; ');
}

/** Whether `value` is, field for field, the manifest the user trusted. */
function sameManifest(value: unknown, trusted: LocalPluginSource['manifest']): boolean {
  try {
    // A round trip through JSON drops `undefined` fields, which the file the
    // user reviewed cannot have.
    const copy: unknown = JSON.parse(JSON.stringify(value));
    return isDeepStrictEqual(copy, JSON.parse(JSON.stringify(trusted)));
  } catch {
    return false;
  }
}

/**
 * Loads a plugin the user has trusted and returns it as a kernel plugin.
 *
 * This runs the plugin's code: `import()` evaluates the entry module, and its
 * factory runs before this returns. Call it only for a plugin whose trust
 * covers the current content, which is why the digest is computed again here,
 * immediately before importing, and compared with the one the user trusted.
 * Nothing in discovery or trust ever imports a plugin.
 *
 * The module's default export is a {@link PluginFactory}. It is called with the
 * SDK, and what it returns must have a `setup` function and may have `dispose`
 * and a `manifest`. The returned plugin's manifest is always the one from the
 * descriptor, the one the user was shown. A module that carries a `manifest` of
 * its own must carry the same one.
 *
 * Node keys loaded modules by URL and cannot unload them. The digest goes into
 * the URL, so changed content is a new module while unchanged content is the
 * same instance, state and all: a plugin keeps its state in `setup`, not at the
 * top of the module. The entry has to be one self-contained file, since what it
 * imports in turn is cached by path and the digest does not reach it.
 */
export async function loadLocalPlugin(
  plugin: LocalPluginSource,
  options: LoadLocalPluginOptions,
): Promise<KernelPlugin> {
  const { id, manifest } = plugin;
  const fail = (code: PluginHostError['code'], message: string, cause?: unknown): PluginHostError =>
    new PluginHostError(code, message, {
      pluginId: id,
      ...(cause === undefined ? {} : { cause }),
    });

  options.signal?.throwIfAborted();
  const { digest } = await computeDirectoryDigest(plugin.directory, {
    limits: options.limits,
    pluginId: id,
  });
  options.signal?.throwIfAborted();
  if (digest !== options.trustedDigest) {
    throw fail(
      'plugin-digest-mismatch',
      `Plugin "${id}" has changed since it was trusted; review it again before it loads`,
    );
  }

  const url = new URL(pathToFileURL(plugin.entry).href);
  url.searchParams.set('digest', digest);
  const importModule = options.importModule ?? ((specifier: string) => import(specifier));

  let moduleNamespace: unknown;
  try {
    moduleNamespace = await importModule(url.href);
  } catch (error: unknown) {
    throw fail(
      'plugin-load-failed',
      `Plugin "${id}" failed while loading: ${describeError(error)}`,
      error,
    );
  }

  options.signal?.throwIfAborted();
  const factory =
    typeof moduleNamespace === 'object' && moduleNamespace !== null
      ? (moduleNamespace as { readonly default?: unknown }).default
      : undefined;
  if (typeof factory !== 'function') {
    throw fail('plugin-invalid-module', `Plugin "${id}" must export a function as its default`);
  }

  let produced: unknown;
  try {
    produced = await (factory as PluginFactory)(options.sdk ?? createPluginSdk());
  } catch (error: unknown) {
    throw fail(
      'plugin-load-failed',
      `Plugin "${id}" failed in its factory: ${describeError(error)}`,
      error,
    );
  }

  const parsed = pluginModuleSchema.safeParse(produced);
  if (!parsed.success) {
    throw fail(
      'plugin-invalid-module',
      `Plugin "${id}" returned something that is not a plugin module: ${summarize(parsed.error)}`,
      parsed.error,
    );
  }
  const { setup, dispose, manifest: declared } = parsed.data;
  if (declared !== undefined && !sameManifest(declared, manifest)) {
    throw fail(
      'plugin-manifest-mismatch',
      `Plugin "${id}" carries a manifest that differs from the one in its descriptor; only the descriptor's is shown to the user`,
    );
  }

  const module = produced as PluginModule;
  return definePlugin({
    manifest,
    setup: (env: PluginEnv) => setup.call(module, env),
    ...(dispose === undefined ? {} : { dispose: () => dispose.call(module) }),
  });
}
