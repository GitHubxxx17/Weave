import { localSourceCandidateIdentity, type ReadyLocalPlugin } from '@weave/plugin-host';
import type { ExtensionCoordinator } from './extension-coordinator.js';
import type { ExtensionGenerationSnapshot } from './extension-types.js';
import { localExtensionSourceId as sourceId } from './local-extension-source.js';
import type { createManagedPluginComposition } from './managed-plugin-composition.js';
import { canonicalizeManagedRequest } from './plugin-authority-data.js';
import {
  PluginAuthorityError,
  type ManagedCommand,
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
    }
  | {
      readonly kind: 'committed';
      readonly operation: RecordedManagedOperation;
      readonly savedAuthority: PluginAuthoritySnapshot;
      readonly application: {
        readonly status: 'applied' | 'failed';
        readonly generation: ExtensionGenerationSnapshot;
        readonly cause?: unknown;
      };
    };

type Replay = Extract<ManagedSelectionResult, { kind: 'replayed' }>;
type Saved = Pick<
  Extract<ManagedSelectionResult, { kind: 'committed' }>,
  'operation' | 'savedAuthority'
> & {
  readonly ready: ReadyLocalPlugin | undefined;
};

function candidateFor(
  snapshot: PluginAuthoritySnapshot,
  command: Extract<ManagedCommand, { kind: 'activate' | 'enable' }>,
) {
  const installation = snapshot.installations.find(({ pluginId }) => pluginId === command.pluginId);
  if (installation === undefined) {
    throw new PluginAuthorityError('plugin-authority-not-found', 'Managed plugin was not imported');
  }
  if (command.kind === 'activate') {
    const candidate = installation.candidates.find(({ digest }) => digest === command.digest);
    if (candidate === undefined) {
      throw new PluginAuthorityError(
        'plugin-authority-not-found',
        'Managed artifact was not imported',
      );
    }
    return candidate;
  }
  if (installation.selection?.digest !== command.selectedDigest) {
    throw new PluginAuthorityError('plugin-authority-conflict', 'Managed selection changed');
  }
  const candidate = installation.candidates.find(
    ({ digest, firstImportSequence }) =>
      digest === command.selectedDigest &&
      firstImportSequence === installation.selection?.candidateImportSequence,
  );
  if (candidate === undefined) {
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
    'assertCommandLeaseSync' | 'readCommandArtifact' | 'adoptCommittedAuthoritySync'
  >,
) {
  return async function applyManagedSelection(
    input: ManagedSelectionRequest,
  ): Promise<ManagedSelectionResult> {
    const { request } = canonicalizeManagedRequest(input);
    const { command } = request;
    if (command.kind === 'import') {
      throw new PluginAuthorityError(
        'plugin-authority-invalid',
        'Import is not a managed selection command',
      );
    }

    const completion = await coordinator.mutateManaged<Replay, Saved>(sourceId, async (context) => {
      function assertCanCommitSync() {
        context.assertOpenSync();
        composition.assertCommandLeaseSync();
        context.assertOpenSync();
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
      let ready: ReadyLocalPlugin | undefined;
      let prepared: ManagedPreparation;
      if (command.kind === 'activate' || command.kind === 'enable') {
        const evidence = await composition.readCommandArtifact(
          candidateFor(authority.snapshotSync(), command),
          context.signal,
        );
        prepared = { kind: command.kind, artifact: evidence.artifact };
        ready = evidence.ready;
      } else {
        prepared = { kind: command.kind };
      }
      assertCanCommitSync();
      const committed = authority.commitSync({ request, prepared });
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

    if (completion.kind === 'replayed') return completion.replay;
    const { saved, generation, members, outcome } = completion;
    const { operation, savedAuthority, ready } = saved;
    const decision = { kind: 'committed' as const, operation, savedAuthority };
    if (outcome.kind === 'failed') {
      return { ...decision, application: { status: 'failed', generation, cause: outcome.cause } };
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
    const applied =
      generation.acceptingRuns &&
      (ready === undefined
        ? !members.some(target)
        : expectedIdentity !== undefined &&
          members.some((member) => target(member) && member.identity === expectedIdentity));
    const attributed =
      applied || expectedIdentity === undefined
        ? undefined
        : outcome.attributedFailures?.find(
            (failure) => target(failure) && failure.identity === expectedIdentity,
          );
    return {
      ...decision,
      application: {
        status: applied ? 'applied' : 'failed',
        generation,
        ...(attributed === undefined ? {} : { cause: attributed.cause }),
      },
    };
  };
}
