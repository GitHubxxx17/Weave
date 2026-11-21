import { PluginHostError } from './errors.js';
import type { GenerationRequest, RunnerGeneration } from './generation-runner.js';
import {
  attemptedKey,
  eligibleLocalPlugins,
  HostState,
  identity,
  issueOf,
  ownerOf,
} from './host-state.js';
import type { CreatePluginHostOptions, PluginGenerationPort, ReloadResult } from './host-types.js';
import type { LocalPluginSourceController, PreparedLocalPlugin } from './local-source-types.js';

interface ReloadContext<R extends GenerationRequest, E, T> {
  readonly port: PluginGenerationPort<R, E, T>;
  readonly assemble: CreatePluginHostOptions<R, E, T>['assemble'];
  readonly source: LocalPluginSourceController;
  readonly state: HostState;
  readonly signal: AbortSignal;
  readonly cleanupErrors: unknown[];
}

/** One deterministic pass; each exclusion strictly shrinks the current survivor set. */
export async function reloadHost<R extends GenerationRequest, E, T>({
  port,
  assemble,
  source,
  state,
  signal,
  cleanupErrors,
}: ReloadContext<R, E, T>): Promise<ReloadResult> {
  signal.throwIfAborted();
  let snapshot = source.snapshot();
  let eligible = eligibleLocalPlugins(snapshot);
  let key = attemptedKey(eligible);
  const result = (unchanged: boolean) =>
    state.result(source.snapshot(), port.current().id, signal.aborted, unchanged);
  if (
    state.cleanKey === key &&
    state.blocked === undefined &&
    state.error === undefined &&
    state.failures.size === 0
  ) {
    return result(true);
  }
  state.cleanKey = undefined;
  state.failures = new Map();
  state.displayFailures = new Map();
  state.error = undefined;
  const excluded = new Set<string>();
  const refreshed = new Set<string>();
  const refreshBudget = eligible.length;

  function fail(key: string, error: unknown): void {
    const issue = issueOf(error);
    state.failures.set(key, issue);
    state.displayFailures.set(key, issue);
    excluded.add(key);
  }

  function hostFailure(error: unknown): ReloadResult {
    const issue = { code: 'plugin-reload-failed', message: issueOf(error).message };
    state.error = issue;
    for (const plugin of eligible) state.displayFailures.set(identity(plugin), issue);
    return result(false);
  }

  function track(item: PreparedLocalPlugin): PreparedLocalPlugin {
    let cleanup: Promise<void> | undefined;
    const dispose = () =>
      (cleanup ??= item.dispose().then(() => {
        cleanupErrors.push(...item.cleanupErrors);
      }));
    return {
      ...item,
      plugin: { ...item.plugin, dispose },
      dispose,
      get cleanupErrors() {
        return item.cleanupErrors;
      },
    };
  }

  async function cleanup(
    items: readonly PreparedLocalPlugin[],
    candidate?: RunnerGeneration<R, E, T>,
  ): Promise<void> {
    if (candidate !== undefined) {
      try {
        await candidate.dispose();
      } catch (error: unknown) {
        cleanupErrors.push(error);
      }
    }
    await Promise.all(items.map((item) => item.dispose()));
  }

  function finishPublished(): void {
    state.publishing = undefined;
    if (!signal.aborted) {
      state.blocked = undefined;
      if (state.failures.size === 0) state.cleanKey = key;
    }
  }

  while (true) {
    signal.throwIfAborted();
    const prepared = await source.prepare(snapshot.stamp, { signal, excluded });
    const items = prepared.items.map(track);
    const mismatch = prepared.failures.find(({ kind }) => kind === 'identity');
    for (const failure of prepared.failures) {
      if (failure.kind === 'load') fail(failure.identity, failure.error);
    }
    if (mismatch !== undefined) {
      await cleanup(items);
      signal.throwIfAborted();
      if (refreshed.has(mismatch.identity) || refreshed.size >= refreshBudget) {
        return hostFailure(
          new PluginHostError(
            'plugin-reload-failed',
            'Local plugin files kept changing during reload; retry after saving them',
            { cause: mismatch.error },
          ),
        );
      }
      refreshed.add(mismatch.identity);
      excluded.add(mismatch.identity);
      snapshot = await source.refresh();
      eligible = eligibleLocalPlugins(snapshot);
      // Publishing the remaining items would silently omit an identity still deemed eligible.
      if (eligible.some((candidate) => identity(candidate) === mismatch.identity)) {
        return hostFailure(
          new PluginHostError(
            'plugin-reload-failed',
            'A local plugin changed during reload and returned to its trusted digest',
            { cause: mismatch.error },
          ),
        );
      }
      key = attemptedKey(eligible);
      continue;
    }

    let candidate: RunnerGeneration<R, E, T> | undefined;
    try {
      signal.throwIfAborted();
      candidate = await assemble(items.map(({ plugin }) => plugin));
      signal.throwIfAborted();
      const currentId = port.current().id;
      if (!Number.isSafeInteger(candidate.id) || candidate.id <= currentId) {
        throw new PluginHostError(
          'plugin-reload-failed',
          `Candidate generation ${String(candidate.id)} does not advance current generation ${String(currentId)}`,
        );
      }
      const assembled = candidate;
      candidate = {
        id: assembled.id,
        runner: assembled.runner,
        resources: assembled.resources,
        async dispose() {
          try {
            await assembled.dispose();
          } finally {
            state.active.delete(assembled.id);
          }
        },
      };
      state.active.set(
        candidate.id,
        items.map(({ id, digest, plugin }) => ({
          id,
          digest,
          manifest: plugin.manifest,
        })),
      );
      state.publishing = candidate.id;
      await port.publish(candidate);
      finishPublished();
      return result(false);
    } catch (original: unknown) {
      // The compatibility port returns a Promise for both outcomes. The
      // committed pointer is authoritative if retirement rejects after commit.
      if (candidate !== undefined && port.current() === candidate) {
        cleanupErrors.push(original);
        finishPublished();
        return result(false);
      }
      if (state.publishing !== undefined) state.active.delete(state.publishing);
      state.publishing = undefined;
      await cleanup(items, candidate);
      signal.throwIfAborted();
      const error = prepared.items.reduce((error, item) => item.normalize(error), original);
      const blamed = prepared.items.find(({ id }) => id === ownerOf(error));
      if (blamed === undefined) return hostFailure(error);
      fail(blamed.identity, error);
    }
  }
}
