import { useEffect, useRef, useState } from 'react';
import { getAgentTaskTree, observeAgentTaskTree, stopAgentTask } from './task-api.js';
import type { AgentTaskTreeSnapshot, AgentTaskView } from './task-types.js';

interface TaskObserverState {
  readonly root: string;
  readonly controller: AbortController;
  readonly pending: Set<string>;
  snapshot?: AgentTaskTreeSnapshot;
  tasks?: readonly AgentTaskView[];
  nextCursor?: string | undefined;
  error?: string | undefined;
  reconnecting?: boolean;
  loadingPage?: boolean;
  observed: boolean;
}

interface TaskStopAttempt {
  readonly operationId: string;
}

const noTasks: readonly AgentTaskView[] = [];
const noStops: ReadonlySet<string> = new Set();
export const stopAllTasksKey = 'all';

export function useAgentTasks(root: string) {
  const observer = useRef<TaskObserverState | undefined>(undefined);
  const stopAttempts = useRef(new Map<string, TaskStopAttempt>());
  const [view, setView] = useState<TaskObserverState>();

  function isCurrent(owner: TaskObserverState): boolean {
    return observer.current === owner && !owner.controller.signal.aborted;
  }

  function publish(owner: TaskObserverState): void {
    if (isCurrent(owner)) setView({ ...owner, pending: new Set(owner.pending) });
  }

  function apply(owner: TaskObserverState, snapshot: AgentTaskTreeSnapshot): void {
    const previous = owner.snapshot;
    if (previous?.epoch === snapshot.epoch && previous.revision >= snapshot.revision) return;
    owner.snapshot = snapshot;
    owner.tasks = snapshot.tasks;
    owner.nextCursor = snapshot.nextCursor;
    publish(owner);
  }

  useEffect(() => {
    if (root === '') return;
    const owner: TaskObserverState = {
      root,
      controller: new AbortController(),
      pending: new Set(),
      observed: false,
    };
    observer.current = owner;
    publish(owner);
    const { signal } = owner.controller;
    void observeAgentTaskTree(
      root,
      (snapshot) => {
        if (!isCurrent(owner) || snapshot.rootSessionId !== root) return;
        owner.observed = true;
        const previous = owner.snapshot;
        if (previous?.epoch === snapshot.epoch && previous.revision >= snapshot.revision) return;
        owner.error = undefined;
        apply(owner, snapshot);
      },
      signal,
      (state) => {
        owner.reconnecting = state === 'reconnecting';
        publish(owner);
      },
    ).catch(() => {
      // A Server without the task feature may still serve ordinary Sessions.
      if (owner.snapshot === undefined) return;
      owner.error = '任务更新已断开';
      publish(owner);
    });
    void getAgentTaskTree(root, { signal })
      .then((snapshot) => {
        if (isCurrent(owner) && !owner.observed) apply(owner, snapshot);
      })
      .catch(() => undefined);
    return () => {
      if (observer.current === owner) observer.current = undefined;
      owner.controller.abort();
    };
  }, [root]);

  async function loadMore(): Promise<void> {
    const owner = observer.current;
    const base = owner?.snapshot;
    if (
      owner?.root !== root ||
      base === undefined ||
      owner.nextCursor === undefined ||
      owner.loadingPage === true
    )
      return;
    owner.loadingPage = true;
    owner.error = undefined;
    publish(owner);
    try {
      const page = await getAgentTaskTree(root, {
        cursor: owner.nextCursor,
        signal: owner.controller.signal,
      });
      if (!isCurrent(owner) || owner.snapshot !== base) return;
      if (page.epoch !== base.epoch || page.revision !== base.revision)
        throw new Error('任务列表已更新');
      const previous = owner.tasks ?? noTasks;
      const known = new Set(previous.map(({ taskId }) => taskId));
      owner.tasks = [...previous, ...page.tasks.filter(({ taskId }) => !known.has(taskId))];
      owner.nextCursor = page.nextCursor;
    } catch {
      if (!isCurrent(owner) || owner.snapshot !== base) return;
      try {
        const fresh = await getAgentTaskTree(root, { signal: owner.controller.signal });
        if (isCurrent(owner) && owner.snapshot === base) apply(owner, fresh);
      } catch {
        if (isCurrent(owner)) owner.error = '无法刷新任务，请重试';
      }
    } finally {
      owner.loadingPage = false;
      publish(owner);
    }
  }

  async function stop(taskId?: string): Promise<void> {
    const owner = observer.current;
    const key = taskId ?? stopAllTasksKey;
    if (owner?.root !== root || owner.pending.has(key)) return;
    const operationKey = JSON.stringify([root, key]);
    const attempt: TaskStopAttempt = {
      operationId: stopAttempts.current.get(operationKey)?.operationId ?? crypto.randomUUID(),
    };
    stopAttempts.current.set(operationKey, attempt);
    owner.pending.add(key);
    owner.error = undefined;
    publish(owner);
    try {
      await stopAgentTask(root, taskId, attempt.operationId);
      if (stopAttempts.current.get(operationKey) === attempt)
        stopAttempts.current.delete(operationKey);
    } catch {
      owner.error = '停止请求未确认，可再次点击停止';
    } finally {
      owner.pending.delete(key);
      publish(owner);
    }
  }

  const current =
    view?.root === root && view.controller === observer.current?.controller ? view : undefined;
  return {
    snapshot: current?.snapshot,
    tasks: current?.tasks ?? noTasks,
    nextCursor: current?.nextCursor,
    error: current?.error,
    reconnecting: current?.reconnecting === true,
    pending: current?.pending ?? noStops,
    loadingPage: current?.loadingPage === true,
    loadMore,
    stop,
  };
}
