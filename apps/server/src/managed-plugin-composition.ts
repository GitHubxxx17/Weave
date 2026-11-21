import {
  ExplicitLocalAuthorityError,
  PluginHostError,
  foldTrust,
  localSourceCandidateIdentity,
  type ExplicitLocalCandidateChecks,
  type ExplicitLocalSelection,
  type LocalPluginIssue,
  type ManagedLocalCandidate,
  type PluginArtifact,
  type ReadyLocalPlugin,
  type RecordedPluginTrustEvent,
} from '@weave/plugin-host';
import type { createLocalExtensionSource } from './local-extension-source.js';
import { McpAuthorityError } from './mcp-authority-store.js';
import type { createMcpExtensionSource } from './mcp-source.js';
import type { OwnedPluginArtifactStore } from './owned-plugin-artifact-store.js';
import { canonicalJson } from './plugin-authority-data.js';
import type {
  ManagedCandidate,
  PluginAuthorityDatabase,
  PluginAuthoritySnapshot,
} from './plugin-authority-types.js';
import { PluginStoreOwnershipError } from './plugin-store-ownership-types.js';
import {
  sameExtensionSourceStamp,
  type ExtensionAuthorityChange,
  type ExtensionIdentity,
  type ExtensionSourceFactory,
  type ExtensionSourceStamp,
  type ManagedGenerationAuthority,
} from './extension-types.js';

/** Holds local and MCP observations until both adapters have applied a paired update. */
export function createManagedAuthorityObserverBuffer(
  publish: (changes: ReadonlyMap<string, ExtensionAuthorityChange>) => void,
) {
  const stamps = new Map<string, ExtensionSourceStamp>();
  let pending: Map<string, ExtensionAuthorityChange> | undefined;

  function wrapSource(register: ExtensionSourceFactory): ExtensionSourceFactory {
    return (observe) => {
      const source = register((sourceId, change) => {
        if (pending === undefined) {
          stamps.set(sourceId, change.snapshot.stamp);
          observe(sourceId, change);
          return;
        }
        const previous = pending.get(sourceId);
        const stamp = previous?.snapshot.stamp ?? stamps.get(sourceId);
        if (stamp !== undefined && sameExtensionSourceStamp(stamp, change.snapshot.stamp)) {
          return;
        }
        pending.set(
          sourceId,
          previous === undefined
            ? change
            : {
                snapshot: change.snapshot,
                affectedIds: [...new Set([...previous.affectedIds, ...change.affectedIds])],
                immediate: previous.immediate || change.immediate,
              },
        );
      });
      stamps.set(source.id, source.snapshot().stamp);
      return source;
    };
  }

  function runSync(apply: () => void): void {
    if (pending !== undefined) throw new Error('Paired extension authority is already applying');
    const changes = new Map<string, ExtensionAuthorityChange>();
    pending = changes;
    try {
      apply();
    } finally {
      pending = undefined;
    }
    for (const [sourceId, change] of changes) {
      stamps.set(sourceId, change.snapshot.stamp);
    }
    // Publishing can synchronously abort a run whose callback starts a new pair.
    if (changes.size > 0) publish(changes);
  }

  return { wrapSource, runSync };
}

export interface ManagedPluginCompositionOptions {
  readonly initialAuthority: PluginAuthoritySnapshot;
  readonly readAuthoritySync: PluginAuthorityDatabase['snapshotSync'];
  /** The raw override prefix can be unavailable until the package completes readback. */
  readonly readLocalTrustEventsSync?: () => readonly RecordedPluginTrustEvent[] | undefined;
  /** Only private execution-enabled callers supply a store. */
  readonly executionStore?: Pick<OwnedPluginArtifactStore, 'binding' | 'assertHeldSync' | 'read'>;
}

interface SelectedTarget {
  readonly candidate: ManagedCandidate;
  readonly activationSequence: number;
  readonly manifest: string;
  readonly key: string;
  ready?: ReadyLocalPlugin | undefined;
  issue?: LocalPluginIssue | undefined;
}

const artifactUnavailable: LocalPluginIssue = {
  code: 'plugin-digest-mismatch',
  message: 'The selected plugin artifact could not be verified',
};

function identityChanged() {
  return new PluginHostError('plugin-digest-mismatch', artifactUnavailable.message);
}

