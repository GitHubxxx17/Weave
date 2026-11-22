import { useId, useState, type ReactElement } from 'react';
import {
  ArrowDownToLine,
  Box,
  Check,
  Puzzle,
  RefreshCw,
  Search,
  ShieldCheck,
  Users,
  X,
} from 'lucide-react';

import {
  type MarketplaceIndexSource,
  type MarketplaceEntry,
  type MarketplaceInstallSelection,
} from './plugin-marketplace-types.js';
import { MarketplaceSources } from './marketplace-sources.js';
import { useMarketplaceSources } from './use-marketplace-sources.js';
import { usePluginCatalogState, usePluginCatalogStore } from './plugin-catalog-context.js';
import { PluginsPanel } from './plugins-panel.js';
import { ManagedContributions, ManagedGithubSource } from './managed-plugin-dialog.js';

import './plugin-marketplace.css';

type Category = 'all' | 'official' | 'community';

function MarketplaceDetail({
  entry,
  indexSource,
  onClose,
  onInstall,
}: {
  readonly entry: MarketplaceEntry;
  readonly indexSource?: MarketplaceIndexSource;
  readonly onClose: () => void;
  readonly onInstall: (selection: MarketplaceInstallSelection) => void;
}): ReactElement {
  const [version, setVersion] = useState(
    entry.kind === 'github'
      ? (entry.releases.find(({ compatibility }) => compatibility === 'compatible') ??
          entry.releases[0])!.manifest.version
      : entry.version,
  );
  const { sharedManagementBlocked, managed } = usePluginCatalogState();
  const release =
    entry.kind === 'github'
      ? (entry.releases.find(({ manifest }) => manifest.version === version) ??
        entry.releases.find(({ compatibility }) => compatibility === 'compatible') ??
        entry.releases[0])
      : undefined;
  const canInstall =
    release?.compatibility === 'compatible' &&
    !sharedManagementBlocked &&
    managed?.kind === 'enabled';
  const record =
    managed?.kind === 'enabled'
      ? managed.catalog.plugins.find(({ pluginId }) => pluginId === entry.id)
      : undefined;
  const selectedCandidate = record?.candidates.find(
    ({ digest, importSequence }) =>
      digest === record.selection?.digest &&
      importSequence === record.selection.candidateImportSequence,
  );
  return (
    <section className="marketplace-detail" aria-label={`${entry.name}详情`}>
      <header className="marketplace-detail-header">
        <span className="marketplace-icon">
          <Puzzle aria-hidden="true" />
        </span>
        <button className="icon-button" type="button" aria-label="关闭插件详情" onClick={onClose}>
          <X aria-hidden="true" />
        </button>
      </header>
      <span className={`marketplace-publisher marketplace-publisher-${entry.category}`}>
        {entry.category === 'official' ? (
          <ShieldCheck aria-hidden="true" />
        ) : (
          <Users aria-hidden="true" />
        )}
        {entry.category === 'official' ? '官方' : '社区'}
      </span>
      <h3>{entry.name}</h3>
      <p className="marketplace-detail-id">{entry.id}</p>
      <p>{entry.description}</p>
      <dl className="marketplace-metadata">
        <div>
          <dt>发布者</dt>
          <dd>{entry.publisher}</dd>
        </div>
        {indexSource === undefined ? null : (
          <div>
            <dt>索引源</dt>
            <dd>
              {indexSource.name}
              {indexSource.url === null ? null : (
                <span className="marketplace-detail-source-url">{indexSource.url}</span>
              )}
            </dd>
          </div>
        )}
      </dl>
      {record === undefined ? null : (
        <section className="marketplace-record" aria-label="该 ID 的受管记录">
          <h4>该 ID 的受管记录</h4>
          <p>已导入 {record.candidates.length} 个候选</p>
          <p>
            当前选择：
            {selectedCandidate === undefined ? '无' : `v${selectedCandidate.manifest.version}`}
          </p>
          <p>实际发布：{record.active === null ? '无' : `v${record.active.version}`}</p>
          <p className="marketplace-help">候选内容和激活状态可在“已安装”中核对。</p>
        </section>
      )}
      {entry.kind === 'builtin' ? (
        <div className="marketplace-bundled">
          <Check aria-hidden="true" />
          <div>
            <strong>已随 Weave 提供</strong>
            <p>版本 {entry.version} · 官方内置插件</p>
          </div>
        </div>
      ) : (
        <>
          <label className="marketplace-version">
            插件版本
            <select
              value={release?.manifest.version ?? version}
              onChange={(event) => setVersion(event.target.value)}
            >
              {entry.releases.map(({ manifest, compatibility }) => (
                <option key={manifest.version} value={manifest.version}>
                  {manifest.version}
                  {compatibility === 'incompatible' ? ' · 不兼容' : ''}
                </option>
              ))}
            </select>
          </label>
          {release === undefined ? null : (
            <>
              <p
                className={`marketplace-compatibility${release.compatibility === 'incompatible' ? ' marketplace-incompatible' : ''}`}
              >
                {release.compatibility === 'compatible' ? '兼容当前 Weave' : '与当前 Weave 不兼容'}
              </p>
              <ManagedGithubSource source={release.source} />
              <section className="marketplace-declarations" aria-label="市场版本声明">
                <h4>提供的能力与权限</h4>
                <ManagedContributions
                  values={release.manifest.contributes}
                  manifest={release.manifest}
                />
              </section>
              <button
                className="primary-button marketplace-install"
                type="button"
                disabled={!canInstall}
                onClick={() =>
                  onInstall(
                    Object.freeze({
                      publisher: entry.publisher,
                      manifest: release.manifest,
                      source: release.source,
                    }),
                  )
                }
              >
                <ArrowDownToLine aria-hidden="true" />
                准备安装
              </button>
              <p className="marketplace-help">下一步将预览并核对插件内容，再由你确认导入和激活。</p>
              {managed?.kind === 'enabled' ? null : (
                <p className="marketplace-help">当前服务的受管插件安装不可用。</p>
              )}
            </>
          )}
        </>
      )}
    </section>
  );
}

