import {
  assertAuthorizedTool,
  agentToolAuthorityParent,
  readAgentToolInvocation,
  readAgentToolAuthority,
} from './agent-tool-authority.js';
import { bindRetrievalCaller } from './retrieval-caller.js';
import {
  ToolExecutionError,
  type RegisteredToolDefinition,
  type ToolDefinition,
  type ToolExecutionRequest,
  type ToolExecutionContext,
  type ToolApprovalSummary,
} from './tool-types.js';
import type { ToolRegistry } from './tool-registry.js';
import type { RetrievalCaller } from './retrieval-types.js';
interface Configuration {
  readonly rootOnly: boolean;
  readonly protected: boolean;
  readonly operation?: string;
  readonly forceApproval?: (input: unknown) => boolean;
  readonly signal?: AbortSignal;
}
const definitions = new WeakMap<object, Configuration>();
const approvals = new WeakMap<object, object>();
export function configureRetrievalToolDefinition<I, O>(
  definition: ToolDefinition<I, O>,
  config: Configuration,
): void {
  if (
    definitions.has(definition) ||
    (config.protected &&
      (!definition.approval || definition.approval.operation !== config.operation))
  )
    throw new TypeError('Invalid Retrieval host tool configuration');
  definitions.set(definition, Object.freeze({ ...config }));
  if (definition.approval) approvals.set(definition, definition.approval);
}
export function retrievalToolConfiguration(
  definition: RegisteredToolDefinition | undefined,
): Configuration | undefined {
  return definition && definitions.get(definition);
}
const denied = () =>
  new ToolExecutionError('tool-not-permitted', 'The Retrieval tool has no active host authority');
function assertDefinition(definition: RegisteredToolDefinition, config: Configuration): void {
  if (
    config.protected &&
    (definition.approval !== approvals.get(definition) ||
      definition.approval?.operation !== config.operation ||
      definition.approval?.risk !== 'high')
  )
    throw denied();
}
export function assertRetrievalToolAuthority(
  request: ToolExecutionRequest,
  registry: ToolRegistry,
  definition: RegisteredToolDefinition | undefined,
  allow: ((definition: RegisteredToolDefinition) => boolean) | undefined,
): void {
  const config = retrievalToolConfiguration(definition);
  if (!config) return;
  if (!definition || !request.toolAuthority || allow?.(definition) !== true) throw denied();
  assertDefinition(definition, config);
  assertAuthorizedTool(request, registry, definition);
  if (config.rootOnly && agentToolAuthorityParent(request.toolAuthority) !== undefined)
    throw denied();
}
interface State {
  readonly definition: RegisteredToolDefinition;
  readonly request: ToolExecutionRequest;
  readonly registry: ToolRegistry;
  readonly context: ToolExecutionContext;
  readonly summaryContext: ToolExecutionContext;
  readonly assertCurrent: () => void;
  readonly configuration: Configuration;
  active: boolean;
  executing: boolean;
  phase: 'created' | 'preview' | 'prepared' | 'approved' | 'automatic' | 'consumed';
  prepared?: object;
  dispose?: () => void;
}
const contexts = new WeakMap<ToolExecutionContext, { state: State; kind: 'summary' | 'execute' }>();
function assertState(state: State): void {
  if (
    !state.active ||
    state.context.signal.aborted ||
    state.configuration.signal?.aborted ||
    definitions.get(state.definition) !== state.configuration
  )
    throw denied();
  state.assertCurrent();
  assertDefinition(state.definition, state.configuration);
  assertAuthorizedTool(state.request, state.registry, state.registry.get(state.request.name));
  if (
    state.configuration.rootOnly &&
    agentToolAuthorityParent(state.request.toolAuthority) !== undefined
  )
    throw denied();
}
function binding(context: ToolExecutionContext, kind: 'summary' | 'execute'): State {
  const found = contexts.get(context);
  if (
    !found ||
    found.kind !== kind ||
    (kind === 'execute' ? found.state.context : found.state.summaryContext) !== context
  )
    throw denied();
  assertState(found.state);
  return found.state;
}
function caller(state: State): RetrievalCaller {
  return bindRetrievalCaller(
    readAgentToolInvocation(state.request),
    state.request.toolAuthority!,
    () => assertState(state),
  );
}
export function beginRetrievalToolAttempt(
  options: Omit<State, 'active' | 'executing' | 'phase' | 'configuration'>,
) {
  const configuration = definitions.get(options.definition);
  if (!configuration) throw denied();
  const state: State = {
    ...options,
    configuration,
    active: true,
    executing: false,
    phase: 'created',
  };
  return {
    beginPreview() {
      assertState(state);
      if (state.phase !== 'created' || !configuration.protected) throw denied();
      state.phase = 'preview';
      contexts.set(state.summaryContext, { state, kind: 'summary' });
      return () => contexts.delete(state.summaryContext);
    },
    approve() {
      assertState(state);
      if (state.phase !== 'prepared') throw denied();
      state.phase = 'approved';
    },
    automatic() {
      assertState(state);
      if (state.phase !== 'created') throw denied();
      state.phase = 'automatic';
    },
    beginExecute() {
      assertState(state);
      if (state.executing) throw denied();
      state.executing = true;
      contexts.set(state.context, { state, kind: 'execute' });
      return () => {
        state.executing = false;
        contexts.delete(state.context);
      };
    },
    close() {
      state.active = false;
      contexts.delete(state.context);
      contexts.delete(state.summaryContext);
      state.dispose?.();
      delete state.prepared;
    },
  };
}
export async function bindRetrievalToolPreview<T extends object>(
  context: ToolExecutionContext,
  prepare: (
    caller: RetrievalCaller,
  ) => Promise<{ prepared: T; summary: ToolApprovalSummary; dispose?: () => void }>,
): Promise<ToolApprovalSummary> {
  const state = binding(context, 'summary');
  if (state.phase !== 'preview') throw denied();
  state.phase = 'prepared';
  const result = await prepare(caller(state));
  try {
    assertState(state);
  } catch (error) {
    result.dispose?.();
    throw error;
  }
  state.prepared = result.prepared;
  if (result.dispose) state.dispose = result.dispose;
  return result.summary;
}
export function consumeRetrievalToolAttempt<T extends object>(
  context: ToolExecutionContext,
): { caller: RetrievalCaller; prepared?: T; approved: boolean; assertLiveSync(): void } {
  const state = binding(context, 'execute');
  readAgentToolAuthority(context);
  if (
    !state.executing ||
    (state.configuration.protected && state.phase !== 'approved' && state.phase !== 'automatic') ||
    state.phase === 'consumed'
  )
    throw denied();
  const approved = state.phase === 'approved';
  state.phase = 'consumed';
  return {
    caller: caller(state),
    ...(state.prepared ? { prepared: state.prepared as T } : {}),
    approved,
    assertLiveSync() {
      if (binding(context, 'execute') !== state || !state.executing) throw denied();
      readAgentToolAuthority(context);
    },
  };
}
