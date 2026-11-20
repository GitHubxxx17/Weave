import { useRef, useState, type ReactElement } from 'react';
import { Puzzle, RotateCw } from 'lucide-react';

import { usePluginCatalogState, usePluginCatalogStore } from './plugin-catalog-context.js';
import { PluginDecisionDialog } from './plugin-decision-dialog.js';
import { createPluginReview, type PluginReview } from './plugin-review.js';
import { PluginTrustDialog } from './plugin-trust-dialog.js';
import type { PluginDeclarations, PluginIssue, PluginListItem } from './plugin-types.js';

const knownOrigins = ['builtin', 'registered', 'kernel', 'local'] as const;
const originLabels: Readonly<Record<string, string>> = {
  builtin: '内置',
  registered: '已注册',
  kernel: '扩展',
  local: '本地',
};
const localStates = [
  'pending-trust',
  'changed',
  'loaded',
  'disabled',
  'failed',
  'invalid',
  'incompatible',
];
const stateLabels: Readonly<Record<string, string>> = {
  'pending-trust': '待信任',
  changed: '已变更',
  loaded: '已加载',
  disabled: '已停用',
  failed: '失败',
  invalid: '无效',
  incompatible: '不兼容',
};
const capabilityLabels: Readonly<Record<string, string>> = {
  tool: '工具',
  'llm-provider': '模型提供方',
  prompt: '提示词',
  event: '会话事件',
  command: '命令',
};
const hostLabels: Readonly<Record<string, string>> = { mcp: 'MCP', subprocess: '子进程' };
const permissionLabels: Readonly<Record<string, string>> = {
  'workspace:read': '读取工作区',
  'workspace:write': '写入工作区',
  'process:spawn': '运行进程',
  'network:request': '访问网络',
};
const contributionLabels: readonly (readonly [keyof PluginDeclarations, string])[] = [
  ['tools', '工具'],
  ['providers', '模型提供方'],
  ['promptSections', '提示词片段'],
  ['events', '会话事件'],
  ['commands', '命令'],
  ['hooks', '钩子'],
  ['services', '服务'],
];

function displayLabel(labels: Readonly<Record<string, string>>, value: string): string {
  return Object.hasOwn(labels, value) ? (labels[value] ?? value) : value;
}

export function permissionLabel(permission: string): string {
  return (
    (Object.hasOwn(permissionLabels, permission) ? permissionLabels[permission] : undefined) ??
    (permission.startsWith('service:')
      ? `使用服务 ${permission.slice('service:'.length)}`
      : permission)
  );
}

/** Unknown origins/states retain their discovery order after the known values. */
export function groupByOrigin(plugins: readonly PluginListItem[]): readonly {
  readonly origin: string;
  readonly plugins: readonly PluginListItem[];
}[] {
  const groups = new Map<string, PluginListItem[]>(knownOrigins.map((origin) => [origin, []]));
  for (const plugin of plugins) {
    const group = groups.get(plugin.origin);
    if (group === undefined) groups.set(plugin.origin, [plugin]);
    else group.push(plugin);
  }
  return [...groups.entries()]
    .filter(([, members]) => members.length > 0)
    .map(([origin, members]) => ({
      origin,
      plugins:
        origin === 'local'
          ? [...members].sort((left, right) => {
              const rank = (state: string): number => {
                const index = localStates.indexOf(state);
                return index < 0 ? localStates.length : index;
              };
              return rank(left.state) - rank(right.state);
            })
          : members,
    }));
}

function NameTags({ names }: { readonly names: readonly string[] }): ReactElement {
  return (
    <>
      {names.map((name, index) => (
        <code key={`${String(index)}:${name}`} className="plugin-tag">
          {name}
        </code>
      ))}
    </>
  );
}

function Contributions({ values }: { readonly values: PluginDeclarations }): ReactElement {
  return (
    <>
      {contributionLabels.map(([key, label]) => {
        const names = values[key] ?? [];
        return names.length === 0 ? null : (
          <div key={key} className="plugin-fact">
            <dt>{label}</dt>
            <dd>
              <NameTags names={names} />
            </dd>
          </div>
        );
      })}
    </>
  );
}

function Issue({ issue }: { readonly issue: PluginIssue }): ReactElement {
  return (
    <p className="plugin-error">
      <code>{issue.code}</code>：{issue.message}
    </p>
  );
}