export function PluginMarketplacePage({
  hasRunningSessions,
}: {
  readonly hasRunningSessions: boolean;
}): ReactElement {
  const store = usePluginCatalogStore();
  const [tab, setTab] = useState<'discover' | 'installed'>('discover');
  const [category, setCategory] = useState<Category>('all');
  const [query, setQuery] = useState('');
  const sourceState = useMarketplaceSources();
  const { catalog, catalogError: error, loading } = sourceState;
  const [detail, setDetail] = useState<{
    readonly id: string;
    readonly sourceId: string | undefined;
  }>();
  const [installSelection, setInstallSelection] = useState<MarketplaceInstallSelection>();
  const tabsId = useId();
  const changeTab = (next: 'discover' | 'installed'): void => {
    setTab(next);
    if (next === 'installed') void store.refresh().catch(() => undefined);
  };
  const text = query.trim().toLocaleLowerCase();
  const entries = (catalog?.entries ?? []).filter(
    (entry) =>
      (category === 'all' || entry.category === category) &&
      [entry.name, entry.id, entry.description, entry.publisher, ...entry.tags]
        .join(' ')
        .toLocaleLowerCase()
        .includes(text),
  );
  const selected =
    detail?.sourceId === sourceState.effectiveSourceId
      ? entries.find(({ id }) => id === detail?.id)
      : undefined;
  return (
    <div className="plugin-marketplace-page">
      <header className="marketplace-header">
        <div>
          <span className="marketplace-eyebrow">扩展你的工作空间</span>
          <h2>插件市场</h2>
          <p>发现官方与社区插件，管理已安装的扩展和 MCP 服务。</p>
        </div>
        <span className="marketplace-header-icon" aria-hidden="true">
          <Puzzle />
        </span>
      </header>
      <div
        className="marketplace-tabs"
        role="tablist"
        aria-label="插件市场视图"
        onKeyDown={(event) => {
          if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
          event.preventDefault();
          const next =
            event.key === 'Home'
              ? 'discover'
              : event.key === 'End'
                ? 'installed'
                : tab === 'discover'
                  ? 'installed'
                  : 'discover';
          changeTab(next);
          document.getElementById(`${tabsId}-${next}-tab`)?.focus();
        }}
      >
        {(['discover', 'installed'] as const).map((view) => (
          <button
            key={view}
            id={`${tabsId}-${view}-tab`}
            role="tab"
            tabIndex={tab === view ? 0 : -1}
            type="button"
            aria-selected={tab === view}
            aria-controls={`${tabsId}-${view}`}
            onClick={() => changeTab(view)}
          >
            {view === 'discover' ? '发现插件' : '已安装'}
          </button>
        ))}
      </div>
      {tab === 'installed' ? (
        <div
          id={`${tabsId}-installed`}
          role="tabpanel"
          aria-labelledby={`${tabsId}-installed-tab`}
          className="marketplace-installed"
        >
          <PluginsPanel
            hasRunningSessions={hasRunningSessions}
            {...(installSelection === undefined
              ? {}
              : {
                  marketplaceSelection: installSelection,
                  onClearMarketplaceSelection: () => setInstallSelection(undefined),
                })}
          />
        </div>
      ) : (
        <div id={`${tabsId}-discover`} role="tabpanel" aria-labelledby={`${tabsId}-discover-tab`}>
          <MarketplaceSources
            state={sourceState}
            onSelect={(id) => {
              setDetail(undefined);
              sourceState.selectSource(id);
            }}
          />
          <div className="marketplace-toolbar">
            <label className="marketplace-search">
              <Search aria-hidden="true" />
              <input
                type="search"
                aria-label="搜索插件"
                placeholder="搜索名称、功能或发布者"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
            </label>
            <button
              className="secondary-button"
              type="button"
              disabled={loading || sourceState.busy}
              onClick={sourceState.refresh}
            >
              <RefreshCw aria-hidden="true" />
              刷新市场
            </button>
          </div>
          <div className="marketplace-filters" role="group" aria-label="插件来源筛选">
            {(['all', 'official', 'community'] as const).map((kind) => (
              <button
                key={kind}
                type="button"
                aria-pressed={category === kind}
                onClick={() => setCategory(kind)}
              >
                {kind === 'all' ? '全部' : kind === 'official' ? '官方' : '社区'}
              </button>
            ))}
          </div>
          {loading ? (
            <p className="marketplace-status" role="status">
              正在读取插件市场…
            </p>
          ) : error && catalog === undefined ? (
            <div className="marketplace-empty" role="status">
              <Box aria-hidden="true" />
              <h3>插件市场暂不可用</h3>
              <p>请稍后刷新。你仍可以在“已安装”中管理插件。</p>
            </div>
          ) : (
            <div
              className={`marketplace-layout${selected === undefined ? '' : ' marketplace-layout-detail'}`}
            >
              <div className="marketplace-results">
                {category !== 'official' && catalog?.communityStatus !== 'ready' ? (
                  <div className="marketplace-catalog-note" role="status">
                    <Users aria-hidden="true" />
                    <div>
                      <strong>
                        {catalog?.communityStatus === 'unavailable'
                          ? '社区插件目录暂不可用'
                          : '尚未配置社区插件目录'}
                      </strong>
                      <p>
                        开发者发布的插件收录后会显示在这里。你也可以在“已安装”中从 GitHub
                        或本地目录添加插件。
                      </p>
                    </div>
                  </div>
                ) : null}
                {entries.length === 0 ? (
                  <div className="marketplace-empty">
                    <Search aria-hidden="true" />
                    <h3>{text === '' ? '暂无插件' : '没有找到匹配的插件'}</h3>
                    <p>{text === '' ? '稍后再来发现更多扩展。' : '试试其他关键词或来源分类。'}</p>
                  </div>
                ) : (
                  <div className="marketplace-grid">
                    {entries.map((entry) => (
                      <button
                        key={entry.id}
                        type="button"
                        className={`marketplace-card${selected?.id === entry.id ? ' marketplace-card-selected' : ''}`}
                        aria-label={`查看 ${entry.name}`}
                        aria-pressed={selected?.id === entry.id}
                        onClick={() =>
                          setDetail({ id: entry.id, sourceId: sourceState.effectiveSourceId })
                        }
                      >
                        <span className="marketplace-card-top">
                          <span className="marketplace-icon">
                            <Puzzle aria-hidden="true" />
                          </span>
                          <span
                            className={`marketplace-publisher marketplace-publisher-${entry.category}`}
                          >
                            {entry.category === 'official' ? (
                              <ShieldCheck aria-hidden="true" />
                            ) : (
                              <Users aria-hidden="true" />
                            )}
                            {entry.category === 'official' ? '官方' : '社区'}
                          </span>
                        </span>
                        <strong>{entry.name}</strong>
                        <span className="marketplace-card-description">{entry.description}</span>
                        <span className="marketplace-card-publisher">{entry.publisher}</span>
                        <span className="marketplace-card-footer">
                          {entry.kind === 'builtin' ? (
                            <span>
                              <Check aria-hidden="true" />
                              已内置
                            </span>
                          ) : (
                            <span>{entry.releases.length} 个版本</span>
                          )}
                          <span>{entry.tags.slice(0, 2).join(' · ')}</span>
                        </span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
              {selected === undefined ? null : (
                <MarketplaceDetail
                  key={`${sourceState.effectiveSourceId ?? ''}/${selected.id}`}
                  entry={selected}
                  {...(catalog?.indexSource === undefined
                    ? {}
                    : { indexSource: catalog.indexSource })}
                  onClose={() => setDetail(undefined)}
                  onInstall={(selection) => {
                    setInstallSelection(selection);
                    changeTab('installed');
                  }}
                />
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
