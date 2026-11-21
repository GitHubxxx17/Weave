import { useCallback, useEffect, useId, useState, type ReactElement } from 'react';
import { ChevronDown, ChevronUp, FileText, ShieldAlert } from 'lucide-react';

import {
  decideApproval,
  readCommandSummary,
  readEditFileSummary,
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

function formatDuration(milliseconds: number): string {
  if (milliseconds >= 60_000) {
    const minutes = milliseconds / 60_000;
    return `${Number.isInteger(minutes) ? minutes : minutes.toFixed(1)} 分钟`;
  }
  return `${Math.round(milliseconds / 1000)} 秒`;
}

function diffLineClass(line: string): string {
  if (line.startsWith('@@')) {
    return 'approval-diff-line approval-diff-hunk';
  }
  if (line.startsWith('+')) {
    return 'approval-diff-line approval-diff-added';
  }
  if (line.startsWith('-')) {
    return 'approval-diff-line approval-diff-removed';
  }
  return 'approval-diff-line';
}

/** Pretty JSON of a summary from an unknown tool; `undefined` when it is empty. */
function formatGenericSummary(inputSummary: unknown): string | undefined {
  if (inputSummary === undefined || inputSummary === null) {
    return undefined;
  }
  if (typeof inputSummary === 'object' && Object.keys(inputSummary).length === 0) {
    return undefined;
  }
  try {
    return JSON.stringify(inputSummary, null, 2);
  } catch {
    return undefined;
  }
}

/**
 * The complete request shown when a card is expanded: the full command, the
 * diff of an edit, the details of a write, or the raw summary of other tools.
 * Returns `null` when there is nothing beyond the collapsed card.
 */
function renderDetails(approval: ApprovalRequest): ReactElement | null {
  const command = readCommandSummary(approval);
  if (command !== undefined) {
    return (
      <>
        <p className="approval-meta">
          工作目录 <code>{command.cwd}</code> · 超时 {formatDuration(command.timeoutMs)}
        </p>
        <pre className="approval-code" tabIndex={0}>
          {command.command}
        </pre>
      </>
    );
  }

  const edit = readEditFileSummary(approval);
  if (edit !== undefined) {
    return (
      <>
        <p className="approval-meta">
          <code>{edit.path}</code> · 替换 {edit.replacements} 处 · 新增 {edit.linesAdded} 行，删除{' '}
          {edit.linesRemoved} 行
        </p>
        <pre className="approval-code approval-diff" tabIndex={0}>
          {edit.diff.split('\n').map((line, index) => (
            <span key={index} className={diffLineClass(line)}>
              {line}
            </span>
          ))}
        </pre>
        {edit.diffTruncated ? <p className="approval-meta">改动较多，只显示前 200 行</p> : null}
      </>
    );
  }

  const write = readWriteFileSummary(approval);
  if (write !== undefined) {
    const facts = [
      `新内容 ${formatBytes(write.bytes)}${write.lines === undefined ? '' : `，${write.lines} 行`}`,
    ];
    if (write.previousBytes !== undefined) {
      facts.push(
        `覆盖前 ${formatBytes(write.previousBytes)}${
          write.previousLines === undefined ? '' : `，${write.previousLines} 行`
        }`,
      );
    }
    if (write.createdDirectories !== undefined && write.createdDirectories.length > 0) {
      facts.push(`会新建目录 ${write.createdDirectories.join('、')}`);
    }
    return (
      <ul className="approval-facts">
        {facts.map((fact) => (
          <li key={fact}>{fact}</li>
        ))}
      </ul>
    );
  }

  const generic = formatGenericSummary(approval.inputSummary);
  return generic === undefined ? null : (
    <pre className="approval-code" tabIndex={0}>
      {generic}
    </pre>
  );
}

function ApprovalCard({
  approval,
  onDecide,
  onInspectToolCall,
}: {
  readonly approval: ApprovalRequest;
  readonly onDecide: (approvalId: string, decision: 'approve' | 'reject') => Promise<void>;
  readonly onInspectToolCall?: (toolCallId: string) => void;
}): ReactElement {
  const [state, setState] = useState<'idle' | 'submitting'>('idle');
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const contentId = useId();
  const writeSummary = readWriteFileSummary(approval);
  const details = renderDetails(approval);

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
      <div className="approval-card-row">
        <div className="approval-card-icon" aria-hidden="true">
          <ShieldAlert />
        </div>
        <div className="approval-card-body">
          <div className="approval-card-title">
            <strong>{writeSummary === undefined ? approval.summary : 'Agent 请求写入文件'}</strong>
            <span className="approval-risk">{riskLabels[approval.risk]}</span>
          </div>
          <p className="approval-card-detail">
            {writeSummary === undefined ? (
              <span>工具 {approval.toolName}</span>
            ) : (
              <>
                <FileText aria-hidden="true" />
                <code>{writeSummary.path}</code>
                <span>{formatBytes(writeSummary.bytes)}</span>
                {writeSummary.overwrite ? (
                  <span className="approval-overwrite">覆盖已有文件</span>
                ) : (
                  <span>新建文件</span>
                )}
              </>
            )}
            {details === null ? null : (
              <button
                className="approval-toggle"
                type="button"
                aria-expanded={expanded}
                aria-controls={expanded ? contentId : undefined}
                onClick={() => setExpanded((current) => !current)}
              >
                {expanded ? '收起' : '展开'}
                {expanded ? <ChevronUp aria-hidden="true" /> : <ChevronDown aria-hidden="true" />}
              </button>
            )}
            {onInspectToolCall === undefined ? null : (
              <button
                className="approval-toggle"
                type="button"
                onClick={() => onInspectToolCall(approval.toolCallId)}
              >
                查看参数
              </button>
            )}
          </p>
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
      </div>
      {expanded && details !== null ? (
        <div className="approval-card-content" id={contentId}>
          {details}
        </div>
      ) : null}
    </article>
  );
}

/** Lists pending Approvals above the composer. Renders nothing when empty. */
export function ApprovalPanel({
  pending,
  onDecide,
  onInspectToolCall,
}: {
  readonly pending: readonly ApprovalRequest[];
  readonly onDecide: (approvalId: string, decision: 'approve' | 'reject') => Promise<void>;
  readonly onInspectToolCall?: (toolCallId: string) => void;
}): ReactElement | null {
  if (pending.length === 0) {
    return null;
  }
  return (
    <section className="approval-panel" aria-label="待审批操作">
      {pending.map((approval) => (
        <ApprovalCard
          key={approval.approvalId}
          approval={approval}
          onDecide={onDecide}
          {...(onInspectToolCall === undefined ? {} : { onInspectToolCall })}
        />
      ))}
    </section>
  );
}
