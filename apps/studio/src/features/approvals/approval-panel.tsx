import { useCallback, useEffect, useState, type ReactElement } from 'react';
import { FileText, ShieldAlert } from 'lucide-react';

import {
  decideApproval,
  readWriteFileSummary,
  subscribeApprovals,
  type ApprovalRequest,
} from './approval-api.js';

function upsert(
  approvals: readonly ApprovalRequest[],
  next: ApprovalRequest,
): readonly ApprovalRequest[] {
  const index = approvals.findIndex((approval) => approval.approvalId === next.approvalId);
  if (index === -1) {
    return [...approvals, next];
  }
  return approvals.map((approval, position) => (position === index ? next : approval));
}

/**
 * Subscribes to the Server Approval stream while `enabled` is true.
 *
 * The Server-side Broker stays the only source of truth; this hook only keeps
 * a view of it and forwards decisions.
 */
export function useApprovals(enabled: boolean): {
  readonly pending: readonly ApprovalRequest[];
  readonly decide: (approvalId: string, decision: 'approve' | 'reject') => Promise<void>;
} {
  const [approvals, setApprovals] = useState<readonly ApprovalRequest[]>([]);

  useEffect(() => {
    if (!enabled) {
      return;
    }
    const controller = new AbortController();
    void subscribeApprovals(
      {
        onSnapshot: (snapshot) => setApprovals(snapshot),
        onUpdate: (approval) => setApprovals((current) => upsert(current, approval)),
      },
      { signal: controller.signal },
    );
    return () => controller.abort();
  }, [enabled]);

  const decide = useCallback(async (approvalId: string, decision: 'approve' | 'reject') => {
    const updated = await decideApproval(approvalId, decision, {
      reason: decision === 'approve' ? '用户在 Studio 中同意' : '用户在 Studio 中拒绝',
    });
    setApprovals((current) => upsert(current, updated));
  }, []);

  return {
    pending: approvals.filter((approval) => approval.status === 'pending'),
    decide,
  };
}

const riskLabels: Record<ApprovalRequest['risk'], string> = {
  low: '低风险',
  medium: '中风险',
  high: '高风险',
};

function formatBytes(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`;
}

function ApprovalCard({
  approval,
  onDecide,
}: {
  readonly approval: ApprovalRequest;
  readonly onDecide: (approvalId: string, decision: 'approve' | 'reject') => Promise<void>;
}): ReactElement {
  const [state, setState] = useState<'idle' | 'submitting'>('idle');
  const [error, setError] = useState<string | null>(null);
  const writeSummary = readWriteFileSummary(approval);

  async function submit(decision: 'approve' | 'reject'): Promise<void> {
    setState('submitting');
    setError(null);
    try {
      await onDecide(approval.approvalId, decision);
    } catch (caught: unknown) {
      setError(caught instanceof Error ? caught.message : '审批提交失败');
      setState('idle');
    }
  }

  return (
    <article
      className={`approval-card approval-card-${approval.risk}`}
      aria-label={`待审批：${approval.summary}`}
    >
      <div className="approval-card-icon" aria-hidden="true">
        <ShieldAlert />
      </div>
      <div className="approval-card-body">
        <div className="approval-card-title">
          <strong>{writeSummary === undefined ? approval.summary : 'Agent 请求写入文件'}</strong>
          <span className="approval-risk">{riskLabels[approval.risk]}</span>
        </div>
        {writeSummary === undefined ? (
          <p className="approval-card-detail">工具 {approval.toolName}</p>
        ) : (
          <p className="approval-card-detail">
            <FileText aria-hidden="true" />
            <code>{writeSummary.path}</code>
            <span>{formatBytes(writeSummary.bytes)}</span>
            {writeSummary.overwrite ? (
              <span className="approval-overwrite">覆盖已有文件</span>
            ) : (
              <span>新建文件</span>
            )}
          </p>
        )}
        {error === null ? null : (
          <p className="approval-card-error" role="alert">
            {error}
          </p>
        )}
      </div>
      <div className="approval-card-actions">
        <button
          className="secondary-button"
          type="button"
          disabled={state === 'submitting'}
          onClick={() => void submit('reject')}
        >
          拒绝
        </button>
        <button
          className="primary-button"
          type="button"
          disabled={state === 'submitting'}
          onClick={() => void submit('approve')}
        >
          {writeSummary === undefined ? '同意' : '同意写入'}
        </button>
      </div>
    </article>
  );
}

/** Lists pending Approvals above the composer. Renders nothing when empty. */
export function ApprovalPanel({
  pending,
  onDecide,
}: {
  readonly pending: readonly ApprovalRequest[];
  readonly onDecide: (approvalId: string, decision: 'approve' | 'reject') => Promise<void>;
}): ReactElement | null {
  if (pending.length === 0) {
    return null;
  }
  return (
    <section className="approval-panel" aria-label="待审批操作">
      {pending.map((approval) => (
        <ApprovalCard key={approval.approvalId} approval={approval} onDecide={onDecide} />
      ))}
    </section>
  );
}
