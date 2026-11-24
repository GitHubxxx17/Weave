import { Search } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { retrievalErrorMessage, type RetrievalClient } from './client.js';
import { ResultList } from './ResultList.js';
import {
  type RetrievalCapabilities,
  type RetrievalMode,
  type RetrievalQueryResult,
  type RetrievalSourceKind,
} from './types.js';
import { useLatestRequest } from './useLatestRequest.js';

export function splitPrefixes(value: string): string[] {
  return [
    ...new Set(
      value
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean),
    ),
  ];
}

export function SearchForm({
  client,
  capabilities,
  ready,
  hybridReady,
}: {
  client: RetrievalClient;
  capabilities: RetrievalCapabilities | undefined;
  ready: boolean;
  hybridReady: boolean;
}) {
  const [query, setQuery] = useState('');
  const [mode, setMode] = useState<RetrievalMode>('lexical');
  const [prefix, setPrefix] = useState('');
  const [sources, setSources] = useState<RetrievalSourceKind[]>(['workspace', 'memory']);
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<RetrievalQueryResult>();
  const [error, setError] = useState('');
  const request = useLatestRequest();
  const embedding = capabilities?.embedding.configured
    ? capabilities.embedding.identity
    : undefined;
  const canSubmit =
    ready &&
    capabilities?.lexical.available &&
    (mode === 'lexical' || (hybridReady && embedding)) &&
    query.trim() &&
    sources.length;

  function sourceToggle(source: RetrievalSourceKind, checked: boolean): void {
    setSources((current) =>
      checked ? [...current, source] : current.filter((item) => item !== source),
    );
  }
  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!canSubmit) return;
    const input = {
      requestId: crypto.randomUUID(),
      mode,
      intent: {
        query,
        filters: { sources, paths: { include: splitPrefixes(prefix), exclude: [] } },
        limit: 10,
      },
    };
    const signal = request.start();
    setError('');
    setResult(undefined);
    setPending(true);
    try {
      const next = await client.query(input, signal);
      if (!signal.aborted) setResult(next);
    } catch (cause) {
      if (!signal.aborted) setError(retrievalErrorMessage(cause));
    } finally {
      if (!signal.aborted) setPending(false);
    }
  }

  return (
    <section className="retrieval-search">
      <form aria-label="项目搜索" onSubmit={(event) => void submit(event)}>
        <fieldset className="retrieval-segmented" aria-label="搜索模式">
          <label>
            <input
              type="radio"
              name="retrieval-search-mode"
              checked={mode === 'lexical'}
              onChange={() => setMode('lexical')}
            />
            本地词法
          </label>
          <label>
            <input
              type="radio"
              name="retrieval-search-mode"
              checked={mode === 'hybrid'}
              disabled={!embedding || !hybridReady}
              onChange={() => setMode('hybrid')}
            />
            语义搜索
          </label>
        </fieldset>
        <div className="retrieval-query-row">
          <label className="retrieval-query-input">
            <Search aria-hidden="true" />
            <input
              type="search"
              aria-label="搜索查询"
              placeholder="搜索符号、路径、文本或记忆"
              value={query}
              maxLength={1024}
              aria-describedby={
                mode === 'hybrid' && embedding ? 'retrieval-query-destination' : undefined
              }
              onChange={(event) => setQuery(event.currentTarget.value)}
            />
          </label>
          <button className="retrieval-primary" type="submit" disabled={!canSubmit}>
            {mode === 'hybrid' ? '发送查询并语义搜索' : '搜索'}
          </button>
        </div>
        {mode === 'hybrid' && embedding && (
          <p className="retrieval-egress" id="retrieval-query-destination">
            本次查询将发送至 {embedding.destination} · {embedding.model}
          </p>
        )}
        <div className="retrieval-filters">
          <fieldset className="retrieval-checks" aria-label="搜索来源">
            <label>
              <input
                type="checkbox"
                checked={sources.includes('workspace')}
                onChange={(event) => sourceToggle('workspace', event.currentTarget.checked)}
              />
              代码文件
            </label>
            <label>
              <input
                type="checkbox"
                checked={sources.includes('memory')}
                onChange={(event) => sourceToggle('memory', event.currentTarget.checked)}
              />
              已审阅记忆
            </label>
          </fieldset>
          <label className="retrieval-field-inline">
            搜索路径前缀
            <input
              value={prefix}
              onChange={(event) => setPrefix(event.currentTarget.value)}
              placeholder="src"
            />
          </label>
        </div>
      </form>
      {pending && <p role="status">正在搜索…</p>}
      {error && <p role="alert">{error}</p>}
      {result && <ResultList key={result.requestId} client={client} result={result} />}
    </section>
  );
}
