import type { ReactElement } from 'react';
import type { AgentExecutionQueueSnapshot } from './agent-execution-types.js';

/** Queue rows describe future prompts; only claimed executions join conversation history. */
export function ExecutionQueueList({
  state,
  pending,
  onCancel,
  onMove,
  onCopy,
}: {
  readonly state: AgentExecutionQueueSnapshot;
  readonly pending: boolean;
  readonly onCancel: (executionId: string) => void;
  readonly onMove: (executionId: string) => void;
  readonly onCopy: (executionId: string) => void;
}): ReactElement {
  return (
    <section className="execution-queue" aria-label="待执行消息">
      <div className="execution-queue-heading">
        <strong>
          待执行 {state.queued.length}/{state.limits.sessionQueued}
        </strong>
        <span>停止仅影响当前运行</span>
      </div>
      {state.error !== undefined ? <p role="alert">{state.error.message}</p> : null}
      {state.queued.length > 0 ? (
        <ol>
          {state.queued.map((entry, index) => (
            <li key={entry.executionId}>
              <div className="execution-queue-preview">{entry.preview || '图片消息'}</div>
              <div className="execution-queue-meta">
                {entry.provider} · {entry.model} · {entry.imageCount} 张图片 · {entry.skillCount}{' '}
                个技能
              </div>
              <div className="execution-queue-actions">
                <button
                  type="button"
                  disabled={pending || index === 0}
                  aria-label={`上移第 ${index + 1} 条消息`}
                  onClick={() => onMove(entry.executionId)}
                >
                  上移
                </button>
                <button
                  type="button"
                  disabled={pending}
                  aria-label={`复制第 ${index + 1} 条消息到草稿`}
                  onClick={() => onCopy(entry.executionId)}
                >
                  复制到草稿
                </button>
                <button
                  type="button"
                  disabled={pending}
                  aria-label={`取消第 ${index + 1} 条消息`}
                  onClick={() => onCancel(entry.executionId)}
                >
                  取消
                </button>
              </div>
            </li>
          ))}
        </ol>
      ) : null}
    </section>
  );
}
