import { useId, useLayoutEffect, useRef, useState, type ReactElement } from 'react';
import { z } from 'zod';

import {
  managedAction,
  ManagedContributions,
  ManagedGithubSource,
  type ManagedDraft,
  ManagedIdentity,
  ManagedPluginDialog,
  ManagedRecoveryDialog,
  managedRecoveryText,
} from './managed-plugin-dialog.js';
import { githubPluginSourceInputSchema } from './managed-plugin-types.js';
import type {
  ManagedCandidate,
  ManagedCatalogObservation,
  ManagedHeads,
  ManagedMutationResponse,
  ManagedPlugin,
  ManagedReview,
} from './managed-plugin-types.js';
import { usePluginCatalogState, usePluginCatalogStore } from './plugin-catalog-context.js';
import { pluginDialogError } from './plugin-dialog.js';
import type { PluginListItem } from './plugin-types.js';
import {
  marketplaceValueEqual,
  type MarketplaceInstallSelection,
} from './plugin-marketplace-types.js';

import './managed-plugins.css';

const manualPath = z
  .string()
  .min(1)
  .refine((path) => !path.includes('\0'));
const absolutePickerPath = manualPath.refine((path) => {
  if (path.startsWith('/')) return true;
  if (/^[a-z]:[\\/]/i.test(path)) return true;
  return /^\\\\[^\\/]+[\\/][^\\/]+(?:[\\/]|$)/.test(path) && !/^\\\\[?.][\\/]/.test(path);
});
const pickerResult = z
  .strictObject({ path: absolutePickerPath, name: z.string().min(1) })
  .nullable();

export function managedPublishedKernel(
  plugin: PluginListItem,
  managed: ManagedCatalogObservation | undefined,
): boolean {
  return (
    plugin.origin === 'kernel' &&
    managed?.kind === 'enabled' &&
    managed.catalog.plugins.some((row) => row.pluginId === plugin.id && row.active !== null)
  );
}

function ManagedTrust({ trust }: { readonly trust: ManagedPlugin['trust'] }): ReactElement {
  if (trust === null) return <span>无</span>;
  return (
    <>
      <span>{trust.enabled ? '已信任并启用' : '已信任，已停用'}</span>
      <code>{trust.digest}</code>
    </>
  );
}

const applicationLabels = {
  applied: '已应用',
  failed: '应用失败',
  'not-required': '无需加载',
  unknown: '重放回执，原应用状态未知',
} as const;

function ManagedReceipt({ receipt }: { readonly receipt: ManagedMutationResponse }): ReactElement {
  const { decision, application } = receipt;
  const { target } = decision;
  const published =
    receipt.kind === 'committed'
      ? receipt.application.active
      : (receipt.current.plugins.find((row) => row.pluginId === decision.pluginId)?.active ?? null);
  const generation =
    receipt.kind === 'committed' ? receipt.application.generation : receipt.current.generation;
  return (
    <section className="plugin-operation-result managed-receipt" aria-label="受管插件操作回执">
      <p role="status">
        <strong>决定已保存</strong> · {decision.changed ? '已改变' : '无变化'}
      </p>
      <dl className="plugin-facts managed-identity">
        <div className="plugin-fact">
          <dt>保存的决定</dt>
          <dd>
            <span>
              {decision.pluginId} · {managedAction(target)}
            </span>
          </dd>
        </div>
        <div className="plugin-fact">
          <dt>决定序号</dt>
          <dd>{decision.operationSequence}</dd>
        </div>
        <div className="plugin-fact">
          <dt>目标摘要</dt>
          <dd>{target.digest === null ? '无' : <code>{target.digest}</code>}</dd>
        </div>
        {'immediate' in target ? (
          <div className="plugin-fact">
            <dt>生效时机</dt>
            <dd>{target.immediate ? '立即生效' : '已有回合继续'}</dd>
          </div>
        ) : null}
        <div className="plugin-fact">
          <dt>决定时的选择</dt>
          <dd>
            <ManagedIdentity value={decision.selection} />
          </dd>
        </div>
        <div className="plugin-fact">
          <dt>决定时的信任</dt>
          <dd>
            <ManagedTrust trust={decision.trust} />
          </dd>
        </div>
        <div className="plugin-fact">
          <dt>应用状态</dt>
          <dd>{applicationLabels[application.status]}</dd>
        </div>
        <div className="plugin-fact">
          <dt>票据记录的发布</dt>
          <dd>
            <ManagedIdentity value={published} />
          </dd>
        </div>
      </dl>
      <p>
        票据记录的代际 · 第 {generation.id} 代 ·{' '}
        {generation.acceptingRuns ? '可开始新回合' : '暂停接受新回合'}
      </p>
      {application.status === 'failed' ? (
        <p className="plugin-error">
          {application.issue.message}（{application.issue.code}）
        </p>
      ) : null}
      {generation.blocked === undefined ? null : (
        <p className="plugin-error">{generation.blocked.message}</p>
      )}
    </section>
  );
}

