import { Copy, MoreHorizontal, PanelRightOpen, Square, Trash2 } from 'lucide-react';
import type { ReactElement } from 'react';

import type { useAgentTasks } from '../features/tasks/use-agent-tasks.js';
import { isSettledTask } from '../features/tasks/task-panel.js';
import type { OpenMenu, StudioProject, StudioSession } from './app-types.js';

type AgentTaskState = ReturnType<typeof useAgentTasks>;

export type ChatHeaderProps = {
  readonly activeProject: StudioProject | undefined;
  readonly activeProjectId: string;
  readonly activeSession: StudioSession | undefined;
  readonly activeSessionId: string;
  readonly activeTaskRoot: string;
  readonly activeChildTask: AgentTaskState['tasks'][number] | undefined;
  readonly taskState: Pick<AgentTaskState, 'pending' | 'stop'>;
  readonly openMenu: OpenMenu;
  readonly isActivityPanelOpen: boolean;
  readonly setIsActivityPanelOpen: (open: boolean) => void;
  readonly toggleMenu: (menu: Exclude<OpenMenu, null>) => void;
  readonly showNotice: (message: string) => void;
  readonly clearActiveRunState: () => void;
  readonly selectProjectSession: (projectId: string, sessionId: string) => void;
};

/** Breadcrumb, child-task stop, session menu and context-panel toggle. */
export function ChatHeader({
  activeProject,
  activeProjectId,
  activeSession,
  activeSessionId,
  activeTaskRoot,
  activeChildTask,
  taskState,
  openMenu,
  isActivityPanelOpen,
  setIsActivityPanelOpen,
  toggleMenu,
  showNotice,
  clearActiveRunState,
  selectProjectSession,
}: ChatHeaderProps): ReactElement {
  return (
    <header className="chat-header">
      <div className="breadcrumb">
        <span>{activeProject?.folderName ?? 'weave'}</span>
        <span className="breadcrumb-divider" aria-hidden="true">
          /
        </span>
        {activeSession?.taskOrigin !== undefined ? (
          <>
            <button
              className="task-parent-link"
              type="button"
              onClick={() => selectProjectSession(activeProjectId, activeTaskRoot)}
            >
              返回父会话
            </button>
            <span className="breadcrumb-divider" aria-hidden="true">
              /
            </span>
          </>
        ) : null}
        <strong>{activeSession?.title ?? '未命名会话'}</strong>
      </div>
      <div className="header-actions">
        {activeChildTask !== undefined && !isSettledTask(activeChildTask) ? (
          <button
            className="icon-button"
            type="button"
            aria-label="停止子任务"
            title="停止子任务"
            disabled={
              taskState.pending.has(activeChildTask.taskId) ||
              activeChildTask.status === 'cancelling'
            }
            onClick={() => void taskState.stop(activeChildTask.taskId)}
          >
            <Square aria-hidden="true" />
          </button>
        ) : null}
        <div className={`menu-anchor${openMenu === 'more' ? ' menu-anchor-open' : ''}`}>
          <button
            className="icon-button"
            type="button"
            aria-label="更多操作"
            title="更多操作"
            aria-expanded={openMenu === 'more'}
            onClick={() => toggleMenu('more')}
          >
            <MoreHorizontal aria-hidden="true" />
          </button>
          {openMenu === 'more' ? (
            <div className="popup-menu popup-menu-right" role="menu" aria-label="会话操作">
              <button
                type="button"
                role="menuitem"
                onClick={() => showNotice(`会话标识：${activeSessionId}`)}
              >
                <span className="menu-icon">
                  <Copy aria-hidden="true" />
                </span>
                复制会话标识
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  clearActiveRunState();
                  showNotice('运行状态已清空');
                }}
              >
                <span className="menu-icon">
                  <Trash2 aria-hidden="true" />
                </span>
                清空运行状态
              </button>
            </div>
          ) : null}
        </div>
        {!isActivityPanelOpen ? (
          <button
            className="icon-button"
            type="button"
            aria-label="显示上下文"
            title="显示上下文"
            onClick={() => setIsActivityPanelOpen(true)}
          >
            <PanelRightOpen aria-hidden="true" />
          </button>
        ) : null}
      </div>
    </header>
  );
}
