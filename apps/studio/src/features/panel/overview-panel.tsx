import { useEffect, useState, type ReactElement } from 'react';
import { ChevronRight, FolderOpen } from 'lucide-react';

import {
  formatDuration,
  outputTokensPerSecond,
  turnDurationMs,
} from '../conversation/turn-stats.js';
import { splitPath, type PanelContext } from './panel-data.js';

function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) {
      return;
    }
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return active ? now : Date.now();
}

/** Run state, project folder, model, and session facts for the active Session. */
export function OverviewPanel(props: PanelContext): ReactElement {
  const now = useNow(props.isRunning);
  const toolCount = props.turns.reduce((sum, turn) => sum + turn.toolCalls, 0);
  const failedTools = props.turns.reduce((sum, turn) => sum + turn.failedToolCalls, 0);
  const lastTurn = props.turns.at(-1);
  const speed = outputTokensPerSecond(props.turns);
  const folderName =
    props.folderPath === undefined ? '未设置项目文件夹' : splitPath(props.folderPath).name;

  return (
    <div className="panel-body" role="region" aria-label="概览">
      <section className="overview-block">
        <div className="overview-status">
          <span className={`overview-status-badge overview-status-badge-${props.statusKey}`}>
            <span className={`status-pulse status-pulse-${props.statusKey}`} aria-hidden="true" />
            <strong className={`run-status run-status-${props.statusKey}`}>
              {props.statusLabel}
            </strong>
          </span>
          {props.isRunning && lastTurn !== undefined ? (
            <span className="overview-status-meta">
              已运行 {formatDuration(turnDurationMs(lastTurn, now))}
            </span>
          ) : speed === undefined ? null : (
            <span className="overview-status-meta">{Math.round(speed)} token/s</span>
          )}
        </div>
        <button className="overview-folder" type="button" onClick={props.onSetFolder}>
          <span className="overview-folder-icon" aria-hidden="true">
            <FolderOpen />
          </span>
          <span className="overview-folder-copy">
            <strong>{folderName}</strong>
            <small title={props.folderPath}>
              {props.folderPath ?? '设置后 Agent 才能读写项目文件'}
            </small>
          </span>
          <span className="overview-folder-action">
            {props.folderPath === undefined ? '设置' : '更改'}
            <ChevronRight aria-hidden="true" />
          </span>
        </button>
        <dl className="overview-facts">
          <div>
            <dt>模型</dt>
            <dd title={props.modelLabel}>{props.modelLabel}</dd>
          </div>
          <div>
            <dt>轮次</dt>
            <dd>{props.turns.length} 轮</dd>
          </div>
          <div>
            <dt>工具调用</dt>
            <dd>
              {toolCount} 次
              {failedTools > 0 ? (
                <span className="overview-fact-alert">{failedTools} 次失败</span>
              ) : null}
            </dd>
          </div>
          <div>
            <dt>会话</dt>
            <dd title={props.sessionLabel} aria-label={`会话 #${props.sessionLabel}`}>
              <code>#{props.sessionLabel.split('-')[0]}</code>
            </dd>
          </div>
        </dl>
      </section>

      {props.errorMessage !== null ? (
        <section className="overview-block overview-error" aria-label="运行错误">
          <div className="overview-block-heading">
            <h3>运行错误</h3>
            <span className="status-badge status-failed">错误</span>
          </div>
          <p className="error-message">{props.errorMessage}</p>
        </section>
      ) : null}
    </div>
  );
}
