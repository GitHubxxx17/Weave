import type { ExtensionGeneration } from '../mcp/mcp-types.js';
import type { ManagedHeads } from './managed-plugin-types.js';

export function sameLegacyGeneration(a: ExtensionGeneration, b: ExtensionGeneration): boolean {
  return (
    a.id === b.id &&
    a.acceptingRuns === b.acceptingRuns &&
    a.blocked?.code === b.blocked?.code &&
    a.blocked?.message === b.blocked?.message
  );
}

export function sameManagedGeneration(a: ExtensionGeneration, b: ExtensionGeneration): boolean {
  return (
    a.id === b.id &&
    a.acceptingRuns === b.acceptingRuns &&
    (a.blocked === undefined) === (b.blocked === undefined)
  );
}

export function managedHeadsAtLeast(candidate: ManagedHeads, confirmed: ManagedHeads): boolean {
  return (
    candidate.installSequence >= confirmed.installSequence &&
    candidate.trustSequence >= confirmed.trustSequence &&
    candidate.operationSequence >= confirmed.operationSequence
  );
}
