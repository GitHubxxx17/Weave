import { Bot, FolderOpen, Search, Settings, ShieldCheck } from 'lucide-react';
import { useState, type ReactElement } from 'react';

import { filterSettingsCategories, type SettingsCategoryId } from './settings-categories.js';

const categoryIcons = {
  providers: Bot,
  permissions: ShieldCheck,
  storage: FolderOpen,
  appearance: Settings,
} as const;

export interface SettingsSidebarProps {
  readonly activeCategory: SettingsCategoryId;
  readonly onSelectCategory: (category: SettingsCategoryId) => void;
}

/** Category sidebar of the settings page, with a search box that filters the categories. */
export function SettingsSidebar({
  activeCategory,
  onSelectCategory,
}: SettingsSidebarProps): ReactElement {
  const [query, setQuery] = useState('');
  const categories = filterSettingsCategories(query);
  const groups = (['配置', '系统'] as const).filter((group) =>
    categories.some((category) => category.group === group),
  );

  return (
    <aside className="settings-sidebar" aria-label="设置分类">
      <header className="settings-sidebar-header">
        <Settings aria-hidden="true" />
        <h2>设置</h2>
      </header>
      <label className="settings-sidebar-search">
        <Search aria-hidden="true" />
        <input
          type="search"
          value={query}
          placeholder="搜索设置"
          aria-label="搜索设置"
          onChange={(event) => setQuery(event.target.value)}
        />
      </label>
      <nav className="settings-sidebar-nav" aria-label="设置分类导航">
        {groups.length === 0 ? <p className="settings-sidebar-empty">没有匹配的设置</p> : null}
        {groups.map((group) => (
          <div className="settings-sidebar-group" key={group}>
            <p className="settings-sidebar-label">{group}</p>
            {categories
              .filter((category) => category.group === group)
              .map((category) => {
                const Icon = categoryIcons[category.id];
                const active = category.id === activeCategory;
                return (
                  <button
                    key={category.id}
                    className={`settings-sidebar-item${active ? ' settings-sidebar-item-active' : ''}`}
                    type="button"
                    disabled={!category.available}
                    aria-current={active ? 'page' : undefined}
                    onClick={() => onSelectCategory(category.id)}
                  >
                    <Icon aria-hidden="true" />
                    <span>{category.label}</span>
                    {category.available ? null : <small>即将推出</small>}
                  </button>
                );
              })}
          </div>
        ))}
      </nav>
      <div className="settings-sidebar-footer">
        <span className="connection-dot" aria-hidden="true" />
        <span>本地运行时</span>
        <small>已连接</small>
      </div>
    </aside>
  );
}
