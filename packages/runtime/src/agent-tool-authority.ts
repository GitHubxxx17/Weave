import type { ToolDefinition as PublicToolDefinition } from '@weave/protocol';
import { agentTaskFactDigest, type AgentTaskToolIdentity } from '@weave/session';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { AgentRunError, type AgentRunRequest } from './agent-types.js';
import type { CreateApprovalRequestInput } from './approval-types.js';
import type { ToolRegistry } from './tool-registry.js';
import {
  ToolExecutionError,
  type RegisteredToolDefinition,
  type ToolExecutionContext,
  type ToolExecutionRequest,
  type ToolPermissionMode,
} from './tool-types.js';

declare const authorityBrand: unique symbol;

/** Host-only identity for one Runner invocation. */
export type AgentToolAuthority = { readonly [authorityBrand]: true };

export interface AgentToolRunIdentity {
  readonly sessionId: string;
  readonly executionId: string;
  readonly turnId: string;
  readonly userMessageId: string;
}

export interface AgentToolAuthoritySettings {
  readonly provider: string;
  readonly model: string;
  readonly temperature?: number;
  readonly maxTokens?: number;
  readonly reasoningEffort?: string;
  readonly permissionMode: ToolPermissionMode;
  readonly useProviderDefaults: false;
}

export interface AgentToolAuthorityView {
  readonly identity: AgentToolRunIdentity;
  readonly settings: AgentToolAuthoritySettings;
  readonly tools: readonly AgentTaskToolIdentity[];
}

export interface AgentToolInvocationAuthority extends AgentToolAuthorityView {
  readonly toolCallId: string;
  readonly toolName: string;
}

export interface AgentToolAuthorityLifetime {
  readonly identity: AgentToolRunIdentity;
  /** A cheap synchronous host fence. The Runner's own lifetime is checked independently. */
  readonly isLive?: (() => boolean) | undefined;
  /** Checks any additional host authority before policy, approval summary and execution. */
  readonly checkpoint?: ((context: ToolExecutionContext) => void | Promise<void>) | undefined;
}

export interface CreateAgentToolAuthorityOptions extends AgentToolAuthorityLifetime {
  readonly registry: ToolRegistry;
  readonly ownerOf: (tool: RegisteredToolDefinition) => string | undefined;
  /** Synchronous host classification, captured once for each exact root entry. */
  readonly rootOnlyTool?: ((tool: RegisteredToolDefinition) => boolean) | undefined;
}

export interface DeriveAgentToolAuthorityOptions extends AgentToolAuthorityLifetime {
  readonly access: 'read-only' | 'workspace';
}

type InstructionTool = PublicToolDefinition & { readonly readOnly: boolean };

interface CapturedTool {
  readonly definition: RegisteredToolDefinition;
  readonly publicTool: InstructionTool;
  readonly identity: AgentTaskToolIdentity;
  readonly rootOnly: boolean;
}

interface RunState {
  readonly signal: AbortSignal;
  invocation?: ToolExecutionRequest;
}

interface AuthorityState {
  readonly identity: AgentToolRunIdentity;
  readonly registry: ToolRegistry;
  readonly ownerOf: CreateAgentToolAuthorityOptions['ownerOf'];
  readonly isLive: AgentToolAuthorityLifetime['isLive'];
  readonly checkpoint: AgentToolAuthorityLifetime['checkpoint'];
  readonly entries: ReadonlyMap<string, CapturedTool>;
  readonly tools: readonly AgentTaskToolIdentity[];
  readonly parentSessionId?: string;
  settings?: AgentToolAuthoritySettings;
  active?: RunState;
}

const authorities = new WeakMap<AgentToolAuthority, AuthorityState>();
const spent = new WeakSet<AgentToolAuthority>();
const activeExecutions = new WeakMap<ToolExecutionContext, ToolExecutionRequest>();
const taskToolNames = new Set(['agent_spawn', 'agent_status', 'agent_wait', 'agent_cancel']);
const jsonSchema = z.json();

function freezeJson<T extends z.infer<typeof jsonSchema>>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const item of Object.values(value)) freezeJson(item);
    Object.freeze(value);
  }
  return value;
}

function publicTool(definition: RegisteredToolDefinition): InstructionTool {
  const input: unknown = structuredClone(definition.parameters);
  const parameters = jsonSchema.parse(input);
  if (!isDeepStrictEqual(input, parameters)) throw new TypeError('Tool parameters must be JSON');
  return Object.freeze({
    name: definition.name,
    description: definition.description,
    parameters: freezeJson(parameters),
    readOnly: definition.readOnly === true,
  });
}

function mint(
  options: CreateAgentToolAuthorityOptions,
  entries: ReadonlyMap<string, CapturedTool>,
  parentSessionId?: string,
  settings?: AgentToolAuthoritySettings,
): AgentToolAuthority {
  const token = Object.freeze({}) as AgentToolAuthority;
  authorities.set(token, {
    identity: Object.freeze({ ...options.identity }),
    registry: options.registry,
    ownerOf: options.ownerOf,
    isLive: options.isLive,
    checkpoint: options.checkpoint,
    entries,
    tools: Object.freeze([...entries.values()].map((entry) => entry.identity)),
    ...(parentSessionId === undefined ? {} : { parentSessionId }),
    ...(settings === undefined ? {} : { settings }),
  });
  return token;
}

