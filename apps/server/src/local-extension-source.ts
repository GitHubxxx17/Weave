import { isDeepStrictEqual } from 'node:util';
import {
  createLocalPluginSource,
  eligibleLocalSourceCandidates,
  ExplicitLocalAuthorityError,
  localSourceCandidateIdentity,
  PluginHostError,
  projectLocalPluginSnapshot,
  type ExplicitLocalCandidateChecks,
  type ExplicitLocalSelectionInput,
  type LocalSourceStamp,
  type LocalPluginSourceOptions,
  type LocalPluginSourceSnapshot,
  type LocalPluginSourceMutation,
  type LocalPluginSourceController,
  type ReloadResult,
} from '@weave/plugin-host';
import { z } from 'zod';
import type { ExtensionCoordinator } from './extension-coordinator.js';
import {
  sameExtensionSourceStamp,
  type ExtensionAuthorityObserver,
  type ExtensionSourceFactory,
  type ExtensionSourceSnapshot,
} from './extension-types.js';
import type { ServerLocalPluginHost } from './local-plugin-host.js';

const sourceId = 'local-esm';
const mutationOptions = z.strictObject({ immediate: z.boolean().optional() }).optional();

interface ManagedLocalSourceOptions {
  readonly refreshSelectedEvidence: (signal: AbortSignal) => Promise<void>;
  readonly invalidateAuthoritySync: (cause: unknown) => never;
}

interface WithdrawnSelection {
  readonly stickyIds: ReadonlySet<string>;
  readonly trustSequence: number | undefined;
  readonly failure: ExplicitLocalAuthorityError | undefined;
}

