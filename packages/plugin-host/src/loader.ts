import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

import {
  createPluginSdk,
  definePlugin,
  skillsExtensionPoint,
  skillContributionSchema,
  type KernelPlugin,
  type PluginEnv,
  type PluginFactory,
  type PluginModule,
  type PluginSdk,
} from '@weave/plugin';
import { z } from 'zod';

import { computeDirectoryDigest, type DigestLimits } from './digest.js';
import { describeError, ExplicitLocalAuthorityError, PluginHostError } from './errors.js';
import type { ReadyLocalPlugin } from './discovery.js';
import type { PluginPayload } from './artifact-types.js';
import { inspectPluginPayload } from './payload-inspector.js';

/** Options of {@link loadLocalPlugin}. */
export interface LoadLocalPluginOptions {
  /** The digest the user trusted. The current bytes must still match it. */
  readonly trustedDigest: string;
  /** What the plugin's factory is given. Defaults to a new {@link createPluginSdk}. */
  readonly sdk?: PluginSdk | undefined;
  /** Replaces `import()`, for tests. */
  readonly importModule?: ((specifier: string) => Promise<unknown>) | undefined;
  readonly limits?: Partial<DigestLimits> | undefined;
  readonly signal?: AbortSignal | undefined;
  /** Managed artifact verification and authority checks. Requires an attempt signal. */
  readonly explicitChecks?:
    | {
        verify(signal: AbortSignal): Promise<PluginPayload & { readonly digest: string }>;
        assertReadySync(): undefined;
      }
    | undefined;
}

/** The part of a discovered plugin the loader needs. */
export type LocalPluginSource = Pick<ReadyLocalPlugin, 'id' | 'directory' | 'manifest'> &
  PluginPayload;

const verifiedEntrySchema = z.strictObject({
  kind: z.literal('entry').optional(),
  entry: z.string().refine(isAbsolute),
  digest: z.string().regex(/^[0-9a-f]{64}$/),
});
const verifiedSkillsSchema = z.strictObject({
  kind: z.literal('skills'),
  skills: z.array(skillContributionSchema).min(1).max(16),
  digest: z.string().regex(/^[0-9a-f]{64}$/),
});

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
 * covers the current content. The loader verifies the digest just before import
 * using directory hashing or the managed artifact verifier.
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
  const { explicitChecks, signal } = options;
  const fail = (code: PluginHostError['code'], message: string, cause?: unknown): PluginHostError =>
    new PluginHostError(code, message, {
      pluginId: id,
      ...(cause === undefined ? {} : { cause }),
    });
  const changedIdentity = () =>
    fail(
      'plugin-digest-mismatch',
      `Plugin "${id}" has changed since it was trusted; review it again before it loads`,
    );

  function assertExplicitReady(): void {
    if (explicitChecks === undefined) return;
    signal?.throwIfAborted();
    try {
      const result: unknown = explicitChecks.assertReadySync();
      if (result !== undefined) {
        void Promise.resolve(result).catch(() => undefined);
        throw new TypeError('Explicit local plugin authority check must return undefined');
      }
    } catch (cause: unknown) {
      throw new ExplicitLocalAuthorityError(cause);
    }
    signal?.throwIfAborted();
  }

  signal?.throwIfAborted();
  if (plugin.kind === 'skills') {
    if (manifest.host !== 'declarative') throw changedIdentity();
    assertExplicitReady();
    if (explicitChecks !== undefined) {
      if (signal === undefined)
        throw new TypeError('Explicit local plugin checks require a signal');
      const raw = await explicitChecks.verify(signal);
      signal.throwIfAborted();
      const verified = verifiedSkillsSchema.safeParse(raw);
      if (
        !verified.success ||
        verified.data.digest !== options.trustedDigest ||
        !isDeepStrictEqual(verified.data.skills, plugin.skills)
      )
        throw changedIdentity();
    }
    const artifact = await inspectPluginPayload(plugin.directory, {
      signal,
      limits: options.limits,
    });
    signal?.throwIfAborted();
    if (
      artifact.kind !== 'skills' ||
      artifact.digest !== options.trustedDigest ||
      !sameManifest(artifact.descriptor.manifest, manifest) ||
      !isDeepStrictEqual(artifact.skills, plugin.skills)
    )
      throw changedIdentity();
    assertExplicitReady();
    return definePlugin({
      manifest,
      setup(env) {
        signal?.throwIfAborted();
        assertExplicitReady();
        env.contribute(skillsExtensionPoint, (api) => {
          // Admission authority is checked at setup. A retained Generation owns
          // this immutable snapshot even after a newer selection replaces it.
          for (const skill of artifact.skills) api.addSkill(skill);
        });
      },
    });
  }
  if (manifest.host === 'declarative') throw changedIdentity();
  let entry = plugin.entry;
  let digest: string;
  if (explicitChecks === undefined) {
    ({ digest } = await computeDirectoryDigest(plugin.directory, {
      limits: options.limits,
      pluginId: id,
    }));
    signal?.throwIfAborted();
  } else {
    if (signal === undefined) throw new TypeError('Explicit local plugin checks require a signal');
    const result = await explicitChecks.verify(signal);
    signal.throwIfAborted();
    if (result.kind === 'skills') throw changedIdentity();
    const verified = verifiedEntrySchema.safeParse(result);
    if (!verified.success || verified.data.entry !== entry) throw changedIdentity();
    ({ entry, digest } = verified.data);
  }
  if (digest !== options.trustedDigest) throw changedIdentity();

  const url = pathToFileURL(entry);
  url.searchParams.set('digest', digest);
  const importModule = options.importModule ?? ((specifier: string) => import(specifier));

  let moduleNamespace: unknown;
  assertExplicitReady();
  try {
    moduleNamespace = await importModule(url.href);
  } catch (error: unknown) {
    throw fail(
      'plugin-load-failed',
      `Plugin "${id}" failed while loading: ${describeError(error)}`,
      error,
    );
  }

  signal?.throwIfAborted();
  const factory =
    typeof moduleNamespace === 'object' && moduleNamespace !== null
      ? (moduleNamespace as { readonly default?: unknown }).default
      : undefined;
  if (typeof factory !== 'function') {
    throw fail('plugin-invalid-module', `Plugin "${id}" must export a function as its default`);
  }

  const failFactory = (error: unknown): PluginHostError =>
    fail(
      'plugin-load-failed',
      `Plugin "${id}" failed in its factory: ${describeError(error)}`,
      error,
    );
  let sdk: PluginSdk;
  try {
    sdk = options.sdk ?? createPluginSdk();
  } catch (error: unknown) {
    throw failFactory(error);
  }

  let produced: unknown;
  assertExplicitReady();
  try {
    produced = await (factory as PluginFactory)(sdk);
  } catch (error: unknown) {
    throw failFactory(error);
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
    setup(env: PluginEnv) {
      assertExplicitReady();
      return setup.call(module, env);
    },
    ...(dispose === undefined ? {} : { dispose: () => dispose.call(module) }),
  });
}
