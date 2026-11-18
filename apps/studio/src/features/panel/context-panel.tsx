import { type ReactElement } from 'react';

import { formatPercent, formatTokens } from '../conversation/turn-stats.js';
import type { ContextBreakdown } from '../workspace/workspace-types.js';
import {
  contextCategories,
  contextWarnThreshold,
  firstAssistantByTurn,
  latestContext,
  percentWidth,
  type PanelContext,
} from './panel-data.js';

interface TrendPoint {
  readonly key: string;
  readonly label: string;
  readonly ratio: number;
  readonly sentTokens: number;
  readonly targetId: string | undefined;
}

function compositionBar(breakdown: ContextBreakdown): ReactElement {
  return (
    <span className="usage-bar" aria-hidden="true">
      {contextCategories.map((category) => {
        const value = breakdown.categories[category.key];
        return value === 0 ? null : (
          <span
            key={category.key}
            className={`usage-seg context-seg-${category.key}`}
            style={{
              width: percentWidth(breakdown.sentTokens === 0 ? 0 : value / breakdown.sentTokens),
            }}
          />
        );
      })}
    </span>
  );
}

/**
 * Shows how the current send window is composed, in the spirit of the Kiro and
 * Codex context meters. It reads the deterministic breakdown Weave computes
 * before each model request: the fraction of the model window used, the split
 * by source category, and a per-Turn trend. The window counters are estimates,
 * not provider-reported usage, which the separate "用量" panel covers.
 */
export function ContextPanel(props: PanelContext): ReactElement {
  const current = latestContext(props.turns);
  const targetByTurn = firstAssistantByTurn(props.messages);
  const points: TrendPoint[] = props.turns.flatMap((turn, index) =>
    turn.context === undefined
      ? []
      : [
          {
            key: turn.turnId,
            label: `T${index + 1}`,
            ratio: turn.context.ratio,
            sentTokens: turn.context.sentTokens,
            targetId: targetByTurn.get(turn.turnId),
          },
        ],
  );

  if (current === undefined) {
    return (
      <div className="panel-body" role="region" aria-label="上下文">
        <section className="overview-block">
          <div className="overview-block-heading">
            <h3>上下文窗口</h3>
            <span className="activity-state">发送构成</span>
          </div>
          <p className="activity-hint">发送第一条消息后，会在这里显示本次请求的上下文构成。</p>
        </section>
      </div>
    );
  }

  const warn = current.ratio >= contextWarnThreshold;

  return (
    <div className="panel-body" role="region" aria-label="上下文">
      <section className="overview-block" aria-label="窗口占用">
        <div className="overview-block-heading">
          <h3>上下文窗口</h3>
          <span className="activity-state">最新一轮</span>
        </div>
        <dl className="usage-stats">
          <div>
            <dt>窗口</dt>
            <dd>{formatTokens(current.windowTokens)}</dd>
          </div>
          <div>
            <dt>已发送</dt>
            <dd>{formatTokens(current.sentTokens)}</dd>
          </div>
          <div>
            <dt>占用</dt>
            <dd className={warn ? 'context-ratio-warn' : undefined}>
              {formatPercent(current.ratio)}
            </dd>
          </div>
          <div>
            <dt>压缩</dt>
            <dd>{current.trimmed ? '已压缩' : '未压缩'}</dd>
          </div>
        </dl>
        <div
          className={`context-gauge${warn ? ' is-warn' : ''}`}
          role="meter"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(current.ratio * 100)}
          aria-label="上下文窗口占用"
        >
          <span className="context-gauge-fill" style={{ width: percentWidth(current.ratio) }} />
          <span
            className="context-gauge-threshold"
            style={{ left: percentWidth(contextWarnThreshold) }}
            aria-hidden="true"
          />
        </div>
        {warn ? (
          <p className="context-warn-note">
            已超过 {formatPercent(contextWarnThreshold)} 阈值，较早的历史会被确定性压缩；模型可用
            recall 工具取回原文。
          </p>
        ) : null}
      </section>

      <section className="overview-block" aria-label="发送构成">
        <div className="overview-block-heading">
          <h3>发送构成</h3>
          <span className="activity-state">按来源</span>
        </div>
        <div className="usage-composition">
          <p className="usage-total">
            <strong>{formatTokens(current.sentTokens)}</strong> tokens
          </p>
          {compositionBar(current)}
          <ul className="usage-legend">
            {contextCategories.map((category) => {
              const value = current.categories[category.key];
              return (
                <li key={category.key}>
                  <span className={`usage-dot context-seg-${category.key}`} aria-hidden="true" />
                  <span className="usage-legend-label">{category.label}</span>
                  <span className="usage-legend-value">{formatTokens(value)}</span>
                  <span className="usage-legend-percent">
                    {formatPercent(current.sentTokens === 0 ? 0 : value / current.sentTokens)}
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      </section>

      <section className="overview-block" aria-label="历史趋势">
        <div className="overview-block-heading">
          <h3>历史趋势</h3>
          <span className="activity-state">每轮窗口占用</span>
        </div>
        {points.length === 0 ? (
          <p className="activity-hint">出现上下文记录后会按轮次展示占用趋势。</p>
        ) : (
          <ol className="usage-trend" aria-label="上下文占用趋势">
            {points.map((point) => (
              <li key={point.key}>
                <button
                  type="button"
                  className="usage-trend-bar"
                  disabled={point.targetId === undefined}
                  title={`${point.label}：占用 ${formatPercent(point.ratio)} · ${formatTokens(
                    point.sentTokens,
                  )} tokens`}
                  onClick={() =>
                    point.targetId !== undefined && props.onJumpToMessage(point.targetId)
                  }
                >
                  <span
                    className="usage-trend-stack"
                    style={{ height: percentWidth(Math.max(point.ratio, 0.02)) }}
                  >
                    <span
                      className={`usage-seg ${
                        point.ratio >= contextWarnThreshold
                          ? 'context-trend-warn'
                          : 'context-trend-fill'
                      }`}
                      style={{ height: '100%' }}
                    />
                  </span>
                  <span className="usage-trend-label">{point.label}</span>
                </button>
              </li>
            ))}
          </ol>
        )}
      </section>
    </div>
  );
}
