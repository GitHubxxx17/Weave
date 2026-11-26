import type { ExtensionCoordinator } from './extension-coordinator.js';
import { localExtensionSourceId } from './local-extension-source.js';
import { retainedArtifactDigests } from './managed-artifact-retention.js';
import type { PluginAuthorityDatabase } from './plugin-authority-types.js';

export interface ManagedArtifactReclaimResult {
  readonly removed: readonly string[];
  /** Unretained artifacts that a retained Generation still uses; retried later. */
  readonly deferred: readonly string[];
  readonly failed: readonly string[];
}

export interface ManagedArtifactStore {
  list(options?: { readonly signal?: AbortSignal | undefined }): Promise<readonly string[]>;
  remove(digest: string, options?: { readonly signal?: AbortSignal | undefined }): Promise<boolean>;
}

export interface ManagedArtifactReclaimer {
  /** Runs one pass inside the managed mutation queue, so it never races an import. */
  reclaim(): Promise<ManagedArtifactReclaimResult>;
  /** Schedules a pass without waiting. Failures are reported through `onError`. */
  request(): void;
  close(): void;
  drain(): Promise<void>;
}

export interface ManagedArtifactReclaimerOptions {
  readonly coordinator: Pick<ExtensionCoordinator, 'mutateManaged' | 'retainedGenerations'>;
  readonly authority: Pick<PluginAuthorityDatabase, 'snapshotSync'>;
  readonly store: ManagedArtifactStore;
  /** Delay before retrying a pass that deferred artifacts. */
  readonly retryDelayMs?: number;
  readonly onError?: (error: unknown) => void;
}

const defaultRetryDelayMs = 30_000;

/** Digests that any retained Generation still loads from the managed store. */
export function digestsInUse(
  generations: ReturnType<ExtensionCoordinator['retainedGenerations']>,
): ReadonlySet<string> {
  const digests = new Set<string>();
  for (const { members } of generations) {
    for (const member of members) {
      if (member.origin !== 'managed') continue;
      if (member.managedIdentity !== undefined) {
        digests.add(member.managedIdentity.digest);
        continue;
      }
      // Fall back to the JSON identity [pluginId, digest, 'managed', activationSequence].
      // Anything unparseable is treated as unknown content that must not be deleted.
      try {
        const parsed: unknown = JSON.parse(member.identity);
        if (Array.isArray(parsed) && typeof parsed[1] === 'string') digests.add(parsed[1]);
        else digests.add('*');
      } catch {
        digests.add('*');
      }
    }
  }
  return digests;
}

export function createManagedArtifactReclaimer(
  options: ManagedArtifactReclaimerOptions,
): ManagedArtifactReclaimer {
  const { coordinator, authority, store } = options;
  const retryDelayMs = options.retryDelayMs ?? defaultRetryDelayMs;
  const pending = new Set<Promise<unknown>>();
  let closed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let queued = false;
  let again = false;

  async function pass(signal: AbortSignal): Promise<ManagedArtifactReclaimResult> {
    const retained = retainedArtifactDigests(authority.snapshotSync());
    const inUse = digestsInUse(coordinator.retainedGenerations());
    const present = await store.list({ signal });
    const removed: string[] = [];
    const deferred: string[] = [];
    const failed: string[] = [];
    for (const digest of present) {
      if (retained.has(digest)) continue;
      // An unparseable member identity blocks every deletion until it is released.
      if (inUse.has(digest) || inUse.has('*')) {
        deferred.push(digest);
        continue;
      }
      try {
        if (await store.remove(digest, { signal })) removed.push(digest);
      } catch (error: unknown) {
        failed.push(digest);
        options.onError?.(error);
      }
    }
    return { removed, deferred, failed };
  }

  function track<T>(promise: Promise<T>): Promise<T> {
    pending.add(promise);
    const forget = (): void => {
      pending.delete(promise);
    };
    promise.then(forget, forget);
    return promise;
  }

  function schedule(delay: number): void {
    if (closed || timer !== undefined) return;
    timer = setTimeout(() => {
      timer = undefined;
      request();
    }, delay);
    timer.unref();
  }

  function reclaim(): Promise<ManagedArtifactReclaimResult> {
    if (closed) return Promise.resolve({ removed: [], deferred: [], failed: [] });
    return track(
      coordinator
        .mutateManaged<ManagedArtifactReclaimResult, never>(
          localExtensionSourceId,
          async (context) => {
            context.assertOpenSync();
            const replay = await pass(context.signal);
            return { disposition: 'skip-rebuild', replay };
          },
        )
        .then((completion) => {
          if (completion.kind !== 'replayed') throw new Error('Unexpected reclaim completion');
          const { replay } = completion;
          if (replay.deferred.length > 0 || replay.failed.length > 0) schedule(retryDelayMs);
          return replay;
        }),
    );
  }

  function request(): void {
    if (closed) return;
    if (queued) {
      again = true;
      return;
    }
    queued = true;
    void reclaim()
      .catch((error: unknown) => {
        options.onError?.(error);
        schedule(retryDelayMs);
      })
      .finally(() => {
        queued = false;
        if (again) {
          again = false;
          request();
        }
      });
  }

  return {
    reclaim,
    request,
    close() {
      closed = true;
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
    },
    async drain() {
      while (pending.size > 0) await Promise.allSettled([...pending]);
    },
  };
}
