import type { ReactElement } from 'react';

import type { DraftCapture } from '../features/composer/use-composer-draft.js';
import type { AgentExecutionSnapshot } from '../features/agent/agent-execution-types.js';

export type QueuedCopyRequest = {
  readonly snapshot: AgentExecutionSnapshot;
  readonly owner: DraftCapture;
};

export type QueuedCopyDialogProps = {
  readonly copyRequest: QueuedCopyRequest;
  readonly applyQueuedCopy: (
    snapshot: AgentExecutionSnapshot,
    owner: DraftCapture,
    append: boolean,
  ) => void;
  readonly setCopyRequest: (request: null) => void;
};

/** Asks whether a copied queued message appends to or replaces the current draft. */
export function QueuedCopyDialog({
  copyRequest,
  applyQueuedCopy,
  setCopyRequest,
}: QueuedCopyDialogProps): ReactElement {
  return (
    <div className="modal-backdrop">
      <section
        className="queue-copy-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="复制队列消息"
      >
        <h2>保留当前草稿</h2>
        <p>请选择追加或替换；原消息仍在队列中。</p>
        <div className="queue-copy-dialog-actions">
          <button
            type="button"
            onClick={() => applyQueuedCopy(copyRequest.snapshot, copyRequest.owner, true)}
          >
            追加到草稿
          </button>
          <button
            type="button"
            onClick={() => applyQueuedCopy(copyRequest.snapshot, copyRequest.owner, false)}
          >
            替换草稿
          </button>
          <button type="button" onClick={() => setCopyRequest(null)}>
            取消复制
          </button>
        </div>
      </section>
    </div>
  );
}
