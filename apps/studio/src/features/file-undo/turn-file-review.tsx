import {
  lazy,
  Suspense,
  useRef,
  useState,
  useMemo,
  useCallback,
  useSyncExternalStore,
  type ReactElement,
} from 'react';
import type { UndoFileResult, UndoRequest } from './file-undo-api.js';
import { createTurnFileReviewStore, type TurnFileReviewStore } from './turn-file-review-store.js';
import './turn-file-review.css';
const CapturedDiff = lazy(() =>
  import('../files-tree/file-diff-view.js').then((module) => ({
    default: module.CapturedFileDiffView,
  })),
);
const labels: Record<UndoFileResult['status'], string> = {
  restored: '已恢复',
  'already-restored': '已是原始状态',
  conflict: '存在冲突，已保留当前文件',
  failed: '恢复失败',
  unavailable: '无法安全撤销',
};
const reasons: Record<string, string> = {
  'legacy-snapshot': '旧快照缺少成功写入证明',
  'missing-write-intent': '缺少写入意图记录',
  'missing-write-outcome': '缺少成功写入结果',
  'snapshot-capture-failed': '写前原文未完整保存',
  'incomplete-write-evidence': '写入证明不完整',
  'incomplete-write-chain': '本轮存在无法验证的中间修改',
  'workspace-root-changed': '项目文件夹已改变',
  'snapshot-integrity': '快照内容校验失败',
  'current-content-changed': '文件已有后续修改',
  'symlink-path': '路径包含符号链接',
  'path-alias-conflict': '多个路径指向同一实际文件，本轮无法安全拆分',
  'filesystem-error': '文件访问失败，可重试',
};
export interface TurnFileReviewProps {
  readonly projectId: string;
  readonly sessionId: string;
  readonly turnId: string;
  readonly disabled: boolean;
  readonly store?: TurnFileReviewStore;
}
export function TurnFileReview({
  projectId,
  sessionId,
  turnId,
  disabled,
  store: providedStore,
}: TurnFileReviewProps): ReactElement {
  const [localStore] = useState(createTurnFileReviewStore);
  const store = providedStore ?? localStore;
  const owner = useMemo(() => ({ projectId, sessionId, turnId }), [projectId, sessionId, turnId]);
  const subscribe = useCallback(
    (listener: () => void) => store.subscribe(owner, listener),
    [store, owner],
  );
  const getSnapshot = useCallback(() => store.get(owner), [store, owner]);
  const { open, review, results, error, loading, confirm, pending, diffPath } =
    useSyncExternalStore(subscribe, getSnapshot);
  const disabledRef = useRef(disabled);
  disabledRef.current = disabled;
  const setConfirm = (value: boolean) => store.set(owner, { confirm: value });
  const setOpen = (value: boolean) => store.set(owner, { open: value });
  const setDiffPath = (value: string | undefined) => store.set(owner, { diffPath: value });
  function show() {
    store.set(owner, { open: !open });
    if (!open && review === undefined) void store.load(owner);
  }
  function restore(input?: UndoRequest) {
    return store.restore(owner, () => disabledRef.current, input);
  }
  const diff = review?.files.find((file) => file.path === diffPath);
  const canRestore = review?.files.some((file) => file.unavailableReason === undefined) ?? false;
  const retryable =
    results?.some((result) => result.status === 'failed' || result.status === 'conflict') ?? false;
  return (
    <div className="turn-file-undo">
      <button
        type="button"
        className="turn-file-review-toggle"
        onClick={show}
        aria-expanded={open}
        disabled={disabled}
      >
        审阅本轮文件
      </button>
      {open ? (
        <section className="turn-file-review" aria-label="本轮文件审阅">
          <h4>本轮文件改动</h4>
          <p>对比本轮开始前与本轮写入后的内容。仅恢复内建文件工具的改动。</p>
          {loading ? <p role="status">处理中…</p> : null}
          {error ? <p role="alert">{error}</p> : null}
          {review?.files.length === 0 ? <p>本轮没有可审阅的文件改动。</p> : null}
          <ul>
            {review?.files.map((file) => {
              const result = results?.find((result) => result.path === file.path);
              return (
                <li key={file.path}>
                  <strong>{file.path}</strong>
                  {file.unavailableReason ? (
                    <p>无法安全撤销：{reasons[file.unavailableReason] ?? '文件写入证明不完整'}</p>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setDiffPath(diffPath === file.path ? undefined : file.path)}
                    >
                      查看 {file.path} Diff
                    </button>
                  )}
                  {result ? (
                    <p role="status">
                      {labels[result.status]}
                      {reasons[result.reason] ? `：${reasons[result.reason]}` : ''}
                    </p>
                  ) : null}
                </li>
              );
            })}
          </ul>
          {diff?.afterContent !== undefined ? (
            <Suspense fallback={<p>加载 Diff…</p>}>
              <CapturedDiff
                path={diff.path}
                oldContent={diff.previousContent}
                newContent={diff.afterContent}
                existedBefore={diff.existedBefore}
              />
            </Suspense>
          ) : null}
          {pending !== undefined ? (
            <button
              type="button"
              disabled={loading || disabled}
              onClick={() => void restore(pending)}
            >
              {error ? '重试原请求' : '继续未完成请求'}
            </button>
          ) : null}
          {canRestore && pending === undefined && (results === undefined || retryable) ? (
            confirm ? (
              <div className="turn-file-confirm">
                <p>
                  确认恢复本轮文件原文并删除本轮新建文件？其他进程或后续修改会保留并显示冲突。此操作不撤销命令或外部工具的副作用。
                </p>
                <button type="button" disabled={loading || disabled} onClick={() => void restore()}>
                  确认撤销
                </button>
                <button type="button" disabled={loading} onClick={() => setConfirm(false)}>
                  取消
                </button>
              </div>
            ) : (
              <button type="button" disabled={loading || disabled} onClick={() => setConfirm(true)}>
                {retryable ? '重试未恢复文件' : '撤销本轮文件改动'}
              </button>
            )
          ) : null}
          <button
            type="button"
            onClick={() => {
              setOpen(false);
              setConfirm(false);
            }}
          >
            关闭审阅
          </button>
        </section>
      ) : null}
    </div>
  );
}
