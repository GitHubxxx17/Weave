import { useDeferredValue, useMemo, useState, type ReactElement } from 'react';
import { getConversationRow } from './conversation-model.js';
import type { ConversationSnapshot, ConversationTarget } from './conversation-types.js';

export interface ConversationSearchHit {
  readonly rowId: string;
  readonly snippet: string;
  readonly index: number;
  readonly target: ConversationTarget;
}

function snippet(text: string, query: string): string {
  const at = text.toLocaleLowerCase().indexOf(query);
  return `${at > 36 ? '…' : ''}${text.slice(Math.max(0, at - 36), at + query.length + 72)}${at + query.length + 72 < text.length ? '…' : ''}`;
}

/** Search logical rows, including lazy process bodies and rows outside the window. */
export function findConversationHits(
  snapshot: ConversationSnapshot,
  query: string,
): readonly ConversationSearchHit[] {
  const needle = query.trim().toLocaleLowerCase();
  if (needle === '') return [];
  const hits: ConversationSearchHit[] = [];
  snapshot.rowIds.forEach((rowId, index) => {
    const row = getConversationRow(snapshot, rowId);
    if (row === undefined) return;
    const text = [row.text, row.reasoning].join('\n');
    if (text.toLocaleLowerCase().includes(needle)) {
      hits.push({
        rowId,
        index,
        snippet: snippet(text, needle),
        target: { kind: 'row', sessionId: snapshot.sessionId, rowId },
      });
      return;
    }
    for (const tool of row.tools) {
      const content = [tool.name, tool.arguments, tool.result ?? ''].join('\n');
      if (!content.toLocaleLowerCase().includes(needle)) continue;
      const target: ConversationTarget =
        row.turnId === undefined
          ? { kind: 'row', sessionId: snapshot.sessionId, rowId }
          : {
              kind: 'tool',
              sessionId: snapshot.sessionId,
              turnId: row.turnId,
              toolCallId: tool.toolCallId,
            };
      hits.push({ rowId, index, snippet: snippet(content, needle), target });
      break;
    }
  });
  return hits;
}

export function ConversationSearch({
  snapshot,
  onReveal,
}: {
  readonly snapshot: ConversationSnapshot;
  readonly onReveal: (target: ConversationTarget) => void;
}): ReactElement {
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(0);
  const deferredQuery = useDeferredValue(query);
  const hits = useMemo(
    () => findConversationHits(snapshot, deferredQuery),
    [snapshot, deferredQuery],
  );
  return (
    <div className="conversation-search">
      <input
        type="search"
        aria-label="查找会话内容"
        placeholder="查找会话内容"
        value={query}
        onChange={(event) => {
          setQuery(event.currentTarget.value);
          setPage(0);
        }}
      />
      {query.trim() !== '' ? (
        <div
          className="conversation-search-results"
          aria-label="会话查找结果"
          aria-busy={query !== deferredQuery}
        >
          <p>{hits.length} 条匹配</p>
          {hits.slice(page * 50, (page + 1) * 50).map((hit) => (
            <button
              key={hit.rowId}
              type="button"
              data-search-row-id={hit.rowId}
              onClick={() => onReveal(hit.target)}
            >
              <span>第 {hit.index + 1} 条</span>
              <small>{hit.snippet}</small>
            </button>
          ))}
          {hits.length > 50 ? (
            <div className="conversation-search-pagination">
              <button
                type="button"
                disabled={page === 0}
                onClick={() => setPage((current) => current - 1)}
              >
                上一页
              </button>
              <span>
                {page + 1} / {Math.ceil(hits.length / 50)}
              </span>
              <button
                type="button"
                disabled={(page + 1) * 50 >= hits.length}
                onClick={() => setPage((current) => current + 1)}
              >
                下一页
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
