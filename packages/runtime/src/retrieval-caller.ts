import {
  describeAgentToolAuthority,
  type AgentToolAuthority,
  type AgentToolInvocationAuthority,
} from './agent-tool-authority.js';
import { RetrievalError } from './retrieval-errors.js';
import type { RetrievalCaller } from './retrieval-types.js';

interface Binding {
  readonly invocation: AgentToolInvocationAuthority;
  readonly authority: AgentToolAuthority;
  readonly assertLiveSync: () => void;
}

const callers = new WeakMap<RetrievalCaller, Binding>();

export function bindRetrievalCaller(
  invocation: AgentToolInvocationAuthority,
  authority: AgentToolAuthority,
  assertLiveSync: () => void,
): RetrievalCaller {
  assertLiveSync();
  if (describeAgentToolAuthority(authority).identity !== invocation.identity)
    throw new RetrievalError('retrieval-scope-forbidden');
  const caller = Object.freeze({}) as RetrievalCaller;
  callers.set(caller, { invocation, authority, assertLiveSync });
  return caller;
}

function bindingFor(caller: RetrievalCaller): Binding {
  const binding = callers.get(caller);
  if (binding === undefined) throw new RetrievalError('retrieval-scope-forbidden');
  binding.assertLiveSync();
  return binding;
}

export function retrievalCallerAuthority(caller: RetrievalCaller): AgentToolAuthority {
  return bindingFor(caller).authority;
}

export function describeRetrievalCaller(caller: RetrievalCaller): AgentToolInvocationAuthority {
  return bindingFor(caller).invocation;
}
