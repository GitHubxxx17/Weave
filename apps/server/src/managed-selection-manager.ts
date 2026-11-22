import {
  foldTrust,
  localSourceCandidateIdentity,
  PluginArtifactError,
  PluginHostError,
  type ReadyLocalPlugin,
} from '@weave/plugin-host';
import type {
  ExtensionCoordinator,
  ManagedApplicationFailureKind,
  ManagedRuntimeObservation,
} from './extension-coordinator.js';
import { localExtensionSourceId as sourceId } from './local-extension-source.js';
import {
  commitManagedCommandSync,
  invalidateManagedCommandAuthoritySync,
} from './managed-command-commit.js';
import type { createManagedPluginComposition } from './managed-plugin-composition.js';
import { ManagedInstallerError } from './managed-plugin-installer-errors.js';
import { canonicalizeManagedRequest, canonicalJson } from './plugin-authority-data.js';
import {
  PluginAuthorityError,
  type ManagedCommand,
  type ManagedPluginRecord,
  type ManagedPreparation,
  type ManagedRequest,
  type PluginAuthorityDatabase,
  type PluginAuthoritySnapshot,
  type RecordedManagedOperation,
} from './plugin-authority-types.js';

export type ManagedSelectionRequest = ManagedRequest & {
  readonly command: Exclude<ManagedCommand, { readonly kind: 'import' }>;
};

export type ManagedSelectionResult =
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
        | { readonly status: 'applied' }
        | {
            readonly status: 'failed';
            readonly failureKind: ManagedApplicationFailureKind;
            readonly cause?: unknown;
          };
    };

export type ApplyManagedSelection = (
  input: ManagedSelectionRequest,
  signal?: AbortSignal,
) => Promise<ManagedSelectionResult>;

type Replay = Omit<Extract<ManagedSelectionResult, { kind: 'replayed' }>, 'observed'>;
type Saved = Pick<
  Extract<ManagedSelectionResult, { kind: 'committed' }>,
  'operation' | 'savedAuthority'
> & {
  readonly ready: ReadyLocalPlugin | undefined;
};

function reviewedInstallation(
  snapshot: PluginAuthoritySnapshot,
  command: ManagedSelectionRequest['command'],
): ManagedPluginRecord {
  if (
    snapshot.heads.installSequence !== command.expectedInstallSequence ||
    snapshot.heads.trustSequence !== command.expectedTrustSequence
  ) {
    throw new PluginAuthorityError('plugin-authority-conflict', 'Managed authority changed');
  }
  const installation = snapshot.installations.find(({ pluginId }) => pluginId === command.pluginId);
  if (installation === undefined) {
    throw new PluginAuthorityError('plugin-authority-not-found', 'Managed plugin was not imported');
  }
  const reviewedSelection =
    command.kind === 'activate' ? command.previousSelection : command.selectedDigest;
  if ((installation.selection?.digest ?? null) !== reviewedSelection) {
    throw new PluginAuthorityError('plugin-authority-conflict', 'Managed selection changed');
  }
  return installation;
}

function candidateFor(
  snapshot: PluginAuthoritySnapshot,
  installation: ManagedPluginRecord,
  command: Extract<ManagedCommand, { kind: 'activate' | 'enable' }>,
) {
  if (command.kind === 'activate') {
    const candidate = installation.candidates.find(({ digest }) => digest === command.digest);
    if (candidate === undefined) {
      throw new PluginAuthorityError(
        'plugin-authority-not-found',
        'Managed artifact was not imported',
      );
    }
    if (canonicalJson(candidate.manifest) !== canonicalJson(command.manifest)) {
      throw new PluginAuthorityError(
        'plugin-authority-conflict',
        'Managed artifact manifest changed',
      );
    }
    return candidate;
  }
  const candidate = installation.candidates.find(
    ({ digest, firstImportSequence }) =>
      digest === command.selectedDigest &&
      firstImportSequence === installation.selection?.candidateImportSequence,
  );
  const trust = foldTrust(snapshot.trustEvents).get(command.pluginId);
  if (
    candidate === undefined ||
    trust?.digest !== candidate.digest ||
    canonicalJson(trust.manifest) !== canonicalJson(candidate.manifest)
  ) {
    throw new PluginAuthorityError(
      'plugin-authority-activation-required',
      'Managed artifact requires activation',
    );
  }
  return candidate;
}

