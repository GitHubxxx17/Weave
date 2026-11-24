import { memo, useCallback, useSyncExternalStore, type ReactElement } from 'react';
import { ChevronRight, LoaderCircle, Sparkles, TerminalSquare } from 'lucide-react';
import type { TurnSummary } from '../workspace/workspace-types.js';
import { FileAttachmentSummaries } from '../file-context/file-attachments.js';
import { TurnFileReview } from '../file-undo/turn-file-review.js';
import type { TurnFileReviewStore } from '../file-undo/turn-file-review-store.js';
import { SkillHistory } from '../skills/skill-history.js';
import { MarkdownMessage } from './markdown-message.js';
import { MessageFooter } from './message-footer.js';
import { ToolStep } from './tool-step.js';
import type {
  ConversationAction,
  ConversationRow as RowData,
  ConversationRunStatus,
} from './conversation-types.js';
import { conversationToolKey, type ConversationUiState } from './conversation-ui-state.js';

export interface ConversationRowProps {
  readonly row: RowData;
  readonly sessionId: string;
  readonly projectId: string;
  readonly turn: TurnSummary | undefined;
  readonly isLatestAssistant: boolean;
  readonly isLastReply: boolean;
  readonly canRetry: boolean;
  readonly hasRetry: boolean;
  readonly hasUser: boolean;
  readonly status: ConversationRunStatus;
  readonly sessionHasWork: boolean;
  readonly canCompose: boolean;
  readonly onAction: (action: ConversationAction) => void;
  readonly uiState: ConversationUiState;
  readonly fileReviewStore: TurnFileReviewStore;
}

const timeFormat = new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit' });
const dateFormat = new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric' });
function formatTime(occurredAt: string): string {
  const date = new Date(occurredAt);
  if (Number.isNaN(date.getTime())) return '时间未知';
  const today = new Date();
  return date.toDateString() === today.toDateString()
    ? timeFormat.format(date)
    : `${dateFormat.format(date)} ${timeFormat.format(date)}`;
}
function placeholder(
  status: ConversationRunStatus,
  latest: boolean,
  hasReasoning: boolean,
): string {
  if (hasReasoning && !(latest && status === 'streaming'))
    return '模型没有单独输出正文，回答写在了上方的「思考过程」里，展开即可查看。';
  if (!latest) return '暂无回复';
  return {
    streaming: '正在思考…',
    cancelled: '本次运行已取消',
    error: '本次运行失败，请查看运行错误',
    completed: 'Agent 没有返回文本',
    idle: '暂无回复',
  }[status];
}

