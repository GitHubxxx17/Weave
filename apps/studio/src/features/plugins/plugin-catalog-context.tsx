import {
  createContext,
  useContext,
  useEffect,
  useSyncExternalStore,
  type ReactElement,
  type ReactNode,
} from 'react';

import type { PluginCatalogState, PluginCatalogStore } from './plugin-catalog-store.js';

const PluginCatalogContext = createContext<PluginCatalogStore | undefined>(undefined);

export function PluginCatalogProvider({
  store,
  children,
}: {
  readonly store: PluginCatalogStore;
  readonly children: ReactNode;
}): ReactElement {
  useEffect(() => {
    // The store publishes the failure and retains ownership across effect replay.
    void store.ensureLoaded().catch(() => undefined);
  }, [store]);
  return <PluginCatalogContext.Provider value={store}>{children}</PluginCatalogContext.Provider>;
}

export function usePluginCatalogStore(): PluginCatalogStore {
  const store = useContext(PluginCatalogContext);
  if (store === undefined) throw new Error('PluginCatalogProvider is required');
  return store;
}

export function usePluginCatalogState(): PluginCatalogState {
  const store = usePluginCatalogStore();
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}

export function PluginPendingBadge(): ReactElement | null {
  const { catalog, mcp } = usePluginCatalogState();
  const count =
    (catalog?.plugins.filter(
      (plugin) =>
        plugin.origin === 'local' &&
        plugin.host !== 'mcp' &&
        (plugin.state === 'pending-trust' || plugin.state === 'changed'),
    ).length ?? 0) +
    (mcp?.servers.filter((server) => server.state === 'untrusted' || server.state === 'changed')
      .length ?? 0);
  if (count === 0) return null;
  return (
    <span className="plugin-pending-badge" aria-label={`${String(count)} 个插件待审阅`}>
      {count}
    </span>
  );
}
