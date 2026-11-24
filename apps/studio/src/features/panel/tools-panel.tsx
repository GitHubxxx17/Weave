import { type ReactElement } from 'react';
import { Wrench } from 'lucide-react';

import { ToolStep } from '../conversation/tool-step.js';
import { collectTimeline, type PanelContext } from './panel-data.js';

/** The full tool-call timeline for the Session, newest first. */
export function ToolsPanel(props: PanelContext): ReactElement {
  const timeline = collectTimeline(props.messages);

  return (
    <div className="panel-body" role="region" aria-label="工具调用">
      <section className="overview-block">
        <div className="overview-block-heading">
          <h3>工具时间线</h3>
          <span className="activity-state">{timeline.length} 次</span>
        </div>
        {timeline.length === 0 ? (
          <div className="activity-empty">
            <span className="activity-empty-icon" aria-hidden="true">
              <Wrench aria-hidden="true" />
            </span>
            <p>当前还没有工具调用</p>
          </div>
        ) : (
          <div className="tool-list">
            {timeline.map(({ tool, message }) => (
              <ToolStep
                key={JSON.stringify([
                  props.sessionId ?? props.sessionLabel,
                  message.turnId ?? message.id,
                  tool.toolCallId,
                ])}
                tool={tool}
                showTime={props.formatTime(message.occurredAt)}
              />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
