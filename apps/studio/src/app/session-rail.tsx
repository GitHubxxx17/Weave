import {
  Archive,
  ChevronDown,
  ChevronRight,
  FolderOpen,
  Pencil,
  Plus,
  Search,
  X,
} from 'lucide-react';
import type { ReactElement } from 'react';

import type { OpenMenu, ProductView, StudioProject } from './app-types.js';

export type SessionRailProps = {
  readonly activeView: ProductView;
  readonly openMenu: OpenMenu;
  readonly projects: readonly StudioProject[];
  readonly visibleProjects: readonly StudioProject[];
  readonly activeProject: StudioProject | undefined;
  readonly activeProjectId: string;
  readonly activeSessionId: string;
  readonly expandedProjectIds: readonly string[];
  readonly normalizedSearchQuery: string;
  readonly isSearchOpen: boolean;
  readonly searchQuery: string;
  readonly setIsSearchOpen: (open: boolean) => void;
  readonly setSearchQuery: (query: string) => void;
  readonly isSessionStreaming: (sessionId: string) => boolean;
  readonly toggleMenu: (menu: Exclude<OpenMenu, null>) => void;
  readonly selectProject: (projectId: string) => void;
  readonly openFolderDialog: (project: StudioProject) => void;
  readonly openProjectDialog: () => void;
  readonly createSession: () => Promise<void>;
  readonly toggleProjectExpanded: (projectId: string) => void;
  readonly selectProjectSession: (projectId: string, sessionId: string) => void;
  readonly openSessionEditor: (projectId: string, sessionId: string) => void;
  readonly archiveSession: (projectId: string, sessionId: string) => Promise<void>;
};

