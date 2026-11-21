import { useState, type ReactElement } from 'react';

import { usePluginCatalogState, usePluginCatalogStore } from '../plugins/plugin-catalog-context.js';
import type { PluginCatalog, PluginListItem } from '../plugins/plugin-types.js';
import { McpConfigDialog } from './mcp-config-dialog.js';
import { McpDecisionDialog } from './mcp-decision-dialog.js';
import { createMcpReview, type McpReview } from './mcp-review.js';
import { McpTrustDialog } from './mcp-trust-dialog.js';
import type {
  ExtensionGeneration,
  McpManagementSnapshot,
  McpServerConfig,
  McpServerRecord,
  McpToolMetadata,
} from './mcp-types.js';

import './mcp-panel.css';

const stateLabels = {
  removed: '已移除',
  changed: '已变更',
  untrusted: '待信任',
  disabled: '已停用',
  connecting: '连接中',
  loaded: '已加载',
  failed: '失败',
} as const;
interface McpRow {
  readonly id: string;
  readonly record?: McpServerRecord;
  readonly plugin?: PluginListItem;
}

/** MCP health is authoritative; the registry adds actual contributions only. */
export function selectMcpRows(
  catalog: PluginCatalog | undefined,
  mcp: McpManagementSnapshot | undefined,
): readonly McpRow[] {
  const plugins = new Map(
    (catalog?.plugins ?? [])
      .filter((plugin) => plugin.host === 'mcp')
      .map((plugin) => [plugin.id, plugin]),
  );
  const rows: McpRow[] = (mcp?.servers ?? []).map((record) => {
    const id = `mcp-${record.config.id}`;
    const plugin = plugins.get(id);
    plugins.delete(id);
    return { id, record, ...(plugin === undefined ? {} : { plugin }) };
  });
  for (const [id, plugin] of plugins) rows.push({ id, plugin });
  return rows;
}

type PanelDialog =
  | { readonly kind: 'create'; readonly expectedSequence: number; readonly reviewEpoch: number }
  | {
      readonly kind: 'edit';
      readonly initial: McpServerConfig;
      readonly expectedSequence: number;
      readonly reviewEpoch: number;
    }
  | { readonly kind: 'trust'; readonly review: McpReview }
  | {
      readonly kind: 'disable' | 'revoke' | 'remove';
      readonly server: McpServerRecord;
      readonly expectedSequence: number;
      readonly reviewEpoch: number;
    };

