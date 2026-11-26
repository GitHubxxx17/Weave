import {
  PluginApiError,
  confirmPluginHooks,
  fetchPluginCatalog,
  reloadPlugins,
  revokePluginTrust,
  setPluginEnabled,
  trustPlugin,
} from './plugin-api.js';
import type { PluginCatalog, PluginMutationResponse, PluginReloadResult } from './plugin-types.js';
import {
  fetchManagedCatalog,
  prepareManagedRequest,
  prepareManagedUpdateRequest,
  previewGithubManagedPlugin,
  previewManagedPlugin,
  previewManagedUpdate,
  sendManagedRequest,
} from './managed-plugin-api.js';
import type {
  ManagedCatalog,
  GithubManagedPreview,
  GithubPluginSource,
  ManagedCatalogObservation,
  ManagedHeads,
  ManagedMutationResponse,
  ManagedPreview,
  ManagedReview,
  ManagedUpdatePreview,
  ManagedUpdateReview,
  PreparedManagedRequest,
} from './managed-plugin-types.js';
import {
  managedHeadsAtLeast,
  sameLegacyGeneration,
  sameManagedGeneration,
} from './plugin-catalog-observation.js';
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
  readonly source?: 'esm' | 'mcp' | 'managed';
  readonly kind:
    | 'reload'
    | 'trust'
    | 'confirm-hooks'
    | 'enable'
    | 'disable'
    | 'revoke'
    | 'configure'
    | 'update'
    | 'remove'
    | 'import'
    | 'activate'
    | 'uninstall';
  readonly id?: string;
  readonly digest?: string;
};
export type CatalogConsistency =
  | { readonly kind: 'uninitialized' | 'refreshing' | 'ready' }
  | {
      readonly kind: 'unavailable';
      readonly reason: 'generation-mismatch' | 'managed-authority-lag' | 'protocol' | 'network';
    };
export type CatalogApiError = PluginApiError | McpApiError;
export type ManagedAttemptContext = Readonly<{
  pluginId: string;
  target: ManagedMutationResponse['decision']['target'];
  error: PluginApiError;
}>;
export type ManagedRejection = ManagedAttemptContext &
  Readonly<{ recovery: 'none' | 'review' | 'preview' | 'retry-review' | 'activate' }>;
export type ManagedAttemptOutcome =
  | { readonly kind: 'saved'; readonly response: ManagedMutationResponse }
  | ({ readonly kind: 'unresolved' } & ManagedAttemptContext)
  | ({ readonly kind: 'rejected' } & ManagedRejection)
  | { readonly kind: 'not-sent'; readonly error: PluginApiError };

