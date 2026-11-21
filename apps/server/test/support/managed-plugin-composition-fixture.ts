import type { ExtensionCoordinator } from '../../src/extension-coordinator.js';
import type {
  ExtensionAuthorityObserver,
  ExtensionSourceFactory,
  ExtensionSourceSnapshot,
} from '../../src/extension-types.js';
import { createManagedAuthorityObserverBuffer } from '../../src/managed-plugin-composition.js';
import { McpAuthorityError } from '../../src/mcp-authority-store.js';
import type { createMcpExtensionSource } from '../../src/mcp-source.js';

/** Supplies local authority directly while exercising the real MCP source and publication path. */
export function createManagedPluginCompositionFixture() {
  const localSourceId = 'local-esm';
  let sticky = new Set<string>();
  let localObserver: ExtensionAuthorityObserver;
  let localRevision = 0;
  let localDenied: readonly string[] = [];
  let coordinator: ExtensionCoordinator;
  let mcp: ReturnType<typeof createMcpExtensionSource>;
  const buffer = createManagedAuthorityObserverBuffer((changes) =>
    coordinator.observeAuthorityBatchSync(changes),
  );

  function localSnapshot(): ExtensionSourceSnapshot {
    return { stamp: { revision: localRevision, trustSequence: 0 }, eligible: [] };
  }

  const registerLocal: ExtensionSourceFactory = (observe) => {
    localObserver = observe;
    return {
      id: localSourceId,
      snapshot: localSnapshot,
      refresh: async () => {},
      close: async () => {},
      prepare: async (stamp) => ({
        stamp,
        items: [],
        failures: [],
        recheck: async () => true,
        dispose: async () => {},
      }),
    };
  };

  function reconcileSync(immediate: boolean): void {
    const denied = mcp.declaredPluginIds().filter((id) => sticky.has(id));
    if (localDenied.length !== denied.length || localDenied.some((id) => !denied.includes(id))) {
      const affectedIds = [...new Set([...localDenied, ...denied])];
      localDenied = denied;
      localRevision++;
      localObserver(localSourceId, { snapshot: localSnapshot(), affectedIds, immediate });
    }
    mcp.setDeniedPluginIdsSync(new Set(denied));
  }

  return {
    localSnapshot,
    registerLocal: buffer.wrapSource(registerLocal),
    wrapSource: buffer.wrapSource,
    attach(next: ExtensionCoordinator, source: typeof mcp) {
      coordinator = next;
      mcp = source;
    },
    adoptStickyIdsSync(ids: readonly string[], immediate = false) {
      buffer.runSync(() => {
        sticky = new Set(ids);
        reconcileSync(immediate);
      });
    },
    installAuthoritySync(apply: () => void) {
      buffer.runSync(() => {
        apply();
        reconcileSync(false);
      });
    },
    assertCreateAllowedSync(pluginId: string) {
      if (sticky.has(pluginId)) throw new McpAuthorityError('mcp-conflict');
    },
  };
}
