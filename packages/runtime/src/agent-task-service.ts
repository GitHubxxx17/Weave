import { randomUUID } from 'node:crypto';
import {
  agentTaskCancelInputSchema,
  agentTaskSpawnInputSchema,
  taskIdentifierSchema,
  taskStopReasonSchema,
  type AgentTaskView,
  type AgentTaskViewStatus,
  type TaskPreparationReason,
  type TaskStopReason,
} from '@weave/protocol';
import {
  agentTaskAcceptedPayloadSchema,
  agentTaskFactDigest,
  projectSession,
  type AgentTaskAccepted,
  type AgentTaskCancelRequested,
  type NewSessionEvent,
  type SessionEvent,
  type SessionEventStore,
} from '@weave/session';
import type { BoundTaskExecutionPort } from './agent-task-execution.js';
import type { AgentTaskHost, AgentTaskLifetime, AgentTaskReservation } from './agent-task-host.js';
import {
  AgentTaskEvidenceConflict,
  AgentTaskEvidenceError,
  AgentTaskMaterializer,
  type AcceptedTaskFact,
  type AgentTaskEvidence,
} from './agent-task-materialize.js';
import { agentTaskRequestDigest, reconcileAgentTask } from './agent-task-reconcile.js';
import { checkRecoveredTask, settleRecoveredTask } from './agent-task-recovery.js';
import type {
  AgentTaskReconciliation,
  BoundTaskIdentity,
  TaskExecutionCleanup,
} from './agent-task-types.js';
import {
  deriveAgentToolAuthority,
  describeAgentToolAuthority,
  readAgentToolAuthority,
  type AgentToolInvocationAuthority,
} from './agent-tool-authority.js';
import type { ToolExecutionContext } from './tool-types.js';

const maxRootTasks = 4;
const maxProcessTasks = 16;
const maxTurnTasks = 16;
const taskDeadlineMs = 600_000;

export type AgentTaskErrorCode =
  | 'agent-task-invalid-input'
  | 'agent-task-not-permitted'
  | 'agent-task-not-found'
  | 'agent-task-request-conflict'
  | 'agent-task-capacity'
  | 'agent-task-closed'
  | 'agent-task-busy'
  | 'agent-task-persistence-error';

export class AgentTaskError extends Error {
  constructor(
    readonly code: AgentTaskErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'AgentTaskError';
  }
}

export interface AgentTaskSpawnReceipt {
  readonly taskId: string;
  readonly childSessionId: string;
  readonly status: 'preparing';
  readonly cursor: string;
}

export interface AgentTaskServiceOptions {
  readonly sessionStore: SessionEventStore;
  readonly execution: BoundTaskExecutionPort;
  readonly host: AgentTaskHost;
}

export interface AgentTaskService {
  spawn(input: unknown, context: ToolExecutionContext): Promise<AgentTaskSpawnReceipt>;
  stopParentTurn(
    rootSessionId: string,
    parentTurnId: string,
    operationId: string,
  ): Promise<readonly AgentTaskView[]>;
  stopAll(rootSessionId: string, operationId: string): Promise<readonly AgentTaskView[]>;
  withTaskSessionsIdle<T>(sessionId: string, operation: () => Promise<T>): Promise<T>;
  /** Startup only. The callback repairs durable Execution facts without launching a runner. */
  recover(
    rootSessionIds: readonly string[],
    recoverExecutions: (sessionIds: readonly string[]) => Promise<void>,
  ): Promise<void>;
  requestCancel(
    rootSessionId: string,
    taskIds: readonly string[],
    operationId: string,
    reason: TaskStopReason,
  ): Promise<readonly AgentTaskView[]>;
  snapshot(rootSessionId: string): readonly AgentTaskView[];
  subscribe(listener: (rootSessionId: string) => void): () => void;
  retry(rootSessionId?: string): Promise<void>;
  closeSync(): void;
  drain(): Promise<void>;
}

type TaskFact = Extract<NewSessionEvent, { type: `agent.task.${string}` }>;
type StoredFact = Extract<SessionEvent, { type: TaskFact['type'] }>;
type SettledFact = Extract<StoredFact, { type: 'agent.task.settled' }>;

interface TaskControl {
  readonly lifetime: AgentTaskLifetime;
  readonly controller: AbortController;
  deadlineAt?: number;
  reason?: TaskStopReason;
}

interface TaskRecord {
  readonly payload: AgentTaskAccepted;
  readonly control: TaskControl;
  reservation?: AgentTaskReservation;
  acceptance?: AcceptedTaskFact;
  receipt?: AgentTaskSpawnReceipt;
  materializer?: AgentTaskMaterializer;
  cleanup?: TaskExecutionCleanup;
  preparationReason?: TaskPreparationReason;
  deadline?: NodeJS.Timeout;
  job?: Promise<void>;
  cancelJob?: Promise<void>;
  stopJob?: Promise<void>;
  pendingCancel?: AgentTaskCancelRequested;
  cancelConfirmed?: true;
  view?: AgentTaskView;
  issue?: unknown;
  settled?: SettledFact;
  recovered?: { readonly hadSettlement: boolean; executionChecked: boolean };
}