/** Captures the tools registered in the actual running Generation. */
export function createAgentToolAuthority(
  options: CreateAgentToolAuthorityOptions,
): AgentToolAuthority {
  const entries = new Map<string, CapturedTool>();
  for (const definition of options.registry.list()) {
    const ownerId = options.ownerOf(definition);
    if (
      !ownerId ||
      entries.has(definition.name) ||
      options.registry.get(definition.name) !== definition
    ) {
      throw new TypeError('Tool registry ownership cannot be verified');
    }
    const snapshot = publicTool(definition);
    const rootOnly = options.rootOnlyTool?.(definition) ?? false;
    if (typeof rootOnly !== 'boolean') {
      throw new TypeError('Root-only tool classification must be synchronous');
    }
    entries.set(snapshot.name, {
      definition,
      publicTool: snapshot,
      rootOnly,
      identity: Object.freeze({
        ownerId,
        name: snapshot.name,
        definitionDigest: agentTaskFactDigest(snapshot),
      }),
    });
  }
  return mint(options, entries);
}

function denied(): ToolExecutionError {
  return new ToolExecutionError(
    'tool-not-permitted',
    'The tool is outside the active run authority',
  );
}

function live(state: AuthorityState): RunState | undefined {
  const run = state.active;
  if (run === undefined || run.signal.aborted || state.isLive?.() === false) return undefined;
  return run;
}

function boundCall(request: ToolExecutionRequest): AuthorityState {
  const token = request.toolAuthority;
  const state = token === undefined ? undefined : authorities.get(token);
  try {
    const original = state === undefined ? undefined : live(state)?.invocation;
    if (
      original !== undefined &&
      original.sessionId === request.sessionId &&
      original.executionId === request.executionId &&
      original.turnId === request.turnId &&
      original.toolCallId === request.toolCallId &&
      original.name === request.name &&
      original.signal === request.signal &&
      original.permissionMode === request.permissionMode
    )
      return state!;
  } catch (cause: unknown) {
    throw new ToolExecutionError('tool-not-permitted', 'Tool run authority could not be checked', {
      cause,
    });
  }
  throw denied();
}

/** Reads the public snapshot for a genuine host token, including a child before its first start. */
export function describeAgentToolAuthority(token: AgentToolAuthority): AgentToolAuthorityView {
  const state = authorities.get(token);
  if (state?.settings === undefined) throw denied();
  return Object.freeze({ identity: state.identity, tools: state.tools, settings: state.settings });
}

/** Verifies that context is the exact, still-executing Pipeline call. */
export function readAgentToolAuthority(
  context: ToolExecutionContext,
): AgentToolInvocationAuthority {
  const request = activeExecutions.get(context);
  if (request === undefined || context.signal.aborted) throw denied();
  return readAgentToolInvocation(request);
}

/** Internal host reader; the Pipeline owns the request binding. */
export function readAgentToolInvocation(
  request: ToolExecutionRequest,
): AgentToolInvocationAuthority {
  const state = boundCall(request);
  assertAuthorizedTool(request, state.registry, state.registry.get(request.name));
  return Object.freeze({
    ...describeAgentToolAuthority(request.toolAuthority!),
    toolCallId: request.toolCallId,
    toolName: request.name,
  });
}

/** Narrows the exact root tools during a genuine agent_spawn invocation. */
export function deriveAgentToolAuthority(
  context: ToolExecutionContext,
  options: DeriveAgentToolAuthorityOptions,
): AgentToolAuthority {
  const parent = readAgentToolAuthority(context);
  const state = authorities.get(context.toolAuthority!)!;
  if (state.parentSessionId !== undefined || parent.toolName !== 'agent_spawn') throw denied();
  const entries = new Map(
    [...state.entries].filter(
      ([name, entry]) =>
        !entry.rootOnly &&
        !taskToolNames.has(name) &&
        (options.access === 'workspace' || entry.publicTool.readOnly),
    ),
  );
  return mint(
    { ...options, registry: state.registry, ownerOf: state.ownerOf },
    entries,
    parent.identity.sessionId,
    parent.settings,
  );
}

/** Attaches a token to exactly one execution at the Runner's real start. */
export function activateAgentToolAuthority(
  request: AgentRunRequest,
  registry: ToolRegistry | undefined,
  settings: AgentToolAuthoritySettings,
  signal: AbortSignal,
): (() => void) | undefined {
  if (request.toolAuthority === undefined) return undefined;
  const state = authorities.get(request.toolAuthority);
  const identity = request.executionIdentity;
  if (
    state === undefined ||
    spent.has(request.toolAuthority) ||
    state.active !== undefined ||
    state.registry !== registry ||
    state.identity.sessionId !== request.sessionId ||
    state.identity.executionId !== identity?.executionId ||
    state.identity.turnId !== identity.turnId ||
    state.identity.userMessageId !== identity.userMessageId ||
    (state.parentSessionId !== undefined &&
      (!isDeepStrictEqual(state.settings, settings) || request.useProviderDefaults !== false)) ||
    state.isLive?.() === false ||
    signal.aborted
  ) {
    throw new AgentRunError('agent-invalid-input', 'The run does not match its tool authority');
  }
  const capturedSettings = Object.freeze({ ...settings });
  state.settings = capturedSettings;
  state.active = { signal };
  return () => {
    delete state.active;
    spent.add(request.toolAuthority!);
  };
}

