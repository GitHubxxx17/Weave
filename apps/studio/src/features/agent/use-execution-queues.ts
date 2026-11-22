import { useEffect, useRef, useState } from 'react';
import {
  cancelQueuedExecution,
  getExecutionQueue,
  observeExecutionQueue,
  reorderExecutionQueue,
} from './agent-queue-client.js';
import { AgentStreamError } from './agent-stream.js';
import type {
  AgentExecutionQueueSnapshot,
  AgentExecutionSummary,
} from './agent-execution-types.js';

/** Session metadata observers never launch or cancel an active execution. */
export function useExecutionQueues(options: {
  readonly activeSessionId: string;
  readonly activeProjectId: string;
  readonly onActive: (
    projectId: string,
    sessionId: string,
    execution: AgentExecutionSummary,
  ) => void;
  readonly onNotice: (message: string) => void;
}) {
  const latest = useRef(options);
  latest.current = options;
  const [states, setStates] = useState<Record<string, AgentExecutionQueueSnapshot>>({});
  const stateRef = useRef(new Map<string, AgentExecutionQueueSnapshot>());
  const observers = useRef(new Map<string, { controller: AbortController; projectId: string }>());
  const [pending, setPending] = useState<Record<string, boolean>>({});
  const controls = useRef(new Map<string, AbortController>());
  const apply = (projectId: string, state: AgentExecutionQueueSnapshot): void => {
    const previous = stateRef.current.get(state.sessionId);
    const [epoch, , sequence] = state.cursor.split(':');
    const [previousEpoch, , previousSequence] = previous?.cursor.split(':') ?? [];
    if (epoch === previousEpoch && Number(sequence) < Number(previousSequence)) return;
    stateRef.current.set(state.sessionId, state);
    setStates((current) => ({ ...current, [state.sessionId]: state }));
    if (state.active !== null) latest.current.onActive(projectId, state.sessionId, state.active);
  };
  async function refresh(projectId: string, sessionId: string): Promise<void> {
    const observer = observers.current.get(sessionId);
    const before = stateRef.current.get(sessionId);
    const state = await getExecutionQueue(sessionId);
    const current = stateRef.current.get(sessionId);
    if (
      observer !== undefined &&
      observers.current.get(sessionId) === observer &&
      !observer.controller.signal.aborted &&
      (current === before || current?.cursor.split(':')[0] === state.cursor.split(':')[0])
    )
      apply(projectId, state);
  }
  async function open(projectId: string, sessionId: string): Promise<void> {
    if (sessionId !== latest.current.activeSessionId) return;
    if (observers.current.has(sessionId)) return;
    const observer = { projectId, controller: new AbortController() };
    observers.current.set(sessionId, observer);
    const receive = (state: AgentExecutionQueueSnapshot): void => {
      if (observers.current.get(sessionId) === observer && !observer.controller.signal.aborted)
        apply(projectId, state);
    };
    // Install streaming first; a slow initial GET cannot overwrite newer cursors.
    void observeExecutionQueue(sessionId, receive, { signal: observer.controller.signal }).catch(
      (error: unknown) => {
        if (!observer.controller.signal.aborted)
          latest.current.onNotice(
            `无法观察待执行消息。${error instanceof AgentStreamError ? error.message : '请重新打开会话'}`,
          );
      },
    );
    try {
      await refresh(projectId, sessionId);
    } catch (error: unknown) {
      if (!observer.controller.signal.aborted)
        latest.current.onNotice(
          `无法读取待执行消息。${error instanceof AgentStreamError ? error.message : '请重新打开会话'}`,
        );
    }
  }
  useEffect(() => {
    for (const [sessionId, observer] of observers.current) {
      if (sessionId === options.activeSessionId) continue;
      observer.controller.abort();
      observers.current.delete(sessionId);
      stateRef.current.delete(sessionId);
      controls.current.get(sessionId)?.abort();
      controls.current.delete(sessionId);
    }
    setStates((current) =>
      Object.fromEntries(
        Object.entries(current).filter(([sessionId]) => sessionId === options.activeSessionId),
      ),
    );
    setPending((current) =>
      Object.fromEntries(
        Object.entries(current).filter(([sessionId]) => sessionId === options.activeSessionId),
      ),
    );
    if (options.activeSessionId !== '') void open(options.activeProjectId, options.activeSessionId);
  }, [options.activeSessionId]);
  async function control(
    sessionId: string,
    executionId: string,
    kind: 'cancel' | 'move',
  ): Promise<void> {
    const state = stateRef.current.get(sessionId);
    const observer = observers.current.get(sessionId);
    if (state === undefined || observer === undefined || controls.current.has(sessionId)) return;
    const controller = new AbortController();
    controls.current.set(sessionId, controller);
    setPending((current) => ({ ...current, [sessionId]: true }));
    const requestId = crypto.randomUUID();
    const isCurrent = (): boolean =>
      observers.current.get(sessionId) === observer &&
      !observer.controller.signal.aborted &&
      !controller.signal.aborted;
    const applyControl = (state: AgentExecutionQueueSnapshot): void => {
      if (isCurrent()) apply(observer.projectId, state);
    };
    try {
      if (kind === 'cancel')
        applyControl(
          await cancelQueuedExecution(
            sessionId,
            executionId,
            { requestId, expectedRevision: state.revision },
            controller.signal,
          ),
        );
      else {
        const ids = state.queued.map((entry) => entry.executionId);
        const index = ids.indexOf(executionId);
        if (index <= 0) return;
        [ids[index - 1], ids[index]] = [ids[index]!, ids[index - 1]!];
        applyControl(
          await reorderExecutionQueue(
            sessionId,
            { requestId, expectedRevision: state.revision, executionIds: ids },
            controller.signal,
          ),
        );
      }
    } catch (error: unknown) {
      if (!isCurrent()) return;
      latest.current.onNotice(
        error instanceof AgentStreamError && error.code === 'execution-not-queued'
          ? '该消息已开始，未取消当前运行。'
          : error instanceof AgentStreamError && error.code === 'execution-queue-conflict'
            ? '待执行顺序已变化，请重新操作。'
            : '队列操作失败，请重试。',
      );
      await refresh(observer.projectId, sessionId).catch(() => undefined);
    } finally {
      if (controls.current.get(sessionId) === controller) {
        controls.current.delete(sessionId);
        setPending((current) => ({ ...current, [sessionId]: false }));
      }
    }
  }
  useEffect(
    () => () => {
      for (const observer of observers.current.values()) observer.controller.abort();
      observers.current.clear();
      for (const controller of controls.current.values()) controller.abort();
      controls.current.clear();
    },
    [],
  );
  return {
    states,
    pending,
    getState: (sessionId: string) => stateRef.current.get(sessionId),
    open,
    refresh,
    cancel: (sessionId: string, executionId: string) => control(sessionId, executionId, 'cancel'),
    move: (sessionId: string, executionId: string) => control(sessionId, executionId, 'move'),
  };
}
