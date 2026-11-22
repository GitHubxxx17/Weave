import { useEffect, useRef, useState } from 'react';
import {
  addPluginMarketplaceSource,
  fetchPluginMarketplace,
  fetchPluginMarketplaceSources,
  refreshPluginMarketplaceSource,
  removePluginMarketplaceSource,
} from './plugin-marketplace-api.js';
import type { PluginMarketplace, PluginMarketplaceSources } from './plugin-marketplace-types.js';
import { PluginApiError } from './plugin-api.js';

const mutationErrors: Record<string, string> = {
  'plugin-marketplace-invalid-request': '请检查索引源名称和 HTTPS 索引地址。',
  'plugin-marketplace-source-exists': '该索引源已添加，请从列表中选择。',
  'plugin-marketplace-source-limit': '最多添加十个远程索引源，请先移除不再使用的来源。',
  'plugin-marketplace-settings-unavailable': '无法保存索引源设置，请检查服务状态后重试。',
  'plugin-marketplace-source-not-found': '该索引源已不存在，请重新读取设置。',
  'plugin-marketplace-source-immutable': '预置索引源不能移除。',
  'plugin-marketplace-closed': '服务正在关闭，请重新连接后重试。',
};

/** Source settings do not share plugin activation state or issue automatic network refreshes. */
export function useMarketplaceSources() {
  const [catalog, setCatalog] = useState<PluginMarketplace>();
  const [sources, setSources] = useState<PluginMarketplaceSources>();
  const [selectedSourceId, setSelectedSourceId] = useState<string>();
  const [catalogRevision, setCatalogRevision] = useState(0);
  const [sourcesRevision, setSourcesRevision] = useState(0);
  const [loading, setLoading] = useState(true);
  const [catalogError, setCatalogError] = useState(false);
  const [sourcesError, setSourcesError] = useState(false);
  const [actionError, setActionError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const action = useRef<AbortController | undefined>(undefined);
  const sourcesRead = useRef<AbortController | undefined>(undefined);
  const sourcesEpoch = useRef(0);
  const mounted = useRef(false);
  const selection = useRef<string | undefined>(undefined);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      action.current?.abort();
    };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setCatalogError(false);
    void fetchPluginMarketplace(controller.signal, selectedSourceId)
      .then((value) => {
        if (!controller.signal.aborted) setCatalog(value);
      })
      .catch(() => {
        if (!controller.signal.aborted) setCatalogError(true);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [catalogRevision, selectedSourceId]);

  useEffect(() => {
    const controller = new AbortController();
    const epoch = ++sourcesEpoch.current;
    sourcesRead.current = controller;
    setSourcesError(false);
    void fetchPluginMarketplaceSources(controller.signal)
      .then((value) => {
        if (!controller.signal.aborted && epoch === sourcesEpoch.current) {
          setSources(value);
          if (
            selection.current !== undefined &&
            !value.sources.some(({ id }) => id === selection.current)
          ) {
            setSelectedSourceId(
              value.sources.find(({ kind }) => kind === 'local')?.id ?? value.sources[0]?.id,
            );
            setCatalog(undefined);
            setLoading(true);
          }
        }
      })
      .catch(() => {
        if (!controller.signal.aborted && epoch === sourcesEpoch.current) setSourcesError(true);
      });
    return () => controller.abort();
  }, [sourcesRevision]);

  const effectiveSourceId =
    selectedSourceId ??
    catalog?.indexSource?.id ??
    sources?.sources.find(({ kind }) => kind === 'local')?.id ??
    sources?.sources[0]?.id;
  const selectedSource = sources?.sources.find(({ id }) => id === effectiveSourceId);
  selection.current = effectiveSourceId;

  function selectSource(id: string): void {
    if (action.current !== undefined || id === effectiveSourceId) return;
    setSelectedSourceId(id);
    setCatalog(undefined);
    setCatalogError(false);
    setLoading(true);
    setActionError(undefined);
  }

  async function run(
    operation: (signal: AbortSignal) => Promise<PluginMarketplaceSources>,
    complete: (value: PluginMarketplaceSources) => void,
  ): Promise<boolean> {
    if (action.current !== undefined || !mounted.current) return false;
    const controller = new AbortController();
    // A settings GET started before this write cannot restore an older source list.
    sourcesEpoch.current += 1;
    sourcesRead.current?.abort();
    action.current = controller;
    setBusy(true);
    setActionError(undefined);
    try {
      const value = await operation(controller.signal);
      if (controller.signal.aborted || !mounted.current) return false;
      setSources(value);
      setSourcesError(false);
      complete(value);
      return true;
    } catch (reason) {
      if (!controller.signal.aborted && mounted.current)
        setActionError(
          (reason instanceof PluginApiError ? mutationErrors[reason.code] : undefined) ??
            '索引源操作未完成，请重新读取设置确认结果后重试。',
        );
      return false;
    } finally {
      if (action.current === controller) action.current = undefined;
      if (mounted.current) setBusy(false);
    }
  }

  function addSource(source: { readonly name: string; readonly url: string }): Promise<boolean> {
    const previous = new Set(sources?.sources.map(({ id }) => id));
    return run(
      (signal) => addPluginMarketplaceSource(source, signal),
      (value) => {
        const added = value.sources.find(({ id }) => !previous.has(id));
        if (added !== undefined) {
          setSelectedSourceId(added.id);
          setCatalog(undefined);
          setLoading(true);
        }
      },
    );
  }

  function removeSource(id: string): Promise<boolean> {
    return run(
      (signal) => removePluginMarketplaceSource(id, signal),
      (value) => {
        if (effectiveSourceId === id) {
          setSelectedSourceId(value.sources[0]?.id);
          setCatalog(undefined);
          setLoading(true);
        }
      },
    );
  }

  function refresh(): void {
    if (effectiveSourceId === undefined || sources === undefined) {
      setCatalogRevision((value) => value + 1);
      setSourcesRevision((value) => value + 1);
      return;
    }
    void run(
      (signal) => refreshPluginMarketplaceSource(effectiveSourceId, signal),
      () => {
        setCatalogRevision((value) => value + 1);
      },
    );
  }

  return {
    catalog,
    sources,
    selectedSource,
    effectiveSourceId,
    loading,
    catalogError,
    sourcesError,
    actionError,
    busy,
    selectSource,
    addSource,
    removeSource,
    refresh,
    reloadSources: () => {
      if (action.current !== undefined) return;
      setSourcesRevision((value) => value + 1);
      setActionError(undefined);
    },
  };
}
