import { Bot, FolderOpen, Search, Settings, ShieldCheck } from 'lucide-react';
import type { ReactElement } from 'react';

/** Static category sidebar shown next to the settings page. */
export function SettingsSidebar(): ReactElement {
  return (
    <aside className="settings-sidebar" aria-label="设置分类">
      <header className="settings-sidebar-header">
        <Settings aria-hidden="true" />
        <h2>设置</h2>
      </header>
      <div className="settings-sidebar-search">
        <Search aria-hidden="true" />
        <span>搜索设置</span>
      </div>
      <nav className="settings-sidebar-nav" aria-label="设置分类导航">
        <p className="settings-sidebar-label">配置</p>
        <button className="settings-sidebar-item settings-sidebar-item-active" type="button">
          <Bot aria-hidden="true" />
          <span>模型服务</span>
        </button>
        <button className="settings-sidebar-item" type="button" disabled>
          <ShieldCheck aria-hidden="true" />
          <span>运行权限</span>
          <small>即将推出</small>
        </button>
        <p className="settings-sidebar-label">系统</p>
        <button className="settings-sidebar-item" type="button" disabled>
          <FolderOpen aria-hidden="true" />
          <span>数据存储</span>
          <small>即将推出</small>
        </button>
        <button className="settings-sidebar-item" type="button" disabled>
          <Settings aria-hidden="true" />
          <span>界面外观</span>
          <small>即将推出</small>
        </button>
      </nav>
      <div className="settings-sidebar-footer">
        <span className="connection-dot" aria-hidden="true" />
        <span>本地运行时</span>
        <small>已连接</small>
      </div>
    </aside>
  );
}
