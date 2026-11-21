import { PluginError, type KernelPlugin } from '@weave/plugin';
import { PluginHostError, type LocalPluginIssue } from '@weave/plugin-host';
import type {
  ExtensionAuthorityObserver,
  ExtensionFailure,
  ExtensionGenerationSnapshot,
  ExtensionIdentity,
  ExtensionMember,
  ExtensionPreparationFailure,
  ExtensionSource,
  ExtensionSourceFactory,
  ExtensionSourceSnapshot,
  ExtensionSourceStamp,
  PreparedExtensionSource,
} from './extension-types.js';
import type { ServerGeneration, ServerGenerationController, ServerHost } from './server-host.js';

interface ExtensionState {
  readonly generation: ExtensionGenerationSnapshot;
  readonly members: readonly ExtensionMember[];
  readonly failed: readonly ExtensionFailure[];
  readonly error?: LocalPluginIssue;
}

interface ExtensionReloadResult extends ExtensionState {
  readonly unchanged: boolean;
}

export interface ExtensionCoordinator {
  readonly runner: ServerGenerationController['runner'];
  generationSnapshot(): ExtensionGenerationSnapshot;
  snapshot(): ExtensionState;
  reload(): Promise<ExtensionReloadResult>;
  mutate(sourceId: string, operation: () => Promise<unknown>): Promise<ExtensionReloadResult>;
  hasActive(sourceId: string, pluginId: string): boolean;
  retryImmediateRevocation(sourceId: string, pluginId: string): void;
  dispose(): Promise<void>;
}

interface ExtensionCoordinatorOptions {
  readonly host: ServerHost;
  readonly sources: readonly ExtensionSourceFactory[];
  readonly assemble: (plugins: readonly KernelPlugin[]) => Promise<ServerGeneration>;
}