export interface PluginCatalogState {
  readonly catalog: PluginCatalog | undefined;
  readonly mcp: McpManagementSnapshot | undefined;
  readonly mcpAvailable: boolean | undefined;
  readonly managed: ManagedCatalogObservation | undefined;
  readonly managedUnresolved: ManagedAttemptContext | undefined;
  readonly managedLastResult: ManagedMutationResponse | undefined;
  readonly managedLastRejection: ManagedRejection | undefined;
  readonly managedReviewRequiredId: string | undefined;
  readonly sharedManagementBlocked: boolean;
  readonly canRecoverManagedLag: boolean;
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
  previewManaged(sourceDirectory: string, signal?: AbortSignal): Promise<ManagedPreview>;
  previewGithubManaged(
    source: GithubPluginSource,
    signal?: AbortSignal,
  ): Promise<GithubManagedPreview>;
  submitManaged(review: ManagedReview): Promise<ManagedAttemptOutcome>;
  previewManagedUpdate(pluginId: string, signal?: AbortSignal): Promise<ManagedUpdatePreview>;
  submitManagedUpdate(review: ManagedUpdateReview): Promise<ManagedAttemptOutcome>;
  retryManaged(): Promise<ManagedAttemptOutcome>;
  stopTrackingManaged(): Promise<void>;
  trust(id: string, digest: string): Promise<void>;
  confirmHooks(id: string, digest: string, hooks: readonly string[]): Promise<void>;
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
type McpObservation =
  | { readonly kind: 'enabled'; readonly snapshot: McpManagementSnapshot }
  | { readonly kind: 'disabled' };
interface CatalogGroup {
  readonly catalog: PluginCatalog;
  readonly mcp: McpObservation;
  readonly managed: ManagedCatalogObservation;
}
type CatalogRead = { readonly kind: 'ready' | 'lag'; readonly group: CatalogGroup };
interface Seed {
  readonly catalog?: PluginCatalog;
  readonly mcp?: McpManagementSnapshot;
  readonly managed?: ManagedCatalog;
}
interface ReadOptions {
  readonly seed?: Seed;
  readonly alreadyInvalidated?: boolean;
  readonly rememberInitial?: boolean;
}
const toApiError = (error: unknown): CatalogApiError =>
  error instanceof PluginApiError || error instanceof McpApiError
    ? error
    : new PluginApiError('plugin-network', '无法连接到本地服务', 0);
function toManagedError(reason: unknown): PluginApiError {
  const error = toApiError(reason);
  return error instanceof PluginApiError
    ? error
    : new PluginApiError(error.code, error.message, error.status);
}
class ManagedAuthorityLagError extends PluginApiError {
  constructor() {
    super('catalog-managed-authority-lag', '受管插件目录正在等待同步', 0);
  }
}
function unavailable(error: CatalogApiError): CatalogConsistency {
  if (error.code === 'catalog-generation-mismatch')
    return { kind: 'unavailable', reason: 'generation-mismatch' };
  if (error instanceof ManagedAuthorityLagError)
    return { kind: 'unavailable', reason: 'managed-authority-lag' };
  return { kind: 'unavailable', reason: error.status === 0 ? 'network' : 'protocol' };
}

async function observeMcp(): Promise<McpObservation> {
  try {
    return { kind: 'enabled', snapshot: await fetchMcpCatalog() };
  } catch (error) {
    if (
      error instanceof McpApiError &&
      error.status === 404 &&
      error.code === 'mcp-management-disabled'
    )
      return { kind: 'disabled' };
    throw error;
  }
}

function hasReloadManager({ catalog, mcp }: CatalogGroup): boolean {
  return mcp.kind === 'enabled' || catalog.local !== undefined;
}

function rejectionRecovery(
  { code, status }: PluginApiError,
  command: PreparedManagedRequest['target']['kind'],
  retry: boolean,
  update = false,
): ManagedRejection['recovery'] | undefined {
  if (
    (status === 400 && code === 'plugin-invalid-request') ||
    (status === 403 && code === 'forbidden-origin') ||
    (status === 404 && code === 'plugin-installer-disabled') ||
    (status === 413 && code === 'plugin-request-too-large') ||
    (status === 415 && code === 'unsupported-media-type')
  )
    return retry ? undefined : 'none';
  if (status === 404 && code === 'plugin-authority-not-found' && command !== 'import')
    return 'review';
  if (status !== 409) return undefined;
  // An update confirmation that no longer matches the reviewed preview is never replayed; the
  // user reviews the current state again.
  if (
    update &&
    (code === 'plugin-preview-stale' ||
      code === 'plugin-authority-conflict' ||
      code === 'plugin-artifact-unavailable' ||
      code === 'plugin-managed-id-conflict')
  )
    return 'review';
  switch (code) {
    case 'plugin-authority-request-conflict':
      return 'none';
    case 'plugin-preview-stale':
    case 'plugin-managed-id-conflict':
      return command === 'import' ? 'preview' : undefined;
    case 'plugin-managed-namespace-unavailable':
    case 'plugin-artifact-capacity':
      return command === 'import' ? 'retry-review' : undefined;
    case 'plugin-authority-conflict':
      return command === 'import' ? undefined : 'review';
    case 'plugin-authority-activation-required':
      return command === 'enable' ? 'activate' : undefined;
    case 'plugin-artifact-unavailable':
      if (command === 'import') return 'preview';
      return command === 'activate' || command === 'enable' ? 'review' : undefined;
    default:
      return undefined;
  }
}

/** One app-owned cache and write gate for the complete extension catalog. */
export function createPluginCatalogStore(): PluginCatalogStore {
  let snapshot: PluginCatalogState = Object.freeze({
    catalog: undefined,
    mcp: undefined,
    mcpAvailable: undefined,
    managed: undefined,
    managedUnresolved: undefined,
    managedLastResult: undefined,
    managedLastRejection: undefined,
    managedReviewRequiredId: undefined,
    sharedManagementBlocked: true,
    canRecoverManagedLag: false,
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
  let operationPromise: Promise<unknown> | undefined;
  let reloadPromise: Promise<void> | undefined;
  let confirmedHeads: ManagedHeads | undefined;
  let lastLag: CatalogGroup | undefined;
  let unresolvedRequest: PreparedManagedRequest | undefined;
  const publish = (next: PluginCatalogState): void => {
    const writeBlocked = operationPromise !== undefined || unresolvedRequest !== undefined;
    snapshot = Object.freeze({
      ...next,
      sharedManagementBlocked: next.consistency.kind !== 'ready' || writeBlocked,
      canRecoverManagedLag:
        !writeBlocked &&
        next.consistency.kind === 'unavailable' &&
        next.consistency.reason === 'managed-authority-lag' &&
        lastLag !== undefined &&
        hasReloadManager(lastLag),
    });
    for (const listener of listeners) listener();
  };

  function meetsConfirmedHeads(heads: ManagedHeads): boolean {
    return confirmedHeads === undefined || managedHeadsAtLeast(heads, confirmedHeads);
  }

  async function readGroup(seed: Seed = {}): Promise<CatalogRead> {
    for (let round = 0; round < 3; round++) {
      const initialSeed = round === 0 ? seed : {};
      const [plugins, mcp, managed] = await Promise.allSettled([
        initialSeed.catalog !== undefined
          ? Promise.resolve(initialSeed.catalog)
          : fetchPluginCatalog(),
        initialSeed.mcp !== undefined
          ? Promise.resolve({ kind: 'enabled' as const, snapshot: initialSeed.mcp })
          : observeMcp(),
        initialSeed.managed !== undefined
          ? Promise.resolve({ kind: 'enabled' as const, catalog: initialSeed.managed })
          : fetchManagedCatalog(),
      ]);
      if (plugins.status === 'rejected') throw plugins.reason;
      if (mcp.status === 'rejected') throw mcp.reason;
      if (managed.status === 'rejected') throw managed.reason;
      const group = { catalog: plugins.value, mcp: mcp.value, managed: managed.value };
      const { generation } = group.catalog;
      if (confirmedHeads !== undefined && group.managed.kind !== 'enabled') {
        throw new PluginApiError(
          'catalog-managed-authority-unavailable',
          '受管插件目录不可用，请重新连接或重新打开 Studio',
          404,
        );
      }
      if (group.mcp.kind === 'disabled' && group.managed.kind !== 'enabled')
        return { kind: 'ready', group };
      if (generation === undefined) {
        if (initialSeed.catalog !== undefined) continue;
        throw new PluginApiError(
          'catalog-invalid-generation',
          '插件目录缺少版本信息，请重新读取目录',
          200,
        );
      }
      if (
        group.mcp.kind === 'enabled' &&
        !sameLegacyGeneration(generation, group.mcp.snapshot.generation)
      )
        continue;
      if (group.managed.kind === 'enabled') {
        if (!sameManagedGeneration(generation, group.managed.catalog.generation)) continue;
        if (!meetsConfirmedHeads(group.managed.catalog.heads)) {
          if (round === 2) return { kind: 'lag', group };
          continue;
        }
      }
      return { kind: 'ready', group };
    }
    throw new McpApiError('catalog-generation-mismatch', '目录版本尚未同步，请重新读取目录', 0);
  }
  function install(group: CatalogGroup, alreadyInvalidated: boolean): void {
    if (group.managed.kind === 'enabled') confirmedHeads = group.managed.catalog.heads;
    const mcp = group.mcp.kind === 'enabled' ? group.mcp.snapshot : undefined;
    const authorityChanged =
      snapshot.mcp !== undefined &&
      mcp !== undefined &&
      snapshot.mcp.authoritySequence !== mcp.authoritySequence;
    publish({
      ...snapshot,
      catalog: group.catalog,
      mcp,
      mcpAvailable: group.mcp.kind === 'enabled',
      managed: Object.freeze(group.managed),
      consistency: Object.freeze({ kind: 'ready' }),
      error: undefined,
      reviewEpoch: snapshot.reviewEpoch + Number(authorityChanged && !alreadyInvalidated),
    });
  }
  function beginRead({
    seed,
    alreadyInvalidated = false,
    rememberInitial = false,
  }: ReadOptions = {}): Promise<void> {
    if (readPromise !== undefined) return readPromise;
    const promise = Promise.resolve()
      .then(async () => {
        lastLag = undefined;
        const { kind, group } = await readGroup(seed);
        if (kind === 'lag') {
          lastLag = group;
          throw new ManagedAuthorityLagError();
        }
        install(group, alreadyInvalidated);
      })
      .catch((reason: unknown) => {
        const error = toApiError(reason);
        publish({ ...snapshot, error, consistency: Object.freeze(unavailable(error)) });
        throw error;
      })
      .finally(() => {
        readPromise = undefined;
        if (snapshot.initialLoading) publish({ ...snapshot, initialLoading: false });
      });
    readPromise = promise;
    if (rememberInitial) initialPromise = promise;
    publish({
      ...snapshot,
      initialLoading: snapshot.catalog === undefined,
      consistency: Object.freeze({ kind: 'refreshing' }),
    });
    return promise;
  }
  function ensureLoaded(): Promise<void> {
    if (operationPromise !== undefined) return operationPromise.then(ensureLoaded, ensureLoaded);
    return readPromise ?? initialPromise ?? beginRead({ rememberInitial: true });
  }
  function refresh(): Promise<void> {
    if (operationPromise !== undefined) return operationPromise.then(refresh, refresh);
    return beginRead({ rememberInitial: true });
  }
  const requireReady = (): void => {
    if (snapshot.consistency.kind !== 'ready')
      throw new McpApiError('catalog-unavailable', '请先重新读取一致的目录', 0);
  };
  async function reconcile(seed: Seed, alreadyInvalidated = false): Promise<void> {
    try {
      await beginRead({ seed, alreadyInvalidated });
    } catch {
      /* Durable outcomes and original write failures remain visible. */
    }
  }
  function writeBlock(allowUnresolved = false): PluginApiError | undefined {
    if (operationPromise !== undefined)
      return new PluginApiError('plugin-operation-pending', '已有插件操作正在进行', 0);
    if (!allowUnresolved && unresolvedRequest !== undefined)
      return new PluginApiError('plugin-managed-unresolved', '请先核对受管插件操作的结果', 0);
    return undefined;
  }
  function reserve<T>(
    pending: PluginPendingOperation | undefined,
    operation: (olderRead: Promise<void> | undefined) => Promise<T>,
    remember?: (promise: Promise<T>) => void,
  ): Promise<T> {
    // Reserve before notifying reentrant subscribers. A write waits for every older read.
    const olderRead = readPromise;
    const promise = Promise.resolve()
      .then(() => operation(olderRead))
      .finally(() => {
        operationPromise = undefined;
        reloadPromise = undefined;
        publish({ ...snapshot, pendingOperation: undefined });
      });
    operationPromise = promise;
    remember?.(promise);
    publish({
      ...snapshot,
      pendingOperation: pending === undefined ? undefined : Object.freeze(pending),
    });
    return promise;
  }
  async function prepareOrdinaryWrite(olderRead: Promise<void> | undefined): Promise<void> {
    await olderRead;
    if (snapshot.catalog === undefined) await beginRead({ rememberInitial: true });
    requireReady();
  }
  function reportWriteError(reason: unknown): never {
    const error = toApiError(reason);
    publish({ ...snapshot, error });
    throw error;
  }
  function start(pending: PluginPendingOperation, operation: () => Promise<void>): Promise<void> {
    const blocked = writeBlock();
    if (blocked !== undefined) return Promise.reject(blocked);
    return reserve(pending, async (olderRead) => {
      try {
        await prepareOrdinaryWrite(olderRead);
        await operation();
      } catch (reason) {
        reportWriteError(reason);
      }
    });
  }
  async function esmWrite(
    request: () => Promise<PluginMutationResponse>,
    id?: string,
  ): Promise<void> {
    if (id !== undefined && snapshot.managedReviewRequiredId !== undefined)
      publish({ ...snapshot, managedReviewRequiredId: undefined });
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
      if (
        id !== undefined &&
        reason instanceof PluginApiError &&
        reason.code === 'plugin-managed-review-required'
      )
        publish({ ...snapshot, managedReviewRequiredId: id });
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
    if (reloadPromise !== undefined) return reloadPromise;
    const blocked = writeBlock();
    if (blocked !== undefined) return Promise.reject(blocked);
    const hadCatalog = snapshot.catalog !== undefined;
    const requestedLagRecovery = lastLag !== undefined;
    return reserve(
      { kind: 'reload' },
      async (olderRead) => {
        try {
          await olderRead?.catch(() => undefined);
          const recoverLag = requestedLagRecovery || lastLag !== undefined;
          const probe = recoverLag || snapshot.consistency.kind !== 'ready';
          if (probe) {
            try {
              await beginRead({ rememberInitial: true });
            } catch (error) {
              if (!recoverLag || lastLag === undefined || !hasReloadManager(lastLag)) throw error;
            }
          }
          const mcp =
            lastLag === undefined
              ? snapshot.mcp
              : lastLag.mcp.kind === 'enabled'
                ? lastLag.mcp.snapshot
                : undefined;
          const catalog = lastLag?.catalog ?? snapshot.catalog;
          if (mcp !== undefined) await mcpWrite(() => reloadMcpServers(mcp.authoritySequence));
          else if (catalog?.local !== undefined) await esmWrite(reloadPlugins);
          else if (!probe && hadCatalog) await beginRead();
        } catch (reason) {
          reportWriteError(reason);
        }
      },
      (promise) => {
        reloadPromise = promise;
      },
    );
  }
  function requireManaged(): ManagedCatalog {
    if (snapshot.managed?.kind !== 'enabled')
      throw new PluginApiError('plugin-installer-disabled', '受管插件安装不可用', 404);
    return snapshot.managed.catalog;
  }
  async function previewManaged(
    sourceDirectory: string,
    signal?: AbortSignal,
  ): Promise<ManagedPreview> {
    const blocked = writeBlock();
    if (blocked !== undefined) throw blocked;
    if (snapshot.sharedManagementBlocked)
      throw new PluginApiError('catalog-unavailable', '请先重新读取一致的目录', 0);
    requireManaged();
    return previewManagedPlugin(sourceDirectory, signal);
  }
  async function previewGithubManaged(
    source: GithubPluginSource,
    signal?: AbortSignal,
  ): Promise<GithubManagedPreview> {
    const blocked = writeBlock();
    if (blocked !== undefined) throw blocked;
    if (snapshot.sharedManagementBlocked)
      throw new PluginApiError('catalog-unavailable', '请先重新读取一致的目录', 0);
    requireManaged();
    return previewGithubManagedPlugin(source, signal);
  }
  async function sendManaged(
    prepared: PreparedManagedRequest,
    retry: boolean,
  ): Promise<ManagedAttemptOutcome> {
    if (snapshot.managedLastRejection !== undefined)
      publish({ ...snapshot, managedLastRejection: undefined });
    let response: ManagedMutationResponse;
    try {
      response = await sendManagedRequest(prepared);
    } catch (reason) {
      const error = toManagedError(reason);
      const context = { pluginId: prepared.pluginId, target: prepared.target, error };
      const recovery = rejectionRecovery(
        error,
        prepared.target.kind,
        retry,
        prepared.flow === 'update',
      );
      if (recovery === undefined) {
        unresolvedRequest = prepared;
        publish({ ...snapshot, managedUnresolved: Object.freeze(context) });
        await reconcile({});
        return { kind: 'unresolved', ...context };
      }
      const rejection = Object.freeze({ ...context, recovery });
      unresolvedRequest = undefined;
      publish({ ...snapshot, managedUnresolved: undefined, managedLastRejection: rejection });
      await reconcile({});
      return { kind: 'rejected', ...rejection };
    }
    unresolvedRequest = undefined;
    if (meetsConfirmedHeads(response.current.heads)) confirmedHeads = response.current.heads;
    publish({ ...snapshot, managedUnresolved: undefined, managedLastResult: response });
    await reconcile({ managed: response.current });
    return { kind: 'saved', response };
  }
  function submitManaged(review: ManagedReview): Promise<ManagedAttemptOutcome> {
    const blocked = writeBlock();
    if (blocked !== undefined) return Promise.resolve({ kind: 'not-sent', error: blocked });
    const id = review.kind === 'import' ? review.preview.candidate.manifest.id : review.pluginId;
    return reserve({ source: 'managed', kind: review.kind, id }, async (olderRead) => {
      let prepared: PreparedManagedRequest;
      try {
        await prepareOrdinaryWrite(olderRead);
        const { heads } = requireManaged();
        const install =
          review.kind === 'import'
            ? review.preview.expectedInstallSequence
            : review.expectedInstallSequence;
        if (
          install !== heads.installSequence ||
          (review.kind !== 'import' && review.expectedTrustSequence !== heads.trustSequence)
        )
          throw new PluginApiError('plugin-managed-review-stale', '本次审查已失效，请重新审查', 0);
        prepared = prepareManagedRequest(review, crypto.randomUUID());
      } catch (reason) {
        return { kind: 'not-sent', error: toManagedError(reason) };
      }
      return sendManaged(prepared, false);
    });
  }
  async function previewUpdate(
    pluginId: string,
    signal?: AbortSignal,
  ): Promise<ManagedUpdatePreview> {
    const blocked = writeBlock();
    if (blocked !== undefined) throw blocked;
    if (snapshot.sharedManagementBlocked)
      throw new PluginApiError('catalog-unavailable', '请先重新读取一致的目录', 0);
    requireManaged();
    return previewManagedUpdate(pluginId, signal);
  }
  function submitManagedUpdate(review: ManagedUpdateReview): Promise<ManagedAttemptOutcome> {
    const blocked = writeBlock();
    if (blocked !== undefined) return Promise.resolve({ kind: 'not-sent', error: blocked });
    return reserve(
      { source: 'managed', kind: 'activate', id: review.pluginId },
      async (olderRead) => {
        let prepared: PreparedManagedRequest;
        try {
          await prepareOrdinaryWrite(olderRead);
          const { heads } = requireManaged();
          if (
            review.expectedInstallSequence !== heads.installSequence ||
            review.expectedTrustSequence !== heads.trustSequence
          )
            throw new PluginApiError(
              'plugin-managed-review-stale',
              '本次审查已失效，请重新审查',
              0,
            );
          prepared = prepareManagedUpdateRequest(review, crypto.randomUUID());
        } catch (reason) {
          return { kind: 'not-sent', error: toManagedError(reason) };
        }
        return sendManaged(prepared, false);
      },
    );
  }
  function retryManaged(): Promise<ManagedAttemptOutcome> {
    const blocked = writeBlock(true);
    if (blocked !== undefined) return Promise.resolve({ kind: 'not-sent', error: blocked });
    const prepared = unresolvedRequest;
    if (prepared === undefined)
      return Promise.resolve({
        kind: 'not-sent',
        error: new PluginApiError('plugin-managed-no-unresolved', '没有需要核对的受管插件操作', 0),
      });
    return reserve(
      { source: 'managed', id: prepared.pluginId, kind: prepared.target.kind },
      async (olderRead) => {
        await olderRead?.catch(() => undefined);
        return sendManaged(prepared, true);
      },
    );
  }
  function stopTrackingManaged(): Promise<void> {
    const blocked = writeBlock(true);
    if (blocked !== undefined) return Promise.reject(blocked);
    if (unresolvedRequest === undefined) return Promise.resolve();
    return reserve(undefined, async (olderRead) => {
      await olderRead?.catch(() => undefined);
      unresolvedRequest = undefined;
      publish({ ...snapshot, managedUnresolved: undefined });
      await beginRead({ rememberInitial: true });
    });
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
    previewManaged,
    previewGithubManaged,
    submitManaged,
    previewManagedUpdate: previewUpdate,
    submitManagedUpdate,
    retryManaged,
    stopTrackingManaged,
    trust: (id, digest) =>
      start({ kind: 'trust', id, digest }, () => esmWrite(() => trustPlugin(id, digest), id)),
    confirmHooks: (id, digest, hooks) =>
      start({ kind: 'confirm-hooks', id, digest }, () =>
        esmWrite(() => confirmPluginHooks(id, digest, hooks), id),
      ),
    setEnabled: (id, enabled, immediate = false) =>
      start({ kind: enabled ? 'enable' : 'disable', id }, () =>
        esmWrite(() => setPluginEnabled(id, enabled, { immediate }), id),
      ),
    revoke: (id, immediate = false) =>
      start({ kind: 'revoke', id }, () => esmWrite(() => revokePluginTrust(id, { immediate }), id)),
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
