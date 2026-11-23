import {
  agentTaskSpawnInputSchema,
  taskIdentifierSchema,
  taskPreparationStatus,
  taskPreviewMaxBytes,
  taskSettlementSchema,
  taskStopReasonSchema,
  type AgentTaskSpawnInput,
  type TaskExecutionReason,
  type TaskSettlement,
} from '@weave/protocol';
import {
  agentTaskFactDigest,
  projectAgentExecutions,
  projectSession,
  type AgentExecutionInput,
  type AgentTaskAccepted,
  type AgentTaskOrigin,
  type SessionAgentTask,
  type SessionEvent,
} from '@weave/session';
import type {
  AgentTaskParentPrefix,
  AgentTaskReconciliation,
  AgentTaskReconciliationBlock,
  BoundTaskIdentity,
  TaskExecutionCleanup,
} from './agent-task-types.js';

type Fact<T extends SessionEvent['type']> = Extract<SessionEvent, { type: T }>;
type ExecutionAccepted = Fact<'execution.accepted'>;
type ExecutionFinished = Fact<'execution.finished'>;
type ExecutionSettlement = Extract<TaskSettlement, { phase: 'execution' }>;
const encoder = new TextEncoder();

export { agentTaskFactDigest };

export function agentTaskRequestDigest(input: AgentTaskSpawnInput): string {
  return agentTaskFactDigest(agentTaskSpawnInputSchema.parse(input));
}

export function agentTaskExecutionInput(
  task: Pick<AgentTaskAccepted, 'settings' | 'prompt'>,
): AgentExecutionInput {
  return {
    ...task.settings,
    userMessage: { role: 'user', content: [{ type: 'text', text: task.prompt }] },
  };
}

export function agentTaskExecutionIdentity(task: AgentTaskAccepted): BoundTaskIdentity {
  return {
    sessionId: task.childSessionId,
    requestId: task.requestId,
    executionId: task.childExecutionId,
    turnId: task.childTurnId,
    userMessageId: task.childUserMessageId,
  };
}

export function agentTaskOrigin(
  task: AgentTaskAccepted,
  parentAcceptedSequence: number,
): AgentTaskOrigin {
  return {
    version: 1,
    taskId: task.taskId,
    rootSessionId: task.rootSessionId,
    parentSessionId: task.parentSessionId,
    childSessionId: task.childSessionId,
    childExecutionId: task.childExecutionId,
    childTurnId: task.childTurnId,
    childUserMessageId: task.childUserMessageId,
    parentAcceptedSequence,
    parentAcceptedDigest: agentTaskFactDigest(task),
    admissionClass: 'agent-task-once',
  };
}

function blocked(reason: AgentTaskReconciliationBlock): AgentTaskReconciliation {
  return { kind: 'blocked', reason };
}

function matchesParent(
  events: readonly SessionEvent[],
  accepted: Fact<'agent.task.accepted'>,
): boolean {
  const task = accepted.payload;
  if (
    task.requestDigest !==
    agentTaskRequestDigest({ title: task.title, prompt: task.prompt, access: task.access })
  )
    return false;
  const beforeAcceptance = events.slice(0, accepted.sequence - 1);
  const execution = beforeAcceptance.find(
    (event) =>
      event.type === 'execution.accepted' && event.payload.executionId === task.parentExecutionId,
  );
  if (execution?.type !== 'execution.accepted' || execution.payload.turnId !== task.parentTurnId)
    return false;
  const turn = beforeAcceptance.find(
    (event) => event.type === 'turn.started' && event.payload.turnId === task.parentTurnId,
  );
  return (
    turn?.type === 'turn.started' &&
    turn.payload.executionId === task.parentExecutionId &&
    turn.payload.userMessageId === execution.payload.userMessageId &&
    execution.sequence < turn.sequence &&
    beforeAcceptance.some(
      (event) =>
        event.type === 'tool-call.created' &&
        event.sequence > turn.sequence &&
        event.payload.turnId === task.parentTurnId &&
        event.payload.toolCall.id === task.parentToolCallId &&
        event.payload.toolCall.name === 'agent_spawn',
    ) &&
    !beforeAcceptance.some(
      (event) =>
        (event.type === 'turn.completed' && event.payload.turnId === task.parentTurnId) ||
        (event.type === 'execution.finished' &&
          event.payload.executionId === task.parentExecutionId) ||
        event.type === 'session.deleted',
    )
  );
}

