import path from 'node:path';

import { z } from 'zod';

import { discoverLocalPlugins, type ReadyLocalPlugin } from './discovery.js';
import { PluginHostError } from './errors.js';
import type { GenerationRequest } from './generation-runner.js';
import { HostQueue } from './host-queue.js';
import { reloadHost } from './host-reload.js';
import { HostState } from './host-state.js';
import type { CreatePluginHostOptions, PluginHost, ReloadResult } from './host-types.js';
import { recordedPluginTrustEventSchema, type PluginTrustEvent } from './trust.js';

const callable = z.custom<(...args: never[]) => unknown>((value) => typeof value === 'function');
const pluginId = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
const digest = z.string().regex(/^[0-9a-f]{64}$/);
const mutationOptions = z.object({ immediate: z.boolean().optional() }).strict().optional();
const positiveInteger = z.number().int().positive();

const configuration = z
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
    generations: z.object({
      runner: z.object({ run: callable }),
      current: callable,
      publish: callable,
      blockNewRuns: callable,
      abortActiveRuns: callable,
      dispose: callable,
    }),
    assemble: callable,
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
  })
  .strict();

/** Coordinates local desired state through the injected, already published generation facade. */
export async function createPluginHost<R extends GenerationRequest, E, T>(
  options: CreatePluginHostOptions<R, E, T>,
): Promise<PluginHost<R, E, T>> {
  configuration.parse(options);
  const reservedIds =
    options.discovery.reservedIds === undefined
      ? undefined
      : z.array(pluginId).parse([...options.discovery.reservedIds]);
  const discovery = { ...options.discovery, ...(reservedIds === undefined ? {} : { reservedIds }) };
  const port = options.generations;
  const state = new HostState(path.resolve(discovery.directory));
  state.active.set(port.current().id, []);
  const queue = new HostQueue<ReloadResult>();
  const cleanupErrors: unknown[] = [];
  let closed = false;
  let closing: Promise<void> | undefined;

  function disposed(): PluginHostError {
    return new PluginHostError('plugin-host-disposed', 'The plugin host is disposed');
  }

  function ensureOpen(): void {
    if (closed) throw disposed();
  }

  function block(immediate = false): void {
    const error = new PluginHostError(
      'plugin-generation-blocked',
      'Local plugin trust changed; new runs wait for a compliant generation',
    );
    state.blocked = { code: error.code, message: error.message };
    port.blockNewRuns(error);
    if (immediate) port.abortActiveRuns(error);
  }

  function checkActiveTrust(): void {
    const active = state.active.get(port.current().id) ?? [];
    if (active.some((plugin) => !state.trust.get(plugin.id)?.enabled)) block();
  }

  async function refresh(readEvents = true): Promise<void> {
    ensureOpen();
    if (readEvents) await readTrust();
    const found = await discoverLocalPlugins(discovery);
    state.discovery = found;
    ensureOpen();
  }

  async function readTrust(): Promise<void> {
    ensureOpen();
    const events = z.array(recordedPluginTrustEventSchema).parse(await options.trustStore.events());
    state.setEvents(events);
    checkActiveTrust();
    ensureOpen();
  }

  function reloadCached(): Promise<ReloadResult> {
    return reloadHost({
      options: { ...options, discovery },
      state,
      closed: () => closed,
      ensureOpen,
      refresh,
      cleanupErrors,
    });
  }

  async function reload(): Promise<ReloadResult> {
    await refresh();
    return reloadCached();
  }

  function ready(id: string): ReadyLocalPlugin {
    const matches = state.discovery.candidates.filter((candidate) => candidate.id === id);
    if (matches.length === 0)
      throw new PluginHostError('plugin-not-found', `Local plugin "${id}" was not found`, {
        pluginId: id,
      });
    const candidate = matches[0]!;
    if (matches.length !== 1 || candidate.status !== 'ready')
      throw new PluginHostError(
        'plugin-not-loadable',
        `Local plugin "${id}" is not uniquely ready to load`,
        { pluginId: id },
      );
    return candidate;
  }

  async function append(event: PluginTrustEvent, immediate = false): Promise<void> {
    ensureOpen();
    const recorded = recordedPluginTrustEventSchema.parse(await options.trustStore.append(event));
    // The durable decision and admission change happen before any following await.
    state.setEvents([...state.events, recorded]);
    if (event.kind === 'revoked' || event.kind === 'disabled') block(immediate);
    ensureOpen();
  }

  const host: PluginHost<R, E, T> = {
    runner: port.runner,
    list: () => state.snapshot(port.current().id, closed).plugins,
    snapshot: () => state.snapshot(port.current().id, closed),
    reload: () => queue.enqueue(true, reload),
    trust: (id, reviewedDigest) =>
      queue.enqueue(false, async () => {
        pluginId.parse(id);
        digest.parse(reviewedDigest);
        await refresh();
        const candidate = ready(id);
        if (candidate.digest !== reviewedDigest)
          throw new PluginHostError(
            'plugin-digest-mismatch',
            `Local plugin "${id}" changed after review`,
            { pluginId: id },
          );
        const trusted = state.trust.get(id);
        if (trusted?.digest !== reviewedDigest || !trusted.enabled) {
          await append({
            kind: 'trusted',
            pluginId: id,
            digest: candidate.digest,
            manifest: candidate.manifest,
          });
        }
        return reloadCached();
      }),
    revoke: (id, mutation) =>
      queue.enqueue(false, async () => {
        pluginId.parse(id);
        const parsed = mutationOptions.parse(mutation);
        await readTrust();
        if (state.trust.has(id)) {
          await append({ kind: 'revoked', pluginId: id }, parsed?.immediate);
          await refresh(false);
        } else {
          await refresh(false);
          if (
            !state.discovery.candidates.some((candidate) => candidate.id === id) &&
            !(state.active.get(port.current().id) ?? []).some((plugin) => plugin.id === id)
          ) {
            throw new PluginHostError('plugin-not-found', `Local plugin "${id}" was not found`, {
              pluginId: id,
            });
          }
          if (parsed?.immediate && state.blocked !== undefined) block(true);
        }
        return reloadCached();
      }),
    setEnabled: (id, enabled, mutation) =>
      queue.enqueue(false, async () => {
        pluginId.parse(id);
        z.boolean().parse(enabled);
        const parsed = mutationOptions.parse(mutation);
        if (enabled) await refresh();
        else await readTrust();
        const trusted = state.trust.get(id);
        if (!trusted)
          throw new PluginHostError(
            'plugin-not-trusted',
            `Local plugin "${id}" has not been trusted`,
            { pluginId: id },
          );
        if (enabled) {
          const candidate = ready(id);
          if (candidate.digest !== trusted.digest)
            throw new PluginHostError(
              'plugin-digest-mismatch',
              `Local plugin "${id}" changed after review`,
              { pluginId: id },
            );
        }
        if (trusted.enabled !== enabled)
          await append({ kind: enabled ? 'enabled' : 'disabled', pluginId: id }, parsed?.immediate);
        else if (!enabled && parsed?.immediate && state.blocked !== undefined) block(true);
        if (!enabled) await refresh(false);
        return reloadCached();
      }),
    dispose() {
      if (!closing) {
        closed = true;
        const error = disposed();
        state.blocked = { code: error.code, message: error.message };
        port.blockNewRuns(error);
        port.abortActiveRuns(error);
        const settled = queue.close(error);
        closing = (async () => {
          await settled;
          try {
            await port.dispose();
          } catch (error: unknown) {
            cleanupErrors.push(error);
          }
          const errors = [...cleanupErrors];
          if (errors.length > 0)
            throw new AggregateError(errors, 'Plugin host disposal failed', { cause: errors[0] });
        })();
      }
      return closing;
    },
  };
  await host.reload();
  return host;
}
