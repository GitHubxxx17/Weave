import {
  agentToolAuthorityParent,
  assertAuthorizedTool,
  readAgentToolAuthority,
  readAgentToolInvocation,
  type AgentToolAuthority,
  type AgentToolInvocationAuthority,
} from './agent-tool-authority.js';
import type { ToolRegistry } from './tool-registry.js';
import {
  ToolExecutionError,
  type RegisteredToolDefinition,
  type ToolDefinition,
  type ToolExecutionContext,
  type ToolExecutionRequest,
  type ToolApprovalSummary,
} from './tool-types.js';

export type MemoryWriteOperation = 'memory.save' | 'memory.delete';

export interface MemoryToolConfiguration {
  readonly classification: 'read' | 'root-write';
  readonly operation?: MemoryWriteOperation | undefined;
  readonly signal?: AbortSignal | undefined;
}

const definitions = new WeakMap<object, Readonly<MemoryToolConfiguration>>();
const approvals = new WeakMap<
  object,
  { readonly definition: object; readonly summarize: unknown }
>();

/** Host composition only: classification follows this exact registered object. */
export function configureMemoryToolDefinition<TInput, TOutput>(
  definition: ToolDefinition<TInput, TOutput>,
  options: MemoryToolConfiguration,
): void {
  if (
    definitions.has(definition) ||
    (options.classification !== 'root-write' && options.classification !== 'read') ||
    (options.classification === 'root-write' &&
      options.operation !== 'memory.save' &&
      options.operation !== 'memory.delete') ||
    (options.classification === 'read' && options.operation !== undefined)
  )
    throw new TypeError('Invalid host Memory tool configuration');
  definitions.set(definition, Object.freeze({ ...options }));
  if (options.classification === 'root-write' && definition.approval !== undefined)
    approvals.set(definition, {
      definition: definition.approval,
      summarize: definition.approval.summarize,
    });
}

export function memoryToolConfiguration(
  definition: RegisteredToolDefinition | undefined,
): Readonly<MemoryToolConfiguration> | undefined {
  return definition === undefined ? undefined : definitions.get(definition);
}

function denied(): ToolExecutionError {
  return new ToolExecutionError(
    'tool-not-permitted',
    'The Memory tool has no active host authority',
  );
}

function assertApproval(
  definition: RegisteredToolDefinition,
  configuration: Readonly<MemoryToolConfiguration>,
): void {
  if (configuration.classification !== 'root-write') return;
  const expected = approvals.get(definition);
  if (
    definition.approval === undefined ||
    definition.approval !== expected?.definition ||
    definition.approval.summarize !== expected.summarize ||
    definition.approval.operation !== configuration.operation ||
    definition.approval.risk !== 'high'
  )
    throw denied();
}

/** Must run before plugin around/policy hooks, even for a missing token. */
export function assertMemoryToolAuthority(
  request: ToolExecutionRequest,
  registry: ToolRegistry,
  definition: RegisteredToolDefinition | undefined,
  allowHostToolContext: ((tool: RegisteredToolDefinition) => boolean) | undefined,
): void {
  const config = memoryToolConfiguration(definition);
  if (config === undefined) return;
  if (
    definition === undefined ||
    allowHostToolContext?.(definition) !== true ||
    request.toolAuthority === undefined
  )
    throw denied();
  assertApproval(definition, config);
  assertAuthorizedTool(request, registry, definition);
  if (
    config.classification === 'root-write' &&
    agentToolAuthorityParent(request.toolAuthority) !== undefined
  )
    throw denied();
}

interface MemoryWriteAttempt {
  readonly opaque: true;
}
interface AttemptState {
  readonly token: MemoryWriteAttempt;
  readonly definition: RegisteredToolDefinition;
  readonly configuration: Readonly<MemoryToolConfiguration>;
  readonly request: ToolExecutionRequest;
  readonly registry: ToolRegistry;
  readonly context: ToolExecutionContext;
  readonly summaryContext: ToolExecutionContext;
  readonly assertCurrent: () => void;
  active: boolean;
  phase: 'created' | 'preview' | 'prepared' | 'approved' | 'automatic' | 'consumed';
  executing: boolean;
  previewStarted: boolean;
  intent?: object;
}
interface ContextBinding {
  readonly token: MemoryWriteAttempt;
  readonly kind: 'summary' | 'execute';
}
const contexts = new WeakMap<ToolExecutionContext, ContextBinding>();
const attempts = new WeakMap<MemoryWriteAttempt, AttemptState>();
const callers = new WeakMap<
  AgentToolInvocationAuthority,
  {
    readonly authority: AgentToolAuthority;
    readonly assertLiveSync: () => void;
  }
>();

function assertState(state: AttemptState): void {
  if (
    !state.active ||
    attempts.get(state.token) !== state ||
    definitions.get(state.definition) !== state.configuration ||
    state.context.signal.aborted ||
    state.configuration.signal?.aborted
  )
    throw denied();
  state.assertCurrent();
  assertApproval(state.definition, state.configuration);
  assertAuthorizedTool(state.request, state.registry, state.registry.get(state.request.name));
  if (
    state.configuration.classification === 'root-write' &&
    agentToolAuthorityParent(state.request.toolAuthority) !== undefined
  )
    throw denied();
}

function getBinding(context: ToolExecutionContext, kind: ContextBinding['kind']): AttemptState {
  const binding = contexts.get(context);
  const state = binding === undefined ? undefined : attempts.get(binding.token);
  if (
    state === undefined ||
    binding?.kind !== kind ||
    (kind === 'summary' ? state.summaryContext !== context : state.context !== context)
  )
    throw denied();
  assertState(state);
  return state;
}

