import { BookOpen, FileCode, FileSearch } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { retrievalErrorMessage, type RetrievalClient } from './client.js';
import type { RetrievalCitation, RetrievalQueryResult } from './types.js';
import { useLatestRequest } from './useLatestRequest.js';

function SourceText({ text, line }: { text: string; line: number | undefined }) {
  const target = useRef<HTMLElement>(null);
  const scrolled = useRef(false);
  useEffect(() => {
    if (scrolled.current || !target.current) return;
    target.current.scrollIntoView?.({ block: 'nearest' });
    scrolled.current = true;
  }, [text]);
  if (line === undefined) return <pre className="retrieval-code">{text}</pre>;
  const lines = text.split(/\r\n|\r|\n/u);
  return (
    <pre className="retrieval-code">
      {lines.map((value, index) =>
        index + 1 === line ? (
          <mark ref={target} key={index}>
            {value}
            {index < lines.length - 1 ? '\n' : ''}
          </mark>
        ) : (
          value + (index < lines.length - 1 ? '\n' : '')
        ),
      )}
    </pre>
  );
}

export function ResultList({
  client,
  result,
}: {
  client: RetrievalClient;
  result: RetrievalQueryResult;
}) {
  const sourceRequest = useLatestRequest();
  const [opened, setOpened] = useState<{
    value: Awaited<ReturnType<RetrievalClient['source']>>;
    text: string;
  }>();
  const [pending, setPending] = useState<string>();
  const [error, setError] = useState('');

  async function open(citation: RetrievalCitation, next?: typeof opened): Promise<void> {
    const signal = sourceRequest.start();
    setPending(citation.chunk.chunkId);
    setError('');
    if (!next) setOpened(undefined);
    try {
      const value = await client.source(citation, next?.value.page.nextCursor, signal);
      if (value.page.offset !== [...(next?.text ?? '')].length)
        throw new Error('Unexpected source offset');
      if (!signal.aborted) setOpened({ value, text: (next?.text ?? '') + value.page.text });
    } catch (cause) {
      if (!signal.aborted) {
        setOpened(undefined);
        setError(retrievalErrorMessage(cause));
      }
    } finally {
      if (!signal.aborted) setPending(undefined);
    }
  }

  return (
    <section className="retrieval-results" aria-label="搜索结果">
      <div className="retrieval-section-heading">
        <h2>
          结果 <span>{result.hits.length}</span>
        </h2>
        <span className="retrieval-mode-label">
          {result.actualMode === 'hybrid' ? '语义与词法' : '本地词法'}
        </span>
      </div>
      {result.omitted.stale > 0 && (
        <p role="status">已略过 {result.omitted.stale} 条已变更的来源。</p>
      )}
      {result.omitted.unavailable > 0 && (
        <p role="status">已略过 {result.omitted.unavailable} 条不可用的来源。</p>
      )}
      {(result.truncated || result.omitted.budget > 0) && (
        <p role="status">部分结果已因响应大小限制省略。</p>
      )}
      {error && <p role="alert">{error}</p>}
      {result.hits.length === 0 && <p className="retrieval-muted">没有匹配且仍可验证的来源。</p>}
      <ol className="retrieval-rows">
        {result.hits.map(({ title, citation, excerpt }) => {
          const { source, chunk } = citation;
          const isOpen = opened?.value.citation.chunk.chunkId === chunk.chunkId;
          const detail =
            source.kind === 'workspace'
              ? `${source.path}:${chunk.startLine}${chunk.endLine === chunk.startLine ? '' : `–${chunk.endLine}`}`
              : `项目记忆 · 版本 ${source.ref.revision}`;
          const Icon = source.kind === 'workspace' ? FileCode : BookOpen;
          return (
            <li className="retrieval-result" key={chunk.chunkId}>
              <header>
                <div className="retrieval-result-name">
                  <Icon aria-hidden="true" />
                  <div>
                    <h3>{title}</h3>
                    <p>{detail}</p>
                  </div>
                </div>
                <button
                  type="button"
                  className="retrieval-icon-button"
                  title={isOpen ? '关闭来源' : '打开来源'}
                  aria-label={isOpen ? `关闭来源 ${title}` : `打开来源 ${title}`}
                  aria-expanded={isOpen}
                  disabled={pending === chunk.chunkId}
                  onClick={() => {
                    if (isOpen) {
                      sourceRequest.clear();
                      setOpened(undefined);
                    } else void open(citation, undefined);
                  }}
                >
                  <FileSearch aria-hidden="true" />
                </button>
              </header>
              <pre className="retrieval-code">{excerpt}</pre>
              {isOpen && opened && (
                <section className="retrieval-source" aria-label="已验证来源">
                  <h4>
                    {opened.value.open.kind === 'workspace'
                      ? `${opened.value.open.path}:${opened.value.open.line}`
                      : `记忆 ${opened.value.open.ref.memoryId} · 版本 ${opened.value.open.ref.revision}`}
                  </h4>
                  {opened.value.open.kind === 'workspace' &&
                    opened.text.split(/\r\n|\r|\n/u).length < opened.value.open.line && (
                      <p className="retrieval-muted">命中行位于后续页面。</p>
                    )}
                  <SourceText
                    text={opened.text}
                    line={
                      opened.value.open.kind === 'workspace' ? opened.value.open.line : undefined
                    }
                  />
                  {opened.value.page.nextCursor && (
                    <button
                      type="button"
                      disabled={pending !== undefined}
                      onClick={() => void open(citation, opened)}
                    >
                      加载更多来源文本
                    </button>
                  )}
                </section>
              )}
            </li>
          );
        })}
      </ol>
    </section>
  );
}