/** Mutation URLs identify one id, so ambiguous identities must remain read-only. */
function canManage(plugin: PluginListItem, idCounts: ReadonlyMap<string, number>): boolean {
  const local = plugin.local;
  return (
    plugin.origin === 'local' &&
    (idCounts.get(plugin.id) ?? 0) === 1 &&
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(plugin.id) &&
    local !== undefined &&
    local.directory.length > 0 &&
    /^[a-f0-9]{64}$/.test(local.digest ?? '') &&
    local.manifest?.id === plugin.id &&
    !['plugin-duplicate-id', 'plugin-id-reserved'].includes(plugin.error?.code ?? '')
  );
}

type PanelDialog =
  | { readonly kind: 'review'; readonly review: PluginReview }
  | { readonly kind: 'disable' | 'revoke'; readonly plugin: PluginListItem };

function PluginItem({
  plugin,
  manageable,
  busy,
  onReview,
  onDecision,
  onEnable,
}: {
  readonly plugin: PluginListItem;
  readonly manageable: boolean;
  readonly busy: boolean;
  readonly onReview: (plugin: PluginListItem) => void;
  readonly onDecision: (plugin: PluginListItem, action: 'disable' | 'revoke') => void;
  readonly onEnable: (plugin: PluginListItem) => void;
}): ReactElement {
  const local = plugin.local;
  const review = manageable && ['pending-trust', 'changed'].includes(plugin.state);
  const trusted = manageable && local?.trusted?.manifest.id === plugin.id;
  const disable = trusted && ['loaded', 'failed'].includes(plugin.state);
  const revoke = trusted && ['changed', 'loaded', 'disabled', 'failed'].includes(plugin.state);
  const enable = trusted && plugin.state === 'disabled' && local?.digest === local.trusted?.digest;
  const hasActual = Object.values(plugin.provides).some((names) => names.length > 0);
  return (
    <li>
      <details className="plugin-item">
        <summary className="plugin-summary">
          <span className="plugin-name">{plugin.name}</span>
          <span className="plugin-version">v{plugin.version}</span>
          <span
            className={`plugin-chip plugin-state plugin-state-${localStates.includes(plugin.state) ? plugin.state : 'unknown'}`}
          >
            {displayLabel(stateLabels, plugin.state)}
          </span>
          {plugin.host === 'in-process' ? null : (
            <span className="plugin-chip">{displayLabel(hostLabels, plugin.host)}</span>
          )}
        </summary>
        <div className="plugin-detail">
          <p className="plugin-id">{plugin.id}</p>
          {plugin.description === undefined ? null : (
            <p className="plugin-description">{plugin.description}</p>
          )}
          <dl className="plugin-facts">
            <div className="plugin-fact">
              <dt>能力</dt>
              <dd>
                {plugin.capabilities.map((capability, index) => (
                  <span key={`${String(index)}:${capability}`} className="plugin-chip">
                    {displayLabel(capabilityLabels, capability)}
                  </span>
                ))}
              </dd>
            </div>
            {plugin.permissions === undefined || plugin.permissions.length === 0 ? null : (
              <div className="plugin-fact">
                <dt>声明权限</dt>
                <dd>
                  {plugin.permissions.map((permission, index) => (
                    <span key={`${String(index)}:${permission}`} className="plugin-chip">
                      {permissionLabel(permission)}
                    </span>
                  ))}
                </dd>
              </div>
            )}
            {plugin.engines === undefined ? null : (
              <div className="plugin-fact">
                <dt>适用版本</dt>
                <dd>
                  <code className="plugin-tag">{plugin.engines.weave}</code>
                </dd>
              </div>
            )}
          </dl>
          {plugin.contributes === undefined ? null : (
            <section className="plugin-contributions">
              <h5>声明贡献</h5>
              <dl className="plugin-facts">
                <Contributions values={plugin.contributes} />
              </dl>
            </section>
          )}
          <section className="plugin-contributions">
            <h5>实际提供</h5>
            {hasActual ? (
              <dl className="plugin-facts">
                <Contributions values={plugin.provides} />
              </dl>
            ) : (
              <p className="plugin-note">当前未提供贡献</p>
            )}
          </section>
          {plugin.error === undefined ? null : <Issue issue={plugin.error} />}
          {local === undefined ? null : (
            <dl className="plugin-facts plugin-local-facts">
              <div className="plugin-fact">
                <dt>来源目录</dt>
                <dd>
                  <code>{local.directory}</code>
                </dd>
              </div>
              {local.digest === undefined ? null : (
                <div className="plugin-fact">
                  <dt>当前摘要</dt>
                  <dd>
                    <code>{local.digest}</code>
                  </dd>
                </div>
              )}
              {local.active === undefined ? null : (
                <div className="plugin-fact">
                  <dt>正在使用</dt>
                  <dd>
                    <span>
                      第 {String(local.active.generation)} 代 · v{local.active.manifest.version}
                    </span>
                    <code>{local.active.digest}</code>
                  </dd>
                </div>
              )}
            </dl>
          )}
          {local?.active !== undefined &&
          (plugin.state !== 'loaded' || local.active.digest !== local.digest) ? (
            <p className="plugin-note">
              已有回合仍可使用先前加载的版本；上方状态表示当前发现的插件。默认决定从下一回合起生效。
            </p>
          ) : null}
          {review || disable || revoke || enable ? (
            <div className="plugin-actions">
              {review ? (
                <button
                  type="button"
                  className="secondary-button"
                  disabled={busy}
                  onClick={() => onReview(plugin)}
                >
                  {plugin.state === 'changed' ? '审阅差异' : '审阅并信任'}
                </button>
              ) : null}
              {disable ? (
                <button
                  type="button"
                  className="secondary-button"
                  disabled={busy}
                  onClick={() => onDecision(plugin, 'disable')}
                >
                  停用
                </button>
              ) : null}
              {enable ? (
                <button
                  type="button"
                  className="secondary-button"
                  disabled={busy}
                  onClick={() => onEnable(plugin)}
                >
                  启用
                </button>
              ) : null}
              {revoke ? (
                <button
                  type="button"
                  className="secondary-button"
                  disabled={busy}
                  onClick={() => onDecision(plugin, 'revoke')}
                >
                  撤销信任
                </button>
              ) : null}
            </div>
          ) : null}
        </div>
      </details>
    </li>
  );
}