export function createManagedSelectionManager(
  coordinator: ExtensionCoordinator,
  authority: Pick<PluginAuthorityDatabase, 'lookupSync' | 'commitSync' | 'snapshotSync'>,
  composition: Pick<
    ReturnType<typeof createManagedPluginComposition>,
    | 'assertCommandLeaseSync'
    | 'readCommandArtifact'
    | 'adoptCommittedAuthoritySync'
    | 'invalidateAuthoritySync'
  >,
): ApplyManagedSelection {
  return async function applyManagedSelection(input, signal) {
    const { request } = canonicalizeManagedRequest(input);
    const { command } = request;
    if (command.kind === 'import') {
      throw new PluginAuthorityError(
        'plugin-authority-invalid',
        'Import is not a managed selection command',
      );
    }

    const completion = await coordinator.mutateManaged<Replay, Saved>(sourceId, async (context) => {
      function assertCallerSync() {
        if (signal?.aborted) {
          throw new ManagedInstallerError('plugin-installer-unavailable', { cause: signal.reason });
        }
      }

      function assertCanCommitSync() {
        context.assertOpenSync();
        assertCallerSync();
        composition.assertCommandLeaseSync();
        context.assertOpenSync();
        assertCallerSync();
      }

      const found = authority.lookupSync(request);
      if (found.kind === 'replayed') {
        return {
          disposition: 'skip-rebuild',
          replay: {
            kind: 'replayed',
            operation: found.operation,
            currentAuthority: found.currentSnapshot,
          },
        };
      }

      assertCanCommitSync();
      const before = authority.snapshotSync();
      const installation = reviewedInstallation(before, command);
      let ready: ReadyLocalPlugin | undefined;
      let prepared: ManagedPreparation;
      if (command.kind === 'activate' || command.kind === 'enable') {
        const candidate = candidateFor(before, installation, command);
        const preparationSignal =
          signal === undefined ? context.signal : AbortSignal.any([context.signal, signal]);
        try {
          const evidence = await composition.readCommandArtifact(candidate, preparationSignal);
          prepared = { kind: command.kind, artifact: evidence.artifact };
          ready = evidence.ready;
        } catch (cause: unknown) {
          if (preparationSignal.aborted && Object.is(cause, preparationSignal.reason)) {
            context.assertOpenSync();
            assertCallerSync();
          }
          if (
            (cause instanceof PluginHostError && cause.code === 'plugin-digest-mismatch') ||
            (cause instanceof PluginArtifactError &&
              (cause.code === 'plugin-artifact-conflict' ||
                cause.code === 'plugin-artifact-not-found' ||
                cause.code === 'plugin-artifact-corrupt'))
          ) {
            throw new ManagedInstallerError('plugin-artifact-unavailable', { cause });
          }
          throw cause;
        }
      } else {
        prepared = { kind: command.kind };
      }
      assertCanCommitSync();
      const committed = commitManagedCommandSync(
        authority,
        { request, prepared },
        before,
        (cause, stickyIds) => {
          invalidateManagedCommandAuthoritySync(coordinator, composition, cause, stickyIds);
        },
      );
      if (committed.kind === 'replayed') {
        return {
          disposition: 'skip-rebuild',
          replay: {
            kind: 'replayed',
            operation: committed.operation,
            currentAuthority: committed.currentSnapshot,
          },
        };
      }

      const saved = {
        operation: committed.operation,
        savedAuthority: committed.afterSnapshot,
        ready,
      };
      const causes: unknown[] = [];
      try {
        composition.adoptCommittedAuthoritySync(saved.savedAuthority, () => {
          coordinator.blockManagedAdoptionFailureSync(
            sourceId,
            new Set(saved.savedAuthority.installations.map(({ pluginId }) => pluginId)),
          );
        });
      } catch (cause: unknown) {
        causes.push(cause);
      }
      if ('immediate' in command && command.immediate) {
        try {
          coordinator.retryImmediateRevocation(sourceId, command.pluginId, 'managed');
        } catch (cause: unknown) {
          causes.push(cause);
        }
      }
      if (causes.length === 0) return { disposition: 'rebuild', saved };
      const cause =
        causes.length === 1
          ? causes[0]
          : new AggregateError(causes, 'Managed authority application failed', {
              cause: causes[0],
            });
      return { disposition: 'committed-failed', saved, cause };
    });

    if (completion.kind === 'replayed')
      return { ...completion.replay, observed: completion.observed };
    const { saved, observed, outcome } = completion;
    const { generation, members } = observed;
    const { operation, savedAuthority, ready } = saved;
    const decision = { kind: 'committed' as const, operation, savedAuthority, observed };
    if (outcome.kind === 'failed') {
      return {
        ...decision,
        application: { status: 'failed', failureKind: outcome.failureKind, cause: outcome.cause },
      };
    }

    const { selection } = operation.decision.pluginAfter;
    const expectedIdentity =
      ready === undefined || selection === null || selection.digest !== ready.digest
        ? undefined
        : localSourceCandidateIdentity({
            ...ready,
            origin: 'managed',
            activationSequence: selection.activationSequence,
          });
    const target = (member: { sourceId: string; pluginId: string; origin?: string }) =>
      member.sourceId === sourceId &&
      member.pluginId === command.pluginId &&
      member.origin === 'managed';
    if (!generation.acceptingRuns) {
      return { ...decision, application: { status: 'failed', failureKind: 'publication' } };
    }
    const applied =
      ready === undefined
        ? !members.some(target)
        : expectedIdentity !== undefined &&
          members.some((member) => target(member) && member.identity === expectedIdentity);
    if (applied) return { ...decision, application: { status: 'applied' } };
    const attributed =
      outcome.kind !== 'completed' || expectedIdentity === undefined
        ? undefined
        : outcome.attributedFailures?.find(
            (failure) => target(failure) && failure.identity === expectedIdentity,
          );
    return {
      ...decision,
      application: {
        status: 'failed',
        failureKind: ready === undefined ? 'publication' : 'preparation',
        ...(attributed === undefined ? {} : { cause: attributed.cause }),
      },
    };
  };
}
