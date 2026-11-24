import type { ReactElement } from 'react';
import { PanelContainer, type PanelContainerProps } from '../panel/panel-container.js';
import { contextWarnThreshold, latestContext } from '../panel/panel-data.js';
import { formatTokens } from './turn-stats.js';
import { useConversationTurns, useConversationTools } from './use-conversation.js';
import type { ConversationStore } from './conversation-types.js';

export function ConnectedContextMeter({
  store,
  sessionId,
  onOpen,
}: {
  readonly store: ConversationStore;
  readonly sessionId: string;
  readonly onOpen: () => void;
}): ReactElement | null {
  const turns = useConversationTurns(store, sessionId);
  const current = latestContext(turns);
  if (current === undefined) return null;
  const percent = Math.round(current.ratio * 100);
  return (
    <button
      type="button"
      className={`composer-context${current.ratio >= contextWarnThreshold ? ' composer-context-warn' : ''}`}
      aria-label={`上下文窗口占用 ${percent}%，点击查看详情`}
      title={`上下文窗口 ${percent}% · ${formatTokens(current.sentTokens)} / ${formatTokens(current.windowTokens)} tokens${current.trimmed ? ' · 已压缩' : ''}`}
      onClick={onOpen}
    >
      <span className="composer-context-track" aria-hidden="true">
        <span className="composer-context-fill" style={{ width: `${percent}%` }} />
      </span>
      <span className="composer-context-value">{percent}%</span>
    </button>
  );
}
export function ConnectedConversationPanels({
  store,
  sessionId,
  context,
  ...props
}: PanelContainerProps & {
  readonly store: ConversationStore;
  readonly sessionId: string;
}): ReactElement {
  const turns = useConversationTurns(store, sessionId);
  const messages = useConversationTools(store, sessionId);
  return <PanelContainer {...props} context={{ ...context, sessionId, turns, messages }} />;
}
