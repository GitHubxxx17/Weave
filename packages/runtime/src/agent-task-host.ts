import type { TaskAccess, TaskPreparationReason, TaskStopReason } from '@weave/protocol';
import type { AgentTaskAccepted } from '@weave/session';
import type { TaskLaunchAuthority, TaskRunnerLease } from './agent-task-execution.js';
import type { BoundTaskIdentity, TaskProjectRelation } from './agent-task-types.js';
import type { ToolExecutionContext } from './tool-types.js';

export interface AgentTaskLifetime {
  readonly signal: AbortSignal;
  getStopReason(): TaskStopReason | undefined;
  /** Permanently closes starts before submitting any durable work outside the caller's gate. */
  requestStop(reason: TaskStopReason): void;
}

export interface AgentTaskReservation {
  readonly project: AgentTaskAccepted['project'];
  readonly tools: AgentTaskAccepted['tools'];
  assertCanStartSync(): void;
  checkpoint(): Promise<void>;
  createExact(accepted: AgentTaskAccepted, parentAcceptedSequence: number): Promise<void>;
  attachExact(accepted: AgentTaskAccepted): Promise<void>;
  withLaunchAuthority<T>(operation: () => Promise<T>): Promise<T>;
  bindRunner(authority: TaskLaunchAuthority): TaskRunnerLease;
  /** Idempotent, synchronous fence that leaves cooperative abort to the task lifetime. */
  closeStarts(reason: TaskStopReason): void;
  /** Idempotent release of the Project and Generation pin. */
  release(): void;
}

export interface AgentTaskHost {
  /** Authenticates the genuine invocation, captures the Project and retains the running Generation. */
  reserve(input: {
    readonly context: ToolExecutionContext;
    readonly child: BoundTaskIdentity;
    readonly access: TaskAccess;
    readonly lifetime: AgentTaskLifetime;
  }): Promise<AgentTaskReservation>;
  projectRelation(accepted: AgentTaskAccepted): Promise<TaskProjectRelation>;
}

export class AgentTaskHostError extends Error {
  constructor(
    readonly reason: TaskPreparationReason,
    options?: ErrorOptions,
  ) {
    super('The task host could not continue materialization', options);
    this.name = 'AgentTaskHostError';
  }
}
