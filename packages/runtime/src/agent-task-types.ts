import type {
  TaskExecutionReason,
  TaskExecutionStatus,
  TaskPreparationReason,
  TaskSettlement,
} from '@weave/protocol';
import type { AgentTaskDispatched, SessionEvent } from '@weave/session';

export interface BoundTaskIdentity {
  readonly sessionId: string;
  readonly requestId: string;
  readonly executionId: string;
  readonly turnId: string;
  readonly userMessageId: string;
}

interface TaskExecutionCleanupBase {
  readonly identity: BoundTaskIdentity;
  readonly launchClosed: true;
  readonly pendingLaunches: 0;
  readonly cleanupComplete: true;
}

export type TaskExecutionCleanup =
  | (TaskExecutionCleanupBase & {
      readonly acceptance: 'none';
      readonly exactAcceptanceAbsent: true;
    })
  | (TaskExecutionCleanupBase & {
      readonly acceptance: 'accepted';
      readonly executionStatus: TaskExecutionStatus;
      readonly terminalSequence: number;
      readonly reason?: TaskExecutionReason;
      readonly resultCandidate?: { readonly messageId: string; readonly messageSequence: number };
    });

export type TaskProjectRelation = 'attached' | 'unattached' | 'tombstoned' | 'conflict' | 'unknown';

export interface AgentTaskParentPrefix {
  readonly events: readonly SessionEvent[];
  readonly taskId: string;
  /** Server checks this task's exact parent/child ownership in the accepted Project. */
  readonly projectRelation: TaskProjectRelation;
  readonly preparation?: {
    readonly reason: TaskPreparationReason;
    readonly materializerClosed: true;
    readonly pendingEffects: 0;
    readonly cleanup: Extract<TaskExecutionCleanup, { acceptance: 'none' }>;
  };
  readonly executionCleanup?: Extract<TaskExecutionCleanup, { acceptance: 'accepted' }>;
}

export type AgentTaskReconciliationBlock =
  | 'parent-prefix-invalid'
  | 'task-not-found'
  | 'parent-mismatch'
  | 'child-prefix-unknown'
  | 'child-prefix-invalid'
  | 'origin-mismatch'
  | 'project-relation-unknown'
  | 'project-relation-mismatch'
  | 'execution-mismatch'
  | 'dispatch-mismatch'
  | 'cleanup-mismatch'
  | 'settlement-mismatch';

export type AgentTaskReconciliation =
  | { readonly kind: 'blocked'; readonly reason: AgentTaskReconciliationBlock }
  | {
      readonly kind: 'preparing';
      readonly stage: 'accepted' | 'child-created' | 'project-attached';
    }
  | { readonly kind: 'executing'; readonly missingDispatch?: AgentTaskDispatched }
  | { readonly kind: 'awaiting-cleanup'; readonly missingDispatch?: AgentTaskDispatched }
  | {
      readonly kind: 'ready';
      readonly settlement: TaskSettlement;
      readonly missingDispatch?: AgentTaskDispatched;
    }
  | {
      readonly kind: 'settled';
      readonly settlement: TaskSettlement;
      readonly missingDispatch?: AgentTaskDispatched;
    };
