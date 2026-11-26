import type { SessionEvent } from './events.js';
import { projectAgentExecutionQueue } from './execution-events.js';
import { projectSession } from './projection.js';
import type { CapturedWorkspaceContext } from './workspace-context.js';

/**
 * Loads captured workspace contexts only for user messages whose exact accepted
 * execution has started. Session projection already rejects a started Turn that
 * does not match its accepted execution and user message.
 */
export function projectMessageWorkspaceContexts(
  events: readonly SessionEvent[],
): ReadonlyMap<string, CapturedWorkspaceContext> {
  if (events.length === 0) return new Map();
  const projection = projectSession(events);
  projectAgentExecutionQueue(events);
  const accepted = new Map<string, CapturedWorkspaceContext>();
  for (const event of events) {
    if (event.type === 'execution.accepted' && event.payload.workspaceContext !== undefined) {
      accepted.set(event.payload.userMessageId, event.payload.workspaceContext);
    }
  }
  const contexts = new Map<string, CapturedWorkspaceContext>();
  for (const message of projection.messages) {
    const context = accepted.get(message.messageId);
    if (context !== undefined && message.turnId !== undefined)
      contexts.set(message.messageId, structuredClone(context));
  }
  return contexts;
}
