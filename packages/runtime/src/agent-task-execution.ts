import { taskSequenceSchema, type TaskStopReason } from '@weave/protocol';
import {
  agentExecutionInputSchema,
  agentTaskAcceptedPayloadSchema,
  agentTaskFactDigest,
  type AgentTaskAccepted,
} from '@weave/session';
import { z } from 'zod';
import {
  agentTaskExecutionIdentity,
  agentTaskExecutionInput,
  agentTaskOrigin,
  agentTaskRequestDigest,
} from './agent-task-reconcile.js';
import {
  AgentExecutionError,
  type AgentExecutionService,
  type AgentExecutionSnapshot,
} from './agent-execution-types.js';
import type { TaskExecutionCleanup } from './agent-task-types.js';
import type { AgentRunner } from './agent-types.js';

const identifier = z.string().min(1).max(240);
export const boundTaskLaunchSchema = z.strictObject({
  sessionId: identifier,
  requestId: identifier,
  identity: z.strictObject({
    executionId: identifier,
    turnId: identifier,
    userMessageId: identifier,
  }),
  input: agentExecutionInputSchema,
});
export interface BoundTaskLaunch {
  readonly sessionId: string;
  readonly requestId: string;
  readonly identity: {
    readonly executionId: string;
    readonly turnId: string;
    readonly userMessageId: string;
  };
  readonly input: z.infer<typeof agentExecutionInputSchema>;
}

declare const launchBrand: unique symbol;
declare const leaseBrand: unique symbol;
export interface TaskLaunchAuthority {
  readonly [launchBrand]: true;
}
export interface TaskRunnerLease {
  readonly [leaseBrand]: true;
}

export interface BoundTaskExecutionPort {
  launchBoundTask(
    request: BoundTaskLaunch,
    authority: TaskLaunchAuthority,
    lease: TaskRunnerLease,
  ): Promise<AgentExecutionSnapshot>;
  cancelBoundTask(authority: TaskLaunchAuthority): Promise<AgentExecutionSnapshot | undefined>;
  whenSettled(authority: TaskLaunchAuthority): Promise<TaskExecutionCleanup>;
}

export interface MintTaskLaunchAuthorityOptions {
  readonly accepted: AgentTaskAccepted;
  readonly parentAcceptedSequence: number;
  /** Read the first permanent stop fence synchronously without acquiring a gate. */
  readonly getStopReason?: () => TaskStopReason | undefined;
}

export interface AdaptTaskRunnerLeaseOptions {
  readonly runner: AgentRunner;
  /** Enforce retained Generation and host start admission synchronously. */
  readonly assertCanStartSync: () => void;
  readonly closeStarts?: (reason: TaskStopReason) => void;
  /** Release the retained pin without waiting for Generation disposal. */
  readonly release?: () => void;
}

interface LaunchBinding {
  readonly identity: ReturnType<typeof agentTaskExecutionIdentity>;
  readonly originDigest: string;
  readonly input: ReturnType<typeof agentTaskExecutionInput>;
  readonly inputDigest: string;
  readonly getStopReason: MintTaskLaunchAuthorityOptions['getStopReason'];
  service?: AgentExecutionService;
}

const authorities = new WeakMap<TaskLaunchAuthority, LaunchBinding>();
const leases = new WeakMap<
  TaskRunnerLease,
  AdaptTaskRunnerLeaseOptions & { readonly authority: TaskLaunchAuthority }
>();
const ports = new WeakMap<AgentExecutionService, BoundTaskExecutionPort>();

/** Host-only. Mint after exact durable parent acceptance has been confirmed. */
export function mintTaskLaunchAuthority(
  options: MintTaskLaunchAuthorityOptions,
): TaskLaunchAuthority {
  const accepted = agentTaskAcceptedPayloadSchema.parse(options.accepted);
  const sequence = taskSequenceSchema.parse(options.parentAcceptedSequence);
  const { title, prompt, access } = accepted;
  if (accepted.requestDigest !== agentTaskRequestDigest({ title, prompt, access }))
    throw taskBindingConflict('Task acceptance request digest conflicts');
  const input = agentExecutionInputSchema.parse(agentTaskExecutionInput(accepted));
  const authority = Object.freeze({}) as TaskLaunchAuthority;
  authorities.set(authority, {
    identity: Object.freeze(agentTaskExecutionIdentity(accepted)),
    originDigest: agentTaskFactDigest(agentTaskOrigin(accepted, sequence)),
    input,
    inputDigest: agentTaskFactDigest(input),
    getStopReason: options.getStopReason,
  });
  return authority;
}

/** Host-only adapter for an already bound retained runner. */
export function adaptTaskRunnerLease(
  authority: TaskLaunchAuthority,
  options: AdaptTaskRunnerLeaseOptions,
): TaskRunnerLease {
  readTaskLaunchAuthority(authority);
  const lease = Object.freeze({}) as TaskRunnerLease;
  leases.set(lease, {
    ...options,
    runner: { run: options.runner.run.bind(options.runner) },
    authority,
  });
  return lease;
}

export function taskBindingConflict(message: string): AgentExecutionError {
  return new AgentExecutionError('execution-request-conflict', message);
}

export function readTaskLaunchAuthority(authority: TaskLaunchAuthority): LaunchBinding {
  const binding = authorities.get(authority);
  if (binding === undefined) throw taskBindingConflict('Unknown task launch authority');
  return binding;
}

export function readTaskRunnerLease(
  authority: TaskLaunchAuthority,
  lease: TaskRunnerLease,
): AdaptTaskRunnerLeaseOptions {
  const binding = leases.get(lease);
  if (binding?.authority !== authority)
    throw taskBindingConflict('Runner lease is not bound to this task launch authority');
  return binding;
}

export function registerBoundTaskExecutionPort(
  service: AgentExecutionService,
  port: BoundTaskExecutionPort,
): void {
  ports.set(service, Object.freeze(port));
}

export function getBoundTaskExecutionPort(service: AgentExecutionService): BoundTaskExecutionPort {
  const port = ports.get(service);
  if (port === undefined) throw taskBindingConflict('Execution service has no bound task port');
  return port;
}