function selectedCandidate(row: ManagedPlugin): ManagedCandidate | undefined {
  const { selection } = row;
  if (selection === null) return undefined;
  return row.candidates.find(
    ({ importSequence, digest }) =>
      importSequence === selection.candidateImportSequence && digest === selection.digest,
  );
}

function managedRowId(id: string): string {
  return `managed-plugin-${id}`;
}

function ManagedRow({
  row,
  heads,
  published,
  blocked,
  onReview,
}: {
  readonly row: ManagedPlugin;
  readonly heads: ManagedHeads;
  readonly published: PluginListItem | undefined;
  readonly blocked: boolean;
  readonly onReview: (draft: ManagedDraft) => void;
}): ReactElement {
  const selection = row.selection;
  const selectedDigest = selection?.digest ?? null;
  const selected = selectedCandidate(row);
  const selectedIsPublished =
    selection !== null &&
    row.active !== null &&
    selection.digest === row.active.digest &&
    selection.activationSequence === row.active.activationSequence;
  const basis = {
    pluginId: row.pluginId,
    expectedInstallSequence: heads.installSequence,
    expectedTrustSequence: heads.trustSequence,
  };
  const reviewSelection = (kind: 'enable' | 'disable' | 'revoke' | 'uninstall'): void => {
    const review: ManagedReview | undefined =
      kind === 'enable'
        ? selectedDigest === null
          ? undefined
          : { ...basis, kind, selectedDigest }
        : { ...basis, kind, selectedDigest, immediate: false };
    if (review !== undefined)
      onReview({
        review,
        ...(selected === undefined ? {} : { selectedManifest: selected.manifest }),
      });
  };
  const activate = (candidate: ManagedCandidate, intent: 'activate' | 'rollback'): void => {
    onReview({
      ...(candidate.provenance === 'github' ? { github: candidate.github } : {}),
      review: {
        ...basis,
        kind: 'activate',
        digest: candidate.digest,
        manifest: candidate.manifest,
        previousSelection: selectedDigest,
        intent,
      },
    });
  };
  return (
    <li>
      <details className="plugin-item managed-plugin" id={managedRowId(row.pluginId)}>
        <summary className="plugin-summary">
          <span className="plugin-name">{row.pluginId}</span>
          <span className="plugin-chip">{row.candidates.length} 个候选</span>
          <span className="plugin-chip">{row.active === null ? '未发布' : '有已发布版本'}</span>
        </summary>
        <div className="plugin-detail">
          <dl className="plugin-facts managed-identity">
            <div className="plugin-fact">
              <dt>当前选择</dt>
              <dd>
                {selected === undefined ? null : (
                  <span>
                    v{selected.manifest.version} · 导入序号 {selected.importSequence}
                  </span>
                )}
                <ManagedIdentity value={selection} />
              </dd>
            </div>
            <div className="plugin-fact">
              <dt>匹配信任</dt>
              <dd>
                <ManagedTrust trust={row.trust} />
              </dd>
            </div>
            <div className="plugin-fact">
              <dt>最新发布</dt>
              <dd>
                <ManagedIdentity value={row.active} />
              </dd>
            </div>
          </dl>
          {selection === null ? null : (
            <p className="plugin-note">
              {selectedIsPublished ? '当前选择已发布' : '当前选择尚未发布'}
            </p>
          )}
          {row.active === null ? null : (
            <section className="plugin-contributions">
              <h5>实际提供</h5>
              {published === undefined ? (
                <p className="plugin-note">实际贡献待同步</p>
              ) : (
                <ManagedContributions values={published.provides} />
              )}
            </section>
          )}
          <div className="plugin-actions">
            {row.trust?.enabled === false ? (
              <button
                type="button"
                className="secondary-button"
                disabled={blocked}
                onClick={() => reviewSelection('enable')}
              >
                启用
              </button>
            ) : null}
            <button
              type="button"
              className="secondary-button"
              disabled={blocked}
              onClick={() => reviewSelection('disable')}
            >
              停用
            </button>
            <button
              type="button"
              className="secondary-button"
              disabled={blocked}
              onClick={() => reviewSelection('revoke')}
            >
              撤销信任
            </button>
            <button
              type="button"
              className="secondary-button"
              disabled={blocked}
              onClick={() => reviewSelection('uninstall')}
            >
              卸载
            </button>
          </div>
          <section className="plugin-contributions" aria-label="候选历史">
            <h5>候选历史</h5>
            <ul className="plugin-list managed-candidates">
              {row.candidates.map((candidate) => (
                <li
                  key={`${candidate.digest}:${candidate.importSequence}`}
                  className="managed-candidate"
                >
                  <span>v{candidate.manifest.version}</span>
                  <span>
                    导入序号 {candidate.importSequence} ·{' '}
                    {candidate.provenance === 'github' ? 'GitHub 仓库' : '本地目录'} ·{' '}
                    <time dateTime={candidate.importedAt}>
                      {new Date(candidate.importedAt).toLocaleString()}
                    </time>
                  </span>
                  {candidate.provenance === 'github' ? (
                    <ManagedGithubSource source={candidate.github} />
                  ) : null}
                  <code>{candidate.digest}</code>
                  <div className="plugin-actions">
                    <button
                      type="button"
                      className="secondary-button"
                      disabled={blocked}
                      onClick={() => activate(candidate, 'activate')}
                    >
                      激活
                    </button>
                    {selectedDigest === null || candidate.digest === selectedDigest ? null : (
                      <button
                        type="button"
                        className="secondary-button"
                        disabled={blocked}
                        onClick={() => activate(candidate, 'rollback')}
                      >
                        回退
                      </button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          </section>
        </div>
      </details>
    </li>
  );
}

type OpenDialog =
  { readonly kind: 'review'; readonly draft: ManagedDraft } | { readonly kind: 'retry' | 'stop' };

export function ManagedPluginsSection({
  getFallbackFocus,
  marketplaceSelection: initialMarketplaceSelection,
  onClearMarketplaceSelection,
}: {
  readonly getFallbackFocus: () => HTMLElement | null;
  readonly marketplaceSelection?: MarketplaceInstallSelection;
  readonly onClearMarketplaceSelection?: () => void;
}): ReactElement {
  const store = usePluginCatalogStore();
  const {
    catalog,
    managed,
    consistency,
    initialLoading,
    pendingOperation,
    managedUnresolved,
    managedLastResult,
    managedLastRejection,
    managedReviewRequiredId,
    sharedManagementBlocked,
    canRecoverManagedLag,
  } = usePluginCatalogState();
  const titleId = useId();
  const sourceChoiceName = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const repositoryRef = useRef<HTMLInputElement>(null);
  const [marketplaceSelection, setMarketplaceSelection] = useState(initialMarketplaceSelection);
  const [sourceKind, setSourceKind] = useState<'local' | 'github'>(
    initialMarketplaceSelection === undefined ? 'local' : 'github',
  );
  const [path, setPath] = useState('');
  const [repository, setRepository] = useState(
    initialMarketplaceSelection?.source.repository ?? '',
  );
  const [commit, setCommit] = useState(initialMarketplaceSelection?.source.commit ?? '');
  const [subdirectory, setSubdirectory] = useState(
    initialMarketplaceSelection?.source.subdirectory ?? '',
  );
  const [previewing, setPreviewing] = useState(false);
  const [localError, setLocalError] = useState<string>();
  const [dialog, setDialog] = useState<OpenDialog | null>(null);
  const revision = useRef(0);
  const previewAbort = useRef<AbortController>(null);
  useLayoutEffect(
    () => () => {
      revision.current++;
      previewAbort.current?.abort();
    },
    [],
  );
  useLayoutEffect(() => {
    const invalidatePreview = (): void => {
      if (!store.getSnapshot().sharedManagementBlocked || previewAbort.current === null) return;
      revision.current++;
      previewAbort.current.abort();
      previewAbort.current = null;
      setPreviewing(false);
    };
    return store.subscribe(invalidatePreview);
  }, [store]);
  const invalidate = (): number => {
    previewAbort.current?.abort();
    previewAbort.current = null;
    setPreviewing(false);
    return ++revision.current;
  };
  const openDialog = (next: OpenDialog): void => {
    invalidate();
    setDialog(next);
  };
  const closeDialog = (): void => {
    invalidate();
    setDialog(null);
  };
  const clearMarketplaceSelection = (): void => {
    setMarketplaceSelection(undefined);
    onClearMarketplaceSelection?.();
  };
  const managedCatalog = managed?.kind === 'enabled' ? managed.catalog : undefined;
  const bridge = window.weaveDesktop;
  const picker =
    bridge?.pluginDirectoryPicker === true && typeof bridge.pickDirectory === 'function'
      ? bridge.pickDirectory
      : undefined;
  const chooseDirectory = async (): Promise<void> => {
    if (picker === undefined || sharedManagementBlocked) return;
    const current = invalidate();
    setLocalError(undefined);
    try {
      const value = await picker.call(bridge, 'plugin-import');
      if (current !== revision.current) return;
      const result = pickerResult.safeParse(value);
      if (!result.success) setLocalError('文件夹选择器返回了无效的目录。');
      else if (result.data !== null) setPath(result.data.path);
    } catch {
      if (current === revision.current) setLocalError('无法打开文件夹选择器。');
    }
  };
  const preview = async (): Promise<void> => {
    if (sharedManagementBlocked || previewAbort.current !== null) return;
    const current = invalidate();
    setLocalError(undefined);
    if (sourceKind === 'local' && !manualPath.safeParse(path).success) {
      setLocalError('请输入本机服务上的绝对目录路径。');
      inputRef.current?.focus();
      return;
    }
    const github = githubPluginSourceInputSchema.safeParse({ repository, commit, subdirectory });
    if (sourceKind === 'github' && !github.success) {
      setLocalError('请输入 GitHub 仓库地址、40 位小写提交 SHA 和有效的相对子目录。');
      repositoryRef.current?.focus();
      return;
    }
    const controller = new AbortController();
    previewAbort.current = controller;
    setPreviewing(true);
    try {
      const result =
        sourceKind === 'github' && github.success
          ? await store.previewGithubManaged(github.data, controller.signal)
          : await store.previewManaged(path, controller.signal);
      if (
        current === revision.current &&
        !store.getSnapshot().sharedManagementBlocked &&
        document.querySelector('[data-plugin-dialog-portal]') === null
      ) {
        if (
          marketplaceSelection !== undefined &&
          (!('github' in result) ||
            !marketplaceValueEqual(result.github, marketplaceSelection.source) ||
            !marketplaceValueEqual(result.candidate.manifest, marketplaceSelection.manifest))
        ) {
          setLocalError('实际插件声明与市场版本不一致，已阻止导入。请核对发布者提供的版本。');
          return;
        }
        setDialog({
          kind: 'review',
          draft:
            'github' in result
              ? {
                  review: { kind: 'import', preview: result },
                  github: result.github,
                  ...(marketplaceSelection === undefined
                    ? {}
                    : { marketplacePublisher: marketplaceSelection.publisher }),
                }
              : { review: { kind: 'import', preview: result }, sourceDirectory: path },
        });
      }
    } catch (reason) {
      if (current === revision.current) setLocalError(pluginDialogError(reason));
    } finally {
      if (current === revision.current) {
        previewAbort.current = null;
        setPreviewing(false);
      }
    }
  };
  const submitReview = async (review: ManagedReview) => {
    const current = revision.current;
    const outcome = await store.submitManaged(review);
    if (
      review.kind === 'import' &&
      current === revision.current &&
      (outcome.kind === 'saved' || outcome.kind === 'unresolved')
    ) {
      setPath('');
      setRepository('');
      setCommit('');
      setSubdirectory('');
      clearMarketplaceSelection();
    }
    return outcome;
  };
  const focusPath = (): void => {
    closeDialog();
    setLocalError(undefined);
    // PluginDialog restores focus during its unmount before the next frame.
    const focusInput = (): void => {
      (sourceKind === 'github' ? repositoryRef : inputRef).current?.focus();
    };
    if (dialog === null) focusInput();
    else window.requestAnimationFrame(focusInput);
  };
  const getImportFallbackFocus = (): HTMLElement | null => {
    const input = (sourceKind === 'github' ? repositoryRef : inputRef).current;
    return input !== null && !input.disabled ? input : getFallbackFocus();
  };
  const focusManagedRow = (id: string): void => {
    const row = document.getElementById(managedRowId(id));
    if (!(row instanceof HTMLDetailsElement)) return;
    row.open = true;
    row.querySelector('summary')?.focus();
  };
  const activityBlocked = initialLoading || pendingOperation !== undefined;
  const hasManagedCatalog = managedCatalog !== undefined;
  const findHandoff = (id: string | undefined): boolean =>
    managedCatalog?.plugins.some((row) => row.pluginId === id) === true;
  const showRejection = managedLastRejection !== undefined && dialog?.kind !== 'review';
  const repreview =
    showRejection &&
    (managedLastRejection.recovery === 'preview' ||
      managedLastRejection.recovery === 'retry-review');
  const reselect =
    showRejection &&
    (managedLastRejection.recovery === 'review' || managedLastRejection.recovery === 'activate');
  const publishedById = new Map(
    (catalog?.plugins ?? [])
      .filter((plugin) => managedPublishedKernel(plugin, managed))
      .map((plugin) => [plugin.id, plugin]),
  );
  return (
    <section className="plugin-group managed-plugins" aria-labelledby={titleId}>
      <div className="overview-block-heading managed-heading">
        <h4 className="plugin-group-title" id={titleId}>
          受管插件
        </h4>
        {managed !== undefined || managedUnresolved !== undefined ? (
          <button
            type="button"
            className="secondary-button"
            disabled={activityBlocked || consistency.kind === 'refreshing'}
            onClick={() => void store.refresh().catch(() => undefined)}
          >
            读取目录
          </button>
        ) : null}
      </div>
      {managed === undefined && !initialLoading ? (
        <p className="plugin-note">受管插件目录同步失败</p>
      ) : null}
      {managed?.kind === 'disabled' ? (
        <p className="plugin-note">此服务未启用受管插件安装</p>
      ) : null}
      {managed?.kind === 'legacy' ? (
        <p className="plugin-note">旧版服务不提供受管插件目录</p>
      ) : null}
      {consistency.kind === 'unavailable' && consistency.reason === 'managed-authority-lag' ? (
        <div className="plugin-operation-result" role="status">
          <p>受管插件目录等待同步</p>
          {canRecoverManagedLag ? (
            <button
              type="button"
              className="secondary-button"
              onClick={() => void store.reload().catch(() => undefined)}
            >
              重新发现并加载扩展
            </button>
          ) : null}
        </div>
      ) : null}
      {managedUnresolved === undefined ? null : (
        <div className="plugin-operation-result">
          <p role="status">
            {managedUnresolved.pluginId} · {managedAction(managedUnresolved.target)}结果未确认
          </p>
          <p>
            {managedUnresolved.error.message}（{managedUnresolved.error.code}）
          </p>
          <div className="plugin-actions">
            <button
              type="button"
              className="secondary-button"
              disabled={activityBlocked}
              onClick={() => openDialog({ kind: 'retry' })}
            >
              重试原请求
            </button>
            <button
              type="button"
              className="secondary-button"
              disabled={activityBlocked}
              onClick={() => openDialog({ kind: 'stop' })}
            >
              停止跟踪
            </button>
          </div>
        </div>
      )}
      {managedLastResult === undefined ? null : <ManagedReceipt receipt={managedLastResult} />}
      {showRejection ? (
        <div className="plugin-operation-result">
          <p role="status">
            {managedLastRejection.pluginId} · {managedAction(managedLastRejection.target)}被拒绝。
            {managedRecoveryText(managedLastRejection.recovery)}
          </p>
          <p className="plugin-error">
            {managedLastRejection.error.message}（{managedLastRejection.error.code}）
          </p>
          {repreview && hasManagedCatalog ? (
            <button
              type="button"
              className="secondary-button"
              disabled={sharedManagementBlocked}
              onClick={focusPath}
            >
              重新预览
            </button>
          ) : null}
          {reselect && findHandoff(managedLastRejection.pluginId) ? (
            <button
              type="button"
              className="secondary-button"
              onClick={() => focusManagedRow(managedLastRejection.pluginId)}
            >
              {managedLastRejection.recovery === 'activate' ? '查看激活候选' : '查看受管插件'}
            </button>
          ) : null}
        </div>
      ) : null}
      {managedReviewRequiredId === undefined ? null : (
        <div className="plugin-operation-result">
          <p role="status">请在受管插件中重新审查 {managedReviewRequiredId}。</p>
          {findHandoff(managedReviewRequiredId) ? (
            <button
              type="button"
              className="secondary-button"
              onClick={() => focusManagedRow(managedReviewRequiredId)}
            >
              查看受管插件 {managedReviewRequiredId}
            </button>
          ) : null}
        </div>
      )}
      {managedCatalog === undefined ? null : (
        <>
          <div className="managed-path-entry">
            {marketplaceSelection === undefined ? null : (
              <div className="marketplace-source-attribution">
                <p>
                  市场发布者：{marketplaceSelection.publisher} ·{' '}
                  {marketplaceSelection.manifest.name} v{marketplaceSelection.manifest.version}
                </p>
                <p className="plugin-note">预览时将核对市场版本与实际插件声明。</p>
                <button
                  type="button"
                  className="secondary-button"
                  disabled={sharedManagementBlocked}
                  onClick={() => {
                    invalidate();
                    clearMarketplaceSelection();
                  }}
                >
                  改为手动来源
                </button>
              </div>
            )}
            <fieldset className="managed-source-choice" disabled={sharedManagementBlocked}>
              <legend>插件来源</legend>
              {(['local', 'github'] as const).map((kind) => (
                <label key={kind}>
                  <input
                    type="radio"
                    name={sourceChoiceName}
                    checked={sourceKind === kind}
                    onChange={() => {
                      invalidate();
                      clearMarketplaceSelection();
                      setSourceKind(kind);
                      setLocalError(undefined);
                    }}
                  />
                  {kind === 'local' ? '本地目录' : 'GitHub 仓库'}
                </label>
              ))}
            </fieldset>
            {sourceKind === 'local' ? (
              <label>
                插件来源目录
                <input
                  ref={inputRef}
                  value={path}
                  autoComplete="off"
                  spellCheck={false}
                  disabled={sharedManagementBlocked}
                  onChange={(event) => {
                    invalidate();
                    clearMarketplaceSelection();
                    setPath(event.target.value);
                    setLocalError(undefined);
                  }}
                />
              </label>
            ) : (
              <>
                <label>
                  GitHub 仓库地址
                  <input
                    ref={repositoryRef}
                    value={repository}
                    placeholder="https://github.com/owner/repo"
                    autoComplete="off"
                    spellCheck={false}
                    disabled={sharedManagementBlocked}
                    onChange={(event) => {
                      invalidate();
                      clearMarketplaceSelection();
                      setRepository(event.target.value);
                      setLocalError(undefined);
                    }}
                  />
                </label>
                <label>
                  完整提交 SHA
                  <input
                    value={commit}
                    autoComplete="off"
                    spellCheck={false}
                    disabled={sharedManagementBlocked}
                    onChange={(event) => {
                      invalidate();
                      clearMarketplaceSelection();
                      setCommit(event.target.value);
                      setLocalError(undefined);
                    }}
                  />
                </label>
                <label>
                  插件子目录（可选）
                  <input
                    value={subdirectory}
                    placeholder="留空使用仓库根目录"
                    autoComplete="off"
                    spellCheck={false}
                    disabled={sharedManagementBlocked}
                    onChange={(event) => {
                      invalidate();
                      clearMarketplaceSelection();
                      setSubdirectory(event.target.value);
                      setLocalError(undefined);
                    }}
                  />
                </label>
              </>
            )}
            <div className="plugin-actions">
              {picker === undefined || sourceKind !== 'local' ? null : (
                <button
                  type="button"
                  className="secondary-button"
                  disabled={sharedManagementBlocked}
                  onClick={() => void chooseDirectory()}
                >
                  选择插件文件夹
                </button>
              )}
              <button
                type="button"
                className="secondary-button"
                disabled={sharedManagementBlocked || previewing}
                onClick={() => void preview()}
              >
                预览插件
              </button>
              {previewing ? (
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() => {
                    invalidate();
                    setLocalError(undefined);
                    (sourceKind === 'github' ? repositoryRef : inputRef).current?.focus();
                  }}
                >
                  取消预览
                </button>
              ) : null}
            </div>
            {previewing ? (
              <p className="plugin-note" role="status">
                正在预览插件…
              </p>
            ) : null}
            {localError === undefined ? null : (
              <p className="plugin-error" role="alert">
                {localError}
              </p>
            )}
          </div>
          {managedCatalog.plugins.length === 0 ? (
            <p className="plugin-note">尚无受管插件</p>
          ) : (
            <ul className="plugin-list">
              {managedCatalog.plugins.map((row) => (
                <ManagedRow
                  key={row.pluginId}
                  row={row}
                  heads={managedCatalog.heads}
                  published={publishedById.get(row.pluginId)}
                  blocked={sharedManagementBlocked}
                  onReview={(draft) => openDialog({ kind: 'review', draft })}
                />
              ))}
            </ul>
          )}
        </>
      )}
      {dialog?.kind === 'review' ? (
        <ManagedPluginDialog
          draft={dialog.draft}
          blocked={sharedManagementBlocked}
          getFallbackFocus={
            dialog.draft.review.kind === 'import' ? getImportFallbackFocus : getFallbackFocus
          }
          onSubmit={submitReview}
          onCancel={closeDialog}
          onReviewAgain={dialog.draft.review.kind === 'import' ? focusPath : closeDialog}
        />
      ) : null}
      {dialog?.kind === 'retry' || dialog?.kind === 'stop' ? (
        <ManagedRecoveryDialog
          kind={dialog.kind}
          blocked={activityBlocked || managedUnresolved === undefined}
          getFallbackFocus={getFallbackFocus}
          onCancel={closeDialog}
          onConfirm={async () => {
            if (dialog.kind === 'stop') {
              try {
                await store.stopTrackingManaged();
              } catch (reason) {
                // A failed follow-up read is already reported by the catalog.
                if (store.getSnapshot().managedUnresolved !== undefined) throw reason;
              }
              return;
            }
            const outcome = await store.retryManaged();
            if (outcome.kind === 'not-sent') throw outcome.error;
          }}
        />
      ) : null}
    </section>
  );
}
