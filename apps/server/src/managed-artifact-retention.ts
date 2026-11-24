import type { ManagedCandidate, PluginAuthoritySnapshot } from './plugin-authority-types.js';

/**
 * Decides which managed artifacts the authority still needs. The decision replays only
 * the recorded operations, in order, so history never changes meaning:
 *
 * - an import retains its digest as a pending candidate, including a repeat import of
 *   known content (which records an operation but no install event);
 * - an activation retains the activated digest and retires the digest it replaced;
 * - an uninstall retires every digest of the plugin.
 *
 * A retired digest may be deleted once no Generation uses it. A candidate that was
 * imported but never activated stays retained until it is activated, replaced by an
 * uninstall, or the store limit is reached.
 */
export function retainedDigestsByPlugin(
  snapshot: PluginAuthoritySnapshot,
): ReadonlyMap<string, ReadonlySet<string>> {
  const retained = new Map<string, Set<string>>();
  const digestsOf = (pluginId: string): Set<string> => {
    const digests = retained.get(pluginId) ?? new Set<string>();
    retained.set(pluginId, digests);
    return digests;
  };
  for (const operation of snapshot.operationEvents) {
    const { command, evidence, decision } = operation;
    switch (command.kind) {
      case 'import':
        if (evidence.kind === 'import') {
          digestsOf(evidence.artifact.pluginId).add(evidence.artifact.digest);
        }
        break;
      case 'activate': {
        const digests = digestsOf(decision.pluginId);
        const replaced = decision.pluginBefore.selection?.digest;
        if (replaced !== undefined && replaced !== command.digest) digests.delete(replaced);
        digests.add(command.digest);
        break;
      }
      case 'uninstall':
        if (decision.changed) digestsOf(decision.pluginId).clear();
        break;
      default:
        break;
    }
  }
  for (const record of snapshot.installations) {
    const digests = digestsOf(record.pluginId);
    if (record.selection !== null) digests.add(record.selection.digest);
  }
  return retained;
}

export function retainedArtifactDigests(snapshot: PluginAuthoritySnapshot): ReadonlySet<string> {
  const digests = new Set<string>();
  for (const values of retainedDigestsByPlugin(snapshot).values()) {
    for (const digest of values) digests.add(digest);
  }
  return digests;
}

/** Candidates the user can still activate; retired history is not offered. */
export function currentCandidates(
  snapshot: PluginAuthoritySnapshot,
  pluginId: string,
  candidates: readonly ManagedCandidate[],
): readonly ManagedCandidate[] {
  const retained = retainedDigestsByPlugin(snapshot).get(pluginId);
  return candidates.filter(({ digest }) => retained?.has(digest) === true);
}
