import { Archive, FolderOpen, RotateCcw, Trash2 } from 'lucide-react';
import type { ReactElement } from 'react';

import { formatMessageTime } from './app-helpers.js';
import type { StudioProject } from './app-types.js';
import type { SessionToDelete } from './use-session-lifecycle.js';

export type ArchivedViewProps = {
  readonly archivedProjects: readonly StudioProject[];
  /** True while the active session streams or has queued work; actions are locked. */
  readonly sessionHasWork: boolean;
  readonly restoreSession: (projectId: string, sessionId: string) => Promise<void>;
  readonly setSessionToDelete: (session: SessionToDelete) => void;
};

/** The "归档" page: archived sessions grouped by project. */
export function ArchivedView({
  archivedProjects,
  sessionHasWork,
  restoreSession,
  setSessionToDelete,
}: ArchivedViewProps): ReactElement {
  return (
    <>
      <header className="page-header">
        <div className="page-header-copy">
          <h2>归档</h2>
          <p>归档会话不会出现在项目树中，可以恢复或删除。</p>
        </div>
      </header>
      <div className="archive-overview-list" aria-label="归档会话列表">
        {archivedProjects.length > 0 ? (
          archivedProjects.map((project) => (
            <section className="archive-project-section" key={project.id}>
              <div className="archive-project-heading">
                <FolderOpen aria-hidden="true" />
                <strong>{project.name}</strong>
                <small>{project.sessions.length} 个归档会话</small>
              </div>
              <div className="archive-session-list">
                {project.sessions.map((session) => (
                  <article className="archive-session-item" key={session.id}>
                    <div>
                      <strong>{session.title}</strong>
                      <small>
                        {session.archivedAt === null
                          ? '已归档'
                          : `归档于 ${formatMessageTime(session.archivedAt)}`}
                      </small>
                    </div>
                    <div className="archive-session-actions">
                      <button
                        className="secondary-button"
                        type="button"
                        aria-label={`恢复会话 ${session.title}`}
                        onClick={() => void restoreSession(project.id, session.id)}
                        disabled={sessionHasWork}
                      >
                        <RotateCcw aria-hidden="true" />
                        恢复
                      </button>
                      <button
                        className="danger-button"
                        type="button"
                        aria-label={`删除会话 ${session.title}`}
                        onClick={() =>
                          setSessionToDelete({
                            projectId: project.id,
                            sessionId: session.id,
                            title: session.title,
                          })
                        }
                        disabled={sessionHasWork}
                      >
                        <Trash2 aria-hidden="true" />
                        删除
                      </button>
                    </div>
                  </article>
                ))}
              </div>
            </section>
          ))
        ) : (
          <div className="page-empty">
            <span className="page-empty-icon" aria-hidden="true">
              <Archive />
            </span>
            <strong>暂无归档会话</strong>
            <p>在左侧会话列表中归档的会话会显示在这里。</p>
          </div>
        )}
      </div>
    </>
  );
}