/** Only the changed row and its own disclosures participate in a live update. */
export const ConversationRow = memo(function ConversationRow({
  row,
  sessionId,
  projectId,
  turn,
  isLatestAssistant,
  isLastReply,
  canRetry,
  hasRetry,
  hasUser,
  status,
  sessionHasWork,
  canCompose,
  onAction,
  uiState,
  fileReviewStore,
}: ConversationRowProps): ReactElement {
  const subscribe = useCallback(
    (listener: () => void) => uiState.subscribe(sessionId, row.id, listener),
    [uiState, sessionId, row.id],
  );
  const getUi = useCallback(() => uiState.get(sessionId, row.id), [uiState, sessionId, row.id]);
  const ui = useSyncExternalStore(subscribe, getUi);
  const streaming = isLatestAssistant && status === 'streaming';
  const hasProcess =
    row.role === 'assistant' && (row.reasoning !== '' || row.tools.length > 0 || streaming);
  const onToolOpenChange = useCallback(
    (toolCallId: string, open: boolean) =>
      uiState.setTool(sessionId, row.id, row.turnId, toolCallId, open),
    [uiState, sessionId, row.id, row.turnId],
  );
  const retry = useCallback(() => {
    if (row.turnId !== undefined) onAction({ type: 'retry', sessionId, turnId: row.turnId });
  }, [onAction, sessionId, row.turnId]);
  const quote = useCallback(
    () => onAction({ type: 'quote', sessionId, rowId: row.id }),
    [onAction, sessionId, row.id],
  );
  return (
    <div className="timeline-content">
      <div className="message-meta">
        {row.role === 'assistant' ? (
          <span className="message-avatar" aria-hidden="true">
            <Sparkles />
          </span>
        ) : null}
        {row.role === 'user' ? '你' : 'Weave Agent'}
        <time dateTime={row.occurredAt}>{formatTime(row.occurredAt)}</time>
      </div>
      {hasProcess ? (
        <details
          className="message-process"
          role="group"
          aria-label="本轮过程"
          open={ui.processOpen}
          onToggle={(event) => uiState.setProcess(sessionId, row.id, event.currentTarget.open)}
        >
          <summary>
            <ChevronRight className="disclosure-icon" aria-hidden="true" />
            <span className="message-process-title">
              <TerminalSquare aria-hidden="true" />
              {row.tools.length > 0 ? `${row.tools.length} 次工具调用` : '思考过程'}
            </span>
            {streaming ? (
              <span className="message-process-state message-process-state-live">
                <LoaderCircle className="spin-icon" aria-hidden="true" />
                进行中
              </span>
            ) : (
              <span className="message-process-state">已完成</span>
            )}
          </summary>
          {ui.processOpen ? (
            <div className="message-process-content">
              {row.reasoning !== '' ? (
                <section className="message-process-section" aria-label="思考内容">
                  <div className="message-process-heading">
                    <span>思考</span>
                    {streaming ? <span className="message-process-live">实时</span> : null}
                  </div>
                  <p className="message-process-text">{row.reasoning}</p>
                </section>
              ) : null}
              {row.tools.length > 0 ? (
                <section className="message-process-section" aria-label="工具步骤">
                  <div className="message-process-heading">
                    <span>工具调用</span>
                    <span>{row.tools.length} 次</span>
                  </div>
                  <div className="message-process-tools">
                    {row.tools.map((tool) => (
                      <ToolStep
                        key={conversationToolKey(sessionId, row.turnId, tool.toolCallId)}
                        tool={tool}
                        open={ui.openTools.has(
                          conversationToolKey(sessionId, row.turnId, tool.toolCallId),
                        )}
                        onOpenChange={onToolOpenChange}
                      />
                    ))}
                  </div>
                </section>
              ) : null}
              {row.reasoning === '' && row.tools.length === 0 ? (
                <p className="message-process-placeholder">Agent 正在准备回复…</p>
              ) : null}
            </div>
          ) : null}
        </details>
      ) : null}
      <div className="message">
        <FileAttachmentSummaries files={row.fileAttachments} />
        {row.role === 'assistant' && row.text !== '' ? (
          <MarkdownMessage text={row.text} />
        ) : row.text !== '' || row.role === 'assistant' ? (
          <p>{row.text || placeholder(status, isLatestAssistant, row.reasoning !== '')}</p>
        ) : null}
        {row.role === 'user' || !hasUser ? (
          <SkillHistory skills={turn?.skills} selected={row.selectedSkills} />
        ) : null}
        {row.role === 'user' && (row.images?.length ?? 0) > 0 ? (
          <div className="message-images">
            {row.images?.map((image, index) => (
              <button
                key={index}
                type="button"
                className="message-image-button"
                aria-label="放大查看图片"
                onClick={() => onAction({ type: 'image', image })}
              >
                <img
                  className="message-image"
                  src={`data:${image.mediaType};base64,${image.data}`}
                  alt="已发送的图片"
                />
              </button>
            ))}
          </div>
        ) : null}
      </div>
      {row.role === 'assistant' && row.turnId !== undefined && isLastReply && !streaming ? (
        <>
          <MessageFooter
            turn={turn}
            timeLabel={formatTime(row.occurredAt)}
            text={row.text}
            canRetry={canRetry}
            disabled={sessionHasWork}
            readOnly={!canCompose}
            retryUnavailableReason={hasRetry ? undefined : '旧会话未记录原始请求设置，无法精确重试'}
            onRetry={retry}
            onQuote={quote}
          />
          {turn?.status !== 'running' ? (
            <TurnFileReview
              projectId={projectId}
              sessionId={sessionId}
              turnId={row.turnId}
              disabled={sessionHasWork || !canCompose}
              store={fileReviewStore}
            />
          ) : null}
        </>
      ) : null}
    </div>
  );
});