interface PendingOperation {
  readonly reload: boolean;
  readonly run: () => Promise<ExtensionReloadResult>;
  readonly result: ReturnType<typeof deferred<ExtensionReloadResult>>;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((accept, fail) => {
    resolve = accept;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function requireController(host: ServerHost): ServerGenerationController {
  const controller = host.controller();
  if (controller === undefined)
    throw new Error('Extensions require an initialized Server generation');
  return controller;
}

function sameStamp(left: ExtensionSourceStamp, right: ExtensionSourceStamp) {
  return left.revision === right.revision && left.trustSequence === right.trustSequence;
}

function matches(left: ExtensionIdentity, right: ExtensionIdentity) {
  return left.pluginId === right.pluginId && left.identity === right.identity;
}

function issueOf(error: unknown): LocalPluginIssue {
  if (error instanceof PluginHostError || error instanceof PluginError) {
    return { code: error.code, message: error.message };
  }
  return {
    code: 'plugin-reload-failed',
    message: error instanceof Error ? error.message : String(error),
  };
}

function disposed() {
  return new PluginHostError('plugin-host-disposed', 'The plugin host is disposed');
}

function sourceStateChanged() {
  return new PluginHostError(
    'plugin-reload-failed',
    'Extension authority or files kept changing during reload; retry after saving them',
  );
}

/** Owns publication and admission for the complete set of Server extension sources. */
export function createExtensionCoordinator(
  options: ExtensionCoordinatorOptions,
): ExtensionCoordinator {
  const controller = requireController(options.host);
  const pending: PendingOperation[] = [];
  const cleanupErrors: unknown[] = [];
  const authorityStamps = new Map<string, ExtensionSourceStamp>();
  const activeByGeneration = new Map<number, readonly ExtensionMember[]>();
  let desiredRevision = 0;
  let members: readonly ExtensionMember[] = [];
  let failed: readonly ExtensionFailure[] = [];
  let error: LocalPluginIssue | undefined;
  let blocked: PluginHostError | undefined;
  let running: Promise<void> | undefined;
  let closing: Promise<void> | undefined;
  let closed = false;
  let preparing: AbortController | undefined;

  const observe: ExtensionAuthorityObserver = (sourceId, change) => {
    if (closed) return;
    const { stamp, eligible } = change.snapshot;
    const previous = authorityStamps.get(sourceId);
    if (previous !== undefined && sameStamp(previous, stamp)) return;
    authorityStamps.set(sourceId, stamp);
    desiredRevision += 1;
    const unauthorized = members.some(
      (member) => member.sourceId === sourceId && !eligible.some((item) => matches(item, member)),
    );
    if (unauthorized) {
      blocked = new PluginHostError(
        'plugin-generation-blocked',
        'Extension trust changed; new runs wait for a compliant generation',
      );
      controller.blockNewRuns(blocked);
    }
    if (change.immediate && change.affectedIds.length > 0) {
      controller.abortActiveRuns(blocked ?? new Error('Extension admission changed'));
    }
  };
  const sources = options.sources.map((create) => create(observe));
  if (new Set(sources.map((source) => source.id)).size !== sources.length) {
    throw new Error('Extension source ids must be unique');
  }
  for (const source of sources) {
    authorityStamps.set(source.id, source.snapshot().stamp);
  }

  function ensureOpen(): void {
    if (closed) throw disposed();
  }

  function generationSnapshot(): ExtensionGenerationSnapshot {
    return {
      id: controller.current().id,
      acceptingRuns: blocked === undefined,
      ...(blocked === undefined ? {} : { blocked: issueOf(blocked) }),
    };
  }

  function snapshot(): ExtensionState {
    return structuredClone({
      generation: generationSnapshot(),
      members,
      failed,
      ...(error === undefined ? {} : { error }),
    });
  }

  function result(unchanged: boolean): ExtensionReloadResult {
    return { ...snapshot(), unchanged };
  }

  function hasActive(sourceId: string, pluginId: string): boolean {
    for (const active of activeByGeneration.values()) {
      if (active.some((member) => member.sourceId === sourceId && member.pluginId === pluginId)) {
        return true;
      }
    }
    return false;
  }

  async function drain(): Promise<void> {
    try {
      while (pending.length > 0) {
        const operation = pending.shift()!;
        try {
          operation.result.resolve(await operation.run());
        } catch (reason: unknown) {
          operation.result.reject(reason);
        }
      }
    } finally {
      running = undefined;
    }
  }

  function enqueue(
    reload: boolean,
    run: () => Promise<ExtensionReloadResult>,
  ): Promise<ExtensionReloadResult> {
    if (closed) return Promise.reject(disposed());
    const previous = pending.at(-1);
    if (reload && previous?.reload) return previous.result.promise;
    const operation = deferred<ExtensionReloadResult>();
    pending.push({ reload, run, result: operation });
    running ??= Promise.resolve().then(drain);
    return operation.promise;
  }

  async function refresh(skip?: string): Promise<void> {
    ensureOpen();
    for (const source of sources) {
      if (source.id !== skip) await source.refresh();
      ensureOpen();
    }
  }

  function captureAuthority(): ReadonlyMap<ExtensionSource, ExtensionSourceSnapshot> {
    return new Map(sources.map((source) => [source, source.snapshot()]));
  }

  async function cleanup(operation: () => void | Promise<void>): Promise<void> {
    try {
      await operation();
    } catch (reason: unknown) {
      cleanupErrors.push(reason);
    }
  }

  async function disposePreparations(
    preparations: Iterable<PreparedExtensionSource>,
  ): Promise<void> {
    for (const preparation of [...preparations].reverse()) {
      await cleanup(() => preparation.dispose());
    }
  }

  function ownPreparations(
    generation: ServerGeneration,
    preparations: readonly PreparedExtensionSource[],
  ): ServerGeneration {
    let disposal: Promise<void> | undefined;
    return {
      ...generation,
      dispose() {
        disposal ??= (async () => {
          await cleanup(() => generation.dispose());
          await disposePreparations(preparations);
          activeByGeneration.delete(generation.id);
        })();
        return disposal;
      },
    };
  }

  async function rebuild(): Promise<ExtensionReloadResult> {
    const initialAuthority = captureAuthority();
    ensureOpen();
    const eligibleCount = [...initialAuthority.values()].reduce(
      (count, source) => count + source.eligible.length,
      0,
    );
    const alreadyCurrent =
      eligibleCount === members.length &&
      members.every((member) =>
        sources.some(
          (source) =>
            source.id === member.sourceId &&
            initialAuthority.get(source)?.eligible.some((item) => matches(item, member)),
        ),
      );
    if (alreadyCurrent && blocked === undefined && error === undefined && failed.length === 0) {
      return result(true);
    }
    const abort = new AbortController();
    preparing = abort;
    const excluded = new Map(sources.map((source) => [source.id, new Set<string>()]));
    const failures: ExtensionFailure[] = [];
    const changed = new Set<string>();
    let refreshes = 0;
    let readingAuthority = false;

    function exclude(sourceId: string, item: ExtensionIdentity, reason: unknown): void {
      const keys = excluded.get(sourceId)!;
      if (keys.has(item.identity)) throw new Error('Extension exclusions must increase on retry');
      keys.add(item.identity);
      failures.push({ sourceId, ...item, error: issueOf(reason) });
    }

    try {
      while (true) {
        ensureOpen();
        const revision = desiredRevision;
        const authority = captureAuthority();
        const preparations = new Map<ExtensionSource, PreparedExtensionSource>();
        let candidate: ServerGeneration | undefined;
        let identityFailure: (ExtensionPreparationFailure & { sourceId: string }) | undefined;
        let retirement: Promise<void> | undefined;
        try {
          for (const [source, state] of authority) {
            readingAuthority = true;
            const preparation = await source.prepare(state.stamp, {
              signal: abort.signal,
              excluded: excluded.get(source.id)!,
            });
            readingAuthority = false;
            preparations.set(source, preparation);
            ensureOpen();
            for (const failure of preparation.failures) {
              if (failure.kind === 'identity') {
                identityFailure = { ...failure, sourceId: source.id };
                break;
              }
              exclude(
                source.id,
                { pluginId: failure.pluginId, identity: failure.identity },
                failure.error,
              );
            }
            if (identityFailure !== undefined) break;
          }
          if (identityFailure === undefined) {
            const items = [...preparations].flatMap(([source, preparation]) =>
              preparation.items.map((item) => ({ sourceId: source.id, item })),
            );
            let valid = true;
            try {
              candidate = await options.assemble(items.map(({ item }) => item.plugin));
              ensureOpen();
              for (const preparation of preparations.values()) {
                readingAuthority = true;
                if (!(await preparation.recheck(abort.signal))) valid = false;
                readingAuthority = false;
                ensureOpen();
              }
              // Every await is complete. Validate the exact current authority, commit
              // the pointer, and update membership/admission in one synchronous turn.
              const currentAuthority = captureAuthority();
              valid &&= revision === desiredRevision;
              for (const [source, preparation] of preparations) {
                const state = currentAuthority.get(source)!;
                const survivors = state.eligible.filter(
                  (item) => !excluded.get(source.id)!.has(item.identity),
                );
                valid &&=
                  sameStamp(preparation.stamp, state.stamp) &&
                  preparation.items.length === survivors.length &&
                  survivors.every((member) =>
                    preparation.items.some(
                      (item) =>
                        matches(item, member) && item.plugin.manifest.id === member.pluginId,
                    ),
                  );
              }
              if (valid) {
                if (
                  !Number.isSafeInteger(candidate.id) ||
                  candidate.id <= controller.current().id
                ) {
                  throw new Error('Candidate generation must advance the current generation');
                }
                const nextMembers = structuredClone(
                  items.map(({ sourceId, item }) => ({
                    sourceId,
                    pluginId: item.pluginId,
                    identity: item.identity,
                    manifest: item.plugin.manifest,
                  })),
                );
                const next = ownPreparations(candidate, [...preparations.values()]);
                ensureOpen();
                if (revision === desiredRevision) {
                  retirement = options.host.commit(next).retirement;
                  activeByGeneration.set(next.id, nextMembers);
                  candidate = undefined;
                  preparing = undefined;
                  members = nextMembers;
                  failed = [...failures];
                  error = undefined;
                  blocked = undefined;
                }
              }
            } catch (original: unknown) {
              if (readingAuthority) throw original;
              const reason = items.reduce(
                (current, { item }) => item.normalizeError?.(current) ?? current,
                original,
              );
              const owner =
                reason instanceof PluginError || reason instanceof PluginHostError
                  ? reason.pluginId
                  : undefined;
              const blamed = items.filter(({ item }) => item.pluginId === owner);
              if (blamed.length !== 1) throw reason;
              const { sourceId, item } = blamed[0]!;
              exclude(sourceId, { pluginId: item.pluginId, identity: item.identity }, reason);
              continue;
            }
          }
        } finally {
          if (retirement === undefined) {
            if (candidate !== undefined) {
              const discarded = candidate;
              await cleanup(() => discarded.dispose());
            }
            await disposePreparations(preparations.values());
          }
        }
        if (retirement !== undefined) {
          await cleanup(() => retirement);
          return result(false);
        }
        ensureOpen();
        if (refreshes >= Math.max(1, eligibleCount)) throw sourceStateChanged();
        refreshes += 1;
        if (identityFailure !== undefined) {
          const key = JSON.stringify([identityFailure.sourceId, identityFailure.identity]);
          if (changed.has(key)) throw sourceStateChanged();
          changed.add(key);
        }
        readingAuthority = true;
        await refresh();
        readingAuthority = false;
        const refreshedAuthority = captureAuthority();
        if (identityFailure !== undefined) {
          const mismatch = identityFailure;
          if (
            [...refreshedAuthority].some(
              ([source, state]) =>
                source.id === mismatch.sourceId &&
                state.eligible.some((item) => matches(item, mismatch)),
            )
          )
            throw sourceStateChanged();
        } else if (
          [...authority].every(([source, state]) =>
            sameStamp(state.stamp, refreshedAuthority.get(source)!.stamp),
          )
        ) {
          throw sourceStateChanged();
        }
      }
    } catch (reason: unknown) {
      ensureOpen();
      failed = [...failures];
      error = { code: 'plugin-reload-failed', message: issueOf(reason).message };
      if (readingAuthority) throw reason;
      return result(false);
    } finally {
      preparing = undefined;
    }
  }

  return {
    runner: controller.runner,
    generationSnapshot,
    snapshot,
    reload: () =>
      enqueue(true, async () => {
        await refresh();
        return rebuild();
      }),
    mutate: (sourceId, operation) =>
      enqueue(false, async () => {
        if (!sources.some((source) => source.id === sourceId)) {
          throw new Error(`Unknown extension source "${sourceId}"`);
        }
        await operation();
        await refresh(sourceId);
        return rebuild();
      }),
    hasActive,
    retryImmediateRevocation(sourceId, pluginId) {
      if (!closed && hasActive(sourceId, pluginId)) {
        controller.abortActiveRuns(blocked ?? new Error('Extension admission changed'));
      }
    },
    dispose() {
      if (closing !== undefined) return closing;
      closed = true;
      blocked = disposed();
      const settled = deferred<void>();
      closing = settled.promise;
      controller.blockNewRuns(blocked);
      controller.abortActiveRuns(blocked);
      preparing?.abort(blocked);
      for (const operation of pending.splice(0)) operation.result.reject(blocked);
      void (async () => {
        await running;
        await cleanup(() => controller.dispose());
        for (const source of [...sources].reverse()) await cleanup(() => source.close());
        if (cleanupErrors.length > 0) {
          throw new AggregateError(cleanupErrors, 'Plugin host disposal failed', {
            cause: cleanupErrors[0],
          });
        }
      })().then(settled.resolve, settled.reject);
      return settled.promise;
    },
  };
}
