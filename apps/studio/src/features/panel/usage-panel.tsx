import { useState, type ReactElement } from 'react';

import { cacheHitRate, formatPercent, formatTokens, sumUsage } from '../conversation/turn-stats.js';
import {
  firstAssistantByTurn,
  percentWidth,
  usageCategories,
  usageComposition,
  type PanelContext,
  type UsageComposition,
} from './panel-data.js';

type Granularity = 'turn' | 'step';

interface TrendPoint {
  readonly key: string;
  readonly label: string;
  readonly composition: UsageComposition;
}

function compositionBar(composition: UsageComposition): ReactElement {
  return (
    <span className="usage-bar" aria-hidden="true">
      {usageCategories.map((category) => {
        const value = composition[category.key];
        return value === 0 ? null : (
          <span
            key={category.key}
            className={`usage-seg usage-seg-${category.key}`}
            style={{ width: percentWidth(value / composition.total) }}
          />
        );
      })}
    </span>
  );
}

function trendPoints(turns: PanelContext['turns'], granularity: Granularity): TrendPoint[] {
  if (granularity === 'turn') {
    return turns.map((turn, index) => ({
      key: turn.turnId,
      label: `T${index + 1}`,
      composition: usageComposition(turn.usage),
    }));
  }
  const points: TrendPoint[] = [];
  let step = 0;
  for (const turn of turns) {
    for (const modelStep of turn.modelSteps) {
      step += 1;
      points.push({
        key: `${turn.turnId}-${step}`,
        label: `S${step}`,
        composition: usageComposition(modelStep.usage),
      });
    }
  }
  return points;
}

/**
 * Token-focused panel in the spirit of the DeepSeek harness context view:
 * session-wide counters, the current prompt/response composition, and a
 * per-Turn or per-Step history trend. It uses the usage Weave records
 * (input, cache, output, reasoning); it does not decompose the prompt by
 * message kind, which Weave does not track.
 */
export function UsagePanel(props: PanelContext): ReactElement {
  const [granularity, setGranularity] = useState<Granularity>('turn');
  const totals = sumUsage(props.turns.map((turn) => turn.usage));
  const composition = usageComposition(totals);
  const hitRate = cacheHitRate(totals);
  const stepCount = props.turns.reduce((sum, turn) => sum + turn.modelSteps.length, 0);
  const toolCount = props.turns.reduce((sum, turn) => sum + turn.toolCalls, 0);
  const points = trendPoints(props.turns, granularity);
  const maxTotal = points.reduce((max, point) => Math.max(max, point.composition.total), 0);
  const targetByTurn = firstAssistantByTurn(props.messages);

  return (
    <div className="panel-body" role="region" aria-label="用量">
      <section className="overview-block">
        <div className="overview-block-heading">
          <h3>统计</h3>
          <span className="activity-state">当前会话累计</span>
        </div>
        <dl className="usage-stats">
          <div>
            <dt>轮次</dt>
            <dd>{props.turns.length}</dd>
          </div>
          <div>
            <dt>步数</dt>
            <dd>{stepCount}</dd>
          </div>
          <div>
            <dt>工具调用</dt>
            <dd>{toolCount}</dd>
          </div>
          <div>
            <dt>缓存命中</dt>
            <dd>{formatPercent(hitRate)}</dd>
          </div>
        </dl>
      </section>

      <section className="overview-block" aria-label="用量构成">
        <div className="overview-block-heading">
          <h3>当前构成</h3>
          <span className="activity-state">输入 + 输出</span>
        </div>
        {totals === undefined ? (
          <p className="activity-hint">模型返回用量后会显示在这里。</p>
        ) : (
          <div className="usage-composition">
            <p className="usage-total">
              <strong>{formatTokens(composition.total)}</strong> tokens
            </p>
            {compositionBar(composition)}
            <ul className="usage-legend">
              {usageCategories.map((category) => {
                const value = composition[category.key];
                return (
                  <li key={category.key}>
                    <span className={`usage-dot usage-seg-${category.key}`} aria-hidden="true" />
                    <span className="usage-legend-label">{category.label}</span>
                    <span className="usage-legend-value">{formatTokens(value)}</span>
                    <span className="usage-legend-percent">
                      {formatPercent(composition.total === 0 ? 0 : value / composition.total)}
                    </span>
                  </li>
                );
              })}
            </ul>
          </div>
        )}
      </section>

      <section className="overview-block" aria-label="历史趋势">
        <div className="overview-block-heading">
          <h3>历史趋势</h3>
          <div className="usage-granularity" role="group" aria-label="趋势粒度">
            <button
              type="button"
              className={granularity === 'turn' ? 'is-active' : undefined}
              aria-pressed={granularity === 'turn'}
              onClick={() => setGranularity('turn')}
            >
              轮次
            </button>
            <button
              type="button"
              className={granularity === 'step' ? 'is-active' : undefined}
              aria-pressed={granularity === 'step'}
              onClick={() => setGranularity('step')}
            >
              步骤
            </button>
          </div>
        </div>
        {maxTotal === 0 ? (
          <p className="activity-hint">
            出现用量后会按{granularity === 'turn' ? '轮次' : '步骤'}展示趋势。
          </p>
        ) : (
          <ol className="usage-trend" aria-label="用量趋势">
            {points.map((point, index) => {
              const targetId =
                granularity === 'turn'
                  ? targetByTurn.get(props.turns[index]?.turnId ?? '')
                  : undefined;
              return (
                <li key={point.key}>
                  <button
                    type="button"
                    className="usage-trend-bar"
                    disabled={targetId === undefined}
                    title={trendTitle(point)}
                    onClick={() => targetId !== undefined && props.onJumpToMessage(targetId)}
                  >
                    <span
                      className="usage-trend-stack"
                      style={{ height: percentWidth(point.composition.total / maxTotal) }}
                    >
                      {usageCategories.map((category) => {
                        const value = point.composition[category.key];
                        return value === 0 ? null : (
                          <span
                            key={category.key}
                            className={`usage-seg usage-seg-${category.key}`}
                            style={{ height: percentWidth(value / point.composition.total) }}
                          />
                        );
                      })}
                    </span>
                    <span className="usage-trend-label">{point.label}</span>
                  </button>
                </li>
              );
            })}
          </ol>
        )}
      </section>
    </div>
  );
}

function trendTitle(point: TrendPoint): string {
  const { cacheRead, freshInput, output, reasoning, total } = point.composition;
  return (
    `${point.label}：合计 ${formatTokens(total)}\n` +
    `命中缓存 ${formatTokens(cacheRead)} · 新输入 ${formatTokens(freshInput)} · ` +
    `输出 ${formatTokens(output)} · 思考 ${formatTokens(reasoning)}`
  );
}
