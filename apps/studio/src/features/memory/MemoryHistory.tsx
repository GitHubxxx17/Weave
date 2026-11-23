import { useEffect, useRef, useState, type ReactElement } from 'react';
import { MemoryApiError, type MemoryClient } from './client.js';
import type { MemoryHistoryPage, MemoryRef, MemoryScope } from './types.js';

export function MemoryHistory({
  client,
  scope,
  memoryId,
  refresh,
  onRead,
}: {
  readonly client: MemoryClient;
  readonly scope: MemoryScope;
  readonly memoryId: string;
  readonly refresh: number;
  readonly onRead: (ref: MemoryRef) => void;
}): ReactElement {
  const [cursor, setCursor] = useState<string>();
  const [page, setPage] = useState<MemoryHistoryPage>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [retry, setRetry] = useState(0);
  const identity = useRef(0);
  useEffect(() => {
    const request = ++identity.current;
    const controller = new AbortController();
    setLoading(true);
    setError(undefined);
    setPage(undefined);
    void client
      .history(scope, memoryId, cursor, controller.signal)
      .then((value) => {
        if (!controller.signal.aborted && identity.current === request) setPage(value);
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted || identity.current !== request) return;
        if (
          cursor !== undefined &&
          cause instanceof MemoryApiError &&
          ['memory-stale-cursor', 'memory-invalid-cursor'].includes(cause.code)
        )
          setCursor(undefined);
        else setError(cause instanceof Error ? cause.message : '无法读取记忆历史');
      })
      .finally(() => {
        if (!controller.signal.aborted && identity.current === request) setLoading(false);
      });
    return () => controller.abort();
  }, [client, scope, memoryId, cursor, refresh, retry]);
  return (
    <section className="memory-history" aria-label="记忆历史">
      <h3>版本历史</h3>
      <p className="memory-muted">修订、审阅与删除均保留在历史中。</p>
      {loading ? <p role="status">正在读取历史…</p> : null}
      {error === undefined ? null : (
        <p role="alert">
          {error}{' '}
          <button type="button" onClick={() => setRetry((value) => value + 1)}>
            重试历史
          </button>
        </p>
      )}
      {page?.entries.length === 0 ? <p>暂无历史</p> : null}
      <ol>
        {page?.entries.map((entry) => (
          <li key={entry.sequence}>
            <span>
              {entry.subject.kind === 'record' ? `版本 ${entry.subject.revision}` : '权限变更'} ·{' '}
              {
                {
                  created: '创建',
                  revised: '修订',
                  reviewed: '审阅',
                  deleted: '删除',
                  'access-changed': '权限变更',
                }[entry.kind]
              }
            </span>
            <small>
              {new Date(entry.occurredAt).toLocaleString()} ·{' '}
              {entry.provenance.actor === 'agent' ? 'Agent' : '你'}
            </small>
            {entry.ref === undefined ? null : (
              <button type="button" onClick={() => onRead(entry.ref!)}>
                查看版本 {entry.ref.revision}
              </button>
            )}
          </li>
        ))}
      </ol>
      <div className="memory-actions">
        {cursor === undefined ? null : (
          <button type="button" disabled={loading} onClick={() => setCursor(undefined)}>
            历史第一页
          </button>
        )}
        {page?.nextCursor === undefined ? null : (
          <button type="button" disabled={loading} onClick={() => setCursor(page.nextCursor)}>
            下一页历史
          </button>
        )}
      </div>
    </section>
  );
}
