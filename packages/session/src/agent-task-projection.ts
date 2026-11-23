import type { SessionEvent } from './events.js';
import {
  agentTaskFactDigest,
  type AgentTaskAccepted,
  type AgentTaskCancelRequested,
  type AgentTaskDispatched,
  type AgentTaskOrigin,
  type AgentTaskSettled,
  type AgentTasksStopRequested,
} from './agent-task-events.js';

type FactAtSequence<T> = Readonly<T> & { readonly sequence: number };

export interface SessionAgentTask {
  readonly taskId: string;
  readonly parentTurnId: string;
  readonly parentToolCallId: string;
  readonly childSessionId: string;
  readonly childExecutionId: string;
  readonly childTurnId: string;
  readonly childUserMessageId: string;
  readonly acceptedSequence: number;
  readonly acceptedAt: string;
  readonly title: string;
  readonly access: AgentTaskAccepted['access'];
  readonly dispatched?: FactAtSequence<AgentTaskDispatched>;
  readonly cancellation?: FactAtSequence<AgentTaskCancelRequested>;
  readonly settled?: FactAtSequence<AgentTaskSettled>;
}

export interface SessionAgentTasks {
  readonly origin?: FactAtSequence<AgentTaskOrigin>;
  readonly tasks: readonly SessionAgentTask[];
  readonly stopOperations?: readonly FactAtSequence<AgentTasksStopRequested>[];
}

interface TaskState {
  task: SessionAgentTask;
  readonly acceptanceDigest: string;
  readonly cancelOperations: Map<string, AgentTaskCancelRequested['reason']>;
}

export interface AgentTaskProjectionState {
  origin?: FactAtSequence<AgentTaskOrigin>;
  childExecution?: 'queued' | 'claimed';
  readonly tasks: Map<string, TaskState>;
  readonly stopOperations: Map<string, FactAtSequence<AgentTasksStopRequested>>;
  readonly assignedIds: Set<string>;
  readonly callsByTurn: Map<string, Set<string>>;
}

export function createAgentTaskProjectionState(): AgentTaskProjectionState {
  return {
    tasks: new Map(),
    stopOperations: new Map(),
    assignedIds: new Set(),
    callsByTurn: new Map(),
  };
}

