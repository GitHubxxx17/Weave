import { Square } from 'lucide-react';
import type { RetrievalJob, RetrievalStatus } from './types.js';

const phases = {
  accepted: '已接受',
  capturing: '正在检查来源',
  indexing: '正在写入索引',
  embedding: '正在生成向量',
  validating: '正在验证索引',
  publishing: '正在发布索引',
  cancelling: '正在取消',
};
const failures = {
  'stale-source': '来源已变更',
  'root-changed': '项目文件夹已变更',
  'memory-revoked': '记忆访问已撤销',
  'embedding-unavailable': '向量服务不可用',
  'embedding-failed': '生成向量失败',
  'index-failed': '写入索引失败',
  deadline: '构建超时',
};
const availability = {
  ready: '索引可用',
  'not-built': '尚未构建索引',
  'root-changed': '项目文件夹已变更，请重建索引',
  'generation-unavailable': '已发布的索引不可用，请重建索引',
};

function jobLabel({ job, live }: RetrievalJob): string {
  if (!job.terminal) return live ? phases[live.phase] : job.startedAt ? '正在构建' : '已接受';
  switch (job.terminal.status) {
    case 'completed':
      return '已完成';
    case 'cancelled':
      return '已取消';
    case 'interrupted':
      return '服务重启，构建已中断';
    case 'failed':
      return failures[job.terminal.code];
  }
}

export function JobStatus({
  status,
  jobs,
  cancelPending,
  onCancel,
  onMore,
}: {
  status: RetrievalStatus | undefined;
  jobs: RetrievalJob[];
  cancelPending: string | undefined;
  onCancel: (jobId: string) => void;
  onMore: (() => void) | undefined;
}) {
  const activeJob = status?.activeJob;
  const history = jobs.filter(({ job }) => job.receipt.jobId !== activeJob?.job.receipt.jobId);
  return (
    <section className="retrieval-jobs" aria-label="索引状态">
      <h2>索引状态</h2>
      {status && <p>{availability[status.availability]}</p>}
      {status?.active && (
        <p className="retrieval-muted">
          {status.active.mode === 'hybrid' ? '混合索引' : '本地索引'} ·{' '}
          {status.active.counts.chunks} 个片段
        </p>
      )}
      {status?.active && activeJob && (
        <p className="retrieval-muted">构建期间仍可搜索已发布的索引。</p>
      )}
      {status?.availability === 'ready' && status.needsRebuild && (
        <p role="status">部分来源可能已变更。</p>
      )}
      {activeJob && (
        <div className="retrieval-live-job" aria-live="polite">
          <div>
            <strong>{jobLabel(activeJob)}</strong>
            {activeJob.live && (
              <p className="retrieval-muted">
                已采集 {activeJob.live.captured} 项 · {activeJob.live.chunks} 个片段
                {activeJob.job.mode === 'hybrid'
                  ? ` · 已生成 ${activeJob.live.embedded} 个向量`
                  : ''}
              </p>
            )}
          </div>
          <button
            type="button"
            disabled={
              cancelPending === activeJob.job.receipt.jobId ||
              activeJob.live?.phase === 'cancelling'
            }
            onClick={() => onCancel(activeJob.job.receipt.jobId)}
          >
            <Square aria-hidden="true" />
            取消构建
          </button>
        </div>
      )}
      {history.length > 0 && (
        <details>
          <summary>构建记录</summary>
          <ul className="retrieval-compact-list retrieval-history">
            {history.map((entry) => (
              <li key={entry.job.receipt.jobId}>
                <span>
                  {entry.job.mode === 'hybrid' ? '混合索引' : '本地索引'} · {jobLabel(entry)}
                </span>
                <time dateTime={entry.job.acceptedAt}>
                  {new Date(entry.job.acceptedAt).toLocaleString()}
                </time>
              </li>
            ))}
          </ul>
          {onMore && (
            <button type="button" onClick={onMore}>
              加载更多构建记录
            </button>
          )}
        </details>
      )}
    </section>
  );
}
