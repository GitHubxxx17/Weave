import { useEffect, useRef, useState, type ReactElement } from 'react';
import { BookOpen, Plus, Search, ShieldCheck, Trash2 } from 'lucide-react';
import { MarkdownMessage } from '../conversation/markdown-message.js';
import { createMemoryClient, MemoryApiError, type MemoryClient } from './client.js';
import { MemoryEditor } from './MemoryEditor.js';
import { MemoryHistory } from './MemoryHistory.js';
import {
  memoryScopeKey,
  type MemoryAccess,
  type MemoryAccessLevel,
  type MemoryCurrent,
  type MemoryPageResult,
  type MemoryReceipt,
  type MemoryRef,
  type MemoryScopeDescriptor,
} from './types.js';
import './memory.css';

const defaultClient = createMemoryClient();
const levels = { disabled: '停用', 'read-only': '只读', 'read-write': '读写（遵循运行权限）' };
export interface MemoryPageProps {
  readonly selectedProjectId?: string;
  readonly verifiedSessionIds?: readonly string[];
  readonly onNavigateSession?: (sessionId: string) => void;
  readonly client?: MemoryClient;
}
export function MemoryPage({
  selectedProjectId,
  verifiedSessionIds = [],
  onNavigateSession,
  client = defaultClient,
}: MemoryPageProps): ReactElement {
  const [scopes, setScopes] = useState<MemoryScopeDescriptor[]>();
  const [choice, setChoice] = useState(selectedProjectId ? `project:${selectedProjectId}` : 'user');
  const [error, setError] = useState<string>();
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    if (selectedProjectId) setChoice(`project:${selectedProjectId}`);
  }, [selectedProjectId]);
  useEffect(() => {
    const controller = new AbortController();
    let current = true;
    setError(undefined);
    void client
      .scopes(controller.signal)
      .then((value) => {
        if (!current || controller.signal.aborted) return;
        setScopes(value);
        setChoice((key) =>
          value.some((item) => memoryScopeKey(item.scope) === key) ? key : 'user',
        );
      })
      .catch((cause: unknown) => {
        if (current && !controller.signal.aborted)
          setError(cause instanceof Error ? cause.message : '无法加载记忆范围');
      });
    return () => {
      current = false;
      controller.abort();
    };
  }, [client, retry]);
  const selected = scopes?.find((item) => memoryScopeKey(item.scope) === choice);
  return (
    <section className="memory-page" aria-label="长期记忆">
      <header className="memory-page-header">
        <div>
          <BookOpen aria-hidden="true" />
          <h1>长期记忆</h1>
          <p>在会话之间保留明确保存的事实与偏好。</p>
        </div>
        <label className="memory-scope">
          记忆范围
          <select
            aria-label="记忆范围"
            value={choice}
            disabled={scopes === undefined}
            onChange={(event) => setChoice(event.target.value)}
          >
            {scopes?.map((item) => (
              <option key={memoryScopeKey(item.scope)} value={memoryScopeKey(item.scope)}>
                {item.name}
                {item.scope.kind === 'project' ? ' · 项目' : ''}
              </option>
            ))}
          </select>
        </label>
      </header>
      {error === undefined ? null : (
        <p role="alert">
          {error}{' '}
          <button type="button" onClick={() => setRetry((value) => value + 1)}>
            重试记忆服务
          </button>
        </p>
      )}
      {scopes === undefined && error === undefined ? <p role="status">正在读取记忆范围…</p> : null}
      {selected === undefined ? null : (
        <ScopeMemory
          key={memoryScopeKey(selected.scope)}
          descriptor={selected}
          client={client}
          verifiedSessionIds={verifiedSessionIds}
          onNavigateSession={onNavigateSession}
        />
      )}
    </section>
  );
}

