import { useEffect, useId, useLayoutEffect, useState, type ReactElement } from 'react';
import type { ComposerDraftController, ComposerOwner } from '../composer/use-composer-draft.js';
import { PluginPanelForm } from './plugin-panel-form.js';
import {
  usePluginPanelData,
  panelRenderKey,
  type PanelAuthority,
} from './use-plugin-panel-data.js';
import type { PanelCell, PluginPanelDescriptor } from './plugin-panel-types.js';
import './plugin-panel.css';
const states = {
  empty: '暂无数据',
  incompatible: '数据版本不兼容',
  'invalid-data': '数据格式无效',
  'data-too-large': '数据超过显示限制',
};
function Cell({ cell }: { readonly cell: PanelCell | undefined }): ReactElement {
  if (cell === undefined) return <span>正在加载</span>;
  if (cell.state !== 'ready') return <span>{states[cell.state]}</span>;
  return <span>{cell.value === null ? '—' : String(cell.value)}</span>;
}
export function DeclarativePluginPanel({
  descriptor,
  authority,
  owner,
  visible,
  composer,
  onUnavailable,
}: {
  readonly descriptor: PluginPanelDescriptor;
  readonly authority: PanelAuthority;
  readonly owner: ComposerOwner;
  readonly visible: boolean;
  readonly composer: ComposerDraftController;
  readonly onUnavailable?: () => void;
}): ReactElement {
  const lifetime = useId();
  const key = panelRenderKey(owner, descriptor, authority, visible);
  const [refresh, setRefresh] = useState(0);
  const result = usePluginPanelData(descriptor, authority, owner, visible, refresh);
  const actionable =
    visible &&
    result.unavailable !== true &&
    descriptor.state === 'available' &&
    owner.sessionId !== '';
  composer.setPanelContext({
    ...authority,
    owner,
    panelRef: descriptor.panelRef,
    visible: actionable,
    lifetime,
  });
  // Rendering invalidates changed ownership synchronously. Layout setup also
  // restores the same context after StrictMode's setup/cleanup/setup replay.
  useLayoutEffect(() => {
    composer.setPanelContext({
      serverEpoch: authority.serverEpoch,
      generation: authority.generation,
      authorityEpoch: authority.authorityEpoch,
      owner,
      panelRef: descriptor.panelRef,
      visible: actionable,
      lifetime,
    });
    return () => composer.invalidatePanel(lifetime);
  }, [
    composer.setPanelContext,
    composer.invalidatePanel,
    authority.serverEpoch,
    authority.generation,
    authority.authorityEpoch,
    owner,
    descriptor.panelRef,
    actionable,
    lifetime,
  ]);
  useEffect(() => {
    if (result.unavailable === true) onUnavailable?.();
  }, [result.unavailable, onUnavailable]);
  const projected = new Map(result.data?.blocks.map((b) => [b.id, b]) ?? []);
  return (
    <section className="declarative-plugin-panel" aria-label={descriptor.definition.title}>
      <header>
        <strong>{descriptor.definition.title}</strong>
        <small>
          {descriptor.pluginName} · {descriptor.pluginVersion}
        </small>
        <button type="button" disabled={!actionable} onClick={() => setRefresh((n) => n + 1)}>
          刷新面板
        </button>
      </header>
      {descriptor.definition.description ? <p>{descriptor.definition.description}</p> : null}
      {result.unavailable ? (
        <p role="status">插件面板不可用</p>
      ) : result.error ? (
        <p role="status">{result.error}</p>
      ) : null}
      {result.data && result.data.state !== 'ready' ? (
        <p role="status">{states[result.data.state]}</p>
      ) : null}
      {descriptor.definition.blocks.map((block) => {
        const data = projected.get(block.id);
        switch (block.type) {
          case 'heading':
            return <h3 key={block.id}>{block.text}</h3>;
          case 'form':
            return (
              <PluginPanelForm
                key={`${key}:${block.id}`}
                form={block}
                descriptor={descriptor}
                authority={authority}
                owner={owner}
                visible={actionable}
                composer={composer}
                {...(onUnavailable === undefined ? {} : { onUnavailable })}
              />
            );
          case 'text':
            return (
              <p key={block.id}>
                {'literal' in block.value ? (
                  <span>{block.value.literal === null ? '—' : String(block.value.literal)}</span>
                ) : (
                  <Cell cell={data?.type === 'text' ? data.cell : undefined} />
                )}
              </p>
            );
          case 'status':
          case 'metric':
            return (
              <p key={block.id}>
                <strong>{block.label}: </strong>
                {'literal' in block.value ? (
                  <span>{block.value.literal === null ? '—' : String(block.value.literal)}</span>
                ) : (
                  <Cell cell={data !== undefined && 'cell' in data ? data.cell : undefined} />
                )}{' '}
                {block.type === 'metric' ? block.unit : null}
              </p>
            );
          case 'key-value':
            return (
              <dl key={block.id}>
                {block.rows.map((row, i) => (
                  <div key={i}>
                    <dt>{row.label}</dt>
                    <dd>
                      {'literal' in row.value ? (
                        <span>{row.value.literal === null ? '—' : String(row.value.literal)}</span>
                      ) : (
                        <Cell cell={data?.type === 'key-value' ? data.cells[i] : undefined} />
                      )}
                    </dd>
                  </div>
                ))}
              </dl>
            );
          case 'table':
            return (
              <div key={block.id}>
                {data?.type === 'table' && data.state !== 'ready' ? (
                  <p>{states[data.state]}</p>
                ) : null}
                <table>
                  <thead>
                    <tr>
                      {block.columns.map((c) => (
                        <th key={c.id} scope="col">
                          {c.title}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {data?.type === 'table'
                      ? data.rows.map((row, i) => (
                          <tr key={i}>
                            {row.map((cell, j) => (
                              <td key={j}>
                                <Cell cell={cell} />
                              </td>
                            ))}
                          </tr>
                        ))
                      : null}
                  </tbody>
                </table>
                {data?.type === 'table' && data.truncatedRows > 0 ? (
                  <p>显示前 100 行，另有 {data.truncatedRows} 行未显示</p>
                ) : null}
              </div>
            );
        }
      })}
    </section>
  );
}
