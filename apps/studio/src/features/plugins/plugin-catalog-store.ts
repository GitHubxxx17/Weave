import {
  PluginApiError,
  fetchPluginCatalog,
  reloadPlugins,
  revokePluginTrust,
  setPluginEnabled,
  trustPlugin,
} from './plugin-api.js';
import type { PluginCatalog, PluginMutationResponse, PluginReloadResult } from './plugin-types.js';
import {
  McpApiError,
  configureMcpServer,
  disableMcpServer,
  enableMcpServer,
  fetchMcpCatalog,
  reloadMcpServers,
  removeMcpServer,
  revokeMcpServer,
  trustMcpServer,
  updateMcpServer,
} from '../mcp/mcp-api.js';
import type {
  ExtensionGeneration,
  McpManagementSnapshot,
  McpMutationResult,
  McpServerConfig,
} from '../mcp/mcp-types.js';
import type { McpReview } from '../mcp/mcp-review.js';

export type PluginPendingOperation = {
  readonly source?: 'esm' | 'mcp';
  readonly kind:
    'reload' | 'trust' | 'enable' | 'disable' | 'revoke' | 'configure' | 'update' | 'remove';
  readonly id?: string;
  readonly digest?: string;
};
export type CatalogConsistency =
  | { readonly kind: 'uninitialized' | 'refreshing' | 'ready' }
  | {
      readonly kind: 'unavailable';
      readonly reason: 'generation-mismatch' | 'protocol' | 'network';
    };
export type CatalogApiError = PluginApiError | McpApiError;
export interface PluginCatalogState {
  readonly catalog: PluginCatalog | undefined;
  readonly mcp: McpManagementSnapshot | undefined;
  readonly mcpAvailable: boolean | undefined;
  readonly consistency: CatalogConsistency;
  readonly reviewEpoch: number;
  readonly mcpLastResult: McpMutationResult['result'] | undefined;
  readonly mcpLastGeneration: ExtensionGeneration | undefined;
  readonly initialLoading: boolean;
  readonly pendingOperation: PluginPendingOperation | undefined;
  readonly error: CatalogApiError | undefined;
  readonly lastResult: PluginReloadResult | undefined;
}
export interface PluginCatalogStore {
  getSnapshot(): PluginCatalogState;
  subscribe(listener: () => void): () => void;
  ensureLoaded(): Promise<void>;
  refresh(): Promise<void>;
  reload(): Promise<void>;
  trust(id: string, digest: string): Promise<void>;
  setEnabled(id: string, enabled: boolean, immediate?: boolean): Promise<void>;
  revoke(id: string, immediate?: boolean): Promise<void>;
  configureMcp(expectedSequence: number, config: McpServerConfig): Promise<void>;
  updateMcp(id: string, expectedSequence: number, config: McpServerConfig): Promise<void>;
  trustMcp(review: McpReview): Promise<void>;
  enableMcp(id: string, expectedSequence: number, configDigest: string): Promise<void>;
  disableMcp(id: string, expectedSequence: number, immediate?: boolean): Promise<void>;
  revokeMcp(id: string, expectedSequence: number, immediate?: boolean): Promise<void>;
  removeMcp(id: string, expectedSequence: number, immediate?: boolean): Promise<void>;
}
interface Pair {
  readonly catalog: PluginCatalog;
  readonly mcp?: McpManagementSnapshot;
  readonly mcpAvailable: boolean;
}
interface Seed {
  readonly catalog?: PluginCatalog;
  readonly mcp?: McpManagementSnapshot;
}
const toApiError = (error: unknown): CatalogApiError =>
  error instanceof PluginApiError || error instanceof McpApiError
    ? error
    : new PluginApiError('plugin-network', '无法连接到本地服务', 0);
const sameGeneration = (a: ExtensionGeneration | undefined, b: ExtensionGeneration): boolean =>
  a !== undefined &&
  a.id === b.id &&
  a.acceptingRuns === b.acceptingRuns &&
  a.blocked?.code === b.blocked?.code &&
  a.blocked?.message === b.blocked?.message;
function unavailable(error: CatalogApiError): CatalogConsistency {
  return {
    kind: 'unavailable',
    reason:
      error.code === 'catalog-generation-mismatch'
        ? 'generation-mismatch'
        : error.status === 0
          ? 'network'
          : 'protocol',
  };
}

