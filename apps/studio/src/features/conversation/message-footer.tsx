import { useState, type ReactElement } from 'react';
import { Check, Copy, Quote, RotateCcw } from 'lucide-react';

import type { TurnSummary } from '../workspace/workspace-types.js';
import {
  cacheHitRate,
  describeModelSteps,
  formatDuration,
  formatPercent,
  formatTokens,
  turnDurationMs,
} from './turn-stats.js';

export interface MessageFooterProps {
  readonly turn: TurnSummary | undefined;
  /** Display time of the reply, already formatted. */
  readonly timeLabel: string;
  readonly text: string;
  /** Only the last Turn of a Session can be retried. */
  readonly canRetry: boolean;
  readonly disabled: boolean;
  readonly readOnly?: boolean;
  readonly retryUnavailableReason?: string | undefined;
  readonly onRetry: () => void;
  readonly onQuote: () => void;
}

/**
 * Metadata and actions under an assistant reply.
 *
 * The first line shows the model, token usage summed over the Turn's model
 * steps (hover for the per-step breakdown), and duration. The second line has
 * the time and actions: retry on the last Turn, quote on earlier ones, copy.
 */
export function MessageFooter({
  turn,
  timeLabel,
  text,
  canRetry,
  disabled,
  readOnly = false,
  retryUnavailableReason,
  onRetry,
  onQuote,
}: MessageFooterProps): ReactElement {
  const [copied, setCopied] = useState(false);
  const usage = turn?.usage;

  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  }

  const parts: string[] = [];
  if (turn?.model !== undefined) {
    parts.push(turn.model);
  }
  if (usage !== undefined) {
    parts.push(
      `输入 ${formatTokens(usage.inputTokens)}（命中 ${formatPercent(cacheHitRate(usage))}）`,
    );
    parts.push(`输出 ${formatTokens(usage.outputTokens)}`);
    if (usage.reasoningTokens !== undefined) {
      parts.push(`思考 ${formatTokens(usage.reasoningTokens)}`);
    }
  } else if (turn !== undefined && turn.status !== 'running') {
    parts.push('模型未返回用量');
  }
  if (turn !== undefined && turn.completedAt !== undefined) {
    parts.push(formatDuration(turnDurationMs(turn)));
  }

  return (
    <div className="message-footer">
      {parts.length === 0 ? null : (
        <p
          className="message-footer-meta"
          title={turn === undefined ? undefined : describeModelSteps(turn)}
        >
          {parts.join(' · ')}
        </p>
      )}
      <div className="message-footer-actions">
        <span className="message-footer-time">{timeLabel}</span>
        {readOnly ? null : canRetry ? (
          <button
            className="message-action"
            type="button"
            aria-label="重试"
            title={retryUnavailableReason ?? '使用原消息、技能和设置重新运行'}
            disabled={disabled || retryUnavailableReason !== undefined}
            onClick={onRetry}
          >
            <RotateCcw aria-hidden="true" />
          </button>
        ) : (
          <button
            className="message-action"
            type="button"
            aria-label="引用"
            title="引用到输入框"
            disabled={disabled || text === ''}
            onClick={onQuote}
          >
            <Quote aria-hidden="true" />
          </button>
        )}
        <button
          className="message-action"
          type="button"
          aria-label={copied ? '已复制' : '复制'}
          title="复制回复"
          disabled={text === ''}
          onClick={() => void copy()}
        >
          {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
        </button>
      </div>
    </div>
  );
}