function matchesExecution(task: AgentTaskAccepted, acceptance: ExecutionAccepted): boolean {
  const payload = acceptance.payload;
  const identity = agentTaskExecutionIdentity(task);
  const expectedInput = agentTaskFactDigest(agentTaskExecutionInput(task));
  return (
    payload.executionId === identity.executionId &&
    payload.requestId === identity.requestId &&
    payload.turnId === identity.turnId &&
    payload.userMessageId === identity.userMessageId &&
    payload.requestDigest === expectedInput &&
    agentTaskFactDigest(payload.input) === expectedInput &&
    (payload.runInput === undefined || agentTaskFactDigest(payload.runInput) === expectedInput) &&
    payload.fileContext === undefined
  );
}

function matchesCleanup(task: AgentTaskAccepted, cleanup: TaskExecutionCleanup): boolean {
  return (
    cleanup.launchClosed === true &&
    cleanup.pendingLaunches === 0 &&
    cleanup.cleanupComplete === true &&
    agentTaskFactDigest(cleanup.identity) === agentTaskFactDigest(agentTaskExecutionIdentity(task))
  );
}

function reconcilePreparation(
  parent: AgentTaskParentPrefix,
  summary: SessionAgentTask,
  task: AgentTaskAccepted,
  childCreated: boolean,
): AgentTaskReconciliation {
  if (summary.dispatched !== undefined) return blocked('dispatch-mismatch');
  if (parent.executionCleanup !== undefined) return blocked('cleanup-mismatch');
  const attached = parent.projectRelation === 'attached' || parent.projectRelation === 'tombstoned';
  const evidence = childCreated
    ? {
        stage: attached ? ('project-attached' as const) : ('child-created' as const),
        parentAcceptedSequence: summary.acceptedSequence,
        childOriginSequence: 2,
      }
    : { stage: 'accepted' as const, parentAcceptedSequence: summary.acceptedSequence };
  const stored = summary.settled?.settlement;
  const firstIntent = summary.cancellation?.reason;
  if (stored !== undefined) {
    if (
      stored.phase !== 'preparation' ||
      agentTaskFactDigest(stored.evidence) !== agentTaskFactDigest(evidence) ||
      (stored.status === 'cancelled' && firstIntent !== undefined && stored.reason !== firstIntent)
    )
      return blocked('settlement-mismatch');
    return { kind: 'settled', settlement: stored };
  }
  const preparation = parent.preparation;
  if (preparation === undefined) return { kind: 'preparing', stage: evidence.stage };
  if (
    !matchesCleanup(task, preparation.cleanup) ||
    preparation.cleanup.acceptance !== 'none' ||
    preparation.cleanup.exactAcceptanceAbsent !== true ||
    preparation.materializerClosed !== true ||
    preparation.pendingEffects !== 0
  )
    return blocked('cleanup-mismatch');
  const candidate = taskSettlementSchema.safeParse({
    phase: 'preparation',
    status: taskPreparationStatus(preparation.reason),
    reason: preparation.reason,
    resultKind: 'none',
    evidence,
  });
  if (
    !candidate.success ||
    (candidate.data.status === 'cancelled' &&
      firstIntent !== undefined &&
      candidate.data.reason !== firstIntent)
  )
    return blocked('cleanup-mismatch');
  return { kind: 'ready', settlement: candidate.data };
}

function collectAnswer(
  events: readonly SessionEvent[],
  turnStart: number,
  turnEnd: number,
  final: boolean,
): Pick<ExecutionSettlement, 'resultKind' | 'messageId' | 'preview' | 'previewTruncated'> & {
  readonly messageSequence?: number;
} {
  for (let index = turnEnd - 2; index >= turnStart; index -= 1) {
    const event = events[index];
    if (event?.type !== 'message.created' || event.payload.message.role !== 'assistant') continue;
    const { message, messageId } = event.payload;
    const text = message.content
      .flatMap((part) => (part.type === 'text' ? [part.text] : []))
      .join('');
    if (
      !message.toolCalls?.length &&
      text.trim().length > 0 &&
      taskIdentifierSchema.safeParse(messageId).success
    ) {
      const bytes = encoder.encode(text);
      const previewTruncated = bytes.length > taskPreviewMaxBytes;
      // Stream mode omits a trailing incomplete code point at the byte boundary.
      const preview = previewTruncated
        ? new TextDecoder('utf-8', { ignoreBOM: true }).decode(
            bytes.subarray(0, taskPreviewMaxBytes),
            { stream: true },
          )
        : text;
      return {
        resultKind: final ? 'final-answer' : 'partial',
        messageId,
        messageSequence: event.sequence,
        preview,
        previewTruncated,
      };
    }
    if (final) break;
  }
  return { resultKind: 'none', preview: '', previewTruncated: false };
}

