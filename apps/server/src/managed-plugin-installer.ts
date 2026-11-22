import { randomUUID } from 'node:crypto';
import {
  PluginArtifactError,
  type LocalPluginDeclarationClaims,
  type PluginArtifact,
  type PluginArtifactSourceIdentity,
} from '@weave/plugin-host';
import type { ExtensionCoordinator, ManagedRuntimeObservation } from './extension-coordinator.js';
import { localExtensionSourceId } from './local-extension-source.js';
import {
  commitManagedCommandSync,
  invalidateManagedCommandAuthoritySync,
} from './managed-command-commit.js';
import type { createManagedPluginComposition } from './managed-plugin-composition.js';
import { ManagedInstallerError } from './managed-plugin-installer-errors.js';
import type { ApplyManagedSelection } from './managed-selection-manager.js';
import type { OwnedPluginArtifactStore } from './owned-plugin-artifact-store.js';
import { canonicalizeManagedRequest, canonicalJson } from './plugin-authority-data.js';
import {
  PluginAuthorityError,
  type ManagedCommand,
  type ManagedLookup,
  type ManagedRequest,
  type PluginAuthorityDatabase,
  type PluginAuthoritySnapshot,
  type RecordedManagedOperation,
} from './plugin-authority-types.js';
import { absoluteStorePathSchema } from './plugin-store-ownership-types.js';

export type ManagedImportRequest = ManagedRequest & {
  readonly command: Extract<ManagedCommand, { kind: 'import' }>;
};

export interface ManagedImportPreview {
  readonly previewId: string;
  readonly expiresAt: string;
  readonly expectedInstallSequence: number;
  readonly candidate: Omit<PluginArtifactSourceIdentity, 'sourceDirectory'>;
}

export type ManagedImportResult =
  | {
      readonly kind: 'replayed';
      readonly operation: RecordedManagedOperation;
      readonly currentAuthority: PluginAuthoritySnapshot;
      readonly observed: ManagedRuntimeObservation;
    }
  | {
      readonly kind: 'committed';
      readonly operation: RecordedManagedOperation;
      readonly savedAuthority: PluginAuthoritySnapshot;
      readonly observed: ManagedRuntimeObservation;
      readonly application:
        | { readonly status: 'not-required' }
        | { readonly status: 'failed'; readonly failureKind: 'adoption'; readonly cause: unknown };
    };

export interface ManagedPluginInstaller {
  preview(sourceDirectory: string, signal?: AbortSignal): Promise<ManagedImportPreview>;
  import(request: ManagedImportRequest, signal?: AbortSignal): Promise<ManagedImportResult>;
  readonly applySelection: ApplyManagedSelection;
  snapshot(): {
    authority: PluginAuthoritySnapshot;
    observed: ManagedRuntimeObservation;
  };
  closeSync(): void;
}

export interface ManagedPluginInstallerOptions {
  readonly coordinator: ExtensionCoordinator;
  readonly authority: Pick<PluginAuthorityDatabase, 'lookupSync' | 'commitSync' | 'snapshotSync'>;
  readonly store: Pick<OwnedPluginArtifactStore, 'preview' | 'stage'>;
  readonly composition: Pick<
    ReturnType<typeof createManagedPluginComposition>,
    | 'assertCommandLeaseSync'
    | 'adoptCommittedAuthoritySync'
    | 'cachedAuthoritySync'
    | 'invalidateAuthoritySync'
    | 'managedAuthority'
  >;
  readonly inspectLocalClaims: (signal: AbortSignal) => Promise<LocalPluginDeclarationClaims>;
  readonly inspectMcpIds?: (signal: AbortSignal) => Promise<readonly string[]>;
  readonly reservedIds: ReadonlySet<string>;
  readonly applySelection: ApplyManagedSelection;
  readonly monotonicNow?: () => number;
  readonly wallNow?: () => number;
}

type Replay = Omit<Extract<ManagedImportResult, { kind: 'replayed' }>, 'observed'>;
type Saved = Pick<
  Extract<ManagedImportResult, { kind: 'committed' }>,
  'operation' | 'savedAuthority'
>;

interface Preview {
  readonly requestedDirectory: string;
  readonly source: PluginArtifactSourceIdentity;
  readonly installSequence: number;
  readonly deadline: number;
}

interface NamespaceClaims {
  readonly local: LocalPluginDeclarationClaims;
  readonly mcp: readonly string[];
}

const maxPreviews = 64;
const previewLifetimeMs = 10 * 60 * 1000;

function stalePreview(cause?: unknown): ManagedInstallerError {
  return new ManagedInstallerError('plugin-preview-stale', { cause });
}

function matchesSource(artifact: PluginArtifact, source: PluginArtifactSourceIdentity): boolean {
  return (
    artifact.digest === source.digest &&
    artifact.files === source.files &&
    artifact.bytes === source.bytes &&
    canonicalJson(artifact.descriptor.manifest) === canonicalJson(source.manifest)
  );
}