function ScopeMemory({
  descriptor,
  client,
  verifiedSessionIds,
  onNavigateSession,
}: {
  readonly descriptor: MemoryScopeDescriptor;
  readonly client: MemoryClient;
  readonly verifiedSessionIds: readonly string[];
  readonly onNavigateSession?: ((sessionId: string) => void) | undefined;
}): ReactElement {
  const { scope } = descriptor;
  const [access, setAccess] = useState<MemoryAccess>(descriptor.access);
  const [accessError, setAccessError] = useState<string>();
  const [accessBusy, setAccessBusy] = useState(false);
  const accessRetry = useRef<
    { level: MemoryAccessLevel; expectedSettingRevision: number; requestId: string } | undefined
  >(undefined);
  const accessLock = useRef(false);
  const accessController = useRef<AbortController | undefined>(undefined);
  useEffect(() => {
    const controller = new AbortController();
    accessController.current = controller;
    accessLock.current = false;
    setAccessBusy(false);
    return () => {
      controller.abort();
      if (accessController.current === controller) accessController.current = undefined;
    };
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    void client
      .access(scope, controller.signal)
      .then((value) => {
        if (!controller.signal.aborted)
          setAccess((current) =>
            value.settingRevision >= current.settingRevision ? value : current,
          );
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted)
          setAccessError(cause instanceof Error ? cause.message : '无法读取使用权限');
      });
    return () => controller.abort();
  }, [client, scope]);
  const [query, setQuery] = useState('');
  const [tag, setTag] = useState('');
  const [cursor, setCursor] = useState<string>();
  const [page, setPage] = useState<MemoryPageResult>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const [refresh, setRefresh] = useState(0);
  const [selected, setSelected] = useState<string>();
  const identity = useRef(0);
  useEffect(() => {
    const request = ++identity.current;
    const controller = new AbortController();
    setLoading(true);
    setError(undefined);
    setPage(undefined);
    void client
      .list(
        scope,
        {
          query,
          ...(tag ? { tag } : {}),
          limit: 25,
          ...(cursor === undefined ? {} : { cursor }),
          includeAgentAuthored: true,
        },
        controller.signal,
      )
      .then((result) => {
        if (!controller.signal.aborted && identity.current === request) setPage(result);
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted || identity.current !== request) return;
        if (
          cursor !== undefined &&
          cause instanceof MemoryApiError &&
          ['memory-stale-cursor', 'memory-invalid-cursor'].includes(cause.code)
        )
          setCursor(undefined);
        else setError(cause instanceof Error ? cause.message : '无法加载记忆');
      })
      .finally(() => {
        if (!controller.signal.aborted && identity.current === request) setLoading(false);
      });
    return () => controller.abort();
  }, [client, scope, query, tag, cursor, refresh]);
  async function changeAccess(level: MemoryAccessLevel) {
    const active = accessController.current;
    if (accessLock.current || active === undefined || active.signal.aborted) return;
    accessLock.current = true;
    setAccessBusy(true);
    setAccessError(undefined);
    if (
      accessRetry.current?.level !== level ||
      accessRetry.current.expectedSettingRevision !== access.settingRevision
    )
      accessRetry.current = {
        level,
        expectedSettingRevision: access.settingRevision,
        requestId: crypto.randomUUID(),
      };
    try {
      const receipt = await client.setAccess(scope, accessRetry.current, active.signal);
      if (
        accessController.current === active &&
        !active.signal.aborted &&
        'level' in receipt.result
      ) {
        setAccess(receipt.result);
        accessRetry.current = undefined;
      }
    } catch (cause) {
      if (accessController.current === active && !active.signal.aborted)
        setAccessError(cause instanceof Error ? cause.message : '无法更新使用权限');
      if (cause instanceof MemoryApiError && cause.status === 409) {
        try {
          const current = await client.access(scope, active.signal);
          if (accessController.current === active && !active.signal.aborted) setAccess(current);
        } catch {
          /* Keep the safe failure visible. */
        }
      }
    } finally {
      if (accessController.current === active && !active.signal.aborted) {
        accessLock.current = false;
        setAccessBusy(false);
      }
    }
  }
  function saved(receipt: MemoryReceipt) {
    setCursor(undefined);
    setRefresh((value) => value + 1);
    if (receipt.subject.kind === 'record') setSelected(receipt.subject.memoryId);
  }
  return (
    <>
      <div className="memory-access">
        <div>
          <ShieldCheck aria-hidden="true" />
          <strong>Agent 与检索使用权限</strong>
          <p>
            {access.level === 'disabled'
              ? '已停用使用。你仍可查看、编辑和审阅本地记忆。'
              : '只有明确读取才会进入 Agent 上下文。个人记忆需要单独启用。'}
          </p>
        </div>
        <label>
          访问级别
          <select
            aria-label="Agent 与检索使用权限"
            value={access.level}
            disabled={accessBusy}
            onChange={(event) => {
              void changeAccess(event.target.value as MemoryAccessLevel);
            }}
          >
            {Object.entries(levels).map(([value, label]) => (
              <option value={value} key={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        {accessError === undefined ? null : (
          <p role="alert">
            {accessError}
            <button
              type="button"
              disabled={accessBusy || accessRetry.current === undefined}
              onClick={() => {
                if (accessRetry.current) void changeAccess(accessRetry.current.level);
              }}
            >
              重试权限更新
            </button>
          </p>
        )}
      </div>
      <div className="memory-workspace">
        <aside className="memory-list" aria-label="当前记忆">
          <div className="memory-list-heading">
            <h2>{descriptor.name}</h2>
            <button type="button" onClick={() => setSelected('new')}>
              <Plus aria-hidden="true" />
              新建记忆
            </button>
          </div>
          <label className="memory-search">
            <Search aria-hidden="true" />
            <input
              type="search"
              aria-label="搜索标题和正文"
              placeholder="搜索标题和正文"
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setCursor(undefined);
              }}
            />
          </label>
          <label className="memory-tag-filter">
            标签筛选
            <input
              aria-label="标签筛选"
              value={tag}
              placeholder="精确匹配标签"
              onChange={(event) => {
                setTag(event.target.value);
                setCursor(undefined);
              }}
            />
          </label>
          {loading ? <p role="status">正在读取记忆…</p> : null}
          {error === undefined ? null : (
            <p role="alert">
              {error}
              <button type="button" onClick={() => setRefresh((value) => value + 1)}>
                重试列表
              </button>
            </p>
          )}
          {page?.records.length === 0 ? (
            <div className="memory-empty">
              <BookOpen aria-hidden="true" />
              <p>{query || tag ? '没有匹配的记忆' : '还没有保存记忆'}</p>
              <small>保存项目约定、偏好或可复用的结论。</small>
            </div>
          ) : null}
          <ul>
            {page?.records.map((item) => (
              <li key={item.ref.memoryId}>
                <button
                  type="button"
                  aria-label={`查看 ${item.title}`}
                  aria-current={selected === item.ref.memoryId ? 'true' : undefined}
                  onClick={() => setSelected(item.ref.memoryId)}
                >
                  <strong>{item.title}</strong>
                  <span className={`memory-badge memory-badge-${item.review}`}>
                    {item.review === 'user-reviewed' ? '已审阅' : 'Agent 编写'}
                  </span>
                  <p>{item.excerpt}</p>
                  <small>
                    v{item.ref.revision} · {item.tags.join(' · ') || '无标签'}
                  </small>
                </button>
              </li>
            ))}
          </ul>
          <div className="memory-actions">
            {cursor === undefined ? null : (
              <button type="button" disabled={loading} onClick={() => setCursor(undefined)}>
                记忆第一页
              </button>
            )}
            {page?.nextCursor === undefined ? null : (
              <button type="button" disabled={loading} onClick={() => setCursor(page.nextCursor)}>
                下一页记忆
              </button>
            )}
          </div>
        </aside>
        <div className="memory-detail">
          {selected === 'new' ? (
            <MemoryEditor
              key="new"
              client={client}
              scope={scope}
              onSaved={saved}
              onCancel={() => setSelected(undefined)}
            />
          ) : selected === undefined ? (
            <div className="memory-empty">
              <BookOpen aria-hidden="true" />
              <h2>选择一条记忆</h2>
              <p>查看内容、来源和版本历史，或保存新的记忆。</p>
            </div>
          ) : (
            <MemoryDetail
              key={selected}
              client={client}
              descriptor={descriptor}
              memoryId={selected}
              refresh={refresh}
              onChanged={saved}
              verifiedSessionIds={verifiedSessionIds}
              onNavigateSession={onNavigateSession}
            />
          )}
        </div>
      </div>
    </>
  );
}

function MemoryDetail({
  client,
  descriptor,
  memoryId,
  refresh,
  onChanged,
  verifiedSessionIds,
  onNavigateSession,
}: {
  readonly client: MemoryClient;
  readonly descriptor: MemoryScopeDescriptor;
  readonly memoryId: string;
  readonly refresh: number;
  readonly onChanged: (receipt: MemoryReceipt) => void;
  readonly verifiedSessionIds: readonly string[];
  readonly onNavigateSession?: ((sessionId: string) => void) | undefined;
}): ReactElement {
  const { scope } = descriptor;
  const [record, setRecord] = useState<MemoryCurrent>();
  const [historical, setHistorical] = useState<MemoryRef>();
  const [editor, setEditor] = useState(false);
  const [deleted, setDeleted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [retry, setRetry] = useState(0);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const cancelDelete = useRef<HTMLButtonElement>(null);
  const identity = useRef(0);
  const operationLock = useRef(false);
  const operationController = useRef<AbortController | undefined>(undefined);
  const operationRetry = useRef<{ fingerprint: string; requestId: string } | undefined>(undefined);
  useEffect(() => {
    const controller = new AbortController();
    operationController.current = controller;
    operationLock.current = false;
    setBusy(false);
    return () => {
      controller.abort();
      if (operationController.current === controller) operationController.current = undefined;
    };
  }, []);
  useEffect(() => {
    if (confirmDelete) cancelDelete.current?.focus();
  }, [confirmDelete]);
  useEffect(() => {
    if (deleted && historical === undefined) return;
    const request = ++identity.current;
    const controller = new AbortController();
    setBusy(true);
    setError(undefined);
    void client
      .read(scope, memoryId, historical, controller.signal)
      .then((value) => {
        if (!controller.signal.aborted && request === identity.current) setRecord(value);
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted && request === identity.current)
          setError(cause instanceof Error ? cause.message : '无法读取记忆');
      })
      .finally(() => {
        if (!controller.signal.aborted && request === identity.current) setBusy(false);
      });
    return () => controller.abort();
  }, [client, scope, memoryId, historical, deleted, refresh, retry]);
  function updated(receipt: MemoryReceipt) {
    setEditor(false);
    setHistorical(undefined);
    setRetry((value) => value + 1);
    onChanged(receipt);
  }
  async function mutate(kind: 'review' | 'delete') {
    const active = operationController.current;
    if (
      record === undefined ||
      operationLock.current ||
      historical !== undefined ||
      deleted ||
      active === undefined ||
      active.signal.aborted
    )
      return;
    operationLock.current = true;
    setBusy(true);
    setError(undefined);
    const fingerprint = JSON.stringify({ kind, ref: record.ref });
    if (operationRetry.current?.fingerprint !== fingerprint)
      operationRetry.current = { fingerprint, requestId: crypto.randomUUID() };
    try {
      const receipt =
        kind === 'review'
          ? await client.review(
              scope,
              { requestId: operationRetry.current.requestId, targetRef: record.ref },
              active.signal,
            )
          : await client.remove(
              scope,
              {
                requestId: operationRetry.current.requestId,
                memoryId,
                expectedRevision: record.ref.revision,
              },
              active.signal,
            );
      if (operationController.current !== active || active.signal.aborted) return;
      operationRetry.current = undefined;
      setConfirmDelete(false);
      if (kind === 'delete') {
        setDeleted(true);
        setHistorical(undefined);
        onChanged(receipt);
      } else updated(receipt);
    } catch (cause) {
      if (operationController.current === active && !active.signal.aborted)
        setError(cause instanceof Error ? cause.message : '记忆操作失败');
    } finally {
      if (operationController.current === active && !active.signal.aborted) {
        operationLock.current = false;
        setBusy(false);
      }
    }
  }
  const source = record?.provenance.actor === 'agent' ? record.provenance : undefined;
  return (
    <section aria-label="记忆详情">
      {busy ? <p role="status">正在更新记忆…</p> : null}
      {error === undefined ? null : (
        <p role="alert">
          {error}{' '}
          <button type="button" onClick={() => setRetry((value) => value + 1)}>
            重新加载记忆
          </button>
        </p>
      )}
      {deleted && historical === undefined ? (
        <div className="memory-deleted">
          <h2>记忆已删除</h2>
          <p>当前列表和搜索已移除这条记忆，历史版本仍可查看。</p>
        </div>
      ) : null}
      {editor && record !== undefined ? (
        <MemoryEditor
          client={client}
          scope={scope}
          record={record}
          onSaved={updated}
          onCancel={() => setEditor(false)}
        />
      ) : record === undefined || (deleted && historical === undefined) ? null : (
        <>
          <header className="memory-detail-heading">
            <span className={`memory-badge memory-badge-${record.review}`}>
              {record.review === 'user-reviewed' ? '已审阅' : 'Agent 编写 · 尚未审阅'}
            </span>
            <h2>{record.title}</h2>
            <p>
              版本 {record.ref.revision}
              {historical === undefined ? ' · 当前版本' : ' · 历史快照'}
            </p>
            <div className="memory-tags">
              {record.tags.map((tag) => (
                <span key={tag}>{tag}</span>
              ))}
            </div>
          </header>
          <MarkdownMessage text={record.content} />
          <dl className="memory-provenance">
            <dt>来源</dt>
            <dd>{source === undefined ? '你在本机保存' : 'Agent 在会话中保存'}</dd>
            {source === undefined ? null : (
              <>
                <dt>会话</dt>
                <dd>
                  <code>{source.sessionId}</code>
                  {verifiedSessionIds.includes(source.sessionId) &&
                  onNavigateSession !== undefined ? (
                    <button type="button" onClick={() => onNavigateSession(source.sessionId)}>
                      打开来源会话
                    </button>
                  ) : (
                    <span>来源会话当前不可用</span>
                  )}
                </dd>
                <dt>执行 / 回合 / 工具调用</dt>
                <dd>
                  <code>
                    {source.executionId} / {source.turnId} / {source.toolCallId}
                  </code>
                </dd>
              </>
            )}
            <dt>保存时间</dt>
            <dd>{new Date(record.updatedAt).toLocaleString()}</dd>
            <dt>内容摘要</dt>
            <dd>
              <code>{record.ref.sha256}</code>
            </dd>
          </dl>
          <div className="memory-actions">
            {historical === undefined && !deleted ? (
              <>
                <button type="button" disabled={busy} onClick={() => setEditor(true)}>
                  编辑记忆
                </button>
                {record.review === 'agent-authored' ? (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      void mutate('review');
                    }}
                  >
                    <ShieldCheck aria-hidden="true" />
                    审阅版本 {record.ref.revision}
                  </button>
                ) : null}
                <button type="button" disabled={busy} onClick={() => setConfirmDelete(true)}>
                  <Trash2 aria-hidden="true" />
                  删除记忆
                </button>
              </>
            ) : !deleted ? (
              <button type="button" disabled={busy} onClick={() => setHistorical(undefined)}>
                返回当前版本
              </button>
            ) : (
              <button type="button" onClick={() => setHistorical(undefined)}>
                返回删除状态
              </button>
            )}
          </div>
        </>
      )}
      {confirmDelete && record !== undefined ? (
        <div
          className="memory-confirm"
          role="alertdialog"
          aria-modal="true"
          aria-labelledby="memory-delete-title"
          aria-describedby="memory-delete-description"
          onKeyDown={(event) => {
            if (event.key === 'Escape' && !busy) setConfirmDelete(false);
            if (event.key === 'Tab') {
              const buttons =
                event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)');
              const first = buttons[0];
              const last = buttons[buttons.length - 1];
              if (event.shiftKey && document.activeElement === first) {
                event.preventDefault();
                last?.focus();
              } else if (!event.shiftKey && document.activeElement === last) {
                event.preventDefault();
                first?.focus();
              }
            }
          }}
        >
          <h3 id="memory-delete-title">删除记忆</h3>
          <strong>{record.title}</strong>
          <p id="memory-delete-description">
            范围：{descriptor.name}
            。删除后当前搜索不再显示，保留历史版本供你查看。已进入会话的工具结果也会保留。
          </p>
          <div className="memory-actions">
            <button
              ref={cancelDelete}
              type="button"
              disabled={busy}
              onClick={() => setConfirmDelete(false)}
            >
              取消删除
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                void mutate('delete');
              }}
            >
              确认删除并保留历史
            </button>
          </div>
        </div>
      ) : null}
      <MemoryHistory
        key={memoryId}
        client={client}
        scope={scope}
        memoryId={memoryId}
        refresh={refresh}
        onRead={(ref) => {
          if (!operationLock.current) {
            setEditor(false);
            setHistorical(ref);
          }
        }}
      />
    </section>
  );
}