function executionReason(
  finished: ExecutionFinished,
  turnEnd: Fact<'turn.completed'> | undefined,
  confirmedReason: TaskExecutionReason | undefined,
): TaskExecutionReason | undefined {
  switch (finished.payload.status) {
    case 'completed':
      return finished.payload.reason === 'agent-step-limit' ||
        turnEnd?.payload.reason === 'agent-step-limit'
        ? 'agent-step-limit'
        : undefined;
    case 'failed':
      return confirmedReason === 'generation-unavailable' ? confirmedReason : 'child-failed';
    case 'interrupted':
      return 'child-interrupted';
    case 'cancelled': {
      const reason = taskStopReasonSchema.safeParse(confirmedReason);
      return reason.success ? reason.data : 'task-cancelled';
    }
  }
}

function reconcileExecution(
  parent: AgentTaskParentPrefix,
  summary: SessionAgentTask,
  task: AgentTaskAccepted,
  events: readonly SessionEvent[],
  acceptance: ExecutionAccepted,
): AgentTaskReconciliation {
  if (parent.preparation !== undefined) return blocked('cleanup-mismatch');
  if (!matchesExecution(task, acceptance)) return blocked('execution-mismatch');
  if (parent.projectRelation !== 'attached' && parent.projectRelation !== 'tombstoned')
    return blocked('project-relation-mismatch');
  const digest = agentTaskFactDigest(acceptance.payload);
  const dispatch = summary.dispatched;
  if (
    dispatch !== undefined &&
    (dispatch.childExecutionAcceptedSequence !== acceptance.sequence ||
      dispatch.childExecutionAcceptedDigest !== digest)
  )
    return blocked('dispatch-mismatch');
  const missing =
    dispatch === undefined
      ? {
          missingDispatch: {
            version: 1 as const,
            taskId: task.taskId,
            childExecutionAcceptedSequence: acceptance.sequence,
            childExecutionAcceptedDigest: digest,
          },
        }
      : {};
  const stored = summary.settled?.settlement;
  if (stored?.phase === 'preparation') return blocked('settlement-mismatch');

  const execution = projectAgentExecutions(events)[0];
  if (execution === undefined) return blocked('execution-mismatch');
  const terminal =
    execution.durableThroughSequence === undefined
      ? undefined
      : events[execution.durableThroughSequence - 1];
  const cleanup = parent.executionCleanup;
  if (terminal?.type !== 'execution.finished') {
    if (stored !== undefined) return blocked('settlement-mismatch');
    if (cleanup !== undefined) return blocked('cleanup-mismatch');
    return { kind: 'executing', ...missing };
  }
  if (
    cleanup !== undefined &&
    (!matchesCleanup(task, cleanup) ||
      cleanup.acceptance !== 'accepted' ||
      cleanup.executionStatus !== terminal.payload.status ||
      cleanup.terminalSequence !== terminal.sequence)
  )
    return blocked('cleanup-mismatch');

  const started = events.find(
    (event): event is Fact<'turn.started'> => event.type === 'turn.started',
  );
  const ended = events.find(
    (event): event is Fact<'turn.completed'> => event.type === 'turn.completed',
  );
  const executionStatus = terminal.payload.status;
  if (started !== undefined) {
    const prompt = events.find(
      (event) =>
        event.type === 'message.created' && event.payload.messageId === task.childUserMessageId,
    );
    if (
      prompt?.type !== 'message.created' ||
      prompt.sequence <= acceptance.sequence ||
      prompt.sequence >= started.sequence ||
      agentTaskFactDigest(prompt.payload.message) !==
        agentTaskFactDigest(acceptance.payload.input.userMessage) ||
      ended === undefined ||
      ended.sequence <= started.sequence ||
      ended.sequence >= terminal.sequence ||
      ended.payload.status !== (executionStatus === 'interrupted' ? 'failed' : executionStatus)
    )
      return blocked('execution-mismatch');
  } else if (executionStatus === 'completed') return blocked('execution-mismatch');
  if (cleanup === undefined && stored === undefined)
    return { kind: 'awaiting-cleanup', ...missing };

  const firstIntent = summary.cancellation?.reason;
  if (executionStatus === 'cancelled' && firstIntent !== undefined) {
    const cleanupCause = taskStopReasonSchema.safeParse(cleanup?.reason);
    if (cleanupCause.success && cleanupCause.data !== firstIntent)
      return blocked('cleanup-mismatch');
    if (
      stored?.status === 'cancelled' &&
      stored.reason !== 'task-cancelled' &&
      stored.reason !== firstIntent
    )
      return blocked('settlement-mismatch');
  }
  // The settled parent fact attests the historical gate's selected closed reason.
  // Durable child status still determines whether that reason can apply.
  const reason = executionReason(terminal, ended, cleanup?.reason ?? stored?.reason);
  const status = reason === 'agent-step-limit' ? 'failed' : executionStatus;
  const { messageSequence, ...answer } = collectAnswer(
    events,
    started?.sequence ?? terminal.sequence,
    ended?.sequence ?? terminal.sequence,
    status === 'completed',
  );
  const candidate = cleanup?.resultCandidate;
  if (
    candidate !== undefined &&
    (candidate.messageId !== answer.messageId || candidate.messageSequence !== messageSequence)
  )
    return blocked('cleanup-mismatch');
  const result: ExecutionSettlement = {
    phase: 'execution',
    status,
    executionStatus,
    childExecutionId: task.childExecutionId,
    childTerminalSequence: terminal.sequence,
    ...(reason === undefined ? {} : { reason }),
    ...answer,
  };
  if (stored !== undefined) {
    if (agentTaskFactDigest(stored) !== agentTaskFactDigest(result))
      return blocked('settlement-mismatch');
    return { kind: 'settled', settlement: stored, ...missing };
  }
  return { kind: 'ready', settlement: result, ...missing };
}

