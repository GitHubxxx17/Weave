import { ExplicitLocalAuthorityError } from '@weave/plugin-host';
import type { ExtensionCoordinator } from './extension-coordinator.js';
import { localExtensionSourceId } from './local-extension-source.js';
import type { createManagedPluginComposition } from './managed-plugin-composition.js';
import type {
  ManagedCommit,
  ManagedCommitInput,
  PluginAuthorityDatabase,
  PluginAuthoritySnapshot,
} from './plugin-authority-types.js';

export class ManagedCommitFailure extends AggregateError {
  declare readonly cause: unknown;

  constructor(primary: unknown, additional: readonly unknown[]) {
    super([primary, ...additional], 'Managed command commit failed', { cause: primary });
    this.name = 'ManagedCommitFailure';
  }
}

export function invalidateManagedCommandAuthoritySync(
  coordinator: Pick<ExtensionCoordinator, 'blockManagedAdoptionFailureSync'>,
  composition: Pick<ReturnType<typeof createManagedPluginComposition>, 'invalidateAuthoritySync'>,
  cause: unknown,
  stickyIds: ReadonlySet<string>,
): void {
  const additional: unknown[] = [];
  try {
    coordinator.blockManagedAdoptionFailureSync(localExtensionSourceId, stickyIds);
  } catch (failure: unknown) {
    additional.push(failure);
  }
  const marker = new ExplicitLocalAuthorityError(cause);
  try {
    composition.invalidateAuthoritySync(marker, (failure) => additional.push(failure));
  } catch (failure: unknown) {
    if (failure !== marker) additional.push(failure);
  }
  if (additional.length > 0) throw new ManagedCommitFailure(cause, additional);
}

export function commitManagedCommandSync(
  authority: Pick<PluginAuthorityDatabase, 'commitSync' | 'snapshotSync'>,
  input: ManagedCommitInput,
  observedBefore: PluginAuthoritySnapshot,
  invalidateSync: (cause: unknown, stickyIds: ReadonlySet<string>) => void,
): ManagedCommit {
  try {
    return authority.commitSync(input);
  } catch (primary: unknown) {
    const additional: unknown[] = [];
    let unchanged = false;
    try {
      const { heads } = authority.snapshotSync();
      unchanged =
        heads.installSequence === observedBefore.heads.installSequence &&
        heads.trustSequence === observedBefore.heads.trustSequence;
    } catch (proof: unknown) {
      additional.push(proof);
    }
    if (unchanged) throw primary;

    const stickyIds = new Set(observedBefore.installations.map(({ pluginId }) => pluginId));
    if (input.prepared.kind === 'import') stickyIds.add(input.prepared.artifact.pluginId);
    try {
      invalidateSync(primary, stickyIds);
    } catch (failure: unknown) {
      if (failure instanceof ManagedCommitFailure) additional.push(...failure.errors.slice(1));
      else additional.push(failure);
    }
    if (additional.length > 0) throw new ManagedCommitFailure(primary, additional);
    throw primary;
  }
}
