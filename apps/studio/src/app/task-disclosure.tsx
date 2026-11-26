import type { ReactElement } from 'react';

import { AgentTaskPanel } from '../features/tasks/task-panel.js';
import type { AgentTaskView } from '../features/tasks/task-types.js';
import type { useAgentTasks } from '../features/tasks/use-agent-tasks.js';
import type { TaskTranscriptTarget } from './app-types.js';

export type TaskDisclosureProps = {
  readonly activeTaskRoot: string;
  readonly taskState: ReturnType<typeof useAgentTasks>;
  readonly openAgentTask: (task: AgentTaskView, target?: TaskTranscriptTarget) => Promise<void>;
  readonly prepareTaskDraft: (prompt: string, access: AgentTaskView['access']) => void;
};

/** Collapsible list of parallel child tasks under the chat header. */
export function TaskDisclosure({
  activeTaskRoot,
  taskState,
  openAgentTask,
  prepareTaskDraft,
}: TaskDisclosureProps): ReactElement {
  return (
    <details className="task-disclosure" key={activeTaskRoot}>
      <summary>
        并行子任务
        {taskState.snapshot === undefined ? '' : `（${taskState.snapshot.totalCount}）`}
        {taskState.tasks.some((task) => task.pendingApprovalCount > 0) ? ' · 有待审批' : ''}
        {taskState.reconnecting && taskState.snapshot !== undefined ? ' · 正在重连…' : ''}
      </summary>
      <AgentTaskPanel
        tasks={taskState.tasks}
        pending={taskState.pending}
        totalCount={taskState.snapshot?.totalCount}
        loadingPage={taskState.loadingPage}
        hasMore={taskState.nextCursor !== undefined}
        onLoadMore={() => void taskState.loadMore()}
        onStop={(taskId) => void taskState.stop(taskId)}
        onOpen={(task, result) =>
          void openAgentTask(
            task,
            result === undefined ? undefined : { sessionId: task.childSessionId, result },
          )
        }
        error={taskState.error}
        onPrepare={prepareTaskDraft}
      />
    </details>
  );
}
