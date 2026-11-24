import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import {
  loadPluginMarketplaceCatalog,
  type PluginMarketplaceCatalog,
} from './plugin-marketplace.js';
import { fetchMarketplaceCatalog, MarketplaceFetchError } from './plugin-marketplace-fetch.js';
import {
  MarketplaceSettingsError,
  openMarketplaceSettings,
  type StoredMarketplaceSource,
} from './plugin-marketplace-settings.js';
import {
  canonicalMarketplaceUrl,
  MarketplaceSourceError,
  marketplaceRemoteId,
  marketplaceSourceNameSchema,
  marketplaceSourcesSchema,
  type MarketplaceSource,
  type MarketplaceSources,
  type PluginMarketplaceManager,
} from './plugin-marketplace-source-types.js';
export type { PluginMarketplaceManager } from './plugin-marketplace-source-types.js';

interface SourceRecord {
  source: MarketplaceSource;
  catalog: PluginMarketplaceCatalog;
  file?: string;
}
export interface MarketplaceManagerOptions {
  readonly settingsFile: string;
  /** Retired append-only log; replayed once into `settingsFile` when that file does not exist. */
  readonly legacySettingsFile?: string;
  readonly builtinCatalogFile?: string | false;
  readonly operatorCatalogFile?: string | false | undefined;
  readonly reservedIds?: readonly string[];
  readonly fetch?: typeof globalThis.fetch;
}
const empty: PluginMarketplaceCatalog = { communityStatus: 'unconfigured', plugins: [] };