export function agentToolAuthorityParent(
  token: AgentToolAuthority | undefined,
): string | undefined {
  if (token === undefined) return undefined;
  const state = authorities.get(token);
  if (state === undefined || live(state) === undefined) throw denied();
  return state.parentSessionId;
}

export function agentToolInstructionView(token: AgentToolAuthority): readonly InstructionTool[] {
  const state = authorities.get(token);
  if (state === undefined || spent.has(token) || live(state) === undefined) throw denied();
  return Object.freeze([...state.entries.values()].map((entry) => entry.publicTool));
}

/** Commits only the call currently being executed by the Runner. */
export async function withAgentToolInvocation<T>(
  request: ToolExecutionRequest,
  invoke: () => Promise<T>,
): Promise<T> {
  if (request.toolAuthority === undefined) return invoke();
  const state = authorities.get(request.toolAuthority);
  const run = state === undefined ? undefined : live(state);
  if (run === undefined || run.invocation !== undefined) throw denied();
  run.invocation = Object.freeze({ ...request });
  try {
    return await invoke();
  } finally {
    delete run.invocation;
  }
}

export function assertAuthorizedTool(
  request: ToolExecutionRequest,
  registry: ToolRegistry,
  definition: RegisteredToolDefinition | undefined,
): AuthorityState | undefined {
  if (request.toolAuthority === undefined) return undefined;
  const state = boundCall(request);
  if (state.registry !== registry) throw denied();
  const entry = state.entries.get(request.name);
  if (entry === undefined && definition === undefined && state.parentSessionId === undefined) {
    throw new ToolExecutionError('tool-not-found', `Tool "${request.name}" was not found`);
  }
  if (entry === undefined || definition === undefined || entry.definition !== definition) {
    throw denied();
  }
  try {
    if (
      state.ownerOf(definition) === entry.identity.ownerId &&
      agentTaskFactDigest(publicTool(definition)) === entry.identity.definitionDigest
    )
      return state;
  } catch (cause: unknown) {
    throw new ToolExecutionError(
      'tool-not-permitted',
      'Registered tool authority could not be checked',
      { cause },
    );
  }
  throw denied();
}

/** Runs a cooperative host checkpoint without extending the call's lifetime. */
export function checkAgentToolCheckpoint(
  state: AuthorityState | undefined,
  context: ToolExecutionContext,
): void | Promise<void> {
  return state?.checkpoint?.(context);
}

export function beginAgentToolExecution(
  context: ToolExecutionContext,
  request: ToolExecutionRequest,
): () => void {
  if (context.toolAuthority === undefined) return () => {};
  activeExecutions.set(context, request);
  return () => {
    activeExecutions.delete(context);
  };
}

export function validateAgentProviderTools(
  token: AgentToolAuthority,
  tools: readonly PublicToolDefinition[] | undefined,
): void {
  const state = authorities.get(token);
  if (state === undefined || live(state) === undefined) {
    throw new AgentRunError(
      'agent-stream-protocol',
      'The model request has no active tool authority',
    );
  }
  const seen = new Set<string>();
  for (const tool of tools ?? []) {
    const entry = state.entries.get(tool.name);
    try {
      const parameters = jsonSchema.parse(tool.parameters);
      if (
        entry !== undefined &&
        !seen.has(tool.name) &&
        Object.keys(tool).length === 3 &&
        isDeepStrictEqual(parameters, tool.parameters) &&
        agentTaskFactDigest({ ...tool, readOnly: entry.publicTool.readOnly }) ===
          entry.identity.definitionDigest
      ) {
        seen.add(tool.name);
        continue;
      }
    } catch {
      // Invalid schema data is rejected along with all other alterations.
    }
    throw new AgentRunError(
      'agent-stream-protocol',
      'The model request changed the authorized tool definitions',
    );
  }
}

type ApprovalProvenance = Pick<AgentToolRunIdentity, 'executionId' | 'turnId'>;
const approvalProvenance = new WeakMap<CreateApprovalRequestInput, ApprovalProvenance>();

/** Records trusted attribution without adding a writable field to the Broker's input. */
export function bindToolApproval(
  input: CreateApprovalRequestInput,
  state: AuthorityState | undefined,
): CreateApprovalRequestInput {
  if (state !== undefined) {
    const { executionId, turnId } = state.identity;
    approvalProvenance.set(input, { executionId, turnId });
  }
  return input;
}

export function consumeToolApproval(
  input: CreateApprovalRequestInput,
): ApprovalProvenance | undefined {
  const provenance = approvalProvenance.get(input);
  approvalProvenance.delete(input);
  return provenance;
}
