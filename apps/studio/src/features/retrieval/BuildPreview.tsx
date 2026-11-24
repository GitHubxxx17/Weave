import { ChevronDown, ChevronRight, Database, FileCode } from 'lucide-react';
import { useEffect, useState } from 'react';
import { retrievalErrorMessage, type RetrievalClient } from './client.js';
import type {
  RetrievalPreview,
  RetrievalPreviewPage,
  RetrievalSource,
  RetrievalTextPage,
} from './types.js';
import { useLatestRequest } from './useLatestRequest.js';

const skipLabels = {
  'system-exclusion': '系统排除',
  'not-selected': '不在选择范围',
  empty: '空文件',
  'too-large': '文件过大',
  'invalid-utf8': '无效 UTF-8',
  binary: '二进制文件',
  'unsafe-file': '不允许读取该文件',
  changed: '读取期间已变更',
  unavailable: '文件不可用',
  'source-limit': '来源数量上限',
  'capture-limit': '采集大小上限',
  'chunk-limit': '片段数量上限',
};

function PreviewSource({
  client,
  preview,
  source,
  title,
}: {
  client: RetrievalClient;
  preview: RetrievalPreview;
  source: RetrievalSource;
  title: string;
}) {
  const request = useLatestRequest();
  const [open, setOpen] = useState(false);
  const [captured, setCaptured] = useState<{ page: RetrievalTextPage; text: string }>();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  async function load(previous?: typeof captured): Promise<void> {
    const signal = request.start();
    setPending(true);
    setError('');
    try {
      const page = await client.previewText(preview, source, previous?.page.nextCursor, signal);
      const text = previous?.text ?? '';
      if (page.offset !== [...text].length) throw new Error('Unexpected preview offset');
      if (!signal.aborted) setCaptured({ page, text: text + page.text });
    } catch (cause) {
      if (!signal.aborted) setError(retrievalErrorMessage(cause));
    } finally {
      if (!signal.aborted) setPending(false);
    }
  }
  const Toggle = open ? ChevronDown : ChevronRight;
  return (
    <li>
      <button
        className="retrieval-source-button"
        type="button"
        aria-expanded={open}
        onClick={() => {
          if (open) {
            request.clear();
            setPending(false);
            setOpen(false);
          } else {
            setOpen(true);
            if (!captured) void load();
          }
        }}
      >
        <Toggle aria-hidden="true" />
        <FileCode aria-hidden="true" />{' '}
        <span>{source.kind === 'workspace' ? source.path : title}</span>
      </button>
      {open && (
        <div className="retrieval-preview-text">
          {pending && <p role="status">正在加载采集文本…</p>}
          {error && <p role="alert">{error}</p>}
          {captured && <pre className="retrieval-code">{captured.text}</pre>}
          {captured?.page.nextCursor && (
            <button type="button" disabled={pending} onClick={() => void load(captured)}>
              加载更多文本
            </button>
          )}
          {error && !captured && (
            <button type="button" onClick={() => void load()}>
              重试
            </button>
          )}
        </div>
      )}
    </li>
  );
}

export function BuildPreview({
  client,
  preview,
  pending,
  busy,
  retry,
  onConfirm,
}: {
  client: RetrievalClient;
  preview: RetrievalPreview;
  pending: boolean;
  busy: boolean;
  retry: boolean;
  onConfirm: () => void;
}) {
  const [pages, setPages] = useState<RetrievalPreviewPage[]>([]);
  const [pageError, setPageError] = useState('');
  const [loading, setLoading] = useState(true);
  const [reload, setReload] = useState(0);
  const pageRequest = useLatestRequest();
  const rows = pages.flatMap((page) => page.sources);
  const skipped = pages.flatMap((page) => page.skipped);
  const next = pages.at(-1)?.nextCursor;
  const { counts, coverage, embedding } = preview;

  useEffect(() => {
    const controller = new AbortController();
    void client
      .previewPage(preview, undefined, controller.signal)
      .then(
        (page) => {
          if (!controller.signal.aborted) setPages([page]);
        },
        (cause) => {
          if (!controller.signal.aborted) setPageError(retrievalErrorMessage(cause));
        },
      )
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [client, preview, reload]);

  async function loadMore(cursor: string): Promise<void> {
    const signal = pageRequest.start();
    setLoading(true);
    setPageError('');
    try {
      const page = await client.previewPage(preview, cursor, signal);
      if (!signal.aborted) setPages((current) => [...current, page]);
    } catch (cause) {
      if (!signal.aborted) setPageError(retrievalErrorMessage(cause));
    } finally {
      if (!signal.aborted) setLoading(false);
    }
  }

  return (
    <section className="retrieval-preview" aria-label="构建预览">
      <h3>构建预览</h3>
      <p className="retrieval-muted">
        {counts.files} 个文件 · {counts.memories} 条记忆 · {counts.chunks} 个片段
      </p>
      <p className="retrieval-muted">
        {counts.captureBytes.toLocaleString()} 字节源文本 · 已加载 {rows.length}/{counts.sources} 项
      </p>
      {embedding ? (
        <p className="retrieval-egress">
          将向 {embedding.identity.destination} · {embedding.identity.model} 发送{' '}
          {embedding.inputCount} 个片段（{embedding.inputBytes.toLocaleString()} 字节、
          {embedding.requestCount} 次请求）。
        </p>
      ) : (
        <p className="retrieval-muted">索引内容保存在本机。</p>
      )}
      {coverage.truncated && <p role="status">文件发现已达到扫描上限。</p>}
      {coverage.skippedDetailsTruncated && <p role="status">排除明细已达到显示上限。</p>}
      {counts.skipped > 0 && (
        <details>
          <summary>已排除 {counts.skipped} 项</summary>
          <ul className="retrieval-compact-list">
            {coverage.skipCounts.map(({ reason, count }) => (
              <li key={reason}>
                {skipLabels[reason]} · {count}
              </li>
            ))}
          </ul>
          <ul className="retrieval-compact-list">
            {skipped.map(({ path, reason }) => (
              <li key={`${path}:${reason}`}>
                {path} · {skipLabels[reason]}
              </li>
            ))}
          </ul>
        </details>
      )}
      <ul className="retrieval-preview-sources">
        {rows.map(({ source, title }) => (
          <PreviewSource
            key={source.sourceKey}
            client={client}
            preview={preview}
            source={source}
            title={title}
          />
        ))}
      </ul>
      {loading && <p role="status">正在加载预览…</p>}
      {pageError && <p role="alert">{pageError}</p>}
      {pageError && pages.length === 0 && (
        <button
          type="button"
          disabled={loading}
          onClick={() => {
            setLoading(true);
            setPageError('');
            setReload((value) => value + 1);
          }}
        >
          重试加载预览
        </button>
      )}
      {next && (
        <button type="button" disabled={loading} onClick={() => void loadMore(next)}>
          加载更多预览项
        </button>
      )}
      <button
        className="retrieval-primary"
        type="button"
        disabled={
          pending || (busy && !retry) || (pages.length === 0 && !retry) || counts.chunks === 0
        }
        onClick={onConfirm}
      >
        <Database aria-hidden="true" />
        {retry ? '重试同一构建' : embedding ? '构建混合索引并发送以上内容' : '构建本地索引'}
      </button>
    </section>
  );
}
