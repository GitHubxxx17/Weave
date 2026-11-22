import type { SessionEvent } from './events.js';
import { projectAgentExecutionQueue } from './execution-events.js';
import type { CapturedFileContext } from './file-context.js';
import { projectSession } from './projection.js';

/** Loads bodies only for messages whose exact accepted execution has started. */
export function projectMessageFileContexts(
  events: readonly SessionEvent[],
): ReadonlyMap<string, CapturedFileContext> {
  if (events.length === 0) return new Map();
  const projection = projectSession(events);
  projectAgentExecutionQueue(events);
  const accepted = new Map<string, CapturedFileContext>();
  for (const event of events) {
    if (event.type === 'execution.accepted' && event.payload.fileContext !== undefined) {
      accepted.set(event.payload.userMessageId, event.payload.fileContext);
    }
  }
  const contexts = new Map<string, CapturedFileContext>();
  for (const message of projection.messages) {
    if (message.fileAttachments === undefined) continue;
    const context = accepted.get(message.messageId);
    if (context === undefined) throw new Error('Captured message has no accepted file context');
    contexts.set(message.messageId, structuredClone(context));
  }
  return contexts;
}
