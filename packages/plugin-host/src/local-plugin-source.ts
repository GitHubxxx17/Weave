import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import { z } from 'zod';

import { discoverLocalPlugins, type DiscoveryResult, type ReadyLocalPlugin } from './discovery.js';
import { PluginHostError } from './errors.js';
import { eligibleLocalPlugins, identity, immutable } from './host-state.js';
import { loadLocalPlugin } from './loader.js';
import type {
  LocalPluginSourceController,
  LocalPluginSourceMutation,
  LocalPluginSourceOptions,
  LocalPluginSourceSnapshot,
  LocalSourceAuthorityReason,
  LocalSourceMutationContext,
  LocalSourceStamp,
  PreparedLocalPlugin,
  PreparedLocalPluginFailure,
  PreparedLocalPlugins,
} from './local-source-types.js';
import { createPluginLifecycle } from './plugin-lifecycle.js';
import {
  foldTrust,
  recordedPluginTrustEventSchema,
  resolveLocalPlugins,
  type PluginTrustEvent,
  type RecordedPluginTrustEvent,
} from './trust.js';

export const callable = z.custom<(...args: never[]) => unknown>(
  (value) => typeof value === 'function',
);
const pluginId = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
const digest = z.string().regex(/^[0-9a-f]{64}$/);
const positiveInteger = z.number().int().positive();

export const localSourceConfiguration = z
  .object({
    discovery: z
      .object({
        directory: z.string().min(1),
        hostVersion: z
          .string()
          .regex(/^\d+\.\d+\.\d+$/)
          .optional(),
        reservedIds: z
          .custom<Iterable<string>>(
            (value) => value !== null && typeof value === 'object' && Symbol.iterator in value,
          )
          .optional(),
        maxCandidates: positiveInteger.optional(),
        limits: z
          .object({ maxFiles: positiveInteger.optional(), maxBytes: positiveInteger.optional() })
          .strict()
          .optional(),
      })
      .strict(),
    trustStore: z.object({ append: callable, events: callable }),
    sdk: z
      .object({
        apiVersion: z.string(),
        z: z.unknown(),
        defineServiceRef: callable,
        defineExtensionPoint: callable,
        defineHook: callable,
      })
      .passthrough()
      .optional(),
    setupTimeoutMs: z.number().finite().positive().optional(),
    importModule: callable.optional(),
    onAuthorityChange: callable.optional(),
  })
  .strict();

const mutation = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('trust'), id: pluginId, digest }),
  z.strictObject({ kind: z.literal('revoke'), id: pluginId, immediate: z.boolean().optional() }),
  z.strictObject({
    kind: z.literal('setEnabled'),
    id: pluginId,
    enabled: z.boolean(),
    immediate: z.boolean().optional(),
  }),
]);

const recordedEventsSchema = z.array(recordedPluginTrustEventSchema);

function disposed(): PluginHostError {
  return new PluginHostError('plugin-host-disposed', 'The plugin host is disposed');
}

function notFound(id: string): PluginHostError {
  return new PluginHostError('plugin-not-found', `Local plugin "${id}" was not found`, {
    pluginId: id,
  });
}

function badLog(): PluginHostError {
  return new PluginHostError(
    'plugin-reload-failed',
    'The local plugin trust log changed or moved backwards',
  );
}

function sameStamp(left: LocalSourceStamp, right: LocalSourceStamp): boolean {
  return left.revision === right.revision && left.trustSequence === right.trustSequence;
}

function changedIdentity(error: unknown): boolean {
  return (
    error instanceof PluginHostError &&
    (error.code === 'plugin-digest-mismatch' ||
      error.code === 'plugin-unreadable' ||
      error.code === 'plugin-unsupported-file' ||
      error.code === 'plugin-too-large')
  );
}