/** Excludes hidden/inert branches after the modal has restored background state. */
function visible(element: HTMLElement): boolean {
  for (let node: HTMLElement | null = element; node !== null; node = node.parentElement) {
    if (node.hidden || node.hasAttribute('inert') || node.getAttribute('aria-hidden') === 'true')
      return false;
    const style = window.getComputedStyle(node);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
  }
  return element.isConnected && !element.matches(':disabled');
}

export function PluginsPanel({
  hasRunningSessions,
}: {
  readonly hasRunningSessions: boolean;
}): ReactElement {
  const store = usePluginCatalogStore();
  const { catalog, initialLoading, pendingOperation, error, lastResult } = usePluginCatalogState();
  const [dialog, setDialog] = useState<PanelDialog | null>(null);
  const regionRef = useRef<HTMLDivElement>(null);
  const busy = initialLoading || pendingOperation !== undefined;
  const idCounts = new Map<string, number>();
  for (const plugin of catalog?.plugins ?? [])
    idCounts.set(plugin.id, (idCounts.get(plugin.id) ?? 0) + 1);
  const getFallbackFocus = (): HTMLElement | null => {
    const tab = [...document.querySelectorAll<HTMLElement>('[data-plugin-tab]')].find(visible);
    if (tab !== undefined) return tab;
    if (regionRef.current !== null && visible(regionRef.current)) return regionRef.current;
    return (
      [...document.querySelectorAll<HTMLElement>('.workspace-nav button')].find(visible) ?? null
    );
  };
  const local = catalog?.local;
  return (
    <div
      ref={regionRef}
      className="panel-body plugins-panel"
      role="region"
      aria-label="插件"
      tabIndex={-1}
    >
      <section className="overview-block">
        <div className="overview-block-heading">
          <h3>插件</h3>
          <span className="activity-state">
            {catalog === undefined ? null : `${String(catalog.plugins.length)} 个`}
          </span>
          <button
            type="button"
            className="icon-button"
            aria-label="刷新插件列表"
            title="刷新"
            disabled={busy}
            onClick={() => {
              void store.reload().catch(() => undefined);
            }}
          >
            <RotateCw
              aria-hidden="true"
              className={pendingOperation?.kind === 'reload' ? 'spin-icon' : undefined}
            />
          </button>
        </div>
        {initialLoading ? (
          <p className="activity-state" role="status">
            正在读取插件…
          </p>
        ) : null}
        {pendingOperation === undefined ? null : (
          <p className="activity-state" role="status">
            {pendingOperation.kind === 'reload' ? '正在重新发现并加载插件…' : '正在保存插件决定…'}
          </p>
        )}
        {error === undefined ? null : (
          <p className="error-message" role="alert">
            {error.message}（{error.code}）
          </p>
        )}
        {lastResult?.error === undefined ? null : (
          <div className="plugin-operation-result" role="status">
            <p>决定已记录，但插件重建未完成。请检查错误后刷新。</p>
            <Issue issue={lastResult.error} />
          </div>
        )}
        {lastResult?.failed.map(({ id, error: issue }) => (
          <div key={`${id}:${issue.code}`} className="plugin-operation-result">
            <p>{id} 未能加载</p>
            <Issue issue={issue} />
          </div>
        ))}
        {catalog?.plugins.length === 0 ? (
          <div className="activity-empty">
            <span className="activity-empty-icon" aria-hidden="true">
              <Puzzle aria-hidden="true" />
            </span>
            <p>
              {local !== undefined && local.generation.plugins.length > 0
                ? '当前没有发现插件；先前加载的插件仍列在下方当前加载集合中。'
                : '当前没有已加载的插件。'}
              {local === undefined ? 'Agent 创建后才会列出。' : '可将本地插件放入下方目录后刷新。'}
            </p>
          </div>
        ) : null}
        {catalog === undefined
          ? null
          : groupByOrigin(catalog.plugins).map((group) => (
              <div key={group.origin} className="plugin-group">
                <h4 className="plugin-group-title">
                  {displayLabel(originLabels, group.origin)}
                  <span className="activity-state"> {String(group.plugins.length)}</span>
                </h4>
                <ul className="plugin-list">
                  {group.plugins.map((plugin) => (
                    <PluginItem
                      key={JSON.stringify([plugin.origin, plugin.id, plugin.local?.directory])}
                      plugin={plugin}
                      manageable={local !== undefined && canManage(plugin, idCounts)}
                      busy={busy}
                      onReview={(item) => {
                        const review = createPluginReview(item);
                        if (review !== undefined) setDialog({ kind: 'review', review });
                      }}
                      onDecision={(item, action) => setDialog({ kind: action, plugin: item })}
                      onEnable={(item) => {
                        void store.setEnabled(item.id, true).catch(() => undefined);
                      }}
                    />
                  ))}
                </ul>
              </div>
            ))}
      </section>
      {local === undefined ? (
        catalog === undefined ? null : (
          <p className="plugin-note">此服务仅提供插件列表，本地插件管理不可用。</p>
        )
      ) : (
        <footer className="plugin-host-summary">
          <p>
            插件目录 <code>{local.directory}</code>
          </p>
          {!local.exists ? <p>目录不存在；创建目录并放入插件后刷新。</p> : null}
          {local.truncated ? <p>发现结果已截断，部分插件尚未显示。</p> : null}
          {local.error === undefined ? null : <Issue issue={local.error} />}
          <p>
            当前加载版本：第 {String(local.generation.id)} 代 ·{' '}
            {local.generation.acceptingRuns ? '可开始新回合' : '暂停接受新回合'}
          </p>
          {local.generation.blocked === undefined ? null : (
            <Issue issue={local.generation.blocked} />
          )}
          <section className="plugin-generation-members" aria-label="当前加载集合">
            <h5>当前加载集合</h5>
            {local.generation.plugins.length === 0 ? (
              <p>当前加载集合中没有本地插件。</p>
            ) : (
              <ul className="plugin-list">
                {local.generation.plugins.map((member) => (
                  <li key={`${member.id}:${member.digest}`}>
                    <span>
                      {member.id} · v{member.manifest.version}
                    </span>
                    <code>{member.digest}</code>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </footer>
      )}
      {dialog?.kind === 'review' ? (
        <PluginTrustDialog
          review={dialog.review}
          busy={busy}
          onCancel={() => setDialog(null)}
          onTrust={(review) => store.trust(review.id, review.digest)}
          getFallbackFocus={getFallbackFocus}
        />
      ) : null}
      {dialog !== null && dialog.kind !== 'review' ? (
        <PluginDecisionDialog
          plugin={dialog.plugin}
          action={dialog.kind}
          hasRunningSessions={hasRunningSessions}
          busy={busy}
          onCancel={() => setDialog(null)}
          onConfirm={(immediate) =>
            dialog.kind === 'disable'
              ? store.setEnabled(dialog.plugin.id, false, immediate)
              : store.revoke(dialog.plugin.id, immediate)
          }
          getFallbackFocus={getFallbackFocus}
        />
      ) : null}
    </div>
  );
}
