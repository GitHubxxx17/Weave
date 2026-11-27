import { FolderOpen, RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useState, type ReactElement } from 'react';

import {
  fetchStorageSettings,
  StorageApiError,
  type StorageLocation,
  type StorageSettings,
} from '../features/settings/storage-api.js';

const locationNames: Readonly<Record<string, { readonly name: string; readonly hint: string }>> = {
  database: { name: '主数据库', hint: '会话、项目、模型服务配置，以及 MCP 与插件授权' },
  memory: { name: '记忆库', hint: '长期记忆' },
  retrieval: { name: '检索索引', hint: '工作区检索使用的索引' },
  pluginMarketplaceSources: { name: '插件市场来源', hint: '已添加的插件市场来源设置' },
  plugins: { name: '插件目录', hint: '本地与已安装的插件' },
  skills: { name: '技能目录', hint: '用户自定义技能' },
};

const errorLabels = {
  'permission-denied': '无权限读取',
  'read-failed': '读取失败',
  'kind-mismatch': '类型与预期不符',
} as const;

/** Formats a byte count with binary units, for example `12.4 MB`. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}

function describeSize(location: StorageLocation): string {
  if (location.error !== undefined) return errorLabels[location.error];
  if (!location.exists || location.sizeBytes === null) return '尚未创建';
  const size = formatBytes(location.sizeBytes);
  return location.truncated ? `至少 ${size}` : size;
}

type LoadState =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly data: StorageSettings }
  | { readonly status: 'local-only' }
  | { readonly status: 'error'; readonly message: string };

/** Read-only view of where Weave keeps its data on this computer. */
export function StorageSettingsView(): ReactElement {
  const [state, setState] = useState<LoadState>({ status: 'loading' });
  const [reloadKey, setReloadKey] = useState(0);
  const [openError, setOpenError] = useState<string | null>(null);
  const openDataDirectory = window.weaveDesktop?.openDataDirectory;

  useEffect(() => {
    const controller = new AbortController();
    setState({ status: 'loading' });
    fetchStorageSettings(controller.signal).then(
      (data) => {
        if (!controller.signal.aborted) setState({ status: 'ready', data });
      },
      (error: unknown) => {
        if (controller.signal.aborted) return;
        if (error instanceof StorageApiError && error.code === 'storage-local-only') {
          setState({ status: 'local-only' });
        } else {
          setState({
            status: 'error',
            message: error instanceof StorageApiError ? error.message : '存储位置暂时不可用',
          });
        }
      },
    );
    return () => controller.abort();
  }, [reloadKey]);

  const refresh = useCallback(() => setReloadKey((key) => key + 1), []);

  const openDirectory = useCallback(async () => {
    if (openDataDirectory === undefined) return;
    setOpenError(null);
    try {
      const result = await openDataDirectory();
      if (!result.ok) setOpenError(result.error ?? '无法打开数据目录');
    } catch {
      setOpenError('无法打开数据目录');
    }
  }, [openDataDirectory]);

  return (
    <div className="storage-settings-view">
      <div className="product-view-heading">
        <div>
          <p>系统</p>
          <h2>数据存储</h2>
          <span>查看 Weave 把数据保存在这台电脑的哪些位置。此页面只读。</span>
        </div>
        <button
          className="secondary-button"
          type="button"
          onClick={refresh}
          disabled={state.status === 'loading'}
        >
          <RefreshCw aria-hidden="true" />
          刷新
        </button>
      </div>

      {state.status === 'loading' ? (
        <p className="storage-settings-status" role="status">
          正在读取存储位置…
        </p>
      ) : null}
      {state.status === 'local-only' ? (
        <p className="storage-settings-status" role="alert">
          出于安全考虑，存储位置只能在运行 Weave 的这台电脑上查看
        </p>
      ) : null}
      {state.status === 'error' ? (
        <p className="storage-settings-status storage-settings-status-error" role="alert">
          {state.message}
        </p>
      ) : null}

      {state.status === 'ready' ? (
        <>
          <section className="storage-settings-root" aria-label="数据目录">
            <div className="storage-settings-root-copy">
              <strong>数据目录</strong>
              <code className="storage-settings-path">{state.data.dataDirectory}</code>
            </div>
            {openDataDirectory === undefined ? null : (
              <button
                className="secondary-button"
                type="button"
                onClick={() => void openDirectory()}
              >
                <FolderOpen aria-hidden="true" />
                打开数据目录
              </button>
            )}
          </section>
          {openError === null ? null : (
            <p className="storage-settings-status storage-settings-status-error" role="alert">
              {openError}
            </p>
          )}
          <ul className="storage-settings-list" aria-label="存储位置">
            {state.data.locations.map((location) => {
              const names = locationNames[location.id];
              const problem = location.error !== undefined || !location.exists;
              return (
                <li className="storage-settings-item" key={location.id}>
                  <div className="storage-settings-item-copy">
                    <strong>{names?.name ?? location.id}</strong>
                    {names === undefined ? null : <span>{names.hint}</span>}
                    <code className="storage-settings-path">{location.path}</code>
                  </div>
                  <span
                    className={`storage-settings-size${problem ? ' storage-settings-size-muted' : ''}`}
                  >
                    {describeSize(location)}
                  </span>
                </li>
              );
            })}
          </ul>
        </>
      ) : null}
    </div>
  );
}
