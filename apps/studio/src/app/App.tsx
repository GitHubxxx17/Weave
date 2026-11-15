import { FormEvent, useRef, useState } from 'react';

import { AgentStreamError, streamAgentRun } from '../features/agent/agent-stream.js';
import type { AgentRuntimeEvent } from '../features/agent/agent-types.js';

type RunStatus = 'idle' | 'streaming' | 'completed' | 'error' | 'cancelled';

type ChatMessage = {
  readonly id: string;
  readonly role: 'user' | 'assistant';
  readonly text: string;
};

type ToolActivity = {
  readonly toolCallId: string;
  readonly name: string;
  readonly arguments: string;
  readonly status: 'called' | 'executing' | 'completed' | 'failed';
  readonly result?: string;
};

const statusLabels: Record<RunStatus, string> = {
  idle: 'Ready',
  streaming: 'Streaming',
  completed: 'Completed',
  error: 'Error',
  cancelled: 'Cancelled',
};

let nextId = 0;

function createId(prefix: string): string {
  nextId += 1;
  return `${prefix}-${nextId}`;
}

function safeErrorMessage(error: unknown): string {
  if (error instanceof AgentStreamError) {
    const separator = error.message.indexOf(': ');
    return separator === -1 ? error.message : error.message.slice(separator + 2);
  }

  return 'Agent run failed';
}

function updateToolActivity(
  activities: readonly ToolActivity[],
  toolCallId: string,
  update: (activity: ToolActivity | undefined) => ToolActivity,
): ToolActivity[] {
  const existing = activities.find((activity) => activity.toolCallId === toolCallId);
  const updated = update(existing);

  if (existing === undefined) {
    return [...activities, updated];
  }

  return activities.map((activity) => (activity.toolCallId === toolCallId ? updated : activity));
}

function getAssistantPlaceholder(status: RunStatus, isLatest: boolean): string {
  if (!isLatest) {
    return 'No response';
  }

  switch (status) {
    case 'streaming':
      return 'Thinking...';
    case 'cancelled':
      return 'Run cancelled';
    case 'error':
      return 'No response';
    case 'completed':
      return 'Agent returned no text';
    case 'idle':
      return 'No response';
  }
}

