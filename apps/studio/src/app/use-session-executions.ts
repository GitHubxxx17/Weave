import {
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
} from 'react';

import type { AgentRuntimeEvent, AgentStreamHandlers } from '../features/agent/agent-types.js';
import {
  cancelAgentExecution,
  getAgentExecution,
  listAgentExecutions,
  observeAgentExecution,
  waitForExecutionRetry,
} from '../features/agent/agent-execution-client.js';
import {
  isTerminalExecution,
  type AgentExecutionSnapshot,
} from '../features/agent/agent-execution-types.js';
import type { useExecutionQueues } from '../features/agent/use-execution-queues.js';
import type { createConversationStore } from '../features/conversation/conversation-store.js';
import type { LiveOwner } from '../features/conversation/conversation-types.js';
import { sumUsage } from '../features/conversation/turn-stats.js';
import type { createTurnFileReviewStore } from '../features/file-undo/turn-file-review-store.js';
import { createWorkspaceApi } from '../features/workspace/workspace-api.js';
import type {
  SessionDetail,
  TurnSummary,
  TurnUsage,
} from '../features/workspace/workspace-types.js';
import {
  createId,
  liveTurnIdFor,
  safeErrorMessage,
  toStudioSession,
  updateToolActivity,
  workspaceErrorMessage,
} from './app-helpers.js';
import {
  idleRunState,
  type ChatMessage,
  type RunStatus,
  type SessionRunHandle,
  type SessionRunState,
  type StudioProject,
  type ToolActivity,
} from './app-types.js';

const workspaceApi = createWorkspaceApi();

export type UseSessionExecutionsOptions = {
  readonly conversationStore: ReturnType<typeof createConversationStore>;
  readonly fileReviewStore: ReturnType<typeof createTurnFileReviewStore>;
  readonly queueController: ReturnType<typeof useExecutionQueues>;
  readonly setProjects: Dispatch<SetStateAction<readonly StudioProject[]>>;
  readonly activeProjectId: string;
  readonly activeSessionId: string;
  /** Mirrors `activeSessionId` synchronously for async callbacks. */
  readonly activeSessionIdRef: MutableRefObject<string>;
  /** Shows (or clears with `null`) the App-level notice banner. */
  readonly onNotice: (message: string | null) => void;
};

/**
 * Owns run handles, per-session run state, execution observation, event
 * handling and durable reconciliation. Project and navigation state stay in the
 * App and reach this hook through the options.
 */