export function createLocalExtensionSource(
  options: LocalPluginSourceOptions,
  managed?: ManagedLocalSourceOptions,
) {
  let source: LocalPluginSourceController;
  let observe: ExtensionAuthorityObserver;
  let effective: ExtensionSourceSnapshot | undefined;
  let rawStamp: LocalSourceStamp | undefined;
  let withdrawn: WithdrawnSelection | undefined;
  let adopting = false;
  const pendingRawPreparations = new Set<AbortController>();
  const reservedIds = new Set(options.discovery.reservedIds);
  // The ESM lifecycle captures cleanup errors so plugin code cannot interrupt
  // rollback. Collect them after draining both rejected and published attempts.
  const cleanupErrors: unknown[] = [];

  function effectiveCandidates(raw: LocalPluginSourceSnapshot) {
    return eligibleLocalSourceCandidates(raw).filter(
      (candidate) =>
        withdrawn === undefined ||
        (candidate.origin === 'manual' && !withdrawn.stickyIds.has(candidate.id)),
    );
  }

  function updateEffective(raw: LocalPluginSourceSnapshot, policyChanged = false) {
    const eligible = effectiveCandidates(raw).map((candidate) => ({
      pluginId: candidate.id,
      identity: localSourceCandidateIdentity(candidate),
      origin: candidate.origin,
    }));
    const revision =
      (effective?.stamp.revision ?? 0) +
      Number(
        policyChanged ||
          (rawStamp !== undefined && rawStamp.revision !== raw.stamp.revision) ||
          (effective !== undefined && !isDeepStrictEqual(eligible, effective.eligible)),
      );
    const trustSequence = Math.max(
      raw.stamp.trustSequence,
      effective?.stamp.trustSequence ?? 0,
      withdrawn?.trustSequence ?? 0,
    );
    rawStamp = raw.stamp;
    effective = { stamp: { revision, trustSequence }, eligible };
    return effective;
  }

  function snapshot(): ExtensionSourceSnapshot {
    return updateEffective(source.snapshot());
  }

  function adoptExplicitSelectionSync(input: ExplicitLocalSelectionInput): void {
    const recovery = withdrawn !== undefined;
    adopting = true;
    try {
      source.adoptExplicitSelectionSync(input);
      withdrawn = undefined;
    } finally {
      adopting = false;
    }
    observe(sourceId, {
      snapshot: updateEffective(source.snapshot(), recovery),
      affectedIds: [],
      immediate: false,
    });
  }

  function withdrawExplicitSelectionSync(
    stickyIds: ReadonlySet<string>,
    trustSequence?: number,
    failure?: ExplicitLocalAuthorityError,
  ): () => void {
    const before = effective;
    const policyChanged =
      withdrawn === undefined ||
      !isDeepStrictEqual(withdrawn.stickyIds, stickyIds) ||
      (withdrawn.failure === undefined) !== (failure === undefined);
    withdrawn = { stickyIds, trustSequence, failure };
    const pending = [...pendingRawPreparations];
    const reason = failure ?? new ExplicitLocalAuthorityError();
    const current = updateEffective(source.snapshot(), policyChanged);
    observe(sourceId, {
      snapshot: current,
      affectedIds:
        before?.eligible
          .filter(({ identity }) =>
            current.eligible.every((candidate) => candidate.identity !== identity),
          )
          .map(({ pluginId }) => pluginId) ?? [],
      immediate: false,
    });
    // The composition invokes this after both snapshots and admission are published.
    return () => {
      for (const preparation of pending) preparation.abort(reason);
    };
  }

  function mayReadManagedSync(id: string): boolean {
    const { discovery } = source.snapshot();
    return (
      !reservedIds.has(id) &&
      !discovery.truncated &&
      !discovery.candidates.some((candidate) => candidate.manifest?.id === id)
    );
  }

  async function recheckManaged(
    prepared: Awaited<ReturnType<typeof source.prepare>>,
    rawCandidates: ReturnType<typeof effectiveCandidates>,
    signal: AbortSignal,
    checks: ExplicitLocalCandidateChecks,
  ): Promise<boolean> {
    for (const item of prepared.items) {
      if (item.origin !== 'managed') continue;
      const expected = rawCandidates.find(
        (candidate) => localSourceCandidateIdentity(candidate) === item.identity,
      );
      const current = effectiveCandidates(source.snapshot()).find(
        (candidate) => localSourceCandidateIdentity(candidate) === item.identity,
      );
      if (expected?.origin !== 'managed' || !isDeepStrictEqual(expected, current)) return false;
      try {
        await checks.verify(expected, signal);
      } catch (error: unknown) {
        if (error instanceof PluginHostError && error.code === 'plugin-digest-mismatch')
          return false;
        throw error;
      }
    }
    return true;
  }

  async function close() {
    try {
      await source.close();
    } catch (error: unknown) {
      cleanupErrors.push(error);
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError(cleanupErrors, 'Local plugin source disposal failed', {
        cause: cleanupErrors[0],
      });
    }
  }

  const register: ExtensionSourceFactory = (observer) => {
    observe = observer;
    source = createLocalPluginSource({
      ...options,
      onAuthorityChange(change) {
        if (!adopting) observe(sourceId, { ...change, snapshot: updateEffective(change.snapshot) });
      },
    });
    return {
      id: sourceId,
      snapshot,
      async refresh(signal) {
        try {
          await source.refresh();
        } catch (cause: unknown) {
          if (managed !== undefined) managed.invalidateAuthoritySync(cause);
          throw cause;
        }
        if (signal !== undefined) await managed?.refreshSelectedEvidence(signal);
      },
      async prepare(stamp, preparationOptions) {
        if (withdrawn !== undefined) throw withdrawn.failure ?? new ExplicitLocalAuthorityError();
        const raw = source.snapshot();
        if (!sameExtensionSourceStamp(stamp, updateEffective(raw).stamp)) {
          throw new PluginHostError(
            'plugin-reload-failed',
            'Local plugin source changed before preparation',
          );
        }
        const candidates = options.explicitChecks === undefined ? [] : effectiveCandidates(raw);
        const invalidation = new AbortController();
        const signal = AbortSignal.any([preparationOptions.signal, invalidation.signal]);
        pendingRawPreparations.add(invalidation);
        let prepared: Awaited<ReturnType<typeof source.prepare>>;
        try {
          prepared = await source.prepare(raw.stamp, { ...preparationOptions, signal });
        } catch (cause: unknown) {
          invalidation.signal.throwIfAborted();
          throw cause;
        } finally {
          pendingRawPreparations.delete(invalidation);
        }
        let disposal: Promise<void> | undefined;
        function dispose() {
          disposal ??= prepared.dispose().then(() => {
            for (const item of prepared.items) cleanupErrors.push(...item.cleanupErrors);
          });
          return disposal;
        }
        if (invalidation.signal.aborted) {
          try {
            await dispose();
          } catch (cause: unknown) {
            cleanupErrors.push(cause);
          }
          invalidation.signal.throwIfAborted();
        }
        return {
          stamp,
          items: prepared.items.map((item) => ({
            pluginId: item.id,
            identity: item.identity,
            origin: item.origin,
            plugin: item.plugin,
            normalizeError: item.normalize,
            dispose: item.dispose,
          })),
          failures: prepared.failures.map(({ id, identity, origin, kind, error }) => ({
            pluginId: id,
            identity,
            origin,
            kind,
            error,
          })),
          async recheck(signal) {
            try {
              if (!(await source.recheck(prepared, signal)).valid) return false;
            } catch (cause: unknown) {
              if (managed !== undefined) managed.invalidateAuthoritySync(cause);
              throw cause;
            }
            return (
              options.explicitChecks === undefined ||
              recheckManaged(prepared, candidates, signal, options.explicitChecks)
            );
          },
          dispose,
        };
      },
      close,
    };
  };

  return {
    register,
    close,
    snapshot,
    adoptExplicitSelectionSync,
    withdrawExplicitSelectionSync,
    mayReadManagedSync,
    async discoveredPluginIds() {
      await source.refresh();
      return Object.freeze([
        ...new Set(
          source
            .snapshot()
            .discovery.candidates.flatMap((candidate) =>
              candidate.manifest === undefined ? [] : [candidate.manifest.id],
            ),
        ),
      ]);
    },
    facade(
      coordinator: ExtensionCoordinator,
      dispose?: () => Promise<void>,
    ): ServerLocalPluginHost {
      function project(state: ReturnType<ExtensionCoordinator['snapshot']>) {
        const current = source.snapshot();
        const failures = new Map(
          state.failed
            .filter((item) => item.sourceId === sourceId)
            .map((item) => [item.identity, item.error]),
        );
        if (state.error !== undefined) {
          for (const item of snapshot().eligible) {
            if (!failures.has(item.identity)) failures.set(item.identity, state.error);
          }
        }
        return projectLocalPluginSnapshot(current, {
          generation: state.generation.id,
          active: state.members
            .filter((member) => member.sourceId === sourceId)
            .map((member) => {
              const digest = (JSON.parse(member.identity) as [string, string])[1];
              return { id: member.pluginId, digest, manifest: member.manifest };
            }),
          failures,
          blocked: state.generation.blocked,
          error: state.error,
        });
      }

      function reloadResult(
        result: Awaited<ReturnType<ExtensionCoordinator['reload']>>,
      ): ReloadResult {
        const eligible = new Set(snapshot().eligible.map((item) => item.identity));
        return {
          generation: result.generation.id,
          unchanged: result.unchanged,
          failed: result.failed.flatMap(({ sourceId: owner, pluginId, identity, error }) =>
            owner === sourceId && eligible.has(identity) ? [{ id: pluginId, error }] : [],
          ),
          ...(result.error === undefined ? {} : { error: result.error }),
          snapshot: project(result),
        };
      }

      function mutate(command: () => LocalPluginSourceMutation): Promise<ReloadResult> {
        return coordinator
          .mutate(
            sourceId,
            () => {
              const change = command();
              return source.mutate(change, {
                hasActive: (pluginId) => coordinator.hasActive(sourceId, pluginId),
                onImmediateRetry: () => coordinator.retryImmediateRevocation(sourceId, change.id),
              });
            },
            { force: true },
          )
          .then(reloadResult);
      }
      const managementSnapshot = () => project(coordinator.snapshot());
      return {
        runner: coordinator.runner,
        list: () => managementSnapshot().plugins,
        snapshot: managementSnapshot,
        reload: () => coordinator.reload({ force: true }).then(reloadResult),
        trust: (id, digest) => mutate(() => ({ kind: 'trust', id, digest })),
        revoke: (id, options) =>
          mutate(() => ({ kind: 'revoke', id, ...mutationOptions.parse(options) })),
        setEnabled: (id, enabled, options) =>
          mutate(() => ({ kind: 'setEnabled', id, enabled, ...mutationOptions.parse(options) })),
        dispose: dispose ?? coordinator.dispose,
      };
    },
  };
}