function Generation({
  generation,
  prefix,
}: {
  readonly generation: ExtensionGeneration;
  readonly prefix: string;
}): ReactElement {
  return (
    <>
      <p>
        {prefix}：第 {generation.id} 代 ·{' '}
        {generation.acceptingRuns ? '可开始新回合' : '暂停接受新回合'}
      </p>
      {generation.blocked === undefined ? null : (
        <p className="plugin-error">
          <code>{generation.blocked.code}</code>：{generation.blocked.message}
        </p>
      )}
    </>
  );
}
function ToolMetadata({ tool }: { readonly tool: McpToolMetadata }): ReactElement {
  return (
    <li className="mcp-tool-metadata">
      <dl className="plugin-facts">
        <div className="plugin-fact">
          <dt>服务工具名</dt>
          <dd>
            <code>{tool.name}</code>
          </dd>
        </div>
        <div className="plugin-fact">
          <dt>映射工具名</dt>
          <dd>
            <code>{tool.toolName}</code>
          </dd>
        </div>
      </dl>
      <p>{tool.description}</p>
      <details>
        <summary>输入 Schema</summary>
        <pre>{JSON.stringify(tool.inputSchema, null, 2)}</pre>
      </details>
      {tool.outputSchema === undefined ? null : (
        <details>
          <summary>输出 Schema</summary>
          <pre>{JSON.stringify(tool.outputSchema, null, 2)}</pre>
        </details>
      )}
      {tool.annotations === undefined ? null : (
        <details>
          <summary>服务声明的 annotations</summary>
          <pre>{JSON.stringify(tool.annotations, null, 2)}</pre>
        </details>
      )}
    </li>
  );
}
function ActualContributions({
  plugin,
}: {
  readonly plugin: PluginListItem | undefined;
}): ReactElement {
  const names = plugin?.provides.tools ?? [];
  return (
    <section className="plugin-contributions">
      <h5>注册表实际提供</h5>
      {names.length === 0 ? (
        <p className="plugin-note">当前未注册工具贡献</p>
      ) : (
        <dl className="plugin-facts">
          <div className="plugin-fact">
            <dt>工具</dt>
            <dd>
              {names.map((name) => (
                <code className="plugin-tag" key={name}>
                  {name}
                </code>
              ))}
            </dd>
          </div>
        </dl>
      )}
    </section>
  );
}
function McpItem({
  row,
  blocked,
  refreshBlocked,
  onEdit,
  onReview,
  onDecision,
  onEnable,
  onRefresh,
  onReload,
}: {
  readonly row: McpRow;
  readonly blocked: boolean;
  readonly refreshBlocked: boolean;
  readonly onEdit: (server: McpServerRecord) => void;
  readonly onReview: (server: McpServerRecord) => void;
  readonly onDecision: (server: McpServerRecord, action: 'disable' | 'revoke' | 'remove') => void;
  readonly onEnable: (server: McpServerRecord) => void;
  readonly onRefresh: () => void;
  readonly onReload: () => void;
}): ReactElement {
  const record = row.record;
  const label = record?.config.label ?? row.plugin?.name ?? row.id;
  const live = record !== undefined && record.state !== 'removed';
  const review = live && (record.state === 'untrusted' || record.state === 'changed');
  const trusted = record?.trustedDigest !== undefined;
  return (
    <li>
      <details className="plugin-item mcp-item">
        <summary className="plugin-summary">
          <span className="plugin-name">{label}</span>
          <span className="plugin-chip">{record === undefined ? 'MCP' : 'MCP · stdio'}</span>
          <span className={`plugin-chip plugin-state plugin-state-${record?.state ?? 'unknown'}`}>
            {record === undefined ? 'MCP 状态待同步' : stateLabels[record.state]}
          </span>
          {record?.stale === true ? <span className="plugin-chip">工具列表已变化</span> : null}
        </summary>
        <div className="plugin-detail">
          <p className="plugin-id">{record?.config.id ?? row.id}</p>
          {record === undefined ? (
            <>
              <p className="plugin-note">
                注册表中存在 MCP 贡献，但尚无一致的服务管理记录。重新读取目录后再管理此服务。
              </p>
              <button
                type="button"
                className="secondary-button"
                disabled={refreshBlocked}
                onClick={onRefresh}
              >
                重新读取目录
              </button>
            </>
          ) : (
            <>
              <dl className="plugin-facts">
                <div className="plugin-fact">
                  <dt>启动程序</dt>
                  <dd>
                    <code>{record.config.command}</code>
                  </dd>
                </div>
                <div className="plugin-fact">
                  <dt>参数 argv</dt>
                  <dd>
                    <pre>{JSON.stringify(record.config.args, null, 2)}</pre>
                  </dd>
                </div>
                <div className="plugin-fact">
                  <dt>工作目录</dt>
                  <dd>
                    <code>{record.config.cwd}</code>
                  </dd>
                </div>
                <div className="plugin-fact">
                  <dt>环境变量引用</dt>
                  <dd>
                    <pre>{JSON.stringify(record.config.env, null, 2)}</pre>
                  </dd>
                </div>
                <div className="plugin-fact">
                  <dt>当前配置摘要</dt>
                  <dd>
                    <code>{record.configDigest}</code>
                  </dd>
                </div>
                {record.trustedDigest === undefined ? null : (
                  <div className="plugin-fact">
                    <dt>已信任摘要</dt>
                    <dd>
                      <code>{record.trustedDigest}</code>
                    </dd>
                  </div>
                )}
              </dl>
              {record.issue === undefined ? null : (
                <p className="plugin-error">
                  <code>{record.issue.code}</code>：{record.issue.message}
                </p>
              )}
              {record.active === undefined ? null : (
                <div className="mcp-generation-binding">
                  <p>正在使用：第 {record.active.generation} 代</p>
                  <code>{record.active.configDigest}</code>
                </div>
              )}
              {record.drainingGenerations.map((binding) => (
                <div
                  className="mcp-generation-binding"
                  key={`${binding.generation}:${binding.configDigest}`}
                >
                  <p>退役连接：第 {binding.generation} 代</p>
                  <code>{binding.configDigest}</code>
                </div>
              ))}
              {record.active !== undefined || record.drainingGenerations.length > 0 ? (
                <p className="plugin-note">
                  已有回合可能仍持有这些连接；当前配置状态与旧回合的连接分别列出。
                </p>
              ) : null}
              {record.stale ? (
                <div className="mcp-stale-note">
                  <p>服务的工具列表已变化；全量重载后，新回合才能使用重新发现的工具。</p>
                  <button
                    type="button"
                    className="secondary-button"
                    disabled={blocked}
                    onClick={onReload}
                  >
                    全量重载扩展
                  </button>
                </div>
              ) : null}
              {live ? (
                <div className="plugin-actions">
                  <button
                    type="button"
                    className="secondary-button"
                    disabled={blocked}
                    onClick={() => onEdit(record)}
                  >
                    编辑配置
                  </button>
                  {review ? (
                    <button
                      type="button"
                      className="secondary-button"
                      disabled={blocked}
                      onClick={() => onReview(record)}
                    >
                      {record.state === 'changed' ? '审阅差异' : '审阅并信任'}
                    </button>
                  ) : null}
                  {record.state === 'disabled' && record.trustedDigest === record.configDigest ? (
                    <button
                      type="button"
                      className="secondary-button"
                      disabled={blocked}
                      onClick={() => onEnable(record)}
                    >
                      启用
                    </button>
                  ) : null}
                  {record.enabled ? (
                    <button
                      type="button"
                      className="secondary-button"
                      disabled={blocked}
                      onClick={() => onDecision(record, 'disable')}
                    >
                      停用
                    </button>
                  ) : null}
                  {trusted ? (
                    <button
                      type="button"
                      className="secondary-button"
                      disabled={blocked}
                      onClick={() => onDecision(record, 'revoke')}
                    >
                      撤销信任
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className="secondary-button"
                    disabled={blocked}
                    onClick={() => onDecision(record, 'remove')}
                  >
                    移除
                  </button>
                </div>
              ) : null}
              <section className="plugin-contributions">
                <h5>服务工具</h5>
                <p className="plugin-note">
                  MCP 工具始终按高风险工具处理，经共享工具管线审批执行。服务声明的 annotations
                  不改变审批规则。
                </p>
                {record.tools.length === 0 ? (
                  <p className="plugin-note">尚无工具元数据</p>
                ) : (
                  <ul className="plugin-list">
                    {record.tools.map((tool) => (
                      <ToolMetadata key={tool.name} tool={tool} />
                    ))}
                  </ul>
                )}
              </section>
            </>
          )}
          <ActualContributions plugin={row.plugin} />
        </div>
      </details>
    </li>
  );
}

export function McpPanel({
  hasRunningSessions,
  getFallbackFocus,
}: {
  readonly hasRunningSessions: boolean;
  readonly getFallbackFocus: () => HTMLElement | null;
}): ReactElement | null {
  const store = usePluginCatalogStore();
  const {
    catalog,
    mcp,
    mcpAvailable,
    consistency,
    reviewEpoch,
    initialLoading,
    pendingOperation,
    mcpLastResult,
    mcpLastGeneration,
  } = usePluginCatalogState();
  const [dialog, setDialog] = useState<PanelDialog | null>(null);
  const rows = selectMcpRows(catalog, mcp);
  const busy = initialLoading || pendingOperation !== undefined;
  const blocked = busy || consistency.kind !== 'ready' || mcpAvailable !== true;
  const liveCount = mcp?.servers.filter((server) => server.state !== 'removed').length ?? 0;
  const expectedSequence = mcp?.authoritySequence ?? 0;
  const capture = { expectedSequence, reviewEpoch };
  const capturedEpoch = dialog?.kind === 'trust' ? dialog.review.reviewEpoch : dialog?.reviewEpoch;
  const stale = capturedEpoch !== reviewEpoch || consistency.kind !== 'ready';
  const refresh = (): void => {
    void store.refresh().catch(() => undefined);
  };
  const reload = (): void => {
    void store.reload().catch(() => undefined);
  };
  if (mcpAvailable !== true && rows.length === 0 && mcpLastResult === undefined) return null;
  return (
    <section className="mcp-panel plugin-group" aria-label="MCP 服务">
      <div className="overview-block-heading">
        <h4 className="plugin-group-title">
          MCP 服务 <span className="activity-state">{rows.length}</span>
        </h4>
        {mcpAvailable !== true ? null : (
          <button
            type="button"
            className="secondary-button"
            disabled={blocked || liveCount >= 8}
            onClick={() => setDialog({ kind: 'create', ...capture })}
          >
            添加 MCP 服务
          </button>
        )}
      </div>
      {liveCount >= 8 ? (
        <p className="plugin-note">最多保留 8 个未移除的 MCP 服务；移除配置后可继续添加。</p>
      ) : null}
      {mcpLastResult === undefined ? null : (
        <div className="plugin-operation-result" role="status">
          <p>
            决定序号：{mcpLastResult.decisionSequence} ·{' '}
            {mcpLastResult.applied ? '已应用' : '决定已记录，重建未完成'}
            {mcpLastResult.unchanged ? ' · 无变化' : ''}
          </p>
          {mcpLastGeneration === undefined ? null : (
            <Generation prefix="本次结果" generation={mcpLastGeneration} />
          )}
          {mcpLastResult.error === undefined ? null : (
            <p className="plugin-error">
              <code>{mcpLastResult.error.code}</code>：{mcpLastResult.error.message}
            </p>
          )}
          {mcpLastResult.failed.map(({ id, error }) => (
            <p className="plugin-error" key={`${id}:${error.code}`}>
              {id} 未能加载 · <code>{error.code}</code>：{error.message}
            </p>
          ))}
        </div>
      )}
      {mcp === undefined ? null : (
        <p className="plugin-note">当前授权序号：{mcp.authoritySequence}</p>
      )}
      {rows.length === 0 ? (
        <p className="plugin-note">
          尚未配置 MCP 服务。保存启动配置后，需要单独审阅并信任才能启动。
        </p>
      ) : (
        <ul className="plugin-list">
          {rows.map((row) => (
            <McpItem
              key={row.id}
              row={row}
              blocked={blocked}
              refreshBlocked={busy || consistency.kind === 'refreshing'}
              onEdit={(record) =>
                setDialog({
                  kind: 'edit',
                  initial: createMcpReview(record, expectedSequence, reviewEpoch).config,
                  ...capture,
                })
              }
              onReview={(record) =>
                setDialog({
                  kind: 'trust',
                  review: createMcpReview(record, expectedSequence, reviewEpoch),
                })
              }
              onDecision={(server, kind) => setDialog({ kind, server, ...capture })}
              onEnable={(record) => {
                void store
                  .enableMcp(record.config.id, expectedSequence, record.configDigest)
                  .catch(() => undefined);
              }}
              onRefresh={refresh}
              onReload={reload}
            />
          ))}
        </ul>
      )}
      {dialog?.kind === 'create' || dialog?.kind === 'edit' ? (
        <McpConfigDialog
          {...(dialog.kind === 'edit' ? { initial: dialog.initial } : {})}
          expectedSequence={dialog.expectedSequence}
          busy={busy}
          stale={stale}
          onCancel={() => setDialog(null)}
          onSave={(config, sequence) =>
            dialog.kind === 'edit'
              ? store.updateMcp(dialog.initial.id, sequence, config)
              : store.configureMcp(sequence, config)
          }
          getFallbackFocus={getFallbackFocus}
        />
      ) : null}
      {dialog?.kind === 'trust' ? (
        <McpTrustDialog
          review={dialog.review}
          busy={busy}
          stale={stale}
          onCancel={() => setDialog(null)}
          onTrust={(review) => store.trustMcp(review)}
          getFallbackFocus={getFallbackFocus}
        />
      ) : null}
      {dialog?.kind === 'disable' || dialog?.kind === 'revoke' || dialog?.kind === 'remove' ? (
        <McpDecisionDialog
          server={dialog.server}
          action={dialog.kind}
          expectedSequence={dialog.expectedSequence}
          busy={busy}
          stale={stale}
          hasRunningSessions={hasRunningSessions}
          onCancel={() => setDialog(null)}
          onConfirm={(immediate) => {
            const args = [dialog.server.config.id, dialog.expectedSequence, immediate] as const;
            return dialog.kind === 'disable'
              ? store.disableMcp(...args)
              : dialog.kind === 'revoke'
                ? store.revokeMcp(...args)
                : store.removeMcp(...args);
          }}
          getFallbackFocus={getFallbackFocus}
        />
      ) : null}
    </section>
  );
}
