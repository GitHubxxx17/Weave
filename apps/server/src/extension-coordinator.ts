import { PluginError, type KernelPlugin } from '@weave/plugin';
import {
  ExplicitLocalAuthorityError,
  PluginHostError,
  type LocalPluginIssue,
} from '@weave/plugin-host';
import type {
  ExtensionAuthorityChange,
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
  ManagedGenerationAuthority,
  PreparedExtensionItem,
  PreparedExtensionSource,
  RetainedExtensionGeneration,
} from './extension-types.js';
import type { ServerGeneration, ServerGenerationController, ServerHost } from './server-host.js';
import {
  ExtensionPreparationError,
  sameExtensionSourceStamp as sameStamp,
} from './extension-types.js';

interface ExtensionState {
  readonly generation: ExtensionGenerationSnapshot;
  readonly members: readonly ExtensionMember[];
  readonly failed: readonly ExtensionFailure[];
  readonly error?: LocalPluginIssue;
}

interface ExtensionReloadResult extends ExtensionState {
  readonly unchanged: boolean;
}

export interface ExtensionMutationContext {
  readonly assertOpenSync: () => void;
  readonly signal: AbortSignal;
}

export type OwnedDrainOutcome =
  | { readonly kind: 'drained'; readonly cleanupCauses: readonly unknown[] }
  | { readonly kind: 'incomplete'; readonly cause: unknown };

export interface ExtensionCoordinator {
  readonly runner: ServerGenerationController['runner'];
  generationSnapshot(): ExtensionGenerationSnapshot;
  observeAuthorityBatchSync(changes: ReadonlyMap<string, ExtensionAuthorityChange>): void;
  blockManagedOwnershipLossSync(): void;
  snapshot(): ExtensionState;
  retainedGenerations(): readonly RetainedExtensionGeneration[];
  reload(options?: { readonly force?: boolean }): Promise<ExtensionReloadResult>;
  mutate(
    sourceId: string,
    operation: (context: ExtensionMutationContext) => Promise<unknown>,
    options?: { readonly force?: boolean },
  ): Promise<ExtensionReloadResult>;
  hasActive(sourceId: string, pluginId: string): boolean;
  retryImmediateRevocation(sourceId: string, pluginId: string): void;
  beginOwnedDrainSync(): void;
  drainOwnedConsumers(preDrain: () => Promise<void>): Promise<OwnedDrainOutcome>;
  dispose(): Promise<void>;
}

interface ExtensionCoordinatorOptions {
  readonly host: ServerHost;
  readonly sources: readonly ExtensionSourceFactory[];
  readonly assemble: (plugins: readonly KernelPlugin[]) => Promise<ServerGeneration>;
  readonly mcpFirstAuthority?: boolean;
  readonly managedAuthority?: ManagedGenerationAuthority;
}