/** Administrative callers serialize source operations. Ownership of prepared items passes at return. */
export function createLocalPluginSource(
  options: LocalPluginSourceOptions,
): LocalPluginSourceController {
  localSourceConfiguration.parse(options);
  const reservedIds =
    options.discovery.reservedIds === undefined
      ? undefined
      : z.array(pluginId).parse([...options.discovery.reservedIds]);
  const discoveryOptions = {
    ...options.discovery,
    directory: path.resolve(options.discovery.directory),
    reservedIds,
  };
  let snapshot: LocalPluginSourceSnapshot = immutable({
    discovery: {
      directory: discoveryOptions.directory,
      exists: false,
      truncated: false,
      candidates: [],
    },
    plugins: [],
    trust: [],
    stamp: { revision: 0, trustSequence: 0 },
  });
  let events: readonly RecordedPluginTrustEvent[] = [];
  const stopping = new AbortController();
  const preparing = new Set<Promise<PreparedLocalPlugins>>();
  const cleanupErrors: unknown[] = [];
  let closing: Promise<void> | undefined;

  function ensureOpen(): void {
    stopping.signal.throwIfAborted();
  }

  function update(
    discovery: DiscoveryResult,
    reason: LocalSourceAuthorityReason,
    immediate = false,
  ): void {
    const current = snapshot;
    const trust = foldTrust(events);
    const previousTrust = new Map(current.trust.map((record) => [record.pluginId, record]));
    const affectedIds = new Set<string>();
    for (const id of new Set([...previousTrust.keys(), ...trust.keys()])) {
      if (!isDeepStrictEqual(previousTrust.get(id), trust.get(id))) affectedIds.add(id);
    }
    const discoveryChanged = !isDeepStrictEqual(discovery, current.discovery);
    if (discoveryChanged) {
      const previous = new Map(
        current.discovery.candidates.map((candidate) => [candidate.directory, candidate]),
      );
      for (const candidate of discovery.candidates) {
        const before = previous.get(candidate.directory);
        if (!isDeepStrictEqual(before, candidate)) {
          if (before) affectedIds.add(before.id);
          affectedIds.add(candidate.id);
        }
        previous.delete(candidate.directory);
      }
      for (const removed of previous.values()) affectedIds.add(removed.id);
    }
    const changed = discoveryChanged || affectedIds.size > 0;
    const trustSequence = events.at(-1)?.sequence ?? 0;
    if (!changed && trustSequence === current.stamp.trustSequence) return;
    snapshot = immutable({
      discovery,
      trust: [...trust.values()],
      plugins: resolveLocalPlugins(discovery.candidates, trust),
      stamp: { revision: current.stamp.revision + Number(changed), trustSequence },
    });
    if (changed) {
      options.onAuthorityChange?.({
        snapshot,
        reason,
        affectedIds: Object.freeze([...affectedIds]),
        immediate,
      });
    }
  }

  async function readTrust(): Promise<void> {
    ensureOpen();
    const found = recordedEventsSchema.parse(await options.trustStore.events());
    ensureOpen();
    // An append may have observed a high-water mark beyond the last complete read.
    if (
      found.some((event, index) => event.sequence !== index + 1) ||
      events.some((event) => !isDeepStrictEqual(event, found[event.sequence - 1]))
    ) {
      throw badLog();
    }
    events = found;
    update(snapshot.discovery, 'trust-log');
  }

  async function scan(): Promise<LocalPluginSourceSnapshot> {
    ensureOpen();
    const found = await discoverLocalPlugins(discoveryOptions);
    ensureOpen();
    update(found, 'discovery');
    return snapshot;
  }

  async function refresh(): Promise<LocalPluginSourceSnapshot> {
    await readTrust();
    return scan();
  }

  async function append(event: PluginTrustEvent, immediate = false): Promise<void> {
    ensureOpen();
    const recorded = recordedPluginTrustEventSchema.parse(await options.trustStore.append(event));
    const { sequence, occurredAt, scope } = recorded;
    if (
      sequence <= snapshot.stamp.trustSequence ||
      !isDeepStrictEqual(recorded, { ...event, sequence, occurredAt, scope })
    ) {
      throw badLog();
    }
    events = [...events, recorded];
    // Publish the durable fold and any admission change in the same continuation.
    update(
      snapshot.discovery,
      event.kind,
      immediate && (event.kind === 'revoked' || event.kind === 'disabled'),
    );
    ensureOpen();
    if (events.length !== sequence) await readTrust();
  }

  function ready(id: string): ReadyLocalPlugin {
    const matches = snapshot.discovery.candidates.filter((candidate) => candidate.id === id);
    const candidate = matches[0];
    if (candidate === undefined) throw notFound(id);
    if (matches.length !== 1 || candidate.status !== 'ready') {
      throw new PluginHostError(
        'plugin-not-loadable',
        `Local plugin "${id}" is not uniquely ready to load`,
        { pluginId: id },
      );
    }
    return candidate;
  }

  function requireDigest(candidate: ReadyLocalPlugin, reviewed: string): void {
    if (candidate.digest !== reviewed) {
      throw new PluginHostError(
        'plugin-digest-mismatch',
        `Local plugin "${candidate.id}" changed after review`,
        { pluginId: candidate.id },
      );
    }
  }

  async function mutate(
    command: LocalPluginSourceMutation,
    context?: LocalSourceMutationContext,
  ): Promise<LocalPluginSourceSnapshot> {
    ensureOpen();
    const change = mutation.parse(command);
    const { id } = change;
    if (change.kind === 'trust' || (change.kind === 'setEnabled' && change.enabled)) {
      await refresh();
    } else {
      await readTrust();
    }
    const trusted = snapshot.trust.find((record) => record.pluginId === id);
    if (change.kind === 'trust') {
      const candidate = ready(id);
      requireDigest(candidate, change.digest);
      if (trusted?.digest !== change.digest || !trusted.enabled) {
        await append({
          kind: 'trusted',
          pluginId: id,
          digest: change.digest,
          manifest: candidate.manifest,
        });
      }
      return snapshot;
    }
    if (change.kind === 'revoke') {
      if (trusted !== undefined) {
        await append({ kind: 'revoked', pluginId: id }, change.immediate);
        return scan();
      }
      await scan();
      if (!snapshot.plugins.some((row) => row.id === id) && !context?.hasActive?.(id)) {
        throw notFound(id);
      }
      if (change.immediate) context?.onImmediateRetry?.();
      return snapshot;
    }
    if (trusted === undefined) {
      throw new PluginHostError('plugin-not-trusted', `Local plugin "${id}" has not been trusted`, {
        pluginId: id,
      });
    }
    if (change.enabled) requireDigest(ready(id), trusted.digest);
    if (trusted.enabled !== change.enabled) {
      await append(
        { kind: change.enabled ? 'enabled' : 'disabled', pluginId: id },
        change.immediate,
      );
    } else if (!change.enabled && change.immediate) {
      context?.onImmediateRetry?.();
    }
    return change.enabled ? snapshot : scan();
  }

  async function prepare(
    stamp: LocalSourceStamp,
    { signal, excluded }: { readonly signal: AbortSignal; readonly excluded: ReadonlySet<string> },
  ): Promise<PreparedLocalPlugins> {
    ensureOpen();
    const preparationSignal = AbortSignal.any([signal, stopping.signal]);
    preparationSignal.throwIfAborted();
    const cached = snapshot;
    if (!sameStamp(stamp, cached.stamp)) {
      throw new PluginHostError(
        'plugin-reload-failed',
        'Local plugin source changed before preparation',
      );
    }
    const candidates = eligibleLocalPlugins(cached).filter(
      (plugin) => !excluded.has(identity(plugin)),
    );
    const items: PreparedLocalPlugin[] = [];
    const failures: PreparedLocalPluginFailure[] = [];
    try {
      for (const candidate of candidates) {
        const key = identity(candidate);
        try {
          const loaded = await loadLocalPlugin(candidate, {
            trustedDigest: candidate.digest,
            sdk: options.sdk,
            importModule: options.importModule,
            limits: discoveryOptions.limits,
            signal: preparationSignal,
          });
          const lifecycle = createPluginLifecycle(loaded, options.setupTimeoutMs ?? 10_000, signal);
          items.push(
            Object.freeze({
              id: candidate.id,
              digest: candidate.digest,
              identity: key,
              plugin: lifecycle.plugin,
              normalize: lifecycle.normalize,
              dispose: lifecycle.dispose,
              get cleanupErrors() {
                return lifecycle.cleanupErrors;
              },
            }),
          );
        } catch (error: unknown) {
          preparationSignal.throwIfAborted();
          const kind = changedIdentity(error) ? 'identity' : 'load';
          failures.push(Object.freeze({ id: candidate.id, identity: key, kind, error }));
          if (kind === 'identity') break;
        }
        preparationSignal.throwIfAborted();
      }
      return {
        stamp: cached.stamp,
        items: Object.freeze(items),
        failures: Object.freeze(failures),
        async dispose() {
          await Promise.all(items.map((item) => item.dispose()));
        },
      };
    } catch (error: unknown) {
      await Promise.all(items.map((item) => item.dispose()));
      for (const item of items) cleanupErrors.push(...item.cleanupErrors);
      throw error;
    }
  }

  return {
    snapshot: () => snapshot,
    refresh,
    mutate,
    prepare(stamp, options) {
      const pending = prepare(stamp, options);
      preparing.add(pending);
      const forget = () => {
        preparing.delete(pending);
      };
      void pending.then(forget, forget);
      return pending;
    },
    async recheck(prepared, signal) {
      signal.throwIfAborted();
      const next = await refresh();
      signal.throwIfAborted();
      const eligible = new Set(eligibleLocalPlugins(next).map(identity));
      return {
        valid:
          sameStamp(prepared.stamp, next.stamp) &&
          prepared.items.every((item) => eligible.has(item.identity)),
        snapshot: next,
      };
    },
    close() {
      if (closing === undefined) {
        closing = Promise.allSettled([...preparing]).then(() => {
          if (cleanupErrors.length > 0) {
            throw new AggregateError(cleanupErrors, 'Local plugin source disposal failed', {
              cause: cleanupErrors[0],
            });
          }
        });
        stopping.abort(disposed());
      }
      return closing;
    },
  };
}
