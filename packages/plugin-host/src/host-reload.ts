import type { KernelPlugin } from '@weave/plugin';

import type { ReadyLocalPlugin } from './discovery.js';
import { PluginHostError } from './errors.js';
import type { GenerationRequest, RunnerGeneration } from './generation-runner.js';
import { attemptedKey, HostState, identity, issueOf, ownerOf } from './host-state.js';
import type { CreatePluginHostOptions, ReloadResult } from './host-types.js';
import { loadLocalPlugin } from './loader.js';
import { createPluginLifecycle } from './plugin-lifecycle.js';

interface ReloadContext<R extends GenerationRequest, E, T> {
  readonly options: CreatePluginHostOptions<R, E, T>;
  readonly state: HostState;
  readonly closed: () => boolean;
  readonly ensureOpen: () => void;
  readonly refresh: () => Promise<void>;
  readonly cleanupErrors: unknown[];
}

type Lifecycle = ReturnType<typeof createPluginLifecycle>;

/** One deterministic pass; each exclusion strictly shrinks the current survivor set. */
export async function reloadHost<R extends GenerationRequest, E, T>(
  context: ReloadContext<R, E, T>,
): Promise<ReloadResult> {
  const { options, state, ensureOpen } = context;
  const port = options.generations;
  let eligible = state.eligible();
  let key = attemptedKey(eligible);
  if (
    state.cleanKey === key &&
    state.blocked === undefined &&
    state.error === undefined &&
    state.failures.size === 0
  ) {
    return state.result(port.current().id, context.closed(), true);
  }
  state.cleanKey = undefined;
  state.failures = new Map();
  state.displayFailures = new Map();
  state.error = undefined;
  const excluded = new Set<string>();
  const refreshed = new Set<string>();
  const refreshBudget = eligible.length;
  let refreshes = 0;

  function track(original: Lifecycle): Lifecycle {
    let observed = false;
    async function dispose(): Promise<void> {
      await original.dispose();
      if (!observed) {
        observed = true;
        context.cleanupErrors.push(...original.cleanupErrors);
      }
    }
    return {
      plugin: {
        manifest: original.plugin.manifest,
        setup: (env) => original.plugin.setup(env),
        dispose,
      },
      dispose,
      normalize: (error) => original.normalize(error),
      get cleanupErrors() {
        return original.cleanupErrors;
      },
    };
  }

  function fail(plugin: ReadyLocalPlugin, error: unknown): void {
    const issue = issueOf(error);
    const id = identity(plugin);
    state.failures.set(id, issue);
    state.displayFailures.set(id, issue);
    excluded.add(id);
  }

  function hostFailure(error: unknown): ReloadResult {
    const detail = issueOf(error);
    const issue = { code: 'plugin-reload-failed', message: detail.message };
    state.error = issue;
    for (const plugin of state.eligible()) state.displayFailures.set(identity(plugin), issue);
    return state.result(port.current().id, context.closed(), false);
  }

  async function cleanup(
    lifecycles: readonly Lifecycle[],
    candidate?: RunnerGeneration<R, E, T>,
  ): Promise<void> {
    if (candidate) {
      try {
        await candidate.dispose();
      } catch (error: unknown) {
        context.cleanupErrors.push(error);
      }
    }
    await Promise.all(lifecycles.map((lifecycle) => lifecycle.dispose()));
  }

  while (true) {
    ensureOpen();
    const survivors = eligible.filter((plugin) => !excluded.has(identity(plugin)));
    const lifecycles: Lifecycle[] = [];
    let restart = false;
    for (const plugin of survivors) {
      try {
        const loaded = await loadLocalPlugin(plugin, {
          trustedDigest: plugin.digest,
          sdk: options.sdk,
          importModule: options.importModule,
          limits: options.discovery.limits,
        });
        const lifecycle = track(createPluginLifecycle(loaded, options.setupTimeoutMs ?? 10_000));
        lifecycles.push(lifecycle);
        ensureOpen();
      } catch (error: unknown) {
        if (context.closed()) {
          await cleanup(lifecycles);
          ensureOpen();
        }
        if (
          error instanceof PluginHostError &&
          (error.code === 'plugin-digest-mismatch' ||
            error.code === 'plugin-unreadable' ||
            error.code === 'plugin-unsupported-file' ||
            error.code === 'plugin-too-large')
        ) {
          const mismatched = identity(plugin);
          await cleanup(lifecycles);
          if (refreshed.has(mismatched) || refreshes >= refreshBudget) {
            return hostFailure(
              new PluginHostError(
                'plugin-reload-failed',
                'Local plugin files kept changing during reload; retry after saving them',
                { cause: error },
              ),
            );
          }
          refreshed.add(mismatched);
          refreshes += 1;
          excluded.add(mismatched);
          await context.refresh();
          eligible = state.eligible();
          // The bytes returned to the same trusted identity after the mismatch;
          // excluding it would otherwise publish an apparently clean generation
          // that silently omits an eligible plugin.
          if (eligible.some((candidate) => identity(candidate) === mismatched)) {
            return hostFailure(
              new PluginHostError(
                'plugin-reload-failed',
                'A local plugin changed during reload and returned to its trusted digest',
                { cause: error },
              ),
            );
          }
          key = attemptedKey(eligible);
          restart = true;
          break;
        }
        fail(plugin, error);
      }
    }
    if (restart) continue;
    ensureOpen();
    const loadedIds = new Set(lifecycles.map((lifecycle) => lifecycle.plugin.manifest.id));
    const loaded = survivors.filter((plugin) => loadedIds.has(plugin.id));
    let candidate: RunnerGeneration<R, E, T> | undefined;
    let previousActive: ReturnType<typeof state.active.get>;
    let staged = false;
    try {
      candidate = await options.assemble(
        lifecycles.map((lifecycle): KernelPlugin => lifecycle.plugin),
      );
      ensureOpen();
      if (!Number.isSafeInteger(candidate.id) || candidate.id <= port.current().id) {
        throw new PluginHostError(
          'plugin-reload-failed',
          `Candidate generation ${String(candidate.id)} does not advance current generation ${String(port.current().id)}`,
        );
      }
      previousActive = state.active.get(candidate.id);
      state.active.set(
        candidate.id,
        loaded.map(({ id, digest, manifest }) => ({ id, digest, manifest })),
      );
      staged = true;
      state.publishing = candidate.id;
      await port.publish(candidate);
      // Port ownership starts at publication. Retirement may still be finishing here.
      candidate = undefined;
      state.publishing = undefined;
      for (const id of state.active.keys()) if (id !== port.current().id) state.active.delete(id);
      if (!context.closed()) state.blocked = undefined;
      if (state.failures.size === 0 && !context.closed()) state.cleanKey = key;
      return state.result(port.current().id, context.closed(), false);
    } catch (original: unknown) {
      let error = original;
      state.publishing = undefined;
      for (const lifecycle of lifecycles) error = lifecycle.normalize(error);
      if (candidate && staged) {
        if (previousActive === undefined) state.active.delete(candidate.id);
        else state.active.set(candidate.id, previousActive);
      }
      await cleanup(lifecycles, candidate);
      ensureOpen();
      const owner = ownerOf(error);
      const blamed = owner === undefined ? undefined : loaded.find((plugin) => plugin.id === owner);
      if (!blamed) return hostFailure(error);
      fail(blamed, error);
    }
  }
}