export function useSessionExecutions({
  conversationStore,
  fileReviewStore,
  queueController,
  setProjects,
  activeProjectId,
  activeSessionId,
  activeSessionIdRef,
  onNotice: setNotice,
}: UseSessionExecutionsOptions) {
  const [expandedMessageIds, setExpandedMessageIds] = useState<readonly string[]>([]);
  const [runStateBySession, setRunStateBySession] = useState<Record<string, SessionRunState>>({});
  const runHandles = useRef<Map<string, SessionRunHandle>>(new Map());
  const observationEpoch = useRef(0);
  const sessionActivityVersions = useRef(new Map<string, number>());
  // Deleted IDs cannot be revived by an already admitted HTTP read or observer.
  const deletedSessionIds = useRef(new Set<string>());
  // Durable Session sequences survive navigation and Server epochs; late reads must not roll them back.
  const appliedDurableSequences = useRef(new Map<string, number>());
  const settledExecutionSequences = useRef(new Map<string, number>());
  const [admitting, setAdmitting] = useState<Record<string, boolean>>({});
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      for (const handle of runHandles.current.values()) handle.controller.abort();
      runHandles.current.clear();
      // StrictMode replays setup synchronously; only a real detach disposes timers.
      queueMicrotask(() => {
        if (!mounted.current) {
          conversationStore.dispose();
          fileReviewStore.dispose();
        }
      });
    };
  }, [conversationStore, fileReviewStore]);

  /** Run status of any session; a session without a run is idle. */
  function sessionRunStatus(sessionId: string): RunStatus {
    return runStateBySession[sessionId]?.status ?? 'idle';
  }
  function isSessionStreaming(sessionId: string): boolean {
    return (
      sessionRunStatus(sessionId) === 'streaming' ||
      (queueController.states[sessionId]?.queued.length ?? 0) > 0 ||
      admitting[sessionId] === true
    );
  }
  function setSessionRunState(sessionId: string, next: SessionRunState): void {
    setRunStateBySession((current) => ({ ...current, [sessionId]: next }));
  }

  // The composer, overview and footer always reflect the active session's run.
  const activeRunState = runStateBySession[activeSessionId] ?? idleRunState;
  useEffect(() => {
    for (const [key, handle] of runHandles.current) {
      if (!handle.observing || handle.sessionId === activeSessionId) continue;
      if (handle.execution !== undefined)
        conversationStore.detachLive(liveOwner(handle.execution, handle.runId));
      handle.controller.abort();
      runHandles.current.delete(key);
    }
  }, [activeSessionId, conversationStore]);

  /** Applies an immutable message update to one local Studio session. */
  function updateSessionMessages(
    projectId: string,
    sessionId: string,
    update: (messages: readonly ChatMessage[]) => readonly ChatMessage[],
  ): void {
    setProjects((current) =>
      current.map((project) =>
        project.id === projectId
          ? {
              ...project,
              sessions: project.sessions.map((session) =>
                session.id === sessionId
                  ? { ...session, messages: update(session.messages) }
                  : session,
              ),
            }
          : project,
      ),
    );
  }

  /** Applies a change to one Session's Turn summaries, including live ones. */
  function updateSessionTurns(
    projectId: string,
    sessionId: string,
    update: (turns: readonly TurnSummary[]) => readonly TurnSummary[],
  ): void {
    setProjects((current) =>
      current.map((project) =>
        project.id === projectId
          ? {
              ...project,
              sessions: project.sessions.map((session) =>
                session.id === sessionId ? { ...session, turns: update(session.turns) } : session,
              ),
            }
          : project,
      ),
    );
  }

  /** Closes a live Turn that ended without a `completed` event. */
  function finishLiveTurn(
    projectId: string,
    sessionId: string,
    liveTurnId: string,
    finalStatus: 'failed' | 'cancelled',
  ): void {
    const completedAt = new Date().toISOString();
    updateSessionTurns(projectId, sessionId, (turns) =>
      turns.map((turn) =>
        turn.turnId === liveTurnId && turn.status === 'running'
          ? { ...turn, status: finalStatus, completedAt }
          : turn,
      ),
    );
  }

  /** Clears run-scoped state when the active session changes. */
  /** Resets view-only state (expanded process panels) when the active session changes. */
  function resetTransientState(): void {
    setExpandedMessageIds([]);
  }

  /** Clears the active session's transient run status and expanded panels. */
  function clearActiveRunState(): void {
    setExpandedMessageIds([]);
    setRunStateBySession((current) => {
      // Clearing presentation must not erase a live stream or its global run signal.
      if (
        current[activeSessionId] === undefined ||
        current[activeSessionId].status === 'streaming'
      ) {
        return current;
      }
      return Object.fromEntries(
        Object.entries(current).filter(([sessionId]) => sessionId !== activeSessionId),
      );
    });
  }

  function applySessionDetail(
    projectId: string,
    detail: SessionDetail,
    addMissing = false,
  ): boolean {
    if (!mounted.current || deletedSessionIds.current.has(detail.id)) return false;
    if (detail.lastSequence < (appliedDurableSequences.current.get(detail.id) ?? 0)) return false;
    appliedDurableSequences.current.set(detail.id, detail.lastSequence);
    conversationStore.hydrate(detail);
    setProjects((current) =>
      current.map((project) =>
        project.id !== projectId
          ? project
          : {
              ...project,
              sessions:
                addMissing && !project.sessions.some((session) => session.id === detail.id)
                  ? [toStudioSession(detail), ...project.sessions]
                  : project.sessions.map((session) =>
                      session.id === detail.id ? toStudioSession(detail) : session,
                    ),
            },
      ),
    );
    return true;
  }

  async function loadSessionDetail(projectId: string, sessionId: string): Promise<void> {
    if (deletedSessionIds.current.has(sessionId)) return;
    // A streaming session's freshest messages live in memory; a server snapshot
    // would clobber its in-flight assistant message, so skip the reload while it runs.
    if (hasSessionHandles(sessionId)) {
      void queueController.open(projectId, sessionId);
      return;
    }
    const activityVersion = sessionActivityVersions.current.get(sessionId) ?? 0;
    try {
      const detail = await workspaceApi.getSession(sessionId);
      if (detail.id !== sessionId) return;
      if ((sessionActivityVersions.current.get(sessionId) ?? 0) !== activityVersion) return;
      // A run may have started while the snapshot was in flight; don't clobber it.
      if (hasSessionHandles(sessionId)) {
        void queueController.open(projectId, sessionId);
        return;
      }
      if (!applySessionDetail(projectId, detail)) return;
      if (sessionRunStatus(sessionId) === 'streaming') {
        const latest = detail.turns.at(-1);
        setSessionRunState(
          sessionId,
          latest?.status === 'completed'
            ? { status: 'completed', errorMessage: null }
            : latest?.status === 'cancelled'
              ? { status: 'cancelled', errorMessage: null }
              : latest?.status === 'failed'
                ? { status: 'error', errorMessage: '本次运行失败，请查看运行错误' }
                : idleRunState,
        );
      }
      await recoverSessionExecution(projectId, sessionId, detail.lastSequence);
    } catch (error: unknown) {
      if (!deletedSessionIds.current.has(sessionId) && activeSessionIdRef.current === sessionId) {
        setNotice(workspaceErrorMessage(error));
      }
    }
  }

  function hasSessionHandles(sessionId: string): boolean {
    return [...runHandles.current.values()].some(
      (handle) => handle.sessionId === sessionId || handle.execution?.sessionId === sessionId,
    );
  }

  function executionHandle(sessionId: string, runId: string): SessionRunHandle | undefined {
    return [...runHandles.current.values()].find(
      (handle) =>
        handle.runId === runId &&
        (handle.execution === undefined || handle.execution.sessionId === sessionId),
    );
  }

  function executionOwnsStatus(sessionId: string, runId: string): boolean {
    const active = queueController.getState(sessionId)?.active;
    const handle = executionHandle(sessionId, runId);
    return (
      handle !== undefined &&
      !(
        handle.execution !== undefined &&
        isTerminalExecution(handle.execution.status) &&
        (handle.execution.durableThroughSequence ?? 0) <
          (settledExecutionSequences.current.get(sessionId) ?? 0)
      ) &&
      (active === undefined ||
        active === null ||
        active.executionId === handle.execution?.executionId) &&
      ![...runHandles.current.values()].some(
        (candidate) =>
          candidate !== handle &&
          candidate.execution?.sessionId === sessionId &&
          !isTerminalExecution(candidate.execution.status) &&
          candidate.execution.status !== 'queued',
      )
    );
  }

  async function attachExecution(
    projectId: string,
    sessionId: string,
    executionId: string,
    supplied?: AgentExecutionSnapshot,
  ): Promise<void> {
    if (deletedSessionIds.current.has(sessionId)) return;
    if (activeSessionIdRef.current !== sessionId) return;
    if (!mounted.current || runHandles.current.has(executionId)) return;
    const handle: SessionRunHandle = {
      runId: createId('observation'),
      observationEpoch: ++observationEpoch.current,
      projectId,
      sessionId,
      assistantId: supplied?.turnId ?? executionId,
      controller: new AbortController(),
      tools: [],
      observing: true,
    };
    runHandles.current.set(executionId, handle);
    if (queueController.getState(sessionId)?.active?.executionId === executionId)
      setSessionRunState(sessionId, { status: 'streaming', errorMessage: null });
    try {
      let snapshot = supplied;
      let attempt = 0;
      while (snapshot === undefined) {
        try {
          snapshot = await getAgentExecution(sessionId, executionId, handle.controller.signal);
        } catch (error: unknown) {
          if (!(error instanceof TypeError)) throw error;
          await waitForExecutionRetry(attempt++, handle.controller.signal);
        }
      }
      if (
        !mounted.current ||
        deletedSessionIds.current.has(sessionId) ||
        runHandles.current.get(executionId) !== handle
      )
        return;
      handle.execution = snapshot;
      handle.assistantId = snapshot.turnId;
      renderExecution(projectId, snapshot, handle.runId);
      if (snapshot.status === 'queued') {
        runHandles.current.delete(executionId);
        return;
      }
      if (executionOwnsStatus(sessionId, handle.runId))
        setSessionRunState(sessionId, {
          status: 'streaming',
          stopping: snapshot.status === 'cancelling',
          errorMessage: snapshot.error?.message ?? null,
        });
      if (handle.pendingCancel) void requestExecutionCancel(projectId, sessionId, handle.runId);
      await resumeExecution(projectId, sessionId, handle.runId);
    } catch (error: unknown) {
      if (runHandles.current.get(executionId) === handle) runHandles.current.delete(executionId);
      if (!handle.controller.signal.aborted && mounted.current)
        setNotice(`无法恢复执行。${safeErrorMessage(error)}`);
    }
  }

  function executionIsCurrent(sessionId: string, runId: string): boolean {
    return mounted.current && executionHandle(sessionId, runId) !== undefined;
  }

  function liveOwner(snapshot: AgentExecutionSnapshot, runId: string): LiveOwner {
    return {
      sessionId: snapshot.sessionId,
      executionId: snapshot.executionId,
      turnId: snapshot.turnId,
      userMessageId: snapshot.userMessageId,
      runId,
      epoch: executionHandle(snapshot.sessionId, runId)?.observationEpoch ?? -1,
    };
  }
  function renderExecution(
    projectId: string,
    snapshot: AgentExecutionSnapshot,
    runId: string,
  ): void {
    void projectId;
    const handle = executionHandle(snapshot.sessionId, runId);
    if (handle === undefined || !executionIsCurrent(snapshot.sessionId, runId)) return;
    handle.execution = snapshot;
    if (snapshot.status !== 'queued')
      conversationStore.replaceLive(liveOwner(snapshot, runId), snapshot);
  }

  function executionHandlers(
    projectId: string,
    sessionId: string,
    runId: string,
  ): AgentStreamHandlers {
    return {
      onSnapshot: (snapshot) => {
        if (!executionIsCurrent(sessionId, runId)) return;
        renderExecution(projectId, snapshot, runId);
        if (isTerminalExecution(snapshot.status))
          void reconcileExecution(projectId, sessionId, runId);
        if (!executionOwnsStatus(sessionId, runId)) return;
        setRunStateBySession((current) => ({
          ...current,
          [sessionId]: {
            ...current[sessionId],
            status: 'streaming',
            errorMessage: snapshot.error?.message ?? null,
            stopping:
              executionHandle(sessionId, runId)?.pendingCancel || snapshot.status === 'cancelling',
          },
        }));
      },
      onEvent: (event) => {
        const handle = executionHandle(sessionId, runId);
        if (handle?.execution === undefined || !executionIsCurrent(sessionId, runId)) return;
        conversationStore.appendLive(liveOwner(handle.execution, runId), event);
      },
      onStatus: (status) => {
        const handle = executionHandle(sessionId, runId);
        if (handle?.execution === undefined || !executionIsCurrent(sessionId, runId)) return;
        handle.execution = { ...handle.execution, ...status };
        conversationStore.updateLiveStatus(liveOwner(handle.execution, runId), status);
        if (isTerminalExecution(status.status))
          void reconcileExecution(projectId, sessionId, runId);
        if (!executionOwnsStatus(sessionId, runId)) return;
        setRunStateBySession((current) => ({
          ...current,
          [sessionId]: {
            ...current[sessionId],
            status: 'streaming',
            errorMessage: status.error?.message ?? null,
            stopping: handle.pendingCancel || status.status === 'cancelling',
          },
        }));
      },
      onConnection: (connection) => {
        if (!executionIsCurrent(sessionId, runId)) return;
        if (!executionOwnsStatus(sessionId, runId)) return;
        setRunStateBySession((current) => ({
          ...current,
          [sessionId]: {
            ...current[sessionId],
            status: 'streaming',
            errorMessage: current[sessionId]?.errorMessage ?? null,
            connection,
          },
        }));
      },
    };
  }

  async function requestExecutionCancel(
    projectId: string,
    sessionId: string,
    runId: string,
  ): Promise<void> {
    const handle = executionHandle(sessionId, runId);
    if (
      handle?.execution === undefined ||
      handle.cancelInFlight ||
      !executionIsCurrent(sessionId, runId)
    )
      return;
    handle.cancelInFlight = true;
    try {
      const snapshot = await cancelAgentExecution(sessionId, handle.execution.executionId);
      if (!executionIsCurrent(sessionId, runId)) return;
      // Cancellation receipts may lag the observation stream; never replace newer output.
      if (!isTerminalExecution(handle.execution.status)) {
        handle.execution = {
          ...handle.execution,
          status: snapshot.status,
          ...(snapshot.durableThroughSequence === undefined
            ? {}
            : { durableThroughSequence: snapshot.durableThroughSequence }),
          ...(snapshot.error === undefined ? {} : { error: snapshot.error }),
        };
        conversationStore.updateLiveStatus(liveOwner(handle.execution, runId), {
          cursor: handle.execution.cursor,
          status: handle.execution.status,
          ...(handle.execution.durableThroughSequence === undefined
            ? {}
            : { durableThroughSequence: handle.execution.durableThroughSequence }),
          ...(handle.execution.error === undefined ? {} : { error: handle.execution.error }),
        });
        if (isTerminalExecution(handle.execution.status))
          void reconcileExecution(projectId, sessionId, runId);
      }
    } catch (error: unknown) {
      if (executionIsCurrent(sessionId, runId) && executionOwnsStatus(sessionId, runId))
        setSessionRunState(sessionId, {
          status: 'streaming',
          stopping: true,
          errorMessage: `停止请求未确认，可再次点击停止。${safeErrorMessage(error)}`,
        });
    } finally {
      handle.cancelInFlight = false;
    }
  }

  async function reconcileExecution(
    projectId: string,
    sessionId: string,
    runId: string,
  ): Promise<void> {
    const reconciliationHandle = executionHandle(sessionId, runId);
    if (reconciliationHandle === undefined || reconciliationHandle.reconciling) return;
    reconciliationHandle.reconciling = true;
    let attempt = 0;
    try {
      while (executionIsCurrent(sessionId, runId)) {
        const handle = executionHandle(sessionId, runId);
        const snapshot = handle?.execution;
        if (handle === undefined || snapshot === undefined || !isTerminalExecution(snapshot.status))
          return;
        try {
          const detail = await workspaceApi.getSession(sessionId);
          if (!executionIsCurrent(sessionId, runId)) return;
          const turn = detail.turns.find(
            (candidate) =>
              candidate.turnId === snapshot.turnId &&
              candidate.userMessageId === snapshot.userMessageId,
          );
          if (
            detail.id === sessionId &&
            snapshot.durableThroughSequence !== undefined &&
            detail.lastSequence >= snapshot.durableThroughSequence &&
            ((turn !== undefined && turn.status !== 'running') ||
              (turn === undefined && snapshot.status !== 'completed'))
          ) {
            const staleHistory =
              detail.lastSequence < (appliedDurableSequences.current.get(sessionId) ?? 0);
            if (!staleHistory) appliedDurableSequences.current.set(sessionId, detail.lastSequence);
            const settlement = conversationStore.settle(liveOwner(snapshot, runId), detail);
            if (!settlement.confirmed) {
              await waitForExecutionRetry(attempt++, handle.controller.signal);
              continue;
            }
            if (!staleHistory) applySessionDetail(projectId, detail);
            const ownsStatus =
              executionOwnsStatus(sessionId, runId) &&
              snapshot.durableThroughSequence >=
                (settledExecutionSequences.current.get(sessionId) ?? 0);
            settledExecutionSequences.current.set(
              sessionId,
              Math.max(
                snapshot.durableThroughSequence,
                settledExecutionSequences.current.get(sessionId) ?? 0,
              ),
            );
            runHandles.current.delete(snapshot.executionId);
            if (runHandles.current.get(sessionId) === handle) runHandles.current.delete(sessionId);
            // Durable settlement releases observation only; it never cancels a producer.
            handle.controller.abort();
            if (!ownsStatus) return;
            setSessionRunState(sessionId, {
              status:
                snapshot.status === 'completed'
                  ? 'completed'
                  : snapshot.status === 'cancelled'
                    ? 'cancelled'
                    : 'error',
              errorMessage:
                snapshot.status === 'failed' || snapshot.status === 'interrupted'
                  ? (snapshot.error?.message ?? '本次运行已中断；会话记录已更新。')
                  : null,
            });
            return;
          }
        } catch (error: unknown) {
          if (!executionIsCurrent(sessionId, runId)) return;
          if (executionOwnsStatus(sessionId, runId))
            setSessionRunState(sessionId, {
              status: 'streaming',
              stopping: handle.pendingCancel,
              connection: 'reconnecting',
              errorMessage: `正在确认持久化会话记录。${workspaceErrorMessage(error)}`,
            });
        }
        await waitForExecutionRetry(attempt++, handle.controller.signal);
      }
    } catch (error: unknown) {
      if (!reconciliationHandle.controller.signal.aborted && mounted.current)
        setNotice(`无法确认执行记录。${safeErrorMessage(error)}`);
    } finally {
      reconciliationHandle.reconciling = false;
    }
  }

  async function resumeExecution(
    projectId: string,
    sessionId: string,
    runId: string,
  ): Promise<void> {
    let attempt = 0;
    while (executionIsCurrent(sessionId, runId)) {
      const handle = executionHandle(sessionId, runId);
      if (handle?.execution === undefined) return;
      try {
        if (!isTerminalExecution(handle.execution.status)) {
          const snapshot =
            attempt === 0
              ? handle.execution
              : await getAgentExecution(
                  sessionId,
                  handle.execution.executionId,
                  handle.controller.signal,
                );
          if (!executionIsCurrent(sessionId, runId)) return;
          if (snapshot.status === 'queued') {
            runHandles.current.delete(snapshot.executionId);
            return;
          }
          await observeAgentExecution(snapshot, executionHandlers(projectId, sessionId, runId), {
            signal: handle.controller.signal,
          });
        }
        await reconcileExecution(projectId, sessionId, runId);
        return;
      } catch (error: unknown) {
        if (!executionIsCurrent(sessionId, runId)) return;
        if (executionOwnsStatus(sessionId, runId))
          setSessionRunState(sessionId, {
            status: 'streaming',
            stopping: handle.pendingCancel,
            connection: 'reconnecting',
            errorMessage: `正在恢复运行连接。${safeErrorMessage(error)}`,
          });
        try {
          await waitForExecutionRetry(attempt++, handle.controller.signal);
        } catch {
          return;
        }
      }
    }
  }

  async function recoverSessionExecution(
    projectId: string,
    sessionId: string,
    lastSequence: number,
    disposed?: () => boolean,
  ): Promise<void> {
    if (deletedSessionIds.current.has(sessionId)) return;
    await queueController.open(projectId, sessionId);
    if (!mounted.current || disposed?.() || deletedSessionIds.current.has(sessionId)) return;
    try {
      const summaries = await listAgentExecutions(sessionId);
      if (!mounted.current || disposed?.() || deletedSessionIds.current.has(sessionId)) return;
      for (const summary of summaries) {
        if (
          (summary.status !== 'queued' && !isTerminalExecution(summary.status)) ||
          (summary.durableThroughSequence !== undefined &&
            summary.durableThroughSequence > lastSequence)
        )
          void attachExecution(projectId, sessionId, summary.executionId);
      }
    } catch {
      /* Queue observation remains authoritative if history metadata is unavailable. */
    }
  }

  function handleEvent(
    event: AgentRuntimeEvent,
    runId: string,
    assistantId: string,
    projectId: string,
    sessionId: string,
  ): void {
    const handle = runHandles.current.get(sessionId);
    if (handle === undefined || handle.runId !== runId) {
      return;
    }

    switch (event.type) {
      case 'text-delta':
        updateSessionMessages(projectId, sessionId, (current) =>
          current.map((message) =>
            message.id === assistantId ? { ...message, text: message.text + event.text } : message,
          ),
        );
        break;
      case 'reasoning-delta':
        updateSessionMessages(projectId, sessionId, (current) =>
          current.map((message) =>
            message.id === assistantId
              ? { ...message, reasoning: message.reasoning + event.text }
              : message,
          ),
        );
        break;
      case 'tool-call':
        handle.tools = updateToolActivity(handle.tools, event.toolCall.id, () => ({
          toolCallId: event.toolCall.id,
          name: event.toolCall.name,
          arguments: event.toolCall.arguments,
          status: 'called',
        }));
        updateSessionMessages(projectId, sessionId, (messages) =>
          messages.map((message) =>
            message.id === assistantId ? { ...message, tools: handle.tools } : message,
          ),
        );
        break;
      case 'tool-executing':
        handle.tools = updateToolActivity(handle.tools, event.toolCall.id, (existing) => {
          const updated: ToolActivity = {
            toolCallId: event.toolCall.id,
            name: event.toolCall.name,
            arguments: event.toolCall.arguments,
            status: 'executing',
          };
          return existing?.result === undefined ? updated : { ...updated, result: existing.result };
        });
        updateSessionMessages(projectId, sessionId, (messages) =>
          messages.map((message) =>
            message.id === assistantId ? { ...message, tools: handle.tools } : message,
          ),
        );
        break;
      case 'tool-result':
        handle.tools = updateToolActivity(handle.tools, event.result.toolCallId, (existing) => ({
          toolCallId: event.result.toolCallId,
          name: event.result.name,
          arguments: existing?.arguments ?? '',
          status: event.status === 'failed' ? 'failed' : 'completed',
          result: event.result.content,
        }));
        updateSessionMessages(projectId, sessionId, (messages) =>
          messages.map((message) =>
            message.id === assistantId ? { ...message, tools: handle.tools } : message,
          ),
        );
        updateSessionTurns(projectId, sessionId, (turns) =>
          turns.map((turn) =>
            turn.turnId === liveTurnIdFor(assistantId)
              ? {
                  ...turn,
                  toolCalls: turn.toolCalls + 1,
                  failedToolCalls: turn.failedToolCalls + (event.status === 'failed' ? 1 : 0),
                }
              : turn,
          ),
        );
        break;
      case 'usage': {
        const completedAt = new Date().toISOString();
        updateSessionTurns(projectId, sessionId, (turns) =>
          turns.map((turn) => {
            if (turn.turnId !== liveTurnIdFor(assistantId)) {
              return turn;
            }
            const usage = Object.fromEntries(
              Object.entries(event.usage).filter(([, value]) => value !== undefined),
            ) as TurnUsage;
            return {
              ...turn,
              provider: event.provider,
              model: event.model,
              usage: sumUsage([turn.usage, usage]),
              modelSteps: [
                ...turn.modelSteps,
                {
                  startedAt: turn.modelSteps.at(-1)?.completedAt ?? turn.startedAt,
                  completedAt,
                  usage,
                },
              ],
            };
          }),
        );
        break;
      }
      case 'context': {
        updateSessionTurns(projectId, sessionId, (turns) =>
          turns.map((turn) =>
            turn.turnId === liveTurnIdFor(assistantId)
              ? { ...turn, provider: event.provider, model: event.model, context: event.breakdown }
              : turn,
          ),
        );
        break;
      }
      case 'plan': {
        updateSessionTurns(projectId, sessionId, (turns) =>
          turns.map((turn) =>
            turn.turnId === liveTurnIdFor(assistantId) ? { ...turn, plan: event.plan } : turn,
          ),
        );
        break;
      }
      case 'completed': {
        setSessionRunState(sessionId, { status: 'completed', errorMessage: null });
        const liveTurnId = liveTurnIdFor(assistantId);
        const completedAt = new Date().toISOString();
        updateSessionTurns(projectId, sessionId, (turns) =>
          turns.map((turn) =>
            turn.turnId === liveTurnId
              ? { ...turn, turnId: event.turnId, status: 'completed', completedAt }
              : turn,
          ),
        );
        updateSessionMessages(projectId, sessionId, (messages) =>
          messages.map((message) =>
            message.turnId === liveTurnId ? { ...message, turnId: event.turnId } : message,
          ),
        );
        break;
      }
    }
  }

  function cancelRun(): void {
    const sessionId = activeSessionId;
    const activeId = queueController.getState(sessionId)?.active?.executionId;
    if (activeId !== undefined && !runHandles.current.has(activeId))
      void attachExecution(activeProjectId, sessionId, activeId);
    const handle =
      activeId !== undefined
        ? runHandles.current.get(activeId)
        : ([...runHandles.current.values()].find(
            (candidate) =>
              candidate.execution?.sessionId === sessionId &&
              !isTerminalExecution(candidate.execution.status) &&
              candidate.execution.status !== 'queued',
          ) ?? runHandles.current.get(sessionId));
    if (handle === undefined) return;
    handle.pendingCancel = true;
    setSessionRunState(sessionId, { status: 'streaming', stopping: true, errorMessage: null });
    if (handle.execution !== undefined)
      void requestExecutionCancel(activeProjectId, sessionId, handle.runId);
  }

  /**
   * Drops every runtime trace of a permanently deleted session: marks the ID
   * deleted, invalidates in-flight reads, aborts its handles and clears its
   * run state, conversation, file review and sequence bookkeeping.
   */
  function releaseSessionRuntime(projectId: string, sessionId: string): void {
    deletedSessionIds.current.add(sessionId);
    sessionActivityVersions.current.set(
      sessionId,
      (sessionActivityVersions.current.get(sessionId) ?? 0) + 1,
    );
    for (const [key, handle] of runHandles.current) {
      if (handle.sessionId !== sessionId && handle.execution?.sessionId !== sessionId) continue;
      runHandles.current.delete(key);
      handle.controller.abort();
    }
    setRunStateBySession((current) =>
      Object.fromEntries(Object.entries(current).filter(([id]) => id !== sessionId)),
    );
    conversationStore.removeSession(sessionId);
    fileReviewStore.removeSession(projectId, sessionId);
    appliedDurableSequences.current.delete(sessionId);
    settledExecutionSequences.current.delete(sessionId);
  }

  return {
    releaseSessionRuntime,
    expandedMessageIds,
    setExpandedMessageIds,
    runStateBySession,
    runHandles,
    observationEpoch,
    sessionActivityVersions,
    deletedSessionIds,
    appliedDurableSequences,
    admitting,
    setAdmitting,
    mounted,
    activeRunState,
    sessionRunStatus,
    isSessionStreaming,
    setSessionRunState,
    updateSessionMessages,
    updateSessionTurns,
    finishLiveTurn,
    resetTransientState,
    clearActiveRunState,
    applySessionDetail,
    loadSessionDetail,
    hasSessionHandles,
    executionIsCurrent,
    attachExecution,
    recoverSessionExecution,
    handleEvent,
    cancelRun,
    executionHandlers,
    requestExecutionCancel,
    reconcileExecution,
    resumeExecution,
  };
}
