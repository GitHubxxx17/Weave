import { taskStopReasonSchema, type TaskPreparationReason } from '@weave/protocol';
import type { SessionEvent } from '@weave/session';
import { AgentExecutionError } from './agent-execution-types.js';
import {
  mintTaskLaunchAuthority,
  type BoundTaskExecutionPort,
  type BoundTaskLaunch,
  type TaskLaunchAuthority,
} from './agent-task-execution.js';
import {
  AgentTaskHostError,
  type AgentTaskLifetime,
  type AgentTaskReservation,
} from './agent-task-host.js';
import {
  agentTaskExecutionIdentity,
  agentTaskExecutionInput,
  reconcileAgentTask,
} from './agent-task-reconcile.js';
import type { AgentTaskParentPrefix, TaskExecutionCleanup } from './agent-task-types.js';

export type AcceptedTaskFact = Extract<SessionEvent, { type: 'agent.task.accepted' }>;

export interface AgentTaskEvidence {
  readonly parent: AgentTaskParentPrefix;
  readonly child: readonly SessionEvent[];
}

export class AgentTaskEvidenceError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'AgentTaskEvidenceError';
  }
}

export class AgentTaskEvidenceConflict extends AgentTaskEvidenceError {}

function preparationReason(cause: unknown): TaskPreparationReason {
  if (cause instanceof AgentTaskHostError) return cause.reason;
  return 'preparation-failed';
}

export class AgentTaskMaterializer {
  private readonly authority: TaskLaunchAuthority;
  closed = false;
  reason: TaskPreparationReason | undefined;
  private cancellation?: Promise<void>;
  private created = false;
  private attached = false;
  private launch?: {
    readonly request: BoundTaskLaunch;
    readonly lease: ReturnType<AgentTaskReservation['bindRunner']>;
  };
  private launchIssue: unknown;
  private launchUncertain = false;
  private executionStarted = false;

  constructor(
    private readonly acceptance: AcceptedTaskFact,
    private readonly reservation: AgentTaskReservation,
    private readonly lifetime: AgentTaskLifetime,
    private readonly execution: BoundTaskExecutionPort,
    private readonly readEvidence: () => Promise<AgentTaskEvidence>,
    private readonly withTaskGate: <T>(operation: () => Promise<T>) => Promise<T>,
  ) {
    this.authority = mintTaskLaunchAuthority({
      accepted: acceptance.payload,
      parentAcceptedSequence: acceptance.sequence,
      getStopReason: lifetime.getStopReason,
    });
  }

  private async stage() {
    const { parent, child } = await this.readEvidence();
    const result = reconcileAgentTask(parent, child);
    if (result.kind === 'blocked') {
      if (result.reason === 'project-relation-unknown' || result.reason === 'child-prefix-unknown')
        throw new AgentTaskEvidenceError(result.reason);
      throw new AgentTaskEvidenceConflict(result.reason);
    }
    return result;
  }

  private assertOpen(): void {
    const reason = this.lifetime.getStopReason();
    if (reason !== undefined) throw new AgentTaskHostError(reason);
    this.reservation.assertCanStartSync();
  }

  private async checkpoint(): Promise<void> {
    this.assertOpen();
    await this.reservation.checkpoint();
    this.assertOpen();
  }

  private async launchExact(): Promise<void> {
    const { payload } = this.acceptance;
    if (this.launch === undefined) {
      const { sessionId, requestId, ...identity } = agentTaskExecutionIdentity(payload);
      this.launch = {
        request: { sessionId, requestId, identity, input: agentTaskExecutionInput(payload) },
        lease: this.reservation.bindRunner(this.authority),
      };
    }
    const { request, lease } = this.launch;
    try {
      await this.withTaskGate(async () => {
        this.assertOpen();
        await this.reservation.withLaunchAuthority(async () => {
          this.assertOpen();
          await this.execution.launchBoundTask(request, this.authority, lease);
          this.executionStarted = true;
        });
      });
    } catch (cause: unknown) {
      this.launchIssue = cause;
      this.launchUncertain =
        cause instanceof AgentExecutionError && cause.code === 'execution-admission-uncertain';
    }
    if (this.executionStarted) this.launchUncertain = false;
  }

