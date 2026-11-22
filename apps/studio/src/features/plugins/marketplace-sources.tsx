import { useId, useState, type ReactElement } from 'react';
import { Globe, Plus, Settings2, Trash2 } from 'lucide-react';
import type { useMarketplaceSources } from './use-marketplace-sources.js';

type SourcesState = ReturnType<typeof useMarketplaceSources>;
const sourceErrors = {
  network: '无法连接该索引源',
  timeout: '读取索引超时',
  'too-large': '索引超过大小限制',
  'invalid-index': '索引内容格式不正确',
  'settings-unavailable': '索引源设置暂不可用',
};

export function MarketplaceSources({
  state,
  onSelect,
}: {
  readonly state: SourcesState;
  readonly onSelect: (id: string) => void;
}): ReactElement {
  const [expanded, setExpanded] = useState(false);
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const id = useId();
  const selected = state.selectedSource;
  const error = selected?.errorCode === undefined ? undefined : sourceErrors[selected.errorCode];
  return (
    <section className="marketplace-sources" aria-label="插件索引源管理">
      <div className="marketplace-source-toolbar">
        {state.sources === undefined ? null : (
          <label className="marketplace-source-picker">
            <Globe aria-hidden="true" />
            <span className="sr-only">插件索引源</span>
            <select
              aria-label="插件索引源"
              value={state.effectiveSourceId ?? ''}
              disabled={state.busy}
              onChange={(event) => onSelect(event.target.value)}
            >
              {state.sources.sources.map((source) => (
                <option key={source.id} value={source.id}>
                  {source.name}
                </option>
              ))}
            </select>
          </label>
        )}
        <button
          className="secondary-button"
          type="button"
          aria-expanded={expanded}
          aria-controls={`${id}-management`}
          onClick={() => setExpanded((value) => !value)}
        >
          <Settings2 aria-hidden="true" />
          管理索引源
        </button>
      </div>
      {selected?.url === null || selected === undefined ? null : (
        <p className="marketplace-source-url">{selected.url}</p>
      )}
      {selected?.status === 'unfetched' ? (
        <p className="marketplace-help" role="status">
          尚未读取该索引，请点击“刷新市场”获取插件目录。
        </p>
      ) : null}
      {selected?.status === 'unavailable' ? (
        <p className="marketplace-help" role="status">
          {error ?? '索引暂不可用'}。
          {selected.stale ? '正在显示上次成功读取的目录，请刷新重试。' : '请刷新重试。'}
        </p>
      ) : null}
      {state.catalogError && state.catalog !== undefined ? (
        <p className="marketplace-help" role="status">
          本次读取失败，正在显示上次成功读取的目录。
        </p>
      ) : null}
      {state.sourcesError ? (
        <p className="marketplace-help" role="status">
          无法读取索引源设置。
          <button type="button" className="marketplace-text-button" onClick={state.reloadSources}>
            重试读取索引源
          </button>
        </p>
      ) : null}
      {state.actionError ? (
        <p className="marketplace-help" role="alert">
          {state.actionError}
          <button type="button" className="marketplace-text-button" onClick={state.reloadSources}>
            重新读取设置
          </button>
        </p>
      ) : null}
      {expanded ? (
        <div id={`${id}-management`} className="marketplace-source-management">
          <p className="marketplace-help">
            添加你信任的 HTTPS 索引地址或 GitHub
            索引文件地址。目录收录不代表作者认证，安装前请核对具体来源。
          </p>
          <ul className="marketplace-source-list">
            {state.sources?.sources.map((source) => (
              <li key={source.id}>
                <div>
                  <strong>{source.name}</strong>
                  <span>
                    {source.url ?? (source.kind === 'builtin' ? 'Weave 随附目录' : '本地维护目录')}
                  </span>
                </div>
                {source.removable ? (
                  <button
                    className="icon-button"
                    type="button"
                    disabled={state.busy}
                    aria-label={`移除 ${source.name}`}
                    onClick={() => {
                      void state.removeSource(source.id);
                    }}
                  >
                    <Trash2 aria-hidden="true" />
                  </button>
                ) : (
                  <span className="marketplace-help">预置</span>
                )}
              </li>
            ))}
          </ul>
          <form
            className="marketplace-source-form"
            onSubmit={(event) => {
              event.preventDefault();
              void state.addSource({ name: name.trim(), url: url.trim() }).then((added) => {
                if (added) {
                  setName('');
                  setUrl('');
                }
              });
            }}
          >
            <label>
              索引源名称
              <input
                type="text"
                value={name}
                maxLength={300}
                required
                disabled={state.busy || state.sources === undefined}
                onChange={(event) => setName(event.target.value)}
                placeholder="例如：团队插件"
              />
            </label>
            <label>
              索引地址
              <input
                type="url"
                value={url}
                maxLength={2048}
                required
                disabled={state.busy || state.sources === undefined}
                onChange={(event) => setUrl(event.target.value)}
                placeholder="https://example.com/index.json"
              />
            </label>
            <button
              className="secondary-button"
              type="submit"
              disabled={
                state.busy || state.sources === undefined || name.trim() === '' || url.trim() === ''
              }
            >
              <Plus aria-hidden="true" />
              添加索引源
            </button>
          </form>
          <p className="marketplace-help">添加后手动刷新读取目录。移除索引源会保留已导入的插件。</p>
        </div>
      ) : null}
    </section>
  );
}