export async function createPluginMarketplaceManager(
  options: MarketplaceManagerOptions,
): Promise<PluginMarketplaceManager> {
  const reservedIds = options.reservedIds ?? [];
  const builtinFile =
    options.builtinCatalogFile ??
    fileURLToPath(new URL('../../../marketplace/index.json', import.meta.url));
  const settings = await openMarketplaceSettings(options.settingsFile, options.legacySettingsFile);
  const records = new Map<string, SourceRecord>();
  const builtin =
    builtinFile === false
      ? { communityStatus: 'ready' as const, plugins: [] }
      : await loadPluginMarketplaceCatalog(builtinFile, reservedIds);
  records.set('weave', {
    source: {
      id: 'weave',
      name: 'Weave 插件目录',
      url: null,
      kind: 'builtin',
      status: builtin.communityStatus === 'ready' ? 'ready' : 'unavailable',
      stale: false,
      removable: false,
    },
    catalog: builtin,
    ...(builtinFile === false ? {} : { file: builtinFile }),
  });
  if (typeof options.operatorCatalogFile === 'string') {
    const catalog = await loadPluginMarketplaceCatalog(options.operatorCatalogFile, reservedIds);
    records.set('operator', {
      source: {
        id: 'operator',
        name: '本地插件目录',
        url: null,
        kind: 'local',
        status: catalog.communityStatus === 'ready' ? 'ready' : 'unavailable',
        stale: false,
        removable: false,
      },
      catalog,
      file: options.operatorCatalogFile,
    });
  }
  for (const { id, name, url } of settings.initial)
    records.set(id, {
      source: {
        id,
        name,
        url,
        kind: 'remote',
        status: 'unfetched',
        stale: false,
        removable: true,
      },
      catalog: empty,
    });
  let closed = false;
  let active: AbortController | undefined;
  let queue: Promise<unknown> = Promise.resolve();
  function requireOpen(): void {
    if (closed)
      throw new MarketplaceSourceError(
        503,
        'plugin-marketplace-closed',
        'Marketplace sources are closed',
      );
  }
  function get(id?: string): SourceRecord {
    const record = records.get(id ?? (records.has('operator') ? 'operator' : 'weave'));
    if (record === undefined)
      throw new MarketplaceSourceError(
        404,
        'plugin-marketplace-source-not-found',
        'Marketplace source was not found',
      );
    return record;
  }
  function listSources(): MarketplaceSources {
    const sources = [...records.values()].map(({ source }) => ({ ...source }));
    if (!settings.available && sources[0] !== undefined)
      sources[0].errorCode = 'settings-unavailable';
    return marketplaceSourcesSchema.parse({
      schemaVersion: 1,
      revision: settings.revision,
      sources,
    });
  }
  function enqueue<T>(operation: () => Promise<T>): Promise<T> {
    try {
      requireOpen();
    } catch (error) {
      return Promise.reject(error);
    }
    const result = queue.then(() => {
      requireOpen();
      return operation();
    });
    queue = result.catch(() => undefined);
    return result;
  }
  function storedSources(): StoredMarketplaceSource[] {
    return [...records.values()]
      .filter(({ source }) => source.kind === 'remote')
      .map(({ source }) => ({ id: source.id, name: source.name, url: source.url! }));
  }
  async function persist(
    expectedRevision: number,
    sources: readonly StoredMarketplaceSource[],
  ): Promise<void> {
    try {
      await settings.replace(expectedRevision, sources);
    } catch (error) {
      if (error instanceof MarketplaceSettingsError && error.reason === 'conflict')
        throw new MarketplaceSourceError(
          409,
          'plugin-marketplace-revision-conflict',
          'Marketplace sources changed; reload them and try again',
        );
      throw new MarketplaceSourceError(
        503,
        'plugin-marketplace-settings-unavailable',
        'Marketplace source settings cannot be saved',
      );
    }
  }
  return {
    listSources,
    catalog(sourceId) {
      const record = get(sourceId);
      return {
        catalog: structuredClone(record.catalog),
        indexSource: { id: record.source.id, name: record.source.name, url: record.source.url },
      };
    },
    add(input, expectedRevision) {
      return enqueue(async () => {
        const parsed = z
          .strictObject({ name: marketplaceSourceNameSchema, url: z.string() })
          .safeParse(input);
        if (!parsed.success)
          throw new MarketplaceSourceError(
            400,
            'plugin-marketplace-invalid-request',
            'Invalid marketplace source',
          );
        const url = canonicalMarketplaceUrl(parsed.data.url);
        const id = marketplaceRemoteId(url);
        if (records.has(id))
          throw new MarketplaceSourceError(
            409,
            'plugin-marketplace-source-exists',
            'Marketplace source is already configured',
          );
        if ([...records.values()].filter(({ source }) => source.kind === 'remote').length >= 10)
          throw new MarketplaceSourceError(
            409,
            'plugin-marketplace-source-limit',
            'At most ten remote sources can be configured',
          );
        await persist(expectedRevision, [...storedSources(), { id, name: parsed.data.name, url }]);
        records.set(id, {
          source: {
            id,
            name: parsed.data.name,
            url,
            kind: 'remote',
            status: 'unfetched',
            stale: false,
            removable: true,
          },
          catalog: empty,
        });
        return listSources();
      });
    },
    remove(id, expectedRevision) {
      return enqueue(async () => {
        const record = get(id);
        if (!record.source.removable)
          throw new MarketplaceSourceError(
            400,
            'plugin-marketplace-source-immutable',
            'This marketplace source cannot be removed',
          );
        await persist(
          expectedRevision,
          storedSources().filter((source) => source.id !== id),
        );
        records.delete(id);
        return listSources();
      });
    },
    reorder(ids, expectedRevision) {
      return enqueue(async () => {
        const remote = [...records.values()].filter(({ source }) => source.kind === 'remote');
        if (
          ids.length !== remote.length ||
          new Set(ids).size !== ids.length ||
          !ids.every((id) => records.get(id)?.source.kind === 'remote')
        )
          throw new MarketplaceSourceError(
            400,
            'plugin-marketplace-invalid-request',
            'Invalid marketplace source order',
          );
        const ordered = ids.map((id) => records.get(id)!);
        await persist(
          expectedRevision,
          ordered.map(({ source }) => ({ id: source.id, name: source.name, url: source.url! })),
        );
        for (const { source } of remote) records.delete(source.id);
        for (const record of ordered) records.set(record.source.id, record);
        return listSources();
      });
    },
    refresh(sourceId) {
      return enqueue(async () => {
        const record = get(sourceId);
        const abort = new AbortController();
        active = abort;
        try {
          const catalog =
            record.source.kind === 'remote'
              ? await fetchMarketplaceCatalog(
                  record.source.url!,
                  options.fetch ?? globalThis.fetch,
                  abort,
                  reservedIds,
                )
              : record.file === undefined
                ? { communityStatus: 'ready' as const, plugins: [] }
                : await loadPluginMarketplaceCatalog(record.file, reservedIds);
          if (closed) return listSources();
          if (catalog.communityStatus !== 'ready') throw new MarketplaceFetchError('invalid-index');
          record.catalog = catalog;
          record.source = {
            ...record.source,
            status: 'ready',
            stale: false,
            fetchedAt: new Date().toISOString(),
          };
          delete record.source.errorCode;
        } catch (error) {
          if (!closed)
            record.source = {
              ...record.source,
              status: 'unavailable',
              stale: record.catalog.communityStatus === 'ready',
              errorCode: error instanceof MarketplaceFetchError ? error.code : 'network',
            };
          if (!closed && record.catalog.communityStatus !== 'ready')
            record.catalog = { communityStatus: 'unavailable', plugins: [] };
        } finally {
          if (active === abort) active = undefined;
        }
        return listSources();
      });
    },
    closeSync() {
      closed = true;
      active?.abort();
    },
    async drain() {
      await queue;
    },
  };
}