/** Apply only relationships that can be checked in this Session. */
export function applyAgentTaskEvent(
  state: AgentTaskProjectionState,
  event: SessionEvent,
  invalid: (message: string) => Error,
): void {
  if (event.type === 'agent.task.origin') {
    if (
      state.origin !== undefined ||
      event.sequence !== 2 ||
      event.sessionId !== event.payload.childSessionId
    )
      throw invalid('Task origin must be the unique first child fact');
    state.origin = { ...event.payload, sequence: event.sequence };
    return;
  }

  if (event.type === 'agent.tasks.stop-requested') {
    if (state.origin !== undefined) throw invalid('Child task Sessions cannot own stop operations');
    const { operationId, taskIds } = event.payload;
    const previous = state.stopOperations.get(operationId);
    if (previous !== undefined) {
      if (
        taskIds.length !== previous.taskIds.length ||
        taskIds.some((id) => !previous.taskIds.includes(id))
      )
        throw invalid('Task stop operation replay conflicts');
      return;
    }
    state.stopOperations.set(operationId, { ...event.payload, sequence: event.sequence });
    return;
  }

  if (event.type === 'execution.accepted' && state.origin !== undefined) {
    const { origin } = state;
    const { executionId, requestId, turnId, userMessageId } = event.payload;
    if (
      state.childExecution !== undefined ||
      executionId !== origin.childExecutionId ||
      requestId !== `agent-task:${origin.taskId}` ||
      turnId !== origin.childTurnId ||
      userMessageId !== origin.childUserMessageId
    )
      throw invalid('Task origin execution identity conflicts');
    state.childExecution = event.payload.dispatch === 'queued' ? 'queued' : 'claimed';
    return;
  }
  if (event.type === 'execution.claimed' && state.origin !== undefined) {
    if (
      state.childExecution !== 'queued' ||
      event.payload.executionId !== state.origin.childExecutionId
    )
      throw invalid('Task execution claim requires its queued acceptance');
    state.childExecution = 'claimed';
    return;
  }
  if (event.type === 'turn.started' && state.origin !== undefined) {
    const { origin } = state;
    if (
      state.childExecution !== 'claimed' ||
      event.payload.executionId !== origin.childExecutionId ||
      event.payload.turnId !== origin.childTurnId ||
      event.payload.userMessageId !== origin.childUserMessageId
    )
      throw invalid('Task origin Turn requires its exact claimed execution');
    return;
  }
  if (
    event.type !== 'agent.task.accepted' &&
    event.type !== 'agent.task.dispatched' &&
    event.type !== 'agent.task.cancel-requested' &&
    event.type !== 'agent.task.settled'
  )
    return;
  if (state.origin !== undefined) throw invalid('Child task Sessions cannot own tasks');

  const { sequence, payload } = event;
  const record = state.tasks.get(payload.taskId);
  if (event.type === 'agent.task.accepted') {
    const accepted = event.payload;
    const digest = agentTaskFactDigest(accepted);
    if (record !== undefined) {
      if (digest !== record.acceptanceDigest) throw invalid('Task acceptance replay conflicts');
      return;
    }
    const {
      parentTurnId,
      parentToolCallId,
      childSessionId,
      childExecutionId,
      childTurnId,
      childUserMessageId,
      taskId,
    } = accepted;
    const ids = [taskId, childSessionId, childExecutionId, childTurnId, childUserMessageId];
    const calls = state.callsByTurn.get(parentTurnId) ?? new Set<string>();
    if (
      accepted.parentSessionId !== event.sessionId ||
      calls.has(parentToolCallId) ||
      ids.some((id) => state.assignedIds.has(id))
    )
      throw invalid('Task acceptance identity conflicts');
    calls.add(parentToolCallId);
    state.callsByTurn.set(parentTurnId, calls);
    for (const id of ids) state.assignedIds.add(id);
    state.tasks.set(taskId, {
      acceptanceDigest: digest,
      cancelOperations: new Map(),
      task: {
        taskId,
        parentTurnId,
        parentToolCallId,
        childSessionId,
        childExecutionId,
        childTurnId,
        childUserMessageId,
        title: accepted.title,
        access: accepted.access,
        acceptedSequence: sequence,
        acceptedAt: event.occurredAt,
      },
    });
    return;
  }

  if (record === undefined) throw invalid('Task fact requires a prior acceptance');
  const { task } = record;
  if (event.type === 'agent.task.dispatched') {
    if (task.dispatched !== undefined) {
      if (
        task.dispatched.childExecutionAcceptedSequence !==
          event.payload.childExecutionAcceptedSequence ||
        task.dispatched.childExecutionAcceptedDigest !== event.payload.childExecutionAcceptedDigest
      )
        throw invalid('Task dispatch replay conflicts');
      return;
    }
    if (task.settled !== undefined) throw invalid('Task dispatch requires an unsettled task');
    record.task = { ...task, dispatched: { ...event.payload, sequence } };
  } else if (event.type === 'agent.task.cancel-requested') {
    const { operationId, reason } = event.payload;
    const previous = record.cancelOperations.get(operationId);
    if (previous !== undefined) {
      if (previous !== reason) throw invalid('Task cancellation replay conflicts');
      return;
    }
    if (task.settled !== undefined) throw invalid('Task cancellation requires an unsettled task');
    record.cancelOperations.set(operationId, reason);
    if (task.cancellation === undefined)
      record.task = { ...task, cancellation: { ...event.payload, sequence } };
  } else {
    const { settlement } = event.payload;
    if (task.settled !== undefined) {
      if (agentTaskFactDigest(task.settled.settlement) !== agentTaskFactDigest(settlement))
        throw invalid('Task settlement replay conflicts');
      return;
    }
    if (settlement.phase === 'preparation') {
      if (
        task.dispatched !== undefined ||
        settlement.evidence.parentAcceptedSequence !== task.acceptedSequence
      )
        throw invalid('Task preparation settlement conflicts with local evidence');
    } else if (
      settlement.childExecutionId !== task.childExecutionId ||
      task.dispatched === undefined ||
      settlement.childTerminalSequence <= task.dispatched.childExecutionAcceptedSequence
    ) {
      throw invalid('Task execution settlement conflicts with local evidence');
    }
    record.task = { ...task, settled: { ...event.payload, sequence } };
  }
}

export function snapshotAgentTasks(state: AgentTaskProjectionState): SessionAgentTasks | undefined {
  if (state.origin === undefined && state.tasks.size === 0 && state.stopOperations.size === 0)
    return undefined;
  return structuredClone({
    ...(state.origin === undefined ? {} : { origin: state.origin }),
    tasks: Array.from(state.tasks.values(), ({ task }) => task),
    ...(state.stopOperations.size === 0
      ? {}
      : { stopOperations: [...state.stopOperations.values()] }),
  });
}