/** One app-owned cache and write gate for the complete extension catalog. */
export function createPluginCatalogStore(): PluginCatalogStore {
  let snapshot: PluginCatalogState = Object.freeze({
    catalog: undefined,
    mcp: undefined,
    mcpAvailable: undefined,
    consistency: { kind: 'uninitialized' as const },
    reviewEpoch: 0,
    mcpLastResult: undefined,
    mcpLastGeneration: undefined,
    initialLoading: false,
    pendingOperation: undefined,
    error: undefined,
    lastResult: undefined,
  });
  const listeners = new Set<() => void>();
  let initialPromise: Promise<void> | undefined;
  let readPromise: Promise<void> | undefined;
  let operationPromise: Promise<void> | undefined;
  const publish = (next: PluginCatalogState): void => {
    snapshot = Object.freeze(next);
    for (const listener of listeners) listener();
  };

  async function readPair(seed: Seed = {}): Promise<Pair> {
    for (let round = 0; round < 3; round++) {
      const [plugins, mcp] = await Promise.allSettled([
        round === 0 && seed.catalog !== undefined
          ? Promise.resolve(seed.catalog)
          : fetchPluginCatalog(),
        snapshot.mcpAvailable === false
          ? Promise.resolve(undefined)
          : round === 0 && seed.mcp !== undefined
            ? Promise.resolve(seed.mcp)
            : fetchMcpCatalog(),
      ]);
      if (plugins.status === 'rejected') throw plugins.reason;
      if (mcp.status === 'rejected') {
        if (
          mcp.reason instanceof McpApiError &&
          mcp.reason.status === 404 &&
          mcp.reason.code === 'mcp-management-disabled'
        )
          return { catalog: plugins.value, mcpAvailable: false };
        throw mcp.reason;
      }
      if (mcp.value === undefined) return { catalog: plugins.value, mcpAvailable: false };
      if (plugins.value.generation === undefined) {
        throw new McpApiError(
          'catalog-invalid-generation',
          '插件目录缺少版本信息，请重新读取目录',
          200,
        );
      }
      if (sameGeneration(plugins.value.generation, mcp.value.generation))
        return { catalog: plugins.value, mcp: mcp.value, mcpAvailable: true };
    }
    throw new McpApiError('catalog-generation-mismatch', '目录版本尚未同步，请重新读取目录', 0);
  }
  function install(pair: Pair, alreadyInvalidated = false): void {
    const authorityChanged =
      snapshot.mcp !== undefined &&
      pair.mcp !== undefined &&
      snapshot.mcp.authoritySequence !== pair.mcp.authoritySequence;
    publish({
      ...snapshot,
      catalog: pair.catalog,
      mcp: pair.mcp,
      mcpAvailable: pair.mcpAvailable,
      consistency: Object.freeze({ kind: 'ready' }),
      error: undefined,
      reviewEpoch: snapshot.reviewEpoch + Number(authorityChanged && !alreadyInvalidated),
    });
  }
  function read(seed: Seed = {}, alreadyInvalidated = false): Promise<void> {
    const promise = Promise.resolve()
      .then(() => readPair(seed))
      .then((pair) => install(pair, alreadyInvalidated))
      .catch((reason: unknown) => {
        const error = toApiError(reason);
        publish({ ...snapshot, error, consistency: Object.freeze(unavailable(error)) });
        throw error;
      });
    return promise;
  }
  function beginRead(initial: boolean): Promise<void> {
    if (readPromise !== undefined) return readPromise;
    readPromise = read().finally(() => {
      readPromise = undefined;
      publish({ ...snapshot, initialLoading: false });
    });
    publish({
      ...snapshot,
      initialLoading: initial,
      consistency: Object.freeze({ kind: 'refreshing' }),
    });
    return readPromise;
  }
  function ensureLoaded(): Promise<void> {
    if (initialPromise !== undefined) return initialPromise;
    initialPromise = beginRead(snapshot.catalog === undefined);
    return initialPromise;
  }
  function refresh(): Promise<void> {
    if (operationPromise !== undefined)
      return operationPromise.catch(() => undefined).then(() => refresh());
    initialPromise = undefined;
    const promise = beginRead(snapshot.catalog === undefined);
    initialPromise = promise;
    return promise;
  }
  const requireReady = (): void => {
    if (snapshot.consistency.kind !== 'ready')
      throw new McpApiError('catalog-unavailable', '请先重新读取一致的目录', 0);
  };
  async function reconcile(seed: Seed, alreadyInvalidated = false): Promise<void> {
    try {
      await read(seed, alreadyInvalidated);
    } catch {
      /* Durable outcomes and original write failures remain visible. */
    }
  }
  function start(
    pending: PluginPendingOperation,
    operation: () => Promise<void>,
    recover = false,
  ): Promise<void> {
    if (snapshot.pendingOperation !== undefined)
      return Promise.reject(
        new PluginApiError('plugin-operation-pending', '已有插件操作正在进行', 0),
      );
    // Reserve before notifying reentrant subscribers. A write waits for every older read.
    operationPromise = Promise.resolve()
      .then(async () => {
        if (readPromise !== undefined) {
          try {
            await readPromise;
          } catch (error) {
            if (!recover) throw error;
          }
        }
        if (snapshot.catalog === undefined) {
          initialPromise = undefined;
          await ensureLoaded();
        } else if (recover && snapshot.consistency.kind !== 'ready') await beginRead(false);
        requireReady();
        await operation();
      })
      .catch((reason: unknown) => {
        const error = toApiError(reason);
        publish({ ...snapshot, error });
        throw error;
      })
      .finally(() => {
        operationPromise = undefined;
        publish({ ...snapshot, pendingOperation: undefined });
      });
    const promise = operationPromise;
    publish({ ...snapshot, pendingOperation: Object.freeze(pending) });
    return promise;
  }
  async function esmWrite(request: () => Promise<PluginMutationResponse>): Promise<void> {
    try {
      const response = await request();
      publish({
        ...snapshot,
        lastResult: response.result,
        consistency: Object.freeze({ kind: 'refreshing' }),
      });
      await reconcile({
        catalog: Object.freeze({
          plugins: response.plugins,
          local: response.local,
          ...(response.generation === undefined ? {} : { generation: response.generation }),
        }),
      });
    } catch (reason) {
      await reconcile({});
      throw reason;
    }
  }
  async function mcpWrite(request: () => Promise<McpMutationResult>): Promise<void> {
    try {
      const response = await request();
      publish({
        ...snapshot,
        mcpLastResult: response.result,
        mcpLastGeneration: response.generation,
        consistency: Object.freeze({ kind: 'refreshing' }),
      });
      await reconcile({ mcp: response });
    } catch (reason) {
      const conflict = reason instanceof McpApiError && reason.status === 409;
      if (conflict) publish({ ...snapshot, reviewEpoch: snapshot.reviewEpoch + 1 });
      await reconcile({}, conflict);
      throw reason;
    }
  }
  function mcpOperation(
    pending: PluginPendingOperation,
    request: () => Promise<McpMutationResult>,
  ): Promise<void> {
    return start({ ...pending, source: 'mcp' }, async () => {
      if (snapshot.mcpAvailable !== true)
        throw new McpApiError('mcp-management-disabled', 'MCP 管理不可用', 404);
      await mcpWrite(request);
    });
  }
  function reload(): Promise<void> {
    if (snapshot.pendingOperation?.kind === 'reload' && operationPromise !== undefined)
      return operationPromise;
    const hadCatalog = snapshot.catalog !== undefined;
    return start(
      { kind: 'reload' },
      async () => {
        if (snapshot.mcpAvailable === true && snapshot.mcp !== undefined)
          await mcpWrite(() => reloadMcpServers(snapshot.mcp!.authoritySequence));
        else if (snapshot.catalog?.local !== undefined) await esmWrite(reloadPlugins);
        else if (hadCatalog) await read({});
      },
      true,
    );
  }
  return {
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    ensureLoaded,
    refresh,
    reload,
    trust: (id, digest) =>
      start({ kind: 'trust', id, digest }, () => esmWrite(() => trustPlugin(id, digest))),
    setEnabled: (id, enabled, immediate = false) =>
      start({ kind: enabled ? 'enable' : 'disable', id }, () =>
        esmWrite(() => setPluginEnabled(id, enabled, { immediate })),
      ),
    revoke: (id, immediate = false) =>
      start({ kind: 'revoke', id }, () => esmWrite(() => revokePluginTrust(id, { immediate }))),
    configureMcp: (seq, config) =>
      mcpOperation({ kind: 'configure', id: config.id }, () => configureMcpServer(seq, config)),
    updateMcp: (id, seq, config) =>
      mcpOperation({ kind: 'update', id }, () => updateMcpServer(id, seq, config)),
    trustMcp: (review) =>
      mcpOperation({ kind: 'trust', id: review.config.id, digest: review.configDigest }, () => {
        if (
          review.reviewEpoch !== snapshot.reviewEpoch ||
          review.authoritySequence !== snapshot.mcp?.authoritySequence ||
          snapshot.mcp.servers.find((server) => server.config.id === review.config.id)
            ?.configDigest !== review.configDigest
        )
          return Promise.reject(
            new McpApiError('mcp-review-stale', '本次审阅已失效，请重新读取并审阅配置', 0),
          );
        return trustMcpServer(review.config.id, review.authoritySequence, review.configDigest);
      }),
    enableMcp: (id, seq, digest) =>
      mcpOperation({ kind: 'enable', id, digest }, () => enableMcpServer(id, seq, digest)),
    disableMcp: (id, seq, immediate = false) =>
      mcpOperation({ kind: 'disable', id }, () => disableMcpServer(id, seq, { immediate })),
    revokeMcp: (id, seq, immediate = false) =>
      mcpOperation({ kind: 'revoke', id }, () => revokeMcpServer(id, seq, { immediate })),
    removeMcp: (id, seq, immediate = false) =>
      mcpOperation({ kind: 'remove', id }, () => removeMcpServer(id, seq, { immediate })),
  };
}
