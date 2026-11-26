import { FolderCog, MessageSquarePlus, Pencil, Plus } from 'lucide-react';
import type { ReactElement } from 'react';

import type { StudioProject } from './app-types.js';

export type ProjectsViewProps = {
  readonly projects: readonly StudioProject[];
  readonly activeProjectId: string;
  /** True while the active session streams or has queued work; project actions are locked. */
  readonly sessionHasWork: boolean;
  readonly openProjectDialog: () => void;
  readonly openProject: (projectId: string) => void;
  readonly createSessionForProject: (projectId: string) => Promise<unknown>;
  readonly openProjectRename: (project: StudioProject) => void;
  readonly openFolderDialog: (project: StudioProject) => void;
};

/** The "项目" page: every local project with its management actions. */
export function ProjectsView({
  projects,
  activeProjectId,
  sessionHasWork,
  openProjectDialog,
  openProject,
  createSessionForProject,
  openProjectRename,
  openFolderDialog,
}: ProjectsViewProps): ReactElement {
  return (
    <>
      <header className="page-header">
        <div className="page-header-copy">
          <h2>项目</h2>
          <p>每个项目对应一个本地文件夹，Agent 只在该文件夹内读写文件。</p>
        </div>
        <div className="page-header-actions">
          <button className="primary-button" type="button" onClick={openProjectDialog}>
            <Plus aria-hidden="true" />
            创建项目
          </button>
        </div>
      </header>
      <div className="page-section-heading">
        <span>全部项目</span>
        <small>{projects.length} 个</small>
      </div>
      <div className="project-overview-list" aria-label="项目列表">
        {projects.map((project) => {
          const isActive = project.id === activeProjectId;
          const sessionCount = project.sessions.filter(
            (session) => session.archivedAt === null,
          ).length;
          return (
            <article
              className={`project-overview-item${isActive ? ' project-overview-item-active' : ''}`}
              key={project.id}
            >
              <button
                className="project-overview-main"
                type="button"
                aria-label={`打开项目 ${project.name}`}
                onClick={() => openProject(project.id)}
                disabled={sessionHasWork}
              >
                <span className="project-overview-avatar" aria-hidden="true">
                  {project.name.slice(0, 1).toLocaleUpperCase()}
                </span>
                <span className="project-overview-copy">
                  <span className="project-overview-title">
                    <strong>{project.name}</strong>
                    {isActive ? <span className="project-current-badge">当前</span> : null}
                  </span>
                  <span className="project-overview-path">
                    <small className="project-folder-name">
                      {project.folderPath ?? project.folderName}
                    </small>
                    {project.folderPath === undefined ? (
                      <small className="project-folder-missing">未设置文件夹路径</small>
                    ) : null}
                  </span>
                </span>
                <span className="project-overview-meta">{sessionCount} 个会话</span>
              </button>
              <div
                className="project-overview-actions"
                role="group"
                aria-label={`管理项目 ${project.name}`}
              >
                <button
                  className="project-action-button"
                  type="button"
                  aria-label={`在 ${project.name} 中新建会话`}
                  title="新建会话"
                  onClick={() => void createSessionForProject(project.id)}
                  disabled={sessionHasWork}
                >
                  <MessageSquarePlus aria-hidden="true" />
                </button>
                <button
                  className="project-action-button"
                  type="button"
                  aria-label={`重命名项目 ${project.name}`}
                  title="重命名"
                  onClick={() => openProjectRename(project)}
                  disabled={sessionHasWork}
                >
                  <Pencil aria-hidden="true" />
                </button>
                <button
                  className="project-action-button"
                  type="button"
                  aria-label={`设置项目 ${project.name} 的文件夹`}
                  title="设置文件夹"
                  onClick={() => openFolderDialog(project)}
                  disabled={sessionHasWork}
                >
                  <FolderCog aria-hidden="true" />
                </button>
              </div>
            </article>
          );
        })}
      </div>
    </>
  );
}