interface StopAllOperation {
  readonly taskIds: readonly string[];
  confirmed: boolean;
}

function persistence(message: string, cause?: unknown): AgentTaskError {
  return new AgentTaskError('agent-task-persistence-error', message, { cause });
}

function denied(): AgentTaskError {
  return new AgentTaskError(
    'agent-task-not-permitted',
    'Task requires a running root agent_spawn call',
  );
}

function exactInvocation(context: ToolExecutionContext): AgentToolInvocationAuthority {
  try {
    const caller = readAgentToolAuthority(context);
    if (caller.toolName === 'agent_spawn') return caller;
  } catch {
    // Only Pipeline-marked contexts can authorize initial admission.
  }
  throw denied();
}

function makeView(
  acceptance: AcceptedTaskFact,
  status: AgentTaskViewStatus,
  settled?: SettledFact,
): AgentTaskView {
  const {
    taskId,
    rootSessionId,
    parentSessionId,
    parentTurnId,
    childSessionId,
    childExecutionId,
    childTurnId,
    title,
    access,
  } = acceptance.payload;
  const settlement = settled?.payload.settlement;
  const execution = settlement?.phase === 'execution' ? settlement : undefined;
  return {
    taskId,
    rootSessionId,
    parentSessionId,
    parentTurnId,
    childSessionId,
    childExecutionId,
    childTurnId,
    title,
    access,
    acceptedAt: acceptance.occurredAt,
    status,
    resultKind: execution?.resultKind ?? 'none',
    preview: execution?.preview ?? '',
    previewTruncated: execution?.previewTruncated ?? false,
    pendingApprovalIds: [],
    pendingApprovalCount: 0,
    ...(settled === undefined ? {} : { settledAt: settled.occurredAt }),
    ...(settlement?.reason === undefined ? {} : { reason: settlement.reason }),
    ...(execution?.messageId === undefined
      ? {}
      : {
          result: {
            sessionId: childSessionId,
            executionId: childExecutionId,
            turnId: childTurnId,
            messageId: execution.messageId,
            terminalSequence: execution.childTerminalSequence,
          },
        }),
  };
}

function checkParent(events: readonly SessionEvent[], caller: AgentToolInvocationAuthority): void {
  if (events.length === 0) throw denied();
  const parent = projectSession(events);
  const { sessionId, executionId, turnId, userMessageId } = caller.identity;
  if (
    parent.sessionId !== sessionId ||
    parent.agentTasks?.origin !== undefined ||
    parent.deletedAt !== undefined ||
    parent.archivedAt !== undefined
  )
    throw denied();
  const accepted = events.find(
    (event) => event.type === 'execution.accepted' && event.payload.executionId === executionId,
  );
  const started = events.find(
    (event) => event.type === 'turn.started' && event.payload.turnId === turnId,
  );
  if (
    accepted?.type !== 'execution.accepted' ||
    started?.type !== 'turn.started' ||
    accepted.payload.turnId !== turnId ||
    accepted.payload.userMessageId !== userMessageId ||
    started.payload.executionId !== executionId ||
    started.payload.userMessageId !== userMessageId ||
    started.sequence <= accepted.sequence ||
    (accepted.payload.dispatch === 'queued' &&
      !events.some(
        (event) =>
          event.type === 'execution.claimed' &&
          event.payload.executionId === executionId &&
          event.sequence > accepted.sequence &&
          event.sequence < started.sequence,
      )) ||
    !events.some(
      (event) =>
        event.type === 'tool-call.created' &&
        event.sequence > started.sequence &&
        event.payload.turnId === turnId &&
        event.payload.toolCall.name === 'agent_spawn' &&
        event.payload.toolCall.id === caller.toolCallId,
    ) ||
    events.some(
      (event) =>
        (event.type === 'execution.finished' && event.payload.executionId === executionId) ||
        (event.type === 'turn.completed' && event.payload.turnId === turnId) ||
        (event.type === 'tool-result.created' &&
          event.payload.turnId === turnId &&
          event.payload.toolCallId === caller.toolCallId),
    )
  )
    throw denied();
}

