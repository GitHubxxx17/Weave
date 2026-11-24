import type { AgentRunRequestInput, AgentStreamHandlers } from './agent-types.js';
import { launchAgentExecution } from './agent-execution-client.js';
export { launchAndObserveAgentExecution } from './agent-execution-client.js';
export { AgentStreamError, parseSseFrame } from './agent-stream-error.js';

/** Launches an idempotent, Server-owned execution and observes its durable outcome. */
export function streamAgentRun(
  request: AgentRunRequestInput,
  handlers: AgentStreamHandlers,
  options?: { readonly signal?: AbortSignal; readonly requestId?: string | undefined },
): Promise<void> {
  return launchAgentExecution(request, handlers, options).then(() => undefined);
}