/**
 * Reconcile independently read, complete prefixes. An omitted child prefix
 * means no exact read is available. An empty prefix is a confirmed absence.
 */
export function reconcileAgentTask(
  parent: AgentTaskParentPrefix,
  childPrefix?: readonly SessionEvent[],
): AgentTaskReconciliation {
  let summary: SessionAgentTask | undefined;
  try {
    summary = projectSession(parent.events).agentTasks?.tasks.find(
      ({ taskId }) => taskId === parent.taskId,
    );
  } catch {
    return blocked('parent-prefix-invalid');
  }
  if (summary === undefined) return blocked('task-not-found');
  const accepted = parent.events[summary.acceptedSequence - 1];
  if (accepted?.type !== 'agent.task.accepted' || !matchesParent(parent.events, accepted))
    return blocked('parent-mismatch');
  if (childPrefix === undefined) return blocked('child-prefix-unknown');
  if (parent.projectRelation === 'unknown') return blocked('project-relation-unknown');
  if (parent.projectRelation === 'conflict') return blocked('project-relation-mismatch');
  if (childPrefix.length === 0) {
    if (parent.projectRelation !== 'unattached') return blocked('project-relation-mismatch');
    return reconcilePreparation(parent, summary, accepted.payload, false);
  }

  try {
    const child = projectSession(childPrefix);
    const origin = childPrefix[1];
    if (
      child.sessionId !== accepted.payload.childSessionId ||
      origin?.type !== 'agent.task.origin' ||
      agentTaskFactDigest(origin.payload) !==
        agentTaskFactDigest(agentTaskOrigin(accepted.payload, accepted.sequence))
    )
      return blocked('origin-mismatch');
    if (parent.projectRelation === 'tombstoned' && child.deletedAt === undefined)
      return blocked('project-relation-mismatch');
    const execution = childPrefix.find(
      (event): event is ExecutionAccepted => event.type === 'execution.accepted',
    );
    if (execution === undefined) {
      if (
        child.messages.length > 0 ||
        child.turns.length > 0 ||
        projectAgentExecutions(childPrefix).length > 0
      )
        return blocked('execution-mismatch');
      return reconcilePreparation(parent, summary, accepted.payload, true);
    }
    return reconcileExecution(parent, summary, accepted.payload, childPrefix, execution);
  } catch {
    return blocked('child-prefix-invalid');
  }
}
