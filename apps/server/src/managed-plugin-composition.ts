import {
  sameExtensionSourceStamp,
  type ExtensionAuthorityChange,
  type ExtensionSourceFactory,
  type ExtensionSourceStamp,
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
