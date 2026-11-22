import type { AgentRunRequestInput, AgentStreamHandlers } from './agent-types.js';
import { launchAndObserveAgentExecution } from './agent-execution-client.js';
export {
  AgentStreamError,
  parseAgentEvent,
  parseSseFrame,
  streamLegacyAgentRun,
} from './agent-legacy-stream.js';

/** Launches an idempotent, Server-owned execution and observes its durable outcome. */
export function streamAgentRun(
  request: AgentRunRequestInput,
  handlers: AgentStreamHandlers,
  options?: { readonly signal?: AbortSignal; readonly requestId?: string | undefined },
): Promise<void> {
  return launchAndObserveAgentExecution(request, handlers, options);
}