function bindCaller(state: AttemptState, assertLiveSync: () => void): AgentToolInvocationAuthority {
  const caller = readAgentToolInvocation(state.request);
  callers.set(caller, { authority: state.request.toolAuthority!, assertLiveSync });
  return caller;
}

/** Proves a caller returned by the private Memory bridge, without JSON authority fields. */
export function memoryCallerAuthority(caller: AgentToolInvocationAuthority): AgentToolAuthority {
  const binding = callers.get(caller);
  if (binding === undefined) throw denied();
  binding.assertLiveSync();
  return binding.authority;
}

function freezeIntent<T extends object>(intent: T): T {
  const seen = new WeakSet<object>();
  function visit(value: unknown): void {
    if (value === null || typeof value !== 'object' || seen.has(value)) return;
    seen.add(value);
    for (const nested of Object.values(value)) visit(nested);
    Object.freeze(value);
  }
  visit(intent);
  return intent;
}

/** Private Pipeline lifecycle. No attempt identity is exposed on the public context. */
export function beginMemoryToolAttempt(options: {
  readonly definition: RegisteredToolDefinition;
  readonly request: ToolExecutionRequest;
  readonly registry: ToolRegistry;
  readonly context: ToolExecutionContext;
  readonly summaryContext: ToolExecutionContext;
  readonly assertCurrent: () => void;
}): {
  beginPreview(): () => void;
  approve(): void;
  automatic(): void;
  beginExecute(): () => void;
  close(): void;
} {
  const configuration = definitions.get(options.definition);
  if (configuration === undefined) throw denied();
  const token = Object.freeze({ opaque: true }) as MemoryWriteAttempt;
  const state: AttemptState = {
    ...options,
    token,
    configuration,
    active: true,
    phase: 'created',
    executing: false,
    previewStarted: false,
  };
  attempts.set(token, state);
  return {
    beginPreview() {
      assertState(state);
      if (configuration.classification !== 'root-write' || state.phase !== 'created')
        throw denied();
      state.phase = 'preview';
      contexts.set(options.summaryContext, { token, kind: 'summary' });
      return () => contexts.delete(options.summaryContext);
    },
    approve() {
      assertState(state);
      if (state.phase !== 'prepared' || state.intent === undefined) throw denied();
      state.phase = 'approved';
    },
    automatic() {
      assertState(state);
      if (state.phase !== 'created' || state.request.permissionMode !== 'yolo') throw denied();
      state.phase = 'automatic';
    },
    beginExecute() {
      assertState(state);
      if (state.executing) throw denied();
      state.executing = true;
      contexts.set(options.context, { token, kind: 'execute' });
      return () => {
        state.executing = false;
        contexts.delete(options.context);
      };
    },
    close() {
      state.active = false;
      contexts.delete(options.summaryContext);
      contexts.delete(options.context);
      attempts.delete(token);
      delete state.intent;
    },
  };
}

export async function bindMemoryWritePreview<TIntent extends object>(
  context: ToolExecutionContext,
  prepare: (
    caller: AgentToolInvocationAuthority,
    operation: MemoryWriteOperation,
  ) => Promise<{ intent: TIntent; summary: ToolApprovalSummary }>,
): Promise<ToolApprovalSummary> {
  const state = getBinding(context, 'summary');
  if (
    state.phase !== 'preview' ||
    state.previewStarted ||
    state.configuration.operation === undefined
  )
    throw denied();
  state.previewStarted = true;
  const assertLiveSync = () => {
    if (getBinding(context, 'summary') !== state || state.phase !== 'preview') throw denied();
  };
  const caller = bindCaller(state, () => assertState(state));
  const prepared = await prepare(caller, state.configuration.operation);
  assertLiveSync();
  state.intent = freezeIntent(prepared.intent);
  state.phase = 'prepared';
  return prepared.summary;
}

export function consumeMemoryWriteAttempt<TIntent extends object>(
  context: ToolExecutionContext,
): { caller: AgentToolInvocationAuthority; assertLiveSync(): void } & (
  { kind: 'approved'; intent: TIntent } | { kind: 'automatic' }
) {
  const state = getBinding(context, 'execute');
  if (
    !state.executing ||
    state.configuration.classification !== 'root-write' ||
    (state.phase !== 'approved' && state.phase !== 'automatic')
  )
    throw denied();
  // Independently require the existing execute-only authority bridge.
  readAgentToolAuthority(context);
  const phase = state.phase;
  state.phase = 'consumed';
  const assertLiveSync = () => {
    if (getBinding(context, 'execute') !== state || !state.executing || state.phase !== 'consumed')
      throw denied();
    readAgentToolAuthority(context);
  };
  const caller = bindCaller(state, assertLiveSync);
  return phase === 'approved'
    ? Object.freeze({ caller, assertLiveSync, kind: 'approved', intent: state.intent as TIntent })
    : Object.freeze({ caller, assertLiveSync, kind: 'automatic' });
}

/** Reads only the exact live execution context of a classified host Memory definition. */
export function readMemoryAgentToolAuthority(
  context: ToolExecutionContext,
): AgentToolInvocationAuthority {
  const state = getBinding(context, 'execute');
  if (!state.executing) throw denied();
  const assertLiveSync = () => {
    if (getBinding(context, 'execute') !== state || !state.executing) throw denied();
    readAgentToolAuthority(context);
  };
  assertLiveSync();
  return bindCaller(state, assertLiveSync);
}
