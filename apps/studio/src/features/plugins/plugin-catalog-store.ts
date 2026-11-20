import {
  PluginApiError,
  fetchPluginCatalog,
  reloadPlugins,
  revokePluginTrust,
  setPluginEnabled,
  trustPlugin,
} from './plugin-api.js';
import type { PluginCatalog, PluginMutationResponse, PluginReloadResult } from './plugin-types.js';

export type PluginPendingOperation = {
  readonly kind: 'reload' | 'trust' | 'enable' | 'disable' | 'revoke';
  readonly id?: string;
  readonly digest?: string;
};

export interface PluginCatalogState {
  readonly catalog: PluginCatalog | undefined;
  readonly initialLoading: boolean;
  readonly pendingOperation: PluginPendingOperation | undefined;
  readonly error: PluginApiError | undefined;
  readonly lastResult: PluginReloadResult | undefined;
}

export interface PluginCatalogStore {
  getSnapshot(): PluginCatalogState;
  subscribe(listener: () => void): () => void;
  ensureLoaded(): Promise<void>;
  reload(): Promise<void>;
  trust(id: string, digest: string): Promise<void>;
  setEnabled(id: string, enabled: boolean, immediate?: boolean): Promise<void>;
  revoke(id: string, immediate?: boolean): Promise<void>;
}

function toApiError(error: unknown): PluginApiError {
  return error instanceof PluginApiError
    ? error
    : new PluginApiError('plugin-network', '无法连接到本地服务', 0);
}

interface CatalogUpdate {
  readonly catalog: PluginCatalog;
  readonly result?: PluginReloadResult;
}

type Write = (request: () => Promise<PluginMutationResponse>) => Promise<CatalogUpdate>;

/** App-owned cache: subscriptions never own or abort its requests. */
export function createPluginCatalogStore(): PluginCatalogStore {
  let snapshot: PluginCatalogState = Object.freeze({
    catalog: undefined,
    initialLoading: false,
    pendingOperation: undefined,
    error: undefined,
    lastResult: undefined,
  });
  const listeners = new Set<() => void>();
  let initialPromise: Promise<void> | undefined;
  let initialFailed = false;
  let readPromise: Promise<PluginCatalog> | undefined;
  let operationPromise: Promise<void> | undefined;

  const publish = (next: PluginCatalogState): void => {
    snapshot = Object.freeze(next);
    for (const listener of listeners) listener();
  };

  const readCatalog = (): Promise<PluginCatalog> => {
    if (readPromise !== undefined) return readPromise;
    readPromise = fetchPluginCatalog().finally(() => {
      readPromise = undefined;
    });
    return readPromise;
  };

  const ensureLoaded = (): Promise<void> => {
    if (initialPromise !== undefined) return initialPromise;
    // Reserve the promise before publishing so a reentrant subscriber cannot start a second GET.
    initialPromise = Promise.resolve()
      .then(() => readCatalog())
      .then((catalog) => {
        publish({ ...snapshot, catalog, error: undefined });
      })
      .catch((error: unknown) => {
        initialFailed = true;
        const apiError = toApiError(error);
        publish({ ...snapshot, error: apiError });
        throw apiError;
      })
      .finally(() => {
        publish({ ...snapshot, initialLoading: false });
      });
    publish({ ...snapshot, initialLoading: true });
    return initialPromise;
  };

  const start = (
    pendingOperation: PluginPendingOperation,
    operation: (write: Write) => Promise<CatalogUpdate>,
  ): Promise<void> => {
    if (snapshot.pendingOperation !== undefined) {
      return Promise.reject(
        new PluginApiError('plugin-operation-pending', '已有插件操作正在进行', 0),
      );
    }
    let attemptedWrite = false;
    const write: Write = async (request) => {
      attemptedWrite = true;
      const response = await request();
      return {
        catalog: Object.freeze({ plugins: response.plugins, local: response.local }),
        result: response.result,
      };
    };
    // Assign the shared promise before notifying subscribers, including reentrant ones.
    operationPromise = Promise.resolve()
      .then(() => operation(write))
      .then(({ catalog, result }) => {
        publish({
          ...snapshot,
          catalog,
          ...(result === undefined ? {} : { lastResult: result }),
          error: undefined,
        });
      })
      .catch(async (error: unknown) => {
        const apiError = toApiError(error);
        if (attemptedWrite) {
          try {
            const catalog = await readCatalog();
            publish({ ...snapshot, catalog });
          } catch {
            // Retain the previous catalog and the original write failure.
          }
        }
        publish({ ...snapshot, error: apiError });
        throw apiError;
      })
      .finally(() => {
        operationPromise = undefined;
        publish({ ...snapshot, pendingOperation: undefined });
      });
    const result = operationPromise;
    publish({ ...snapshot, pendingOperation: Object.freeze(pendingOperation) });
    return result;
  };

  const reload = (): Promise<void> => {
    if (snapshot.pendingOperation?.kind === 'reload' && operationPromise !== undefined) {
      return operationPromise;
    }
    return start({ kind: 'reload' }, async (write) => {
      const hadCatalog = snapshot.catalog !== undefined;
      if (initialFailed) {
        initialPromise = undefined;
        initialFailed = false;
      }
      await ensureLoaded();
      const catalog = snapshot.catalog;
      if (catalog === undefined)
        throw new PluginApiError('plugin-invalid-response', '插件目录尚未读取', 0);
      if (catalog.local !== undefined) return write(reloadPlugins);
      // The initial GET already refreshed a cold cache; later explicit refreshes read again.
      return { catalog: hadCatalog ? await readCatalog() : catalog };
    });
  };

  const trust = (id: string, digest: string): Promise<void> =>
    start({ kind: 'trust', id, digest }, async (write) => {
      await ensureLoaded();
      return write(() => trustPlugin(id, digest));
    });

  const setEnabled = (id: string, enabled: boolean, immediate = false): Promise<void> =>
    start({ kind: enabled ? 'enable' : 'disable', id }, async (write) => {
      await ensureLoaded();
      return write(() => setPluginEnabled(id, enabled, { immediate }));
    });

  const revoke = (id: string, immediate = false): Promise<void> =>
    start({ kind: 'revoke', id }, async (write) => {
      await ensureLoaded();
      return write(() => revokePluginTrust(id, { immediate }));
    });

  return {
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    ensureLoaded,
    reload,
    trust,
    setEnabled,
    revoke,
  };
}