export function createAgentTaskService(options: AgentTaskServiceOptions): AgentTaskService {
  const { sessionStore, execution, host } = options;
  const listeners = new Set<(rootSessionId: string) => void>();
  const records = new Map<string, TaskRecord>();
  const stoppedTurns = new Map<string, Set<string>>();
  const stopAllTargets = new Map<string, Map<string, StopAllOperation>>();
  const genuineCalls = new WeakMap<ToolExecutionContext, AgentToolInvocationAuthority>();
  let closed = false;
  let admittedLiveTask = false;
  let recoverExecutions: Parameters<AgentTaskService['recover']>[1] | undefined;
  let tail = Promise.resolve();

  const gate = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = tail.then(operation);
    tail = result.then(
      () => {},
      () => {},
    );
    return result;
  };

  const changed = (rootSessionId: string): void => {
    if (listeners.size === 0) return;
    void tail.then(() => {
      for (const listener of [...listeners]) {
        try {
          listener(rootSessionId);
        } catch {
          /* Controls do not depend on observers. */
        }
      }
    });
  };

  const transition = (record: TaskRecord, status: AgentTaskViewStatus): void => {
    if (record.acceptance === undefined || record.view?.status === status) return;
    record.view = makeView(record.acceptance, status, record.settled);
    changed(record.payload.rootSessionId);
  };

  const release = (record: TaskRecord): void => {
    clearTimeout(record.deadline);
    record.reservation?.release();
    delete record.reservation;
    delete record.deadline;
  };

  const readParent = async (root: string): Promise<readonly SessionEvent[]> => {
    try {
      const events = await sessionStore.read(root);
      if (events.length === 0 || projectSession(events).sessionId !== root)
        throw new Error('The root Session prefix is missing');
      return events;
    } catch (cause: unknown) {
      throw new AgentTaskEvidenceError('The parent task prefix could not be read', { cause });
    }
  };

  const findFact = (events: readonly SessionEvent[], input: TaskFact): StoredFact | undefined => {
    const exact = events.find((event): event is StoredFact => {
      if (event.type !== input.type) return false;
      if (event.payload.taskId !== input.payload.taskId) return false;
      return (
        event.type !== 'agent.task.cancel-requested' ||
        input.type !== 'agent.task.cancel-requested' ||
        event.payload.operationId === input.payload.operationId
      );
    });
    if (
      exact !== undefined &&
      agentTaskFactDigest(exact.payload) !== agentTaskFactDigest(input.payload)
    )
      throw new AgentTaskEvidenceError('The existing task fact conflicts with the requested fact');
    return exact;
  };

  const appendFact = async (root: string, input: TaskFact): Promise<StoredFact | undefined> => {
    try {
      const appended = await sessionStore.append(root, [input]);
      const fact = findFact(appended, input);
      if (fact?.sessionId === root) return fact;
    } catch {
      // A lost response can follow a successful append. Read the original fact.
    }
    return findFact(await readParent(root), input);
  };

  const confirmStopAll = async (
    root: string,
    operationId: string,
    operation: StopAllOperation,
  ): Promise<void> => {
    if (operation.confirmed) return;
    const { taskIds } = operation;
    const matchesTargets = (actual: readonly string[]) =>
      actual.length === taskIds.length && taskIds.every((id) => actual.includes(id));
    const readReceipt = async () => {
      const projection = projectSession(await readParent(root));
      if (projection.agentTasks?.origin !== undefined) throw denied();
      const receipt = projection.agentTasks?.stopOperations?.find(
        (entry) => entry.operationId === operationId,
      );
      if (receipt === undefined) {
        if (projection.deletedAt !== undefined)
          throw new AgentTaskError('agent-task-not-found', 'The root Session was deleted');
        return false;
      }
      if (!matchesTargets(receipt.taskIds))
        throw new AgentTaskError(
          'agent-task-request-conflict',
          'Stop All operation targets conflict',
        );
      return true;
    };
    try {
      // Check lifecycle under the Task gate before appending a new receipt.
      if (!(await readReceipt())) {
        let appended = false;
        try {
          const [receipt] = await sessionStore.append(root, [
            {
              type: 'agent.tasks.stop-requested',
              payload: { version: 1, operationId, taskIds },
            },
          ]);
          appended =
            receipt?.type === 'agent.tasks.stop-requested' &&
            receipt.sessionId === root &&
            receipt.payload.operationId === operationId &&
            matchesTargets(receipt.payload.taskIds);
        } catch {
          // Read the original operation when the Store response was lost.
        }
        if (!appended && !(await readReceipt()))
          throw persistence('Stop All operation did not commit');
      }
      operation.confirmed = true;
    } catch (cause: unknown) {
      if (cause instanceof AgentTaskError) throw cause;
      throw persistence('Stop All targets could not be confirmed', cause);
    }
  };

  const readEvidence = async (record: TaskRecord): Promise<AgentTaskEvidence> => {
    const { rootSessionId, childSessionId, taskId } = record.payload;
    try {
      const [parentRead, childRead, relationRead] = await Promise.allSettled([
        readParent(rootSessionId),
        sessionStore.read(childSessionId),
        host.projectRelation(record.payload),
      ]);
      if (parentRead.status === 'rejected') throw parentRead.reason;
      if (childRead.status === 'rejected') throw childRead.reason;
      if (relationRead.status === 'rejected') throw relationRead.reason;
      const { value: events } = parentRead;
      const { value: child } = childRead;
      const { value: projectRelation } = relationRead;
      if (
        findFact(events, { type: 'agent.task.accepted', payload: record.payload })?.sequence !==
        record.acceptance?.sequence
      )
        throw new AgentTaskEvidenceConflict('The exact parent acceptance disappeared');
      if (
        child.length > 0 &&
        (child[0]?.type !== 'session.created' ||
          agentTaskFactDigest(child[0].payload) !==
            agentTaskFactDigest({ title: record.payload.title }))
      )
        throw new AgentTaskEvidenceConflict('The child creation batch has an unexpected title');
      return { parent: { events, taskId, projectRelation }, child };
    } catch (cause: unknown) {
      if (cause instanceof AgentTaskEvidenceConflict) throw cause;
      throw new AgentTaskEvidenceError('The task evidence could not be confirmed', { cause });
    }
  };

  const flushCancellation = async (record: TaskRecord): Promise<void> => {
    if (
      record.pendingCancel === undefined ||
      record.cancelConfirmed ||
      record.settled !== undefined
    )
      return;
    const { rootSessionId } = record.payload;
    const { operationId } = record.pendingCancel;
    const operation = stopAllTargets.get(rootSessionId)?.get(operationId);
    if (operation?.taskIds.includes(record.payload.taskId) === true)
      await confirmStopAll(rootSessionId, operationId, operation);
    const fact = await appendFact(record.payload.rootSessionId, {
      type: 'agent.task.cancel-requested',
      payload: record.pendingCancel,
    });
    if (fact === undefined) throw persistence('The task cancellation intent did not commit');
    record.cancelConfirmed = true;
  };

  const commitReconciliation = async (
    record: TaskRecord,
    result: AgentTaskReconciliation,
    events: readonly SessionEvent[],
  ): Promise<void> => {
    if (result.kind === 'blocked') throw new AgentTaskEvidenceError(result.reason);
    const root = record.payload.rootSessionId;
    if ('missingDispatch' in result && result.missingDispatch !== undefined) {
      const dispatched = await appendFact(root, {
        type: 'agent.task.dispatched',
        payload: result.missingDispatch,
      });
      if (dispatched === undefined) throw persistence('The child dispatch did not commit');
    }
    if (result.kind === 'ready' || result.kind === 'settled') {
      const payload = {
        version: 1 as const,
        taskId: record.payload.taskId,
        settlement: result.settlement,
      };
      const fact =
        result.kind === 'settled'
          ? findFact(events, { type: 'agent.task.settled', payload })
          : await appendFact(root, { type: 'agent.task.settled', payload });
      if (fact?.type !== 'agent.task.settled')
        throw persistence('The task settlement did not commit');
      record.settled = fact;
      transition(record, result.settlement.status);
    } else if (record.control.reason !== undefined) transition(record, 'cancelling');
    else if (result.kind !== 'preparing') transition(record, 'running');
  };

  const confirmParentProgress = async (record: TaskRecord): Promise<void> => {
    await gate(async () => {
      const { parent, child } = await readEvidence(record);
      const cleanup = record.cleanup;
      await flushCancellation(record);
      const events = record.cancelConfirmed
        ? await readParent(record.payload.rootSessionId)
        : parent.events;
      const result = reconcileAgentTask(
        {
          ...parent,
          events,
          ...(cleanup?.acceptance === 'accepted' ? { executionCleanup: cleanup } : {}),
          ...(cleanup?.acceptance === 'none' && record.preparationReason !== undefined
            ? {
                preparation: {
                  reason: record.preparationReason,
                  materializerClosed: true,
                  pendingEffects: 0,
                  cleanup,
                },
              }
            : {}),
        },
        child,
      );
      await commitReconciliation(record, result, events);
    });
  };

  const markBlocked = (record: TaskRecord, cause: unknown): void => {
    record.issue = cause;
    transition(record, 'blocked');
  };

  const abort = (record: TaskRecord): void => {
    const reason = record.control.reason;
    if (reason === undefined || record.settled !== undefined) return;
    record.control.controller.abort(reason);
    const materializer = record.materializer;
    if (
      materializer?.closed !== true ||
      record.cleanup !== undefined ||
      record.cancelJob !== undefined
    )
      return;
    record.cancelJob = (async () => {
      try {
        await materializer.cancelBound();
      } catch (cause: unknown) {
        markBlocked(record, cause);
      } finally {
        delete record.cancelJob;
      }
    })();
  };

  const runTask = async (record: TaskRecord): Promise<void> => {
    const materializer = record.materializer;
    if (materializer !== undefined && record.cleanup === undefined) {
      await materializer.advance();
      if (materializer.reason === undefined) {
        try {
          await confirmParentProgress(record);
        } catch (cause: unknown) {
          markBlocked(record, cause);
        }
      }
      abort(record);
      record.cleanup = await materializer.whenSettled();
      if (record.cleanup.acceptance === 'none' && materializer.reason !== undefined)
        record.preparationReason = materializer.reason;
      delete record.materializer;
    }
    release(record);
    await confirmParentProgress(record);
    delete record.issue;
  };

  const schedule = (record: TaskRecord): void => {
    if (
      (record.materializer === undefined && record.cleanup === undefined) ||
      record.job !== undefined ||
      record.settled !== undefined
    )
      return;
    record.job = new Promise<void>((resolve) => {
      setImmediate(() => {
        void runTask(record)
          .catch((cause: unknown) => markBlocked(record, cause))
          .finally(() => {
            delete record.job;
            resolve();
          });
      });
    });
  };

  const confirmAcceptance = (
    record: TaskRecord,
    acceptance: AcceptedTaskFact,
  ): AgentTaskSpawnReceipt => {
    record.acceptance = acceptance;
    record.receipt = Object.freeze({
      taskId: record.payload.taskId,
      childSessionId: record.payload.childSessionId,
      status: 'preparing',
      cursor: `task:${record.payload.taskId}:${acceptance.sequence}`,
    });
    record.materializer = new AgentTaskMaterializer(
      acceptance,
      record.reservation!,
      record.control.lifetime,
      execution,
      () => readEvidence(record),
      gate,
    );
    record.control.deadlineAt = Date.parse(acceptance.occurredAt) + taskDeadlineMs;
    record.deadline = setTimeout(
      () => record.control.lifetime.requestStop('task-deadline'),
      Math.max(0, record.control.deadlineAt - Date.now()),
    );
    record.deadline.unref();
    transition(record, 'preparing');
    schedule(record);
    return record.receipt;
  };

  const reconcileAcceptance = async (
    record: TaskRecord,
  ): Promise<AgentTaskSpawnReceipt | undefined> => {
    const fact = findFact(await readParent(record.payload.rootSessionId), {
      type: 'agent.task.accepted',
      payload: record.payload,
    });
    if (fact?.type === 'agent.task.accepted') return confirmAcceptance(record, fact);
    release(record);
    records.delete(record.payload.taskId);
    return undefined;
  };

  const fence = (record: TaskRecord, reason: TaskStopReason): void => {
    if (record.control.reason !== undefined || record.settled !== undefined) return;
    record.control.reason = reason;
    record.reservation?.closeStarts(reason);
  };

  const makeControl = (getRecord: () => TaskRecord | undefined): TaskControl => {
    const controller = new AbortController();
    const control: TaskControl = {
      controller,
      lifetime: {
        signal: controller.signal,
        getStopReason() {
          if (
            control.reason === undefined &&
            control.deadlineAt !== undefined &&
            Date.now() >= control.deadlineAt
          )
            control.lifetime.requestStop('task-deadline');
          return control.reason;
        },
        requestStop(reason) {
          if (control.reason !== undefined) return;
          const record = getRecord();
          if (record === undefined) {
            control.reason = reason;
            return;
          }
          if (record.settled !== undefined) return;
          record.pendingCancel ??= {
            version: 1,
            taskId: record.payload.taskId,
            operationId: randomUUID(),
            reason,
          };
          fence(record, record.pendingCancel.reason);
          // Project and Execution callers can synchronously fence without re-entering Task admission.
          record.stopJob = new Promise<void>((resolve) => {
            setImmediate(() => {
              void gate(async () => {
                if (record.acceptance === undefined || record.settled !== undefined) return;
                await flushCancellation(record);
                transition(record, 'cancelling');
              })
                .catch((cause: unknown) => markBlocked(record, cause))
                .finally(() => {
                  abort(record);
                  schedule(record);
                  delete record.stopJob;
                  resolve();
                });
            });
          });
        },
      },
    };
    return control;
  };

  const spawn: AgentTaskService['spawn'] = async (input, context) => {
    const parsed = agentTaskSpawnInputSchema.safeParse(input);
    if (!parsed.success)
      throw new AgentTaskError('agent-task-invalid-input', 'Invalid task parameters');
    const caller = genuineCalls.get(context) ?? exactInvocation(context);
    genuineCalls.set(context, caller);
    const { sessionId: root, executionId, turnId } = caller.identity;
    const requestDigest = agentTaskRequestDigest(parsed.data);
    return gate(async () => {
      const sameCall = (task: AgentTaskAccepted) =>
        task.rootSessionId === root &&
        task.parentTurnId === turnId &&
        task.parentToolCallId === caller.toolCallId;
      const previous = [...records.values()].find(({ payload }) => sameCall(payload));
      const replay = (fact: AgentTaskAccepted): void => {
        if (fact.requestDigest !== requestDigest)
          throw new AgentTaskError(
            'agent-task-request-conflict',
            'This spawn call already has different arguments',
          );
      };
      if (previous !== undefined) {
        replay(previous.payload);
        if (previous.receipt !== undefined) return previous.receipt;
        try {
          const receipt = await reconcileAcceptance(previous);
          if (receipt !== undefined) return receipt;
        } catch (cause: unknown) {
          throw persistence('The previous task acceptance is uncertain', cause);
        }
      }
      const parent = await readParent(root);
      const durablyAccepted = parent.filter(
        (event): event is AcceptedTaskFact => event.type === 'agent.task.accepted',
      );
      const durableReplay = durablyAccepted.find(({ payload }) => sameCall(payload));
      if (durableReplay !== undefined) {
        replay(durableReplay.payload);
        return {
          taskId: durableReplay.payload.taskId,
          childSessionId: durableReplay.payload.childSessionId,
          status: 'preparing',
          cursor: `task:${durableReplay.payload.taskId}:${durableReplay.sequence}`,
        };
      }
      if (closed) throw new AgentTaskError('agent-task-closed', 'Task admission is closed');
      if (stoppedTurns.get(root)?.has(turnId)) throw denied();
      exactInvocation(context);
      checkParent(parent, caller);
      const owned = [...records.values()].filter((record) => record.settled === undefined);
      const rootOwned = new Set(
        owned
          .filter(({ payload }) => payload.rootSessionId === root)
          .map(({ payload }) => payload.taskId),
      );
      for (const task of projectSession(parent).agentTasks?.tasks ?? []) {
        if (task.settled === undefined) rootOwned.add(task.taskId);
      }
      const acceptedThisTurn = new Set(
        durablyAccepted
          .filter(({ payload }) => payload.parentTurnId === turnId)
          .map(({ payload }) => payload.taskId),
      );
      for (const { payload } of owned) {
        if (payload.rootSessionId === root && payload.parentTurnId === turnId)
          acceptedThisTurn.add(payload.taskId);
      }
      if (
        owned.length >= maxProcessTasks ||
        rootOwned.size >= maxRootTasks ||
        acceptedThisTurn.size >= maxTurnTasks
      )
        throw new AgentTaskError('agent-task-capacity', 'Agent task capacity is full');
      const taskId = randomUUID();
      const child: BoundTaskIdentity = {
        sessionId: randomUUID(),
        executionId: randomUUID(),
        turnId: randomUUID(),
        userMessageId: randomUUID(),
        requestId: `agent-task:${taskId}`,
      };
      const { access } = parsed.data;
      const tools = describeAgentToolAuthority(
        deriveAgentToolAuthority(context, { identity: child, access }),
      ).tools;
      let record: TaskRecord | undefined;
      const control = makeControl(() => record);
      let reservation: AgentTaskReservation | undefined;
      try {
        reservation = await host.reserve({ context, child, access, lifetime: control.lifetime });
        if (closed) throw new AgentTaskError('agent-task-closed', 'Task admission is closed');
        checkParent(await readParent(root), exactInvocation(context));
        if (closed) throw new AgentTaskError('agent-task-closed', 'Task admission is closed');
        reservation.assertCanStartSync();
        if (control.reason !== undefined) throw denied();
        if (agentTaskFactDigest(reservation.tools) !== agentTaskFactDigest(tools)) throw denied();
        const payload = agentTaskAcceptedPayloadSchema.parse({
          version: 1,
          taskId,
          rootSessionId: root,
          parentSessionId: root,
          parentExecutionId: executionId,
          parentTurnId: turnId,
          parentToolCallId: caller.toolCallId,
          childSessionId: child.sessionId,
          childExecutionId: child.executionId,
          childTurnId: child.turnId,
          childUserMessageId: child.userMessageId,
          requestId: child.requestId,
          requestDigest,
          depth: 1,
          ...parsed.data,
          settings: caller.settings,
          tools,
          project: reservation.project,
        });
        record = { payload, reservation, control };
      } catch (cause: unknown) {
        reservation?.release();
        if (cause instanceof AgentTaskError) throw cause;
        throw new AgentTaskError('agent-task-not-permitted', 'Task host admission failed', {
          cause,
        });
      }
      records.set(taskId, record);
      admittedLiveTask = true;
      let acceptance: StoredFact | undefined;
      try {
        acceptance = await appendFact(root, {
          type: 'agent.task.accepted',
          payload: record.payload,
        });
      } catch (cause: unknown) {
        record.issue = cause;
        throw persistence('Task acceptance could not be confirmed', cause);
      }
      if (acceptance?.type === 'agent.task.accepted') return confirmAcceptance(record, acceptance);
      release(record);
      records.delete(taskId);
      throw persistence('Task acceptance did not commit');
    });
  };

  const cancelRecords = async (
    owned: readonly TaskRecord[],
    operationId: string,
    reason: TaskStopReason,
    toAbort: TaskRecord[],
    beforeIntents?: () => Promise<void>,
  ): Promise<readonly AgentTaskView[]> => {
    for (const record of owned) {
      if (
        record.pendingCancel?.operationId === operationId &&
        record.pendingCancel.reason !== reason
      )
        throw new AgentTaskError('agent-task-request-conflict', 'Cancellation operation conflicts');
    }
    for (const record of owned) {
      if (record.settled !== undefined || record.recovered?.hadSettlement === true) continue;
      record.pendingCancel ??= { version: 1, taskId: record.payload.taskId, operationId, reason };
      fence(record, record.pendingCancel.reason);
      toAbort.push(record);
    }
    await beforeIntents?.();
    const failures: unknown[] = [];
    for (const record of toAbort) {
      try {
        if (record.acceptance === undefined && (await reconcileAcceptance(record)) === undefined)
          continue;
        await flushCancellation(record);
        transition(record, 'cancelling');
      } catch (cause: unknown) {
        markBlocked(record, cause);
        failures.push(cause);
      }
    }
    if (failures.length > 0)
      throw persistence('Task cancellation could not be confirmed', failures[0]);
    return owned.flatMap(({ view }) => (view === undefined ? [] : [structuredClone(view)]));
  };

  const stopAndAbort = async (
    load: () => readonly TaskRecord[],
    operationId: string,
    reason: TaskStopReason,
  ): Promise<readonly AgentTaskView[]> => {
    const toAbort: TaskRecord[] = [];
    try {
      return await gate(() => cancelRecords(load(), operationId, reason, toAbort));
    } finally {
      for (const record of toAbort) {
        abort(record);
        schedule(record);
      }
    }
  };

  const requestCancel: AgentTaskService['requestCancel'] = async (
    root,
    ids,
    operationId,
    reason,
  ) => {
    const targets = agentTaskCancelInputSchema.safeParse({ taskIds: ids });
    if (
      !targets.success ||
      !taskIdentifierSchema.safeParse(root).success ||
      !taskIdentifierSchema.safeParse(operationId).success ||
      !taskStopReasonSchema.safeParse(reason).success
    )
      throw new AgentTaskError('agent-task-invalid-input', 'Invalid task cancellation');
    return stopAndAbort(
      () =>
        targets.data.taskIds.map((taskId) => {
          const task = records.get(taskId);
          if (task?.payload.rootSessionId !== root || task.view === undefined)
            throw new AgentTaskError(
              'agent-task-not-found',
              'Agent task does not belong to this root',
            );
          return task;
        }),
      operationId,
      reason,
    );
  };

  const stopParentTurn: AgentTaskService['stopParentTurn'] = async (root, turnId, operationId) => {
    if (
      ![root, turnId, operationId].every((value) => taskIdentifierSchema.safeParse(value).success)
    )
      throw new AgentTaskError('agent-task-invalid-input', 'Invalid parent Turn stop');
    return stopAndAbort(
      () => {
        const turns = stoppedTurns.get(root) ?? new Set<string>();
        turns.add(turnId);
        stoppedTurns.set(root, turns);
        return [...records.values()].filter(
          ({ payload }) => payload.rootSessionId === root && payload.parentTurnId === turnId,
        );
      },
      operationId,
      'parent-stop',
    );
  };

  const stopAll: AgentTaskService['stopAll'] = async (root, operationId) => {
    if (![root, operationId].every((value) => taskIdentifierSchema.safeParse(value).success))
      throw new AgentTaskError('agent-task-invalid-input', 'Invalid root task stop');
    const toAbort: TaskRecord[] = [];
    try {
      return await gate(async () => {
        const operations = stopAllTargets.get(root) ?? new Map<string, StopAllOperation>();
        let operation = operations.get(operationId);
        if (operation === undefined) {
          const taskIds = [...records.values()].flatMap(({ payload, settled, recovered }) =>
            payload.rootSessionId === root &&
            settled === undefined &&
            recovered?.hadSettlement !== true
              ? [payload.taskId]
              : [],
          );
          operation = { taskIds, confirmed: false };
          operations.set(operationId, operation);
          stopAllTargets.set(root, operations);
        }
        const owned = operation.taskIds.flatMap((taskId) => {
          const record = records.get(taskId);
          return record?.payload.rootSessionId !== root ? [] : [record];
        });
        return cancelRecords(owned, operationId, 'task-cancelled', toAbort, () =>
          confirmStopAll(root, operationId, operation),
        );
      });
    } finally {
      for (const record of toAbort) {
        abort(record);
        schedule(record);
      }
    }
  };

  const withTaskSessionsIdle: AgentTaskService['withTaskSessionsIdle'] = (sessionId, operation) =>
    gate(async () => {
      if (!taskIdentifierSchema.safeParse(sessionId).success)
        throw new AgentTaskError('agent-task-invalid-input', 'Invalid Session identifier');
      if (
        [...records.values()].some(
          ({ payload, settled }) =>
            settled === undefined &&
            (payload.rootSessionId === sessionId || payload.childSessionId === sessionId),
        )
      )
        throw new AgentTaskError(
          'agent-task-busy',
          'Session has active or unconfirmed agent tasks',
        );
      return operation();
    });

  const recoverTask = async (
    record: TaskRecord,
    runRecovery: NonNullable<typeof recoverExecutions>,
  ): Promise<void> => {
    const recovery = record.recovered!;
    try {
      let evidence = await readEvidence(record);
      const stage = checkRecoveredTask(evidence);
      if (!recovery.executionChecked || stage.kind === 'executing') {
        await runRecovery([record.payload.childSessionId]);
        recovery.executionChecked = true;
        evidence = await readEvidence(record);
      }
      if (!recovery.hadSettlement && record.pendingCancel !== undefined) {
        await flushCancellation(record);
        evidence = await readEvidence(record);
      }
      await commitReconciliation(
        record,
        settleRecoveredTask(record.payload, evidence),
        evidence.parent.events,
      );
      delete record.issue;
    } catch (cause: unknown) {
      markBlocked(record, cause);
    }
  };

  const recover: AgentTaskService['recover'] = (rootSessionIds, runRecovery) =>
    gate(async () => {
      if (admittedLiveTask || recoverExecutions !== undefined || closed)
        throw new AgentTaskError(
          'agent-task-not-permitted',
          'Task recovery must run once before live admission',
        );
      const roots: string[] = [];
      const discovered = new Map<string, TaskRecord>();
      const unavailable = new Map<string, unknown>();
      const recoveredStops = new Map<string, Map<string, StopAllOperation>>();
      for (const id of new Set(rootSessionIds)) {
        let events: readonly SessionEvent[];
        try {
          events = await readParent(id);
        } catch (cause: unknown) {
          unavailable.set(id, cause);
          continue;
        }
        const projection = projectSession(events).agentTasks;
        if (projection?.origin !== undefined) continue;
        roots.push(id);
        const legacyTargets = new Map<string, string[]>();
        for (const event of events) {
          if (
            event.type !== 'agent.task.cancel-requested' ||
            event.payload.reason !== 'task-cancelled'
          )
            continue;
          const { operationId, taskId } = event.payload;
          const targets = legacyTargets.get(operationId) ?? [];
          if (!targets.includes(taskId)) legacyTargets.set(operationId, [...targets, taskId]);
        }
        const operations = new Map<string, StopAllOperation>(
          [...legacyTargets].map(([operationId, taskIds]) => [
            operationId,
            { taskIds, confirmed: true },
          ]),
        );
        const batchIntent = new Map<string, string>();
        for (const { operationId, taskIds } of projection?.stopOperations ?? []) {
          operations.set(operationId, { taskIds, confirmed: true });
          for (const taskId of taskIds)
            if (!batchIntent.has(taskId)) batchIntent.set(taskId, operationId);
        }
        if (operations.size > 0) recoveredStops.set(id, operations);
        for (const summary of projection?.tasks ?? []) {
          const acceptance = events[summary.acceptedSequence - 1];
          if (acceptance?.type !== 'agent.task.accepted' || discovered.has(summary.taskId))
            throw persistence('Invalid recovered task identity');
          const batchOperationId = batchIntent.get(summary.taskId);
          const pendingCancel =
            summary.cancellation === undefined
              ? batchOperationId === undefined || summary.settled !== undefined
                ? undefined
                : {
                    version: 1 as const,
                    taskId: summary.taskId,
                    operationId: batchOperationId,
                    reason: 'task-cancelled' as const,
                  }
              : {
                  version: 1 as const,
                  taskId: summary.taskId,
                  operationId: summary.cancellation.operationId,
                  reason: summary.cancellation.reason,
                };
          const record: TaskRecord = {
            payload: acceptance.payload,
            acceptance,
            control: makeControl(() => record),
            recovered: { hadSettlement: summary.settled !== undefined, executionChecked: false },
            ...(pendingCancel === undefined ? {} : { pendingCancel }),
            ...(summary.cancellation === undefined ? {} : { cancelConfirmed: true as const }),
          };
          discovered.set(summary.taskId, record);
        }
      }
      const childIds = new Set(
        [...discovered.values()].map(({ payload }) => payload.childSessionId),
      );
      for (const [id, cause] of unavailable)
        if (!childIds.has(id))
          throw persistence('Task recovery could not read a root Session', cause);

      recoverExecutions = runRecovery;
      for (const [root, operations] of recoveredStops) stopAllTargets.set(root, operations);
      for (const record of discovered.values()) {
        records.set(record.payload.taskId, record);
        transition(record, 'blocked');
      }
      await runRecovery(roots);
      for (const record of discovered.values()) await recoverTask(record, runRecovery);
    });

  const retry: AgentTaskService['retry'] = async (root) => {
    const candidates = [...records.values()].filter(
      (record) =>
        record.settled === undefined &&
        (root === undefined || record.payload.rootSessionId === root),
    );
    await gate(async () => {
      for (const record of candidates) {
        if (record.recovered !== undefined && recoverExecutions !== undefined) {
          await recoverTask(record, recoverExecutions);
          continue;
        }
        if (record.acceptance !== undefined || records.get(record.payload.taskId) !== record)
          continue;
        try {
          await reconcileAcceptance(record);
        } catch (cause: unknown) {
          markBlocked(record, cause);
        }
      }
    });
    for (const record of candidates) {
      abort(record);
      schedule(record);
    }
  };

  return {
    spawn,
    requestCancel,
    stopParentTurn,
    stopAll,
    withTaskSessionsIdle,
    recover,
    snapshot(root) {
      return [...records.values()].flatMap(({ payload, view }) =>
        payload.rootSessionId === root && view !== undefined ? [structuredClone(view)] : [],
      );
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    retry,
    closeSync() {
      if (closed) return;
      closed = true;
      for (const record of records.values())
        if (record.recovered === undefined) record.control.lifetime.requestStop('shutdown');
    },
    async drain() {
      await retry();
      await Promise.all(
        [...records.values()].flatMap(({ stopJob }) => (stopJob === undefined ? [] : [stopJob])),
      );
      await Promise.all(
        [...records.values()].flatMap((record) =>
          [record.job, record.cancelJob].filter((job) => job !== undefined),
        ),
      );
      await tail;
      const blocked = [...records.values()].filter((record) => record.settled === undefined);
      if (blocked.length > 0)
        throw new AggregateError(
          blocked.map((record) => record.issue ?? new Error('Task cleanup is incomplete')),
          'Agent task drain is incomplete',
        );
    },
  };
}
