import { useEffect, useState, type ReactElement } from 'react';
import { Puzzle, RotateCw } from 'lucide-react';

import { PluginApiError, fetchPlugins } from './plugin-api.js';
import type { PluginListItem } from './plugin-types.js';

type LoadState =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly plugins: readonly PluginListItem[] }
  | { readonly status: 'error'; readonly message: string };

/** Display order of the plugin origins; origins the Server adds later follow these. */
const knownOrigins = ['builtin', 'registered', 'kernel'] as const;

const originLabels: Readonly<Record<string, string>> = {
  builtin: '内置',
  registered: '已注册',
  kernel: '扩展',
};

const capabilityLabels: Readonly<Record<string, string>> = {
  tool: '工具',
  'llm-provider': '模型提供方',
  prompt: '提示词',
};

const hostLabels: Readonly<Record<string, string>> = {
  mcp: 'MCP',
  subprocess: '子进程',
};

const permissionLabels: Readonly<Record<string, string>> = {
  'workspace:read': '读取工作区',
  'workspace:write': '写入工作区',
  'process:spawn': '运行进程',
  'network:request': '访问网络',
};

/** What a permission lets the plugin do, in words; unknown ones are shown as written. */
export function permissionLabel(permission: string): string {
  const known = permissionLabels[permission];
  if (known !== undefined) {
    return known;
  }
  return permission.startsWith('service:')
    ? `使用服务 ${permission.slice('service:'.length)}`
    : permission;
}

/** Groups plugins by origin: the known origins first, then any other in the order met. */
export function groupByOrigin(
  plugins: readonly PluginListItem[],
): readonly { readonly origin: string; readonly plugins: readonly PluginListItem[] }[] {
  const groups = new Map<string, PluginListItem[]>(knownOrigins.map((origin) => [origin, []]));
  for (const plugin of plugins) {
    const group = groups.get(plugin.origin);
    if (group === undefined) {
      groups.set(plugin.origin, [plugin]);
    } else {
      group.push(plugin);
    }
  }
  return [...groups.entries()]
    .filter(([, members]) => members.length > 0)
    .map(([origin, members]) => ({ origin, plugins: members }));
}

function NameTags({ names }: { readonly names: readonly string[] }): ReactElement {
  return (
    <>
      {names.map((name) => (
        <code key={name} className="plugin-tag">
          {name}
        </code>
      ))}
    </>
  );
}

function PluginItem({ plugin }: { readonly plugin: PluginListItem }): ReactElement {
  const provided: readonly (readonly [string, readonly string[]])[] = [
    ['工具', plugin.provides.tools],
    ['模型提供方', plugin.provides.providers],
    ['提示词片段', plugin.provides.promptSections],
    ['服务', plugin.provides.services],
  ];

  return (
    <li>
      <details className="plugin-item">
        <summary className="plugin-summary">
          <span className="plugin-name">{plugin.name}</span>
          <span className="plugin-version">v{plugin.version}</span>
          {plugin.host === 'in-process' ? null : (
            <span className="plugin-chip">{hostLabels[plugin.host] ?? plugin.host}</span>
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
                {plugin.capabilities.map((capability) => (
                  <span key={capability} className="plugin-chip">
                    {capabilityLabels[capability] ?? capability}
                  </span>
                ))}
              </dd>
            </div>
            {provided.map(([label, names]) =>
              names.length === 0 ? null : (
                <div key={label} className="plugin-fact">
                  <dt>{label}</dt>
                  <dd>
                    <NameTags names={names} />
                  </dd>
                </div>
              ),
            )}
            {plugin.permissions === undefined || plugin.permissions.length === 0 ? null : (
              <div className="plugin-fact">
                <dt>权限</dt>
                <dd>
                  {plugin.permissions.map((permission) => (
                    <span key={permission} className="plugin-chip">
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
        </div>
      </details>
    </li>
  );
}

/** The plugins loaded for the Agent, grouped by where they came from. */
export function PluginsPanel(): ReactElement {
  const [state, setState] = useState<LoadState>({ status: 'loading' });
  const [reloads, setReloads] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    fetchPlugins(controller.signal).then(
      (plugins) => {
        if (!controller.signal.aborted) {
          setState({ status: 'ready', plugins });
        }
      },
      (error: unknown) => {
        if (!controller.signal.aborted) {
          setState({
            status: 'error',
            message: error instanceof PluginApiError ? error.message : '读取插件列表失败',
          });
        }
      },
    );
    return () => controller.abort();
  }, [reloads]);

  const reload = (): void => {
    setState({ status: 'loading' });
    setReloads((count) => count + 1);
  };

  return (
    <div className="panel-body" role="region" aria-label="插件">
      <section className="overview-block">
        <div className="overview-block-heading">
          <h3>已加载的插件</h3>
          <span className="activity-state">
            {state.status === 'ready' ? `${String(state.plugins.length)} 个` : null}
          </span>
          <button
            type="button"
            className="icon-button"
            aria-label="刷新插件列表"
            title="刷新"
            onClick={reload}
          >
            <RotateCw aria-hidden="true" />
          </button>
        </div>
        {state.status === 'loading' ? (
          <p className="activity-state" role="status">
            正在读取插件…
          </p>
        ) : null}
        {state.status === 'error' ? (
          <p className="error-message" role="alert">
            {state.message}
          </p>
        ) : null}
        {state.status === 'ready' && state.plugins.length === 0 ? (
          <div className="activity-empty">
            <span className="activity-empty-icon" aria-hidden="true">
              <Puzzle aria-hidden="true" />
            </span>
            <p>当前没有已加载的插件，Agent 创建后才会列出。</p>
          </div>
        ) : null}
        {state.status === 'ready'
          ? groupByOrigin(state.plugins).map((group) => (
              <div key={group.origin} className="plugin-group">
                <h4 className="plugin-group-title">
                  {originLabels[group.origin] ?? group.origin}
                  <span className="activity-state"> {String(group.plugins.length)}</span>
                </h4>
                <ul className="plugin-list">
                  {group.plugins.map((plugin) => (
                    <PluginItem key={plugin.id} plugin={plugin} />
                  ))}
                </ul>
              </div>
            ))
          : null}
      </section>
    </div>
  );
}