function replay(found: Extract<ManagedLookup, { kind: 'replayed' }>) {
  return {
    disposition: 'skip-rebuild' as const,
    replay: {
      kind: 'replayed' as const,
      operation: found.operation,
      currentAuthority: found.currentSnapshot,
    },
  };
}

export function createManagedPluginInstaller(
  options: ManagedPluginInstallerOptions,
): ManagedPluginInstaller {
  const { authority, coordinator, composition, store } = options;
  const monotonicNow = options.monotonicNow ?? (() => performance.now());
  const wallNow = options.wallNow ?? Date.now;
  const previews = new Map<string, Preview>();
  const lifetime = new AbortController();
  const loss = composition.managedAuthority.ownershipLossSignal;
  let pending = false;

  function closeSync() {
    loss.removeEventListener('abort', closeSync);
    previews.clear();
    lifetime.abort(loss.aborted ? loss.reason : undefined);
  }

  if (loss.aborted) closeSync();
  else loss.addEventListener('abort', closeSync, { once: true });

  function assertActiveSync(signal?: AbortSignal) {
    const stopped = lifetime.signal.aborted ? lifetime.signal : signal;
    if (stopped?.aborted) {
      throw new ManagedInstallerError('plugin-installer-unavailable', { cause: stopped.reason });
    }
  }

  function pruneExpiredSync() {
    const now = monotonicNow();
    for (const [id, review] of previews) {
      if (now >= review.deadline) previews.delete(id);
    }
  }

  async function preview(
    sourceDirectory: string,
    signal?: AbortSignal,
  ): Promise<ManagedImportPreview> {
    const directory = absoluteStorePathSchema.safeParse(sourceDirectory);
    if (!directory.success) {
      throw new ManagedInstallerError('plugin-invalid-request', { cause: directory.error });
    }
    assertActiveSync(signal);
    pruneExpiredSync();
    if (pending || previews.size >= maxPreviews) {
      throw new ManagedInstallerError('plugin-preview-capacity');
    }
    pending = true;
    const effective =
      signal === undefined ? lifetime.signal : AbortSignal.any([lifetime.signal, signal]);
    try {
      // The owned store returns validated, detached and frozen evidence.
      const source = await store.preview({ sourceDirectory: directory.data, signal: effective });
      assertActiveSync(signal);
      const installSequence = authority.snapshotSync().heads.installSequence;
      assertActiveSync(signal);
      composition.assertCommandLeaseSync();
      assertActiveSync(signal);
      const previewId = randomUUID();
      const deadline = monotonicNow() + previewLifetimeMs;
      const expiresAt = new Date(wallNow() + previewLifetimeMs).toISOString();
      previews.set(previewId, {
        requestedDirectory: directory.data,
        source,
        installSequence,
        deadline,
      });
      return {
        previewId,
        expiresAt,
        expectedInstallSequence: installSequence,
        candidate: {
          manifest: structuredClone(source.manifest),
          digest: source.digest,
          files: source.files,
          bytes: source.bytes,
        },
      };
    } catch (cause: unknown) {
      if (effective.aborted && Object.is(cause, effective.reason)) assertActiveSync(signal);
      throw cause;
    } finally {
      pending = false;
    }
  }

  function assertNamespaceSync(pluginId: string, claims: NamespaceClaims, previewId: string) {
    const retained = coordinator
      .retainedGenerations()
      .some(({ members }) =>
        members.some(
          (member) =>
            member.pluginId === pluginId &&
            (member.sourceId === 'mcp' ||
              (member.sourceId === localExtensionSourceId && member.origin === 'manual')),
        ),
      );
    if (
      options.reservedIds.has(pluginId) ||
      claims.local.pluginIds.includes(pluginId) ||
      claims.mcp.includes(pluginId) ||
      retained
    ) {
      previews.delete(previewId);
      throw new ManagedInstallerError('plugin-managed-id-conflict');
    }
    if (!claims.local.complete) {
      throw new ManagedInstallerError('plugin-managed-namespace-unavailable');
    }
  }

  async function stageReview(review: Preview, previewId: string, signal: AbortSignal) {
    try {
      return await store.stage({
        sourceDirectory: review.requestedDirectory,
        expectedSource: review.source,
        signal,
      });
    } catch (cause: unknown) {
      if (!(cause instanceof PluginArtifactError)) throw cause;
      if (cause.code === 'plugin-artifact-source-changed') {
        previews.delete(previewId);
        throw stalePreview(cause);
      }
      if (
        cause.code === 'plugin-artifact-conflict' ||
        cause.code === 'plugin-artifact-corrupt' ||
        cause.code === 'plugin-artifact-not-found'
      ) {
        throw new ManagedInstallerError('plugin-artifact-unavailable', { cause });
      }
      throw cause;
    }
  }

  async function importReviewed(
    input: ManagedImportRequest,
    signal?: AbortSignal,
  ): Promise<ManagedImportResult> {
    const { request } = canonicalizeManagedRequest(input);
    const { command } = request;
    if (command.kind !== 'import') {
      throw new PluginAuthorityError(
        'plugin-authority-invalid',
        'Expected a managed import command',
      );
    }
    const { previewId } = command;
    const completion = await coordinator.mutateManaged<Replay, Saved>(
      localExtensionSourceId,
      async (context) => {
        const found = authority.lookupSync(request);
        if (found.kind === 'replayed') return replay(found);

        function assertFreshSync() {
          context.assertOpenSync();
          assertActiveSync(signal);
        }

        function assertFreshLeaseSync() {
          assertFreshSync();
          composition.assertCommandLeaseSync();
          assertFreshSync();
        }

        assertFreshLeaseSync();
        pruneExpiredSync();
        const review = previews.get(previewId);
        if (review === undefined) throw stalePreview();
        const initial = authority.snapshotSync();
        if (initial.heads.installSequence !== review.installSequence) {
          previews.delete(previewId);
          throw stalePreview();
        }
        if (command.expectedInstallSequence !== review.installSequence) {
          throw new PluginAuthorityError('plugin-authority-conflict', 'Managed authority changed');
        }

        const effective = AbortSignal.any(
          signal === undefined
            ? [context.signal, lifetime.signal]
            : [context.signal, lifetime.signal, signal],
        );
        const pluginId = review.source.manifest.id;
        const firstImport = !initial.installations.some((record) => record.pluginId === pluginId);

        async function inspectNamespace(): Promise<NamespaceClaims> {
          const local = await options.inspectLocalClaims(effective);
          assertFreshSync();
          const mcp = (await options.inspectMcpIds?.(effective)) ?? [];
          return { local, mcp };
        }

        let artifact: PluginArtifact;
        let finalClaims: NamespaceClaims | undefined;
        try {
          if (firstImport) {
            const initialClaims = await inspectNamespace();
            assertFreshSync();
            assertNamespaceSync(pluginId, initialClaims, previewId);
          }
          artifact = await stageReview(review, previewId, effective);
          assertFreshSync();
          if (!matchesSource(artifact, review.source)) {
            throw new ManagedInstallerError('plugin-artifact-unavailable');
          }
          if (firstImport) finalClaims = await inspectNamespace();
        } catch (cause: unknown) {
          if (effective.aborted && Object.is(cause, effective.reason)) assertFreshSync();
          throw cause;
        }

        const prepared = {
          kind: 'import' as const,
          artifact: {
            pluginId: artifact.descriptor.manifest.id,
            manifest: artifact.descriptor.manifest,
            digest: artifact.digest,
            files: artifact.files,
            bytes: artifact.bytes,
          },
          provenance: {
            kind: 'local-directory' as const,
            sourceDirectory: review.source.sourceDirectory,
          },
        };
        // No awaits between the last live head, cached namespace observations and commit.
        assertFreshSync();
        const before = authority.snapshotSync();
        if (before.heads.installSequence !== review.installSequence) {
          try {
            const late = authority.lookupSync(request);
            if (late.kind === 'replayed') return replay(late);
            throw stalePreview();
          } finally {
            previews.delete(previewId);
          }
        }
        if (finalClaims !== undefined) assertNamespaceSync(pluginId, finalClaims, previewId);
        assertFreshLeaseSync();
        if (previews.get(previewId) !== review || monotonicNow() >= review.deadline) {
          previews.delete(previewId);
          throw stalePreview();
        }

        const committed = (() => {
          try {
            return commitManagedCommandSync(
              authority,
              { request, prepared },
              before,
              (cause, ids) =>
                invalidateManagedCommandAuthoritySync(coordinator, composition, cause, ids),
            );
          } finally {
            previews.delete(previewId);
          }
        })();
        if (committed.kind === 'replayed') return replay(committed);

        const saved = {
          operation: committed.operation,
          savedAuthority: committed.afterSnapshot,
        };
        try {
          composition.adoptCommittedAuthoritySync(saved.savedAuthority, () =>
            coordinator.blockManagedAdoptionFailureSync(
              localExtensionSourceId,
              new Set(saved.savedAuthority.installations.map(({ pluginId }) => pluginId)),
            ),
          );
          return { disposition: 'committed-no-rebuild', saved };
        } catch (cause: unknown) {
          return { disposition: 'committed-failed', saved, cause };
        }
      },
    );

    if (completion.kind === 'replayed') {
      return { ...completion.replay, observed: completion.observed };
    }
    const { saved, observed, outcome } = completion;
    return {
      kind: 'committed',
      ...saved,
      observed,
      application:
        outcome.kind === 'failed'
          ? { status: 'failed', failureKind: 'adoption', cause: outcome.cause }
          : { status: 'not-required' },
    };
  }

  return {
    preview,
    import: importReviewed,
    applySelection: options.applySelection,
    snapshot() {
      const cachedAuthority = composition.cachedAuthoritySync();
      const { generation, members } = coordinator.snapshot();
      return { authority: cachedAuthority, observed: { generation, members } };
    },
    closeSync,
  };
}