interface PendingOperation {
  readonly reload: boolean;
  force: boolean;
  readonly run: (force: boolean) => Promise<ExtensionReloadResult>;
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

function matches(left: ExtensionIdentity, right: ExtensionIdentity) {
  return (
    left.pluginId === right.pluginId &&
    left.identity === right.identity &&
    left.origin === right.origin
  );
}

function originOf({ origin }: ExtensionIdentity) {
  return origin === undefined ? {} : { origin };
}

function managedIdentities(items: readonly ExtensionIdentity[]): ExtensionIdentity[] {
  return items.flatMap(({ pluginId, identity, origin }) =>
    origin === 'managed' ? [{ pluginId, identity, origin }] : [],
  );
}

function authorityMarker(error: unknown): ExplicitLocalAuthorityError | undefined {
  if (error instanceof ExplicitLocalAuthorityError) return error;
  if (error instanceof PluginError && error.code === 'plugin-setup-failed') {
    return error.cause instanceof ExplicitLocalAuthorityError ? error.cause : undefined;
  }
  return undefined;
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
  const { managedAuthority } = options;
  const pending: PendingOperation[] = [];
  const cleanupErrors: unknown[] = [];
  const lifetime = new AbortController();
  const authorityStamps = new Map<string, ExtensionSourceStamp>();
  const activeByGeneration = new Map<number, readonly ExtensionMember[]>();
  let desiredRevision = 0;
  let members: readonly ExtensionMember[] = [];
  let failed: readonly ExtensionFailure[] = [];
  let error: LocalPluginIssue | undefined;
  let blocked: PluginHostError | undefined;
  let ownershipBlock: PluginHostError | undefined;
  let running: Promise<void> | undefined;
  let closing: Promise<void> | undefined;
  let ownedDrain: Promise<OwnedDrainOutcome> | undefined;
  let ownedDrainStarted = false;
  let closed = false;
  let preparing: AbortController | undefined;

  function blockManagedOwnershipLossSync(): void {
    if (ownershipBlock !== undefined || !members.some(({ origin }) => origin === 'managed')) return;
    ownershipBlock = new PluginHostError(
      'plugin-generation-blocked',
      'Managed plugin store ownership was lost',
    );
    if (!closed) controller.blockNewRuns(ownershipBlock);
  }

  function observeAuthorityBatchSync(changes: ReadonlyMap<string, ExtensionAuthorityChange>): void {
    if (closed) return;
    const changed = new Map<string, ExtensionSourceSnapshot>();
    let immediate = false;
    for (const [sourceId, change] of changes) {
      const stamp = change.snapshot.stamp;
      const previous = authorityStamps.get(sourceId);
      if (previous !== undefined && sameStamp(previous, stamp)) continue;
      authorityStamps.set(sourceId, stamp);
      desiredRevision += 1;
      changed.set(sourceId, change.snapshot);
      immediate ||= change.immediate && change.affectedIds.length > 0;
    }
    if (changed.size === 0) return;
    const unauthorized = members.some(
      (member) =>
        changed.get(member.sourceId)?.eligible.some((item) => matches(item, member)) === false,
    );
    if (unauthorized) {
      blocked = new PluginHostError(
        'plugin-generation-blocked',
        'Extension trust changed; new runs wait for a compliant generation',
      );
      controller.blockNewRuns(ownershipBlock ?? blocked);
    }
    if (immediate) {
      controller.abortActiveRuns(
        ownershipBlock ?? blocked ?? new Error('Extension admission changed'),
      );
    }
  }
  const observe: ExtensionAuthorityObserver = (sourceId, change) => {
    observeAuthorityBatchSync(new Map([[sourceId, change]]));
  };
  const sources = options.sources.map((create) => create(observe));
  if (new Set(sources.map((source) => source.id)).size !== sources.length) {
    throw new Error('Extension source ids must be unique');
  }
  for (const source of sources) {
    authorityStamps.set(source.id, source.snapshot().stamp);
  }
  const mcpAuthoritySource = options.mcpFirstAuthority
    ? sources.find((source) => source.id === 'mcp')
    : undefined;
  const authorityOrder =
    mcpAuthoritySource === undefined
      ? sources
      : [mcpAuthoritySource, ...sources.filter((source) => source !== mcpAuthoritySource)];

  function ensureOpen(): void {
    if (closed) throw disposed();
  }

  function generationSnapshot(): ExtensionGenerationSnapshot {
    const admissionBlock = closed ? blocked : (ownershipBlock ?? blocked);
    return {
      id: controller.current().id,
      acceptingRuns: admissionBlock === undefined,
      ...(admissionBlock === undefined ? {} : { blocked: issueOf(admissionBlock) }),
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

  function retainedGenerations(): readonly RetainedExtensionGeneration[] {
    const currentId = controller.current().id;
    return structuredClone(
      [...activeByGeneration].map(([generationId, retainedMembers]) => ({
        generationId,
        current: generationId === currentId,
        members: retainedMembers,
      })),
    );
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
          operation.result.resolve(await operation.run(operation.force));
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
    run: (force: boolean) => Promise<ExtensionReloadResult>,
    force = false,
  ): Promise<ExtensionReloadResult> {
    if (closed) return Promise.reject(disposed());
    const previous = pending.at(-1);
    if (reload && previous?.reload) {
      previous.force ||= force;
      return previous.result.promise;
    }
    const operation = deferred<ExtensionReloadResult>();
    pending.push({ reload, force, run, result: operation });
    running ??= Promise.resolve().then(drain);
    return operation.promise;
  }

  async function refresh(skip?: string, signal = lifetime.signal): Promise<void> {
    ensureOpen();
    for (const source of authorityOrder) {
      if (options.mcpFirstAuthority || source.id !== skip) await source.refresh(signal);
      ensureOpen();
    }
  }

  function captureAuthority(): ReadonlyMap<ExtensionSource, ExtensionSourceSnapshot> {
    return new Map(sources.map((source) => [source, source.snapshot()]));
  }

  async function cleanup(operation: () => void | Promise<void>): Promise<boolean> {
    try {
      await operation();
      return true;
    } catch (reason: unknown) {
      cleanupErrors.push(reason);
      return false;
    }
  }

  function closeAdmissionSync(cancelActiveRuns: boolean): void {
    if (closed) return;
    closed = true;
    const reason = disposed();
    blocked = reason;
    controller.blockNewRuns(reason);
    if (cancelActiveRuns) controller.abortActiveRuns(reason);
    lifetime.abort(reason);
    preparing?.abort(reason);
    for (const operation of pending.splice(0)) operation.result.reject(reason);
  }

  async function disposeConsumers(): Promise<void> {
    await cleanup(() => controller.dispose());
    for (const source of [...sources].reverse()) await cleanup(() => source.close());
  }

  async function disposePreparations(
    preparations: Iterable<PreparedExtensionSource>,
  ): Promise<boolean> {
    let released = true;
    for (const preparation of [...preparations].reverse()) {
      if (!(await cleanup(() => preparation.dispose()))) released = false;
    }
    return released;
  }

  function ownPreparations(
    generation: ServerGeneration,
    preparations: readonly PreparedExtensionSource[],
    hasManagedMembers: boolean,
  ): ServerGeneration {
    let disposal: Promise<void> | undefined;
    return {
      ...generation,
      ...(hasManagedMembers && managedAuthority !== undefined
        ? { assertCanStartSync: () => managedAuthority.assertManagedStartSync() }
        : {}),
      dispose() {
        disposal ??= (async () => {
          await cleanup(() => generation.dispose());
          if (await disposePreparations(preparations)) activeByGeneration.delete(generation.id);
        })();
        return disposal;
      },
    };
  }

  function membershipMatches(
    authority: ReadonlyMap<ExtensionSource, ExtensionSourceSnapshot>,
    current: readonly ExtensionMember[],
  ): boolean {
    return (
      [...authority.values()].reduce((count, state) => count + state.eligible.length, 0) ===
        current.length &&
      current.every((member) =>
        [...authority].some(
          ([source, state]) =>
            source.id === member.sourceId && state.eligible.some((item) => matches(item, member)),
        ),
      )
    );
  }

  function preparationMatches(
    authority: ReadonlyMap<ExtensionSource, ExtensionSourceSnapshot>,
    preparations: ReadonlyMap<ExtensionSource, PreparedExtensionSource>,
    excluded: ReadonlyMap<string, ReadonlySet<string>>,
  ): boolean {
    return [...authority].every(([source, state]) => {
      const preparation = preparations.get(source)!;
      const survivors = state.eligible.filter(
        (item) => !excluded.get(source.id)!.has(item.identity),
      );
      return (
        sameStamp(preparation.stamp, state.stamp) &&
        preparation.items.length === survivors.length &&
        survivors.every((member) =>
          preparation.items.some(
            (item) => matches(item, member) && item.plugin.manifest.id === member.pluginId,
          ),
        )
      );
    });
  }

  function sameAuthorityStamps(
    before: ReadonlyMap<ExtensionSource, ExtensionSourceSnapshot>,
    after: ReadonlyMap<ExtensionSource, ExtensionSourceSnapshot>,
  ): boolean {
    return [...before].every(([source, state]) => sameStamp(state.stamp, after.get(source)!.stamp));
  }

  async function rebuild(force: boolean): Promise<ExtensionReloadResult> {
    const excluded = new Map(sources.map((source) => [source.id, new Set<string>()]));
    const failures: ExtensionFailure[] = [];
    const changed = new Set<string>();
    let refreshes = 0;
    let readingAuthority = false;

    function exclude(sourceId: string, item: ExtensionIdentity, reason: unknown): void {
      const keys = excluded.get(sourceId)!;
      if (keys.has(item.identity)) throw new Error('Extension exclusions must increase on retry');
      keys.add(item.identity);
      const { pluginId, identity } = item;
      failures.push({ sourceId, pluginId, identity, ...originOf(item), error: issueOf(reason) });
    }

    type OwnedItem = { sourceId: string; item: PreparedExtensionItem };

    function attribute(items: readonly OwnedItem[], original: unknown): void {
      if (authorityMarker(original) !== undefined) throw original;
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
      exclude(sourceId, item, reason);
    }

    function excludeUnready(items: readonly OwnedItem[]): boolean {
      const unready = items.find(({ item }) => item.isReady?.() === false);
      if (unready === undefined) return false;
      exclude(
        unready.sourceId,
        unready.item,
        new PluginHostError(
          'plugin-load-failed',
          'Extension resource became unavailable before publication',
          { pluginId: unready.item.pluginId },
        ),
      );
      return true;
    }

    try {
      const initialRevision = desiredRevision;
      const initialAuthority = captureAuthority();
      ensureOpen();
      const eligibleCount = [...initialAuthority.values()].reduce(
        (count, state) => count + state.eligible.length,
        0,
      );
      if (
        !force &&
        blocked === undefined &&
        ownershipBlock === undefined &&
        error === undefined &&
        failed.length === 0 &&
        membershipMatches(initialAuthority, members)
      ) {
        const managed = managedIdentities(members);
        if (managed.length === 0 || managedAuthority === undefined) return result(true);

        readingAuthority = true;
        managedAuthority.assertManagedPublicationSync(managed);
        const currentAuthority = captureAuthority();
        ensureOpen();
        managedAuthority.assertNotLostSync();
        readingAuthority = false;
        if (
          blocked === undefined &&
          ownershipBlock === undefined &&
          initialRevision === desiredRevision &&
          sameAuthorityStamps(initialAuthority, currentAuthority) &&
          membershipMatches(currentAuthority, members)
        ) {
          return result(true);
        }
      }

      while (true) {
        ensureOpen();
        if (mcpAuthoritySource !== undefined) {
          readingAuthority = true;
          await mcpAuthoritySource.refresh(lifetime.signal);
          readingAuthority = false;
          ensureOpen();
        }
        const revision = desiredRevision;
        const authority = captureAuthority();
        const abort = new AbortController();
        preparing = abort;
        const iterationAuthority = [...authority].some(([source, state]) =>
          state.eligible.some(
            ({ origin, identity }) =>
              origin === 'managed' && !excluded.get(source.id)!.has(identity),
          ),
        )
          ? managedAuthority
          : undefined;
        const lossSignal = iterationAuthority?.ownershipLossSignal;
        const abortOnLoss = () => abort.abort(lossSignal?.reason);
        const preparations = new Map<ExtensionSource, PreparedExtensionSource>();
        let candidate: ServerGeneration | undefined;
        let identityFailure: (ExtensionPreparationFailure & { sourceId: string }) | undefined;
        let retirement: Promise<void> | undefined;

        function checkIteration(): void {
          ensureOpen();
          iterationAuthority?.assertNotLostSync();
          abort.signal.throwIfAborted();
        }

        lossSignal?.addEventListener('abort', abortOnLoss, { once: true });
        try {
          checkIteration();
          for (const [source, state] of authority) {
            readingAuthority = true;
            const preparation = await source.prepare(state.stamp, {
              signal: abort.signal,
              excluded: excluded.get(source.id)!,
            });
            readingAuthority = false;
            preparations.set(source, preparation);
            checkIteration();
            for (const failure of preparation.failures) {
              if (authorityMarker(failure.error) !== undefined) throw failure.error;
              if (failure.kind === 'identity') {
                identityFailure = { ...failure, sourceId: source.id };
                break;
              }
              exclude(source.id, failure, failure.error);
            }
            if (identityFailure !== undefined) break;
          }
          if (identityFailure === undefined) {
            const items = [...preparations].flatMap(([source, preparation]) =>
              preparation.items.map((item) => ({ sourceId: source.id, item })),
            );
            try {
              candidate = await options.assemble(items.map(({ item }) => item.plugin));
            } catch (original: unknown) {
              if (authorityMarker(original) !== undefined) throw original;
              checkIteration();
              attribute(items, original);
              continue;
            }
            checkIteration();

            let valid = true;
            for (const source of authorityOrder) {
              readingAuthority = true;
              if (!(await preparations.get(source)!.recheck(abort.signal))) valid = false;
              readingAuthority = false;
              checkIteration();
            }
            const recheckedAuthority = captureAuthority();
            valid &&=
              revision === desiredRevision &&
              preparationMatches(recheckedAuthority, preparations, excluded);
            checkIteration();
            if (valid) {
              if (!Number.isSafeInteger(candidate.id) || candidate.id <= controller.current().id) {
                throw new Error('Candidate generation must advance the current generation');
              }
              const nextMembers = structuredClone(
                items.map(({ sourceId, item }) => ({
                  sourceId,
                  pluginId: item.pluginId,
                  identity: item.identity,
                  ...originOf(item),
                  ...(item.instanceId === undefined ? {} : { instanceId: item.instanceId }),
                  manifest: item.plugin.manifest,
                })),
              );
              const managed = managedIdentities(nextMembers);
              const next = ownPreparations(
                candidate,
                [...preparations.values()],
                managed.length > 0,
              );
              if (excludeUnready(items)) continue;

              if (managed.length > 0 && managedAuthority !== undefined) {
                readingAuthority = true;
                managedAuthority.assertManagedPublicationSync(managed);
                const currentAuthority = captureAuthority();
                checkIteration();
                readingAuthority = false;
                valid =
                  revision === desiredRevision &&
                  preparationMatches(currentAuthority, preparations, excluded);
                if (valid && excludeUnready(items)) continue;
              }

              if (valid) {
                try {
                  retirement = options.host.commit(next).retirement;
                } catch (original: unknown) {
                  if (authorityMarker(original) !== undefined) throw original;
                  checkIteration();
                  attribute(items, original);
                  continue;
                }
                activeByGeneration.set(next.id, nextMembers);
                candidate = undefined;
                members = nextMembers;
                failed = [...failures];
                error = undefined;
                blocked = undefined;
                if (ownershipBlock !== undefined) controller.blockNewRuns(ownershipBlock);
              }
            }
          }
        } catch (original: unknown) {
          // Direct and kernel-wrapped authority failures keep the original throw.
          if (authorityMarker(original) !== undefined) throw original;
          // An interrupted mixed iteration can return an incidental plugin or abort error.
          iterationAuthority?.assertNotLostSync();
          throw original;
        } finally {
          if (retirement === undefined) {
            if (candidate !== undefined) {
              const discarded = candidate;
              await cleanup(() => discarded.dispose());
            }
            await disposePreparations(preparations.values());
          }
          lossSignal?.removeEventListener('abort', abortOnLoss);
          preparing = undefined;
        }
        if (retirement !== undefined) {
          await cleanup(() => retirement);
          return result(false);
        }
        checkIteration();
        if (refreshes >= Math.max(1, eligibleCount)) throw sourceStateChanged();
        refreshes += 1;
        if (identityFailure !== undefined) {
          const key = JSON.stringify([
            identityFailure.sourceId,
            identityFailure.identity,
            identityFailure.origin,
          ]);
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
        } else if (sameAuthorityStamps(authority, refreshedAuthority)) {
          throw sourceStateChanged();
        }
      }
    } catch (reason: unknown) {
      const marker = authorityMarker(reason);
      if (closed && marker !== undefined) throw reason;
      ensureOpen();
      if (reason instanceof ExtensionPreparationError) readingAuthority = false;
      failed = [...failures];
      error = { code: 'plugin-reload-failed', message: issueOf(marker ?? reason).message };
      if (marker !== undefined || readingAuthority) throw reason;
      return result(false);
    }
  }

  return {
    runner: controller.runner,
    generationSnapshot,
    observeAuthorityBatchSync,
    blockManagedOwnershipLossSync,
    snapshot,
    retainedGenerations,
    reload: (reloadOptions) =>
      enqueue(
        true,
        async (force) => {
          await refresh();
          return rebuild(force);
        },
        reloadOptions?.force === true,
      ),
    mutate: (sourceId, operation, mutationOptions) =>
      enqueue(
        false,
        async (force) => {
          if (!sources.some((source) => source.id === sourceId)) {
            throw new Error(`Unknown extension source "${sourceId}"`);
          }
          await operation({ assertOpenSync: ensureOpen, signal: lifetime.signal });
          await refresh(sourceId);
          return rebuild(force);
        },
        mutationOptions?.force === true,
      ),
    hasActive,
    retryImmediateRevocation(sourceId, pluginId) {
      if (!closed && hasActive(sourceId, pluginId)) {
        controller.abortActiveRuns(
          ownershipBlock ?? blocked ?? new Error('Extension admission changed'),
        );
      }
    },
    beginOwnedDrainSync() {
      if (ownedDrainStarted) return;
      ownedDrainStarted = true;
      closeAdmissionSync(false);
    },
    drainOwnedConsumers(preDrain) {
      if (!ownedDrainStarted) {
        return Promise.reject(
          new Error('Owned extension drain must begin before draining consumers'),
        );
      }
      if (ownedDrain !== undefined) return ownedDrain;
      const settled = deferred<OwnedDrainOutcome>();
      ownedDrain = settled.promise;
      const runningAtDrain = running;
      void (async (): Promise<OwnedDrainOutcome> => {
        try {
          await preDrain();
        } catch (cause: unknown) {
          await runningAtDrain;
          ownedDrain = undefined;
          return { kind: 'incomplete', cause };
        }
        await runningAtDrain;
        controller.abortActiveRuns(blocked);
        await disposeConsumers();
        return { kind: 'drained', cleanupCauses: [...cleanupErrors] };
      })().then(settled.resolve, settled.reject);
      return settled.promise;
    },
    dispose() {
      if (closing !== undefined) return closing;
      const settled = deferred<void>();
      closing = settled.promise;
      closeAdmissionSync(true);
      void (async () => {
        await running;
        await disposeConsumers();
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