function matchesArtifact(artifact: PluginArtifact, target: SelectedTarget): boolean {
  const { candidate } = target;
  return (
    artifact.digest === candidate.digest &&
    artifact.descriptor.manifest.id === candidate.pluginId &&
    artifact.files === candidate.files &&
    artifact.bytes === candidate.bytes &&
    canonicalJson(artifact.descriptor.manifest) === target.manifest
  );
}

export function createManagedPluginComposition(
  options: ManagedPluginCompositionOptions,
  buffer: ReturnType<typeof createManagedAuthorityObserverBuffer>,
  getSources: () => {
    readonly local: ReturnType<typeof createLocalExtensionSource> | undefined;
    readonly mcp: ReturnType<typeof createMcpExtensionSource> | undefined;
  },
  blockManagedOwnershipLossSync: () => void,
) {
  const owned = options.executionStore;
  const ownershipLoss = new AbortController();
  let lossMarker: ExplicitLocalAuthorityError | undefined;
  let authority = options.initialAuthority;
  let targets = new Map<string, SelectedTarget>();

  function applyProjectionSync(
    prefix: readonly RecordedPluginTrustEvent[] | undefined,
    allowEvidence: boolean,
    failure: ExplicitLocalAuthorityError | undefined,
    onWithdrawal: (cancelPreparation: () => void) => void,
  ): void {
    const { local, mcp } = getSources();
    const stickyIds = authority.installations.map(({ pluginId }) => pluginId);
    const sticky = new Set(stickyIds);
    const denied = new Set(mcp?.declaredPluginIds().filter((id) => sticky.has(id)));
    const trust = foldTrust(authority.trustEvents);
    const trustSequences = new Map(
      authority.trustEvents.map(({ pluginId, sequence }) => [pluginId, sequence]),
    );
    const nextTargets = new Map<string, SelectedTarget>();
    const selections: ExplicitLocalSelection[] = [];
    for (const { pluginId, selection, candidates } of authority.installations) {
      if (selection === null) continue;
      const candidate = candidates.find(
        (item) =>
          item.pluginId === pluginId &&
          item.manifest.id === pluginId &&
          item.digest === selection.digest &&
          item.firstImportSequence === selection.candidateImportSequence,
      );
      if (candidate === undefined) continue;
      const { activationSequence } = selection;
      const { manifest, digest } = candidate;
      const selectionInput = { manifest, digest, activationSequence };
      const record = trust.get(pluginId);
      if (
        allowEvidence &&
        lossMarker === undefined &&
        local !== undefined &&
        owned !== undefined &&
        authority.identity.databaseId === owned.binding.databaseId &&
        !denied.has(pluginId) &&
        record?.enabled &&
        record.digest === digest
      ) {
        const canonicalManifest = canonicalJson(manifest);
        if (
          canonicalJson(record.manifest) === canonicalManifest &&
          local.mayReadManagedSync(pluginId)
        ) {
          const key = JSON.stringify([
            digest,
            candidate.firstImportSequence,
            activationSequence,
            candidate.files,
            candidate.bytes,
            canonicalManifest,
            trustSequences.get(pluginId),
          ]);
          const previous = targets.get(pluginId);
          const target =
            previous?.key === key
              ? previous
              : { candidate, activationSequence, manifest: canonicalManifest, key };
          nextTargets.set(pluginId, target);
          selections.push({ ...selectionInput, ready: target.ready, issue: target.issue });
          continue;
        }
      }
      selections.push(selectionInput);
    }
    targets = nextTargets;
    try {
      if (local === undefined) return;
      if (prefix === undefined) {
        onWithdrawal(local.withdrawExplicitSelectionSync(sticky, undefined, failure));
      } else {
        try {
          local.adoptExplicitSelectionSync({
            stickyIds,
            deniedIds: [...denied],
            selections,
            trustEvents: prefix,
          });
        } catch (cause: unknown) {
          targets.clear();
          const error = failure ?? new ExplicitLocalAuthorityError(cause);
          try {
            onWithdrawal(
              local.withdrawExplicitSelectionSync(sticky, prefix.at(-1)?.sequence, error),
            );
          } catch (withdrawal: unknown) {
            if (lossMarker !== undefined) {
              throw new ExplicitLocalAuthorityError(
                new AggregateError([cause, withdrawal], 'Local readiness withdrawal failed', {
                  cause,
                }),
              );
            }
          }
          throw error;
        }
      }
    } finally {
      mcp?.setDeniedPluginIdsSync(denied);
    }
  }

  function reconcileSync(
    snapshot: () => PluginAuthoritySnapshot,
    applyMcp?: () => void,
    priorFailure?: ExplicitLocalAuthorityError,
  ): void {
    let failure = priorFailure;
    let cancelPreparation: (() => void) | undefined;
    try {
      buffer.runSync(() => {
        applyMcp?.();
        let prefix: readonly RecordedPluginTrustEvent[] | undefined;
        try {
          authority = snapshot();
          prefix =
            options.readLocalTrustEventsSync === undefined
              ? authority.trustEvents
              : options.readLocalTrustEventsSync();
        } catch (cause: unknown) {
          failure ??= new ExplicitLocalAuthorityError(cause);
          if (options.readLocalTrustEventsSync === undefined) prefix = authority.trustEvents;
        }
        try {
          applyProjectionSync(
            prefix,
            failure === undefined && prefix !== undefined,
            failure,
            (cancel) => {
              cancelPreparation = cancel;
            },
          );
        } catch (cause: unknown) {
          if (failure === undefined) {
            failure =
              cause instanceof ExplicitLocalAuthorityError
                ? cause
                : new ExplicitLocalAuthorityError(cause);
          } else if (lossMarker !== undefined && cause !== failure) {
            const withdrawal = cause instanceof ExplicitLocalAuthorityError ? cause.cause : cause;
            failure = new ExplicitLocalAuthorityError(
              new AggregateError([failure.cause, withdrawal], 'Local readiness withdrawal failed', {
                cause: failure.cause,
              }),
            );
          }
        }
      });
    } finally {
      cancelPreparation?.();
    }
    if (failure !== undefined) throw failure;
  }

  function adoptAuthoritySync(snapshot: PluginAuthoritySnapshot): void {
    reconcileSync(() => snapshot);
  }

  function adoptLatestAuthoritySync(): void {
    reconcileSync(options.readAuthoritySync);
  }

  function invalidateAuthoritySync(cause: unknown): never {
    const failure =
      cause instanceof ExplicitLocalAuthorityError ? cause : new ExplicitLocalAuthorityError(cause);
    // An install hook can already have withdrawn both sources before rejecting.
    if (targets.size > 0 || !(cause instanceof ExplicitLocalAuthorityError)) {
      reconcileSync(() => authority, undefined, failure);
    }
    throw failure;
  }

  function assertNotLostSync(): undefined {
    if (lossMarker !== undefined) throw lossMarker;
    return undefined;
  }

  function onOwnershipLostSync(error: PluginStoreOwnershipError): undefined {
    if (lossMarker !== undefined) return undefined;
    lossMarker = new ExplicitLocalAuthorityError(error);
    try {
      blockManagedOwnershipLossSync();
      adoptAuthoritySync(authority);
    } catch (withdrawal: unknown) {
      const cause =
        withdrawal instanceof ExplicitLocalAuthorityError ? withdrawal.cause : withdrawal;
      lossMarker = new ExplicitLocalAuthorityError(
        new AggregateError([error, cause], 'Could not withdraw managed plugin readiness', {
          cause: error,
        }),
      );
    } finally {
      ownershipLoss.abort(lossMarker);
    }
    return undefined;
  }

  function rejectOwnershipFailure(cause: unknown): void {
    if (
      cause instanceof PluginStoreOwnershipError &&
      cause.code === 'plugin-store-ownership-lost'
    ) {
      onOwnershipLostSync(cause);
    }
    assertNotLostSync();
  }

  function assertHeldSync(): void {
    assertNotLostSync();
    try {
      owned!.assertHeldSync();
    } catch (cause: unknown) {
      rejectOwnershipFailure(cause);
      invalidateAuthoritySync(cause);
    }
    assertNotLostSync();
  }

  function assertManagedStartSync(): undefined {
    assertNotLostSync();
    try {
      owned!.assertHeldSync();
    } catch (cause: unknown) {
      rejectOwnershipFailure(cause);
      throw new ExplicitLocalAuthorityError(cause);
    }
    return assertNotLostSync();
  }

  async function refreshNamespace(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    const { mcp } = getSources();
    if (mcp !== undefined) await mcp.refresh();
  }

  function sameReady(target: SelectedTarget, expected: ManagedLocalCandidate): boolean {
    const { ready } = target;
    return (
      ready !== undefined &&
      target.activationSequence === expected.activationSequence &&
      ready.digest === expected.digest &&
      ready.entry === expected.entry &&
      ready.directory === expected.directory &&
      target.manifest === canonicalJson(expected.manifest)
    );
  }

  async function readSelected(
    id: string,
    signal: AbortSignal,
    expected?: ManagedLocalCandidate,
  ): Promise<ReadyLocalPlugin | undefined> {
    assertNotLostSync();
    await refreshNamespace(signal);
    assertNotLostSync();
    signal.throwIfAborted();
    adoptLatestAuthoritySync();
    const target = targets.get(id);
    if (target === undefined || (expected !== undefined && !sameReady(target, expected))) {
      return undefined;
    }
    assertHeldSync();
    signal.throwIfAborted();
    const readSignal = AbortSignal.any([signal, ownershipLoss.signal]);
    let artifact: PluginArtifact | undefined;
    try {
      artifact = await owned!.read(target.candidate.digest, { signal: readSignal });
    } catch (cause: unknown) {
      rejectOwnershipFailure(cause);
      if (cause instanceof PluginStoreOwnershipError) invalidateAuthoritySync(cause);
    }
    assertNotLostSync();
    await refreshNamespace(signal);
    assertNotLostSync();
    signal.throwIfAborted();
    adoptLatestAuthoritySync();
    if (targets.get(id) !== target) return undefined;
    assertHeldSync();
    let ready =
      artifact !== undefined && matchesArtifact(artifact, target)
        ? {
            status: 'ready' as const,
            id,
            digest: artifact.digest,
            manifest: target.candidate.manifest,
            directory: artifact.directory,
            entry: artifact.entry,
          }
        : undefined;
    if (
      expected !== undefined &&
      (ready?.entry !== expected.entry || ready?.directory !== expected.directory)
    ) {
      ready = undefined;
    }
    target.ready = ready;
    target.issue = ready === undefined ? artifactUnavailable : undefined;
    adoptAuthoritySync(authority);
    assertNotLostSync();
    return ready;
  }

  function assertReadyEvidenceSync(matchesReady: () => boolean): undefined {
    assertHeldSync();
    adoptLatestAuthoritySync();
    assertNotLostSync();
    if (!matchesReady()) throw new ExplicitLocalAuthorityError(identityChanged());
    return undefined;
  }

  function matchesReadyIdentity({ pluginId, identity, origin }: ExtensionIdentity): boolean {
    const target = targets.get(pluginId);
    return (
      origin === 'managed' &&
      target?.ready !== undefined &&
      localSourceCandidateIdentity({
        ...target.ready,
        origin,
        activationSequence: target.activationSequence,
      }) === identity
    );
  }

  const managedAuthority: ManagedGenerationAuthority = {
    ownershipLossSignal: ownershipLoss.signal,
    assertNotLostSync,
    assertManagedPublicationSync(identities) {
      return assertReadyEvidenceSync(() => identities.every(matchesReadyIdentity));
    },
    assertManagedStartSync,
  };

  const explicitChecks: ExplicitLocalCandidateChecks = {
    async verify(candidate, signal) {
      const ready = await readSelected(candidate.id, signal, candidate);
      if (ready === undefined) throw identityChanged();
      return { entry: ready.entry, digest: ready.digest };
    },
    assertReadySync(candidate) {
      return assertReadyEvidenceSync(() => {
        const target = targets.get(candidate.id);
        return target !== undefined && sameReady(target, candidate);
      });
    },
  };

  return {
    adoptAuthoritySync,
    adoptLatestAuthoritySync,
    adoptInitialAuthoritySync: () => adoptAuthoritySync(options.initialAuthority),
    invalidateAuthoritySync,
    managedAuthority,
    onOwnershipLostSync,
    explicitChecks,
    async refreshSelectedEvidence(signal: AbortSignal): Promise<void> {
      signal.throwIfAborted();
      adoptLatestAuthoritySync();
      for (const id of [...targets.keys()]) await readSelected(id, signal);
    },
    installAuthoritySync: (applyValidatedLog: () => void) =>
      reconcileSync(options.readAuthoritySync, applyValidatedLog),
    assertCreateAllowedSync(pluginId: string): void {
      adoptLatestAuthoritySync();
      if (authority.installations.some((record) => record.pluginId === pluginId)) {
        throw new McpAuthorityError('mcp-conflict');
      }
    },
  };
}
