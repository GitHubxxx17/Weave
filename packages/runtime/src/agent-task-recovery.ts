import { taskStopReasonSchema, type TaskExecutionReason } from '@weave/protocol';
import { projectSession, type AgentTaskAccepted } from '@weave/session';
import { AgentTaskEvidenceError, type AgentTaskEvidence } from './agent-task-materialize.js';
import { agentTaskExecutionIdentity, reconcileAgentTask } from './agent-task-reconcile.js';
import type { AgentTaskReconciliation } from './agent-task-types.js';

type FinishedRecovery = Extract<AgentTaskReconciliation, { kind: 'ready' | 'settled' }>;

export function checkRecoveredTask(evidence: AgentTaskEvidence) {
  const result = reconcileAgentTask(evidence.parent, evidence.child);
  if (result.kind === 'blocked') throw new AgentTaskEvidenceError(result.reason);
  return result;
}

/** Only call after startup Execution recovery has checked this Session. */
export function settleRecoveredTask(
  task: AgentTaskAccepted,
  evidence: AgentTaskEvidence,
): FinishedRecovery {
  const stage = checkRecoveredTask(evidence);
  if (stage.kind === 'settled' || stage.kind === 'ready') return stage;

  const { parent, child } = evidence;
  const summary = projectSession(parent.events).agentTasks?.tasks.find(
    ({ taskId }) => taskId === task.taskId,
  );
  const firstStop = summary?.cancellation;
  const common = {
    identity: agentTaskExecutionIdentity(task),
    launchClosed: true,
    pendingLaunches: 0,
    cleanupComplete: true,
  } as const;

  let result: AgentTaskReconciliation;
  if (stage.kind === 'preparing') {
    result = reconcileAgentTask(
      {
        ...parent,
        preparation: {
          reason: firstStop?.reason ?? 'preparation-interrupted',
          materializerClosed: true,
          pendingEffects: 0,
          cleanup: { ...common, acceptance: 'none', exactAcceptanceAbsent: true },
        },
      },
      child,
    );
  } else {
    const terminal = child.find(
      (event) =>
        event.type === 'execution.finished' && event.payload.executionId === task.childExecutionId,
    );
    if (terminal?.type !== 'execution.finished')
      throw new AgentTaskEvidenceError('Recovered task execution is missing an exact terminal');
    const stop = taskStopReasonSchema.safeParse(terminal.payload.reason);
    let reason: TaskExecutionReason | undefined;
    if (terminal.payload.status === 'cancelled' && stop.success) reason = stop.data;
    else if (
      terminal.payload.status === 'failed' &&
      terminal.payload.reason === 'generation-unavailable'
    )
      reason = 'generation-unavailable';
    result = reconcileAgentTask(
      {
        ...parent,
        executionCleanup: {
          ...common,
          acceptance: 'accepted',
          executionStatus: terminal.payload.status,
          terminalSequence: terminal.sequence,
          ...(reason === undefined ? {} : { reason }),
        },
      },
      child,
    );
  }
  if (result.kind === 'ready' || result.kind === 'settled') return result;
  throw new AgentTaskEvidenceError(
    result.kind === 'blocked' ? result.reason : 'Recovered task remains unsettled',
  );
}