/** Studio's first local Agent workspace, combining chat state and stream events. */
export function App() {
  const [messageInput, setMessageInput] = useState('');
  const [messages, setMessages] = useState<readonly ChatMessage[]>([]);
  const [tools, setTools] = useState<readonly ToolActivity[]>([]);
  const [reasoning, setReasoning] = useState('');
  const [status, setStatus] = useState<RunStatus>('idle');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const latestAssistantMessageId = useRef<string | null>(null);
  const controller = useRef<AbortController | null>(null);
  const activeRunId = useRef<string | null>(null);

  function handleEvent(event: AgentRuntimeEvent, runId: string, assistantId: string): void {
    if (activeRunId.current !== runId) {
      return;
    }

    switch (event.type) {
      case 'text-delta':
        setMessages((current) =>
          current.map((message) =>
            message.id === assistantId ? { ...message, text: message.text + event.text } : message,
          ),
        );
        break;
      case 'reasoning-delta':
        setReasoning((current) => current + event.text);
        break;
      case 'tool-call':
        setTools((current) =>
          updateToolActivity(current, event.toolCall.id, () => ({
            toolCallId: event.toolCall.id,
            name: event.toolCall.name,
            arguments: event.toolCall.arguments,
            status: 'called',
          })),
        );
        break;
      case 'tool-executing':
        setTools((current) =>
          updateToolActivity(current, event.toolCall.id, (existing) => {
            const updated: ToolActivity = {
              toolCallId: event.toolCall.id,
              name: event.toolCall.name,
              arguments: event.toolCall.arguments,
              status: 'executing',
            };
            return existing?.result === undefined
              ? updated
              : { ...updated, result: existing.result };
          }),
        );
        break;
      case 'tool-result':
        setTools((current) =>
          updateToolActivity(current, event.result.toolCallId, (existing) => ({
            toolCallId: event.result.toolCallId,
            name: event.result.name,
            arguments: existing?.arguments ?? '',
            status: 'completed',
            result: event.result.content,
          })),
        );
        break;
      case 'completed':
        setStatus('completed');
        break;
    }
  }

  async function submitMessage(): Promise<void> {
    const text = messageInput.trim();
    if (text === '' || status === 'streaming') {
      return;
    }

    const userMessageId = createId('user');
    const assistantId = createId('assistant');
    const runId = createId('run');
    const requestController = new AbortController();

    latestAssistantMessageId.current = assistantId;
    activeRunId.current = runId;
    controller.current = requestController;
    setMessages((current) => [
      ...current,
      { id: userMessageId, role: 'user', text },
      { id: assistantId, role: 'assistant', text: '' },
    ]);
    setMessageInput('');
    setReasoning('');
    setTools([]);
    setErrorMessage(null);
    setStatus('streaming');

    try {
      await streamAgentRun(
        {
          sessionId: 'session-local',
          userMessage: {
            role: 'user',
            content: [{ type: 'text', text }],
          },
          provider: 'mock',
          model: 'weave-local-demo',
        },
        { onEvent: (event) => handleEvent(event, runId, assistantId) },
        { signal: requestController.signal },
      );
    } catch (error: unknown) {
      if (activeRunId.current !== runId) {
        return;
      }

      if (error instanceof DOMException && error.name === 'AbortError') {
        setStatus('cancelled');
      } else {
        setErrorMessage(safeErrorMessage(error));
        setStatus('error');
      }
    } finally {
      if (activeRunId.current === runId) {
        activeRunId.current = null;
        controller.current = null;
      }
    }
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    void submitMessage();
  }

  function cancelRun(): void {
    const requestController = controller.current;
    if (requestController === null) {
      return;
    }

    activeRunId.current = null;
    controller.current = null;
    requestController.abort();
    setStatus('cancelled');
  }

  return (
    <main className="studio-shell">
      <aside className="session-rail" aria-label="Sessions">
        <div className="rail-heading">
          <span className="brand-mark" aria-hidden="true">
            W
          </span>
          <div>
            <p className="eyebrow">Workspace</p>
            <h1>Weave Studio</h1>
          </div>
        </div>
        <button className="new-session-button" type="button">
          New session
        </button>
        <nav aria-label="Session list">
          <p className="section-label">Sessions</p>
          <button className="session-item session-item-active" type="button">
            <span>Local Agent demo</span>
            <span className="session-dot" aria-hidden="true" />
          </button>
          <button className="session-item" type="button">
            <span>Untitled session</span>
          </button>
        </nav>
        <div className="rail-footer">
          <span className="connection-dot" aria-hidden="true" />
          Local runtime
        </div>
      </aside>

      <section className="chat-column" aria-label="Agent chat">
        <header className="chat-header">
          <div>
            <p className="eyebrow">Session / local</p>
            <h2>Agent Chat</h2>
          </div>
          <span className={`run-status run-status-${status}`}>{statusLabels[status]}</span>
        </header>

        <div className="message-list" aria-live="polite">
          {messages.length === 0 ? (
            <div className="empty-chat">
              <p className="empty-kicker">Local runtime ready</p>
              <h3>Start a conversation with your Agent.</h3>
              <p>Messages stream through the local HTTP and SSE boundary.</p>
            </div>
          ) : (
            messages.map((message) => (
              <article className={`message message-${message.role}`} key={message.id}>
                <div className="message-meta">{message.role === 'user' ? 'You' : 'Agent'}</div>
                <p>
                  {message.text ||
                    getAssistantPlaceholder(
                      status,
                      message.id === latestAssistantMessageId.current,
                    )}
                </p>
              </article>
            ))
          )}
        </div>

        <form className="composer" onSubmit={handleSubmit}>
          <label htmlFor="message-input">Message</label>
          <textarea
            id="message-input"
            name="message"
            rows={3}
            value={messageInput}
            onChange={(event) => setMessageInput(event.target.value)}
            placeholder="Ask the local Agent..."
          />
          <div className="composer-footer">
            <span className="composer-hint">Mock provider · weave-local-demo</span>
            {status === 'streaming' ? (
              <button className="primary-button cancel-button" type="button" onClick={cancelRun}>
                Cancel
              </button>
            ) : (
              <button
                className="primary-button"
                type="submit"
                disabled={messageInput.trim() === ''}
              >
                Send
              </button>
            )}
          </div>
        </form>
      </section>

      <aside className="activity-panel" aria-label="Run activity">
        <header className="activity-header">
          <div>
            <p className="eyebrow">Observability</p>
            <h2>Activity</h2>
          </div>
          <span className="activity-count">{tools.length}</span>
        </header>

        {errorMessage !== null ? (
          <section className="activity-section error-section" aria-label="Run error">
            <div className="activity-section-heading">
              <h3>Run error</h3>
              <span className="status-badge status-failed">Error</span>
            </div>
            <p className="error-message">{errorMessage}</p>
          </section>
        ) : null}

        <section className="activity-section" aria-label="Reasoning">
          <div className="activity-section-heading">
            <h3>Reasoning</h3>
            <span className="activity-muted">{reasoning === '' ? 'Idle' : 'Live'}</span>
          </div>
          <p className="reasoning-text">{reasoning || 'Reasoning deltas will appear here.'}</p>
        </section>

        <section className="activity-section" aria-label="Tools">
          <div className="activity-section-heading">
            <h3>Tools</h3>
            <span className="activity-muted">{tools.length} events</span>
          </div>
          {tools.length === 0 ? (
            <p className="activity-muted">No tool activity yet.</p>
          ) : (
            <div className="tool-list">
              {tools.map((tool) => (
                <article className="tool-activity" key={tool.toolCallId}>
                  <div className="tool-heading">
                    <strong>{tool.name}</strong>
                    <span className={`status-badge status-${tool.status}`}>
                      {tool.status === 'called'
                        ? 'Called'
                        : tool.status === 'executing'
                          ? 'Running'
                          : tool.status === 'completed'
                            ? 'Completed'
                            : 'Failed'}
                    </span>
                  </div>
                  <pre>{tool.arguments}</pre>
                  {tool.result !== undefined ? <p className="tool-result">{tool.result}</p> : null}
                </article>
              ))}
            </div>
          )}
        </section>
      </aside>
    </main>
  );
}