/** Project switcher, session search and the project/session tree. */
export function SessionRail({
  activeView,
  openMenu,
  projects,
  visibleProjects,
  activeProject,
  activeProjectId,
  activeSessionId,
  expandedProjectIds,
  normalizedSearchQuery,
  isSearchOpen,
  searchQuery,
  setIsSearchOpen,
  setSearchQuery,
  isSessionStreaming,
  toggleMenu,
  selectProject,
  openFolderDialog,
  openProjectDialog,
  createSession,
  toggleProjectExpanded,
  selectProjectSession,
  openSessionEditor,
  archiveSession,
}: SessionRailProps): ReactElement {
  return (
    <aside
      className="session-rail"
      aria-label="会话列表"
      hidden={activeView === 'marketplace' || activeView === 'memory' || activeView === 'retrieval'}
      inert={activeView === 'marketplace' || activeView === 'memory' || activeView === 'retrieval'}
    >
      <div className={`menu-anchor${openMenu === 'project' ? ' menu-anchor-open' : ''}`}>
        <button
          className="project-switcher"
          type="button"
          aria-label={`${activeProject?.name ?? '当前'} 项目`}
          aria-expanded={openMenu === 'project'}
          onClick={() => toggleMenu('project')}
        >
          <span className="project-avatar" aria-hidden="true">
            {(activeProject?.name ?? 'W').slice(0, 1).toLocaleUpperCase()}
          </span>
          <span className="project-switcher-copy">
            <small>当前项目</small>
            <strong>{activeProject?.name ?? 'Weave'}</strong>
            <span className="project-folder-name">{activeProject?.folderName ?? 'weave'}</span>
          </span>
          <span className="project-chevron" aria-hidden="true">
            <ChevronDown aria-hidden="true" />
          </span>
        </button>
        {openMenu === 'project' ? (
          <div
            className="popup-menu popup-menu-rail project-menu"
            role="menu"
            aria-label="切换项目"
          >
            <p className="menu-section-label">项目</p>
            {projects.map((project) => (
              <button
                type="button"
                role="menuitem"
                key={project.id}
                onClick={() => selectProject(project.id)}
              >
                <span className="menu-icon">
                  <FolderOpen aria-hidden="true" />
                </span>
                <span>
                  <strong>{project.name}</strong>
                  <small>{project.folderName}</small>
                </span>
              </button>
            ))}
            <div className="menu-divider" />
            {activeProject === undefined ? null : (
              <button type="button" role="menuitem" onClick={() => openFolderDialog(activeProject)}>
                <span className="menu-icon">
                  <FolderOpen aria-hidden="true" />
                </span>
                <span>
                  <strong>设置文件夹</strong>
                  <small>{activeProject.folderPath ?? '未设置，Agent 不能读写文件'}</small>
                </span>
              </button>
            )}
            <button type="button" role="menuitem" onClick={openProjectDialog}>
              <span className="menu-icon menu-icon-accent">
                <Plus aria-hidden="true" />
              </span>
              创建项目
            </button>
          </div>
        ) : null}
      </div>
      <button className="new-session-button" type="button" onClick={() => void createSession()}>
        <Plus aria-hidden="true" />
        新建会话
      </button>
      {isSearchOpen ? (
        <div className="session-search">
          <Search aria-hidden="true" />
          <input
            type="search"
            aria-label="搜索会话"
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
            autoFocus
          />
          <button
            type="button"
            aria-label="关闭搜索"
            onClick={() => {
              setIsSearchOpen(false);
              setSearchQuery('');
            }}
          >
            <X aria-hidden="true" />
          </button>
        </div>
      ) : (
        <button className="search-sessions" type="button" onClick={() => setIsSearchOpen(true)}>
          <Search aria-hidden="true" />
          搜索会话
          <kbd>⌘ K</kbd>
        </button>
      )}
      <nav className="project-tree" aria-label="项目树" role="tree">
        <p className="section-label">项目</p>
        {visibleProjects.map((project) => {
          const isExpanded =
            normalizedSearchQuery !== '' || expandedProjectIds.includes(project.id);

          return (
            <div className="project-tree-node" role="treeitem" key={project.id}>
              <div className="project-tree-row">
                <button
                  className="project-tree-toggle"
                  type="button"
                  aria-label={`${isExpanded ? '收起' : '展开'}项目 ${project.name}`}
                  aria-expanded={isExpanded}
                  onClick={() => toggleProjectExpanded(project.id)}
                >
                  {isExpanded ? (
                    <ChevronDown aria-hidden="true" />
                  ) : (
                    <ChevronRight aria-hidden="true" />
                  )}
                </button>
                <button
                  className="project-tree-project"
                  type="button"
                  aria-label={`项目：${project.name}`}
                  onClick={() => selectProject(project.id)}
                >
                  <FolderOpen aria-hidden="true" />
                  <span>
                    <strong>{project.name}</strong>
                    <small>{project.folderName}</small>
                  </span>
                  <small className="project-session-count">{project.sessions.length} 个会话</small>
                </button>
              </div>
              {isExpanded ? (
                <div className="project-tree-sessions" role="group">
                  {project.sessions.length > 0 ? (
                    project.sessions.map((session) => (
                      <div
                        className={`session-tree-item${session.id === activeSessionId && project.id === activeProjectId ? ' session-tree-item-active' : ''}`}
                        key={session.id}
                      >
                        <button
                          className="session-item"
                          type="button"
                          aria-label={`会话：${session.title}`}
                          onClick={() => selectProjectSession(project.id, session.id)}
                        >
                          <span>
                            <strong>{session.title}</strong>
                            <small>{session.lastUsedLabel}</small>
                          </span>
                        </button>
                        {isSessionStreaming(session.id) ? (
                          <span
                            className="session-running-dot"
                            aria-label="运行中"
                            title="运行中"
                          />
                        ) : session.id === activeSessionId && project.id === activeProjectId ? (
                          <span className="session-dot" aria-hidden="true" />
                        ) : null}
                        <div className="session-actions" role="group" aria-label="会话操作">
                          <button
                            className="session-action-button"
                            type="button"
                            aria-label="编辑会话"
                            title="编辑会话标题"
                            onClick={() => openSessionEditor(project.id, session.id)}
                            disabled={isSessionStreaming(session.id)}
                          >
                            <Pencil aria-hidden="true" />
                          </button>
                          <button
                            className="session-action-button session-action-button-danger"
                            type="button"
                            aria-label="归档会话"
                            title="归档会话"
                            onClick={() => void archiveSession(project.id, session.id)}
                            disabled={isSessionStreaming(session.id)}
                          >
                            <Archive aria-hidden="true" />
                          </button>
                        </div>
                      </div>
                    ))
                  ) : (
                    <p className="session-empty">暂无聊天</p>
                  )}
                </div>
              ) : null}
            </div>
          );
        })}
        {visibleProjects.length === 0 ? <p className="session-empty">没有匹配的会话</p> : null}
      </nav>
      <div className="rail-footer">
        <span className="connection-dot" aria-hidden="true" />
        <span>本地运行时</span>
        <small>已连接</small>
      </div>
    </aside>
  );
}
