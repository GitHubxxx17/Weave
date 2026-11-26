import {
  Archive,
  BookOpen,
  FolderKanban,
  History,
  Puzzle,
  Search,
  Settings,
  Sparkles,
} from 'lucide-react';
import type { ReactElement } from 'react';

import { PluginPendingBadge } from '../features/plugins/plugin-catalog-context.js';
import type { ProductView } from './app-types.js';

export type WorkspaceNavProps = {
  readonly activeView: ProductView;
  readonly onSelectView: (view: ProductView) => void;
};

/** Left-most product navigation column. */
export function WorkspaceNav({ activeView, onSelectView }: WorkspaceNavProps): ReactElement {
  return (
    <aside className="workspace-nav" aria-label="工作区导航">
      <span className="brand-mark" aria-hidden="true">
        W
      </span>
      <nav className="workspace-nav-list" aria-label="主导航">
        <button
          className={`workspace-nav-button${activeView === 'studio' ? ' workspace-nav-button-active' : ''}`}
          type="button"
          aria-current={activeView === 'studio' ? 'page' : undefined}
          onClick={() => onSelectView('studio')}
        >
          <Sparkles aria-hidden="true" />
          <small>工作台</small>
        </button>
        <button
          className={`workspace-nav-button${activeView === 'projects' ? ' workspace-nav-button-active' : ''}`}
          type="button"
          aria-current={activeView === 'projects' ? 'page' : undefined}
          onClick={() => onSelectView('projects')}
        >
          <FolderKanban aria-hidden="true" />
          <small>项目</small>
        </button>
        <button
          className={`workspace-nav-button${activeView === 'retrieval' ? ' workspace-nav-button-active' : ''}`}
          type="button"
          aria-current={activeView === 'retrieval' ? 'page' : undefined}
          onClick={() => onSelectView('retrieval')}
        >
          <Search aria-hidden="true" />
          <small>搜索</small>
        </button>
        <button
          className={`workspace-nav-button workspace-nav-marketplace${activeView === 'marketplace' ? ' workspace-nav-button-active' : ''}`}
          type="button"
          aria-label="插件市场"
          aria-current={activeView === 'marketplace' ? 'page' : undefined}
          data-plugin-navigation=""
          onClick={() => onSelectView('marketplace')}
        >
          <Puzzle aria-hidden="true" />
          <small>插件市场</small>
          <PluginPendingBadge />
        </button>
        <button
          className={`workspace-nav-button${activeView === 'memory' ? ' workspace-nav-button-active' : ''}`}
          type="button"
          aria-current={activeView === 'memory' ? 'page' : undefined}
          onClick={() => onSelectView('memory')}
        >
          <BookOpen aria-hidden="true" />
          <small>记忆</small>
        </button>
        <button
          className={`workspace-nav-button${activeView === 'history' ? ' workspace-nav-button-active' : ''}`}
          type="button"
          aria-current={activeView === 'history' ? 'page' : undefined}
          onClick={() => onSelectView('history')}
        >
          <History aria-hidden="true" />
          <small>历史</small>
        </button>
        <button
          className={`workspace-nav-button${activeView === 'archived' ? ' workspace-nav-button-active' : ''}`}
          type="button"
          aria-current={activeView === 'archived' ? 'page' : undefined}
          onClick={() => onSelectView('archived')}
        >
          <Archive aria-hidden="true" />
          <small>归档</small>
        </button>
      </nav>
      <button
        className={`workspace-nav-button workspace-nav-settings${activeView === 'settings' ? ' workspace-nav-button-active' : ''}`}
        type="button"
        aria-current={activeView === 'settings' ? 'page' : undefined}
        onClick={() => onSelectView('settings')}
      >
        <Settings aria-hidden="true" />
        <small>设置</small>
      </button>
    </aside>
  );
}