  async advance(): Promise<void> {
    if (this.closed) return;
    const { payload, sequence } = this.acceptance;
    try {
      const initialStop = this.lifetime.getStopReason();
      if (initialStop !== undefined) {
        this.reason = initialStop;
        return;
      }
      let stage = await this.stage();
      if (stage.kind === 'preparing' && stage.stage === 'accepted' && !this.created) {
        await this.checkpoint();
        this.assertOpen();
        this.created = true;
        let issue: unknown;
        try {
          await this.reservation.createExact(payload, sequence);
        } catch (cause: unknown) {
          issue = cause;
        }
        stage = await this.stage();
        if (stage.kind === 'preparing' && stage.stage === 'accepted')
          throw issue ?? new Error('The child creation batch is absent');
      }
      if (stage.kind === 'preparing' && stage.stage === 'child-created' && !this.attached) {
        await this.checkpoint();
        this.assertOpen();
        this.attached = true;
        let issue: unknown;
        try {
          await this.reservation.attachExact(payload);
        } catch (cause: unknown) {
          issue = cause;
        }
        stage = await this.stage();
        if (stage.kind === 'preparing' && stage.stage === 'child-created')
          throw issue ?? new Error('The child Project attachment is absent');
      }
      if (
        stage.kind === 'preparing' &&
        stage.stage === 'project-attached' &&
        this.launch === undefined
      ) {
        await this.checkpoint();
        await this.launchExact();
        if (this.executionStarted) return;
        stage = await this.stage();
      }
      if (stage.kind !== 'preparing') {
        if (this.launch === undefined)
          throw new AgentTaskEvidenceError(
            'The child execution has no matching materializer launch',
          );
        if (this.launchUncertain) {
          // The child prefix confirms acceptance. Only the original binding may be reconciled.
          await this.checkpoint();
          await this.launchExact();
        }
        if (
          this.launchIssue instanceof AgentExecutionError &&
          this.launchIssue.code === 'execution-persistence-error'
        ) {
          // Exact acceptance is visible. The port owns terminal reconciliation and cleanup.
          this.executionStarted = true;
        }
        if (!this.executionStarted && this.lifetime.getStopReason() === undefined)
          throw new AgentTaskEvidenceError('The bound child execution could not be confirmed', {
            cause: this.launchIssue,
          });
      } else {
        if (this.executionStarted)
          throw new AgentTaskEvidenceError('Confirmed child execution acceptance is missing');
        throw this.launchIssue ?? new Error('Task preparation did not produce an execution');
      }
    } catch (cause: unknown) {
      if (
        cause instanceof AgentTaskEvidenceError &&
        !(cause instanceof AgentTaskEvidenceConflict) &&
        this.lifetime.getStopReason() === undefined
      )
        throw cause;
      this.reason = this.lifetime.getStopReason() ?? preparationReason(cause);
      const stop = taskStopReasonSchema.safeParse(this.reason);
      if (stop.success) this.lifetime.requestStop(stop.data);
    } finally {
      if (
        this.executionStarted ||
        this.reason !== undefined ||
        this.lifetime.getStopReason() !== undefined
      )
        this.closed = true;
    }
  }

  cancelBound(): Promise<void> {
    this.cancellation ??= this.execution.cancelBoundTask(this.authority).then(
      () => {},
      (cause: unknown) => {
        delete this.cancellation;
        throw cause;
      },
    );
    return this.cancellation;
  }

  async whenSettled(): Promise<TaskExecutionCleanup> {
    if (!this.closed) throw new AgentTaskEvidenceError('The materializer still owns start effects');
    if (this.reason !== undefined || this.lifetime.getStopReason() !== undefined)
      await this.cancelBound();
    return this.execution.whenSettled(this.authority);
  }
}
