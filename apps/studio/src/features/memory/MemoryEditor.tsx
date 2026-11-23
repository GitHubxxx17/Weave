import { useEffect, useRef, useState, type ReactElement } from 'react';
import { MemoryApiError, type MemoryClient } from './client.js';
import {
  memoryContentSchema,
  type MemoryCurrent,
  type MemoryReceipt,
  type MemoryScope,
} from './types.js';

export interface MemoryEditorProps {
  readonly client: MemoryClient;
  readonly scope: MemoryScope;
  readonly record?: MemoryCurrent;
  readonly onSaved: (receipt: MemoryReceipt) => void;
  readonly onCancel: () => void;
}
/** Owns its draft independently from the displayed durable revision. */
export function MemoryEditor({
  client,
  scope,
  record,
  onSaved,
  onCancel,
}: MemoryEditorProps): ReactElement {
  const [base, setBase] = useState(record);
  const [title, setTitle] = useState(record?.title ?? '');
  const [content, setContent] = useState(record?.content ?? '');
  const [tags, setTags] = useState(record?.tags.join('\n') ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [conflict, setConflict] = useState(false);
  const lock = useRef(false);
  const controller = useRef<AbortController | undefined>(undefined);
  const retry = useRef<{ fingerprint: string; requestId: string } | undefined>(undefined);
  const titleInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const active = new AbortController();
    controller.current = active;
    lock.current = false;
    setBusy(false);
    titleInput.current?.focus();
    return () => {
      active.abort();
      if (controller.current === active) controller.current = undefined;
    };
  }, []);
  async function save() {
    const active = controller.current;
    if (lock.current || active === undefined || active.signal.aborted) return;
    const parsed = memoryContentSchema.safeParse({
      title,
      content,
      tags: tags.split(/\r?\n/).filter((tag) => tag.length > 0),
    });
    if (!parsed.success) {
      setError(
        '请填写标题和正文，并检查长度：标题最多 160 字，正文最多 8192 UTF-8 字节，最多 12 个标签。',
      );
      return;
    }
    const payload =
      base === undefined
        ? { ...parsed.data, operation: 'create' as const, expectedRevision: 0 as const }
        : {
            ...parsed.data,
            operation: 'revise' as const,
            expectedRevision: base.ref.revision,
            memoryId: base.ref.memoryId,
          };
    const fingerprint = JSON.stringify(payload);
    if (retry.current?.fingerprint !== fingerprint)
      retry.current = { fingerprint, requestId: crypto.randomUUID() };
    lock.current = true;
    setBusy(true);
    setError(undefined);
    setConflict(false);
    try {
      const receipt = await client.save(
        scope,
        { ...payload, requestId: retry.current.requestId },
        active.signal,
      );
      if (controller.current === active && !active.signal.aborted) onSaved(receipt);
    } catch (cause) {
      if (controller.current === active && !active.signal.aborted) {
        setConflict(cause instanceof MemoryApiError && cause.status === 409);
        setError(cause instanceof Error ? cause.message : '记忆保存失败，草稿已保留。');
      }
    } finally {
      if (controller.current === active && !active.signal.aborted) {
        lock.current = false;
        setBusy(false);
      }
    }
  }
  async function reload() {
    const active = controller.current;
    if (base === undefined || lock.current || active === undefined || active.signal.aborted) return;
    lock.current = true;
    setBusy(true);
    try {
      const current = await client.read(scope, base.ref.memoryId, undefined, active.signal);
      if (controller.current === active && !active.signal.aborted) {
        setBase(current);
        setConflict(false);
        setError(`已加载当前版本 ${current.ref.revision}，草稿已保留。请核对后再次保存。`);
      }
    } catch (cause) {
      if (controller.current === active && !active.signal.aborted)
        setError(cause instanceof Error ? cause.message : '无法加载当前版本');
    } finally {
      if (controller.current === active && !active.signal.aborted) {
        lock.current = false;
        setBusy(false);
      }
    }
  }
  return (
    <form
      className="memory-editor"
      aria-label={base === undefined ? '新建记忆' : '编辑记忆'}
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <h3>{base === undefined ? '新建记忆' : `编辑版本 ${base.ref.revision}`}</h3>
      <p className="memory-muted">保存即表示你确认这些内容。人工保存的版本标记为已审阅。</p>
      <label htmlFor="memory-title">标题</label>
      <input
        ref={titleInput}
        id="memory-title"
        value={title}
        onChange={(event) => setTitle(event.target.value)}
        disabled={busy}
        aria-describedby={error === undefined ? undefined : 'memory-editor-error'}
        required
      />
      <label htmlFor="memory-content">正文</label>
      <textarea
        id="memory-content"
        value={content}
        onChange={(event) => setContent(event.target.value)}
        disabled={busy}
        aria-describedby={
          error === undefined ? 'memory-content-hint' : 'memory-content-hint memory-editor-error'
        }
        required
        rows={12}
      />
      <small id="memory-content-hint">
        支持 Markdown，最多 8192 UTF-8 字节。内容只保存在本地。
      </small>
      <label htmlFor="memory-tags">标签（每行一个）</label>
      <textarea
        id="memory-tags"
        rows={3}
        value={tags}
        onChange={(event) => setTags(event.target.value)}
        disabled={busy}
        aria-describedby={error === undefined ? undefined : 'memory-editor-error'}
      />
      {error === undefined ? null : (
        <p id="memory-editor-error" role="alert">
          {error}
        </p>
      )}
      <div className="memory-actions">
        <button type="submit" disabled={busy}>
          {busy ? '正在保存…' : '保存记忆'}
        </button>
        {conflict && base !== undefined ? (
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              void reload();
            }}
          >
            重新加载当前版本并保留草稿
          </button>
        ) : null}
        <button type="button" disabled={busy} onClick={onCancel}>
          取消编辑
        </button>
      </div>
    </form>
  );
}
