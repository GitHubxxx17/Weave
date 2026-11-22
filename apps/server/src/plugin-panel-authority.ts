import { PanelError } from './plugin-panel-errors.js';
import type { ServerHost } from './server-host.js';
import {
  freezePanel,
  type CurrentUiAuthority,
  type CurrentUiObservation,
} from './plugin-panel-types.js';
/** Explicit embedded-host adapter. Only previously initialized host baseline IDs may be allowed. */
export function createHostUiAuthority(
  host: ServerHost,
  allowedPluginIds: readonly string[],
): CurrentUiAuthority & { closeSync(): void } {
  const allowed = new Set(allowedPluginIds);
  const members = freezePanel(
    host
      .hostUiMembersSync()
      .filter((member) => member.kind === 'host' && allowed.has(member.pluginId)),
  );
  if (members.length !== allowed.size)
    throw new Error('Panel host authority requires an explicit initialized baseline');
  let epoch = 1,
    closed = false,
    signal = new AbortController();
  const listeners = new Set<() => void>();
  function invalidate() {
    const old = signal;
    const next = new AbortController();
    epoch++;
    signal = next;
    old.abort(new PanelError('panel-unavailable'));
    for (const listener of listeners) {
      if (signal !== next) break;
      try {
        listener();
      } catch {
        /* Host observation cannot change publication. */
      }
    }
  }
  const unsubscribe = host.subscribePublicationSync(invalidate);
  return {
    captureCurrentUiSync() {
      return Object.freeze({
        generationId: host.currentPublicationSync()?.generationId ?? 1,
        authorityEpoch: epoch,
        available:
          !closed &&
          host.currentPublicationSync()?.generationId === host.controller()?.current().id,
        members,
        signal: signal.signal,
      });
    },
    assertCurrentUiSync(capture: CurrentUiObservation) {
      if (
        closed ||
        capture.signal.aborted ||
        capture.authorityEpoch !== epoch ||
        capture.generationId !== host.currentPublicationSync()?.generationId ||
        capture.generationId !== host.controller()?.current().id
      )
        throw new PanelError('panel-unavailable');
    },
    subscribeUiInvalidationSync(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    closeSync() {
      if (closed) return;
      closed = true;
      unsubscribe();
      invalidate();
    },
  };
}
