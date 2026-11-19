import { type ReactElement } from 'react';

import { latestPlan, planStatusMeta, type PanelContext } from './panel-data.js';

/**
 * Shows the task checklist the Agent maintains with the `update_plan` tool,
 * in the spirit of the Codex plan list: a progress bar, an optional one-line
 * explanation, and each step with its pending / in_progress / completed status.
 * It reads the latest plan recorded on a Turn, so it survives a reload.
 */
export function PlanPanel(props: PanelContext): ReactElement {
  const plan = latestPlan(props.turns);

  if (plan === undefined || plan.items.length === 0) {
    return (
      <div className="panel-body" role="region" aria-label="计划">
        <section className="overview-block">
          <div className="overview-block-heading">
            <h3>任务计划</h3>
            <span className="activity-state">update_plan</span>
          </div>
          <p className="activity-hint">
            模型用 update_plan 维护任务清单后，这里会显示待办、进行中与已完成的步骤。
          </p>
        </section>
      </div>
    );
  }

  const total = plan.items.length;
  const completed = plan.items.filter((item) => item.status === 'completed').length;
  const ratio = total === 0 ? 0 : completed / total;

  return (
    <div className="panel-body" role="region" aria-label="计划">
      <section className="overview-block" aria-label="任务计划">
        <div className="overview-block-heading">
          <h3>任务计划</h3>
          <span className="activity-state">
            {completed}/{total} 已完成
          </span>
        </div>
        <div
          className="plan-progress"
          role="meter"
          aria-valuemin={0}
          aria-valuemax={total}
          aria-valuenow={completed}
          aria-label="计划完成进度"
        >
          <span className="plan-progress-fill" style={{ width: `${Math.round(ratio * 100)}%` }} />
        </div>
        {plan.explanation !== undefined && plan.explanation.trim() !== '' ? (
          <p className="plan-explanation">{plan.explanation}</p>
        ) : null}
        <ol className="plan-list">
          {plan.items.map((item, index) => {
            const meta = planStatusMeta[item.status];
            return (
              <li key={`${index}-${item.step}`} className={`plan-item plan-item-${item.status}`}>
                <span className="plan-item-mark" aria-hidden="true">
                  {meta.symbol}
                </span>
                <span className="plan-item-step">{item.step}</span>
                <span className="plan-item-status">{meta.label}</span>
              </li>
            );
          })}
        </ol>
      </section>
    </div>
  );
}
