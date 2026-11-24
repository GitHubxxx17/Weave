import { useMemo, type ReactElement } from 'react';
import { getConversationRow } from './conversation-model.js';
import type { ConversationSnapshot } from './conversation-types.js';

export function conversationTranscript(snapshot: ConversationSnapshot): string {
  return snapshot.rowIds
    .flatMap((id) => {
      const row = getConversationRow(snapshot, id);
      return row === undefined
        ? []
        : [
            [
              row.role === 'user' ? '你' : 'Weave Agent',
              row.text,
              row.reasoning,
              ...row.tools.flatMap((tool) => [
                `工具 ${tool.name}`,
                tool.arguments,
                tool.result ?? '',
              ]),
            ]
              .filter(Boolean)
              .join('\n'),
          ];
    })
    .join('\n\n');
}

export function ConversationTranscript({
  snapshot,
  onClose,
}: {
  readonly snapshot: ConversationSnapshot;
  readonly onClose: () => void;
}): ReactElement {
  const transcript = useMemo(() => conversationTranscript(snapshot), [snapshot]);
  return (
    <section className="conversation-transcript" aria-label="完整会话文本">
      <header>
        <h3>完整文本</h3>
        <button type="button" onClick={onClose}>
          关闭
        </button>
      </header>
      <textarea readOnly value={transcript} aria-label="完整会话文本内容" />
      <button type="button" onClick={() => void navigator.clipboard?.writeText(transcript)}>
        复制完整文本
      </button>
    </section>
  );
}
