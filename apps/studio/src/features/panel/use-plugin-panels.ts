import { useCallback, useEffect, useRef, useState } from 'react';
import type { PluginCatalogStore } from '../plugins/plugin-catalog-store.js';
import { fetchPanelCatalog } from './plugin-panel-api.js';
import type { PanelCatalog } from './plugin-panel-types.js';
export interface PluginPanelsState {
  readonly catalog: PanelCatalog | undefined;
  readonly status: 'loading' | 'ready' | 'error';
  readonly refresh: () => void;
}
/** App-lifetime dedicated authority; management notifications only invalidate and refetch. */
export function usePluginPanels(
  management: PluginCatalogStore,
  invalidate: () => void,
): PluginPanelsState {
  const [state, setState] = useState<{
    catalog: PanelCatalog | undefined;
    status: PluginPanelsState['status'];
  }>({ catalog: undefined, status: 'loading' });
  const request = useRef<{ epoch: number; controller: AbortController | null }>({
    epoch: 0,
    controller: null,
  });
  const refresh = useCallback(() => {
    invalidate();
    const current = request.current;
    current.epoch += 1;
    current.controller?.abort();
    const epoch = current.epoch;
    const controller = new AbortController();
    current.controller = controller;
    setState({ catalog: undefined, status: 'loading' });
    void fetchPanelCatalog(controller.signal).then(
      (catalog) => {
        if (!controller.signal.aborted && epoch === request.current.epoch)
          setState({ catalog, status: 'ready' });
      },
      () => {
        if (!controller.signal.aborted && epoch === request.current.epoch)
          setState({ catalog: undefined, status: 'error' });
      },
    );
  }, [invalidate]);
  useEffect(() => {
    refresh();
    const unsubscribe = management.subscribe(refresh);
    return () => {
      unsubscribe();
      request.current.epoch += 1;
      request.current.controller?.abort();
      invalidate();
    };
  }, [management, refresh, invalidate]);
  return { ...state, refresh };
}
