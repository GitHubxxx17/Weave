import { useEffect, useState, type ReactElement } from 'react';
import { FileText, FolderOpen, Wrench } from 'lucide-react';

import type { TurnSummary } from '../workspace/workspace-types.js';
import { ToolStep } from './tool-step.js';
import {
  cacheHitRate,
  formatDuration,
  formatPercent,
  formatTokens,
  outputTokensPerSecond,
  sumUsage,
  turnDurationMs,
} from './turn-stats.js';

export type OverviewToolStatus = 'called' | 'executing' | 'completed' | 'failed';

export interface OverviewTool {
  readonly toolCallId: string;
  readonly name: string;
  readonly arguments: string;
  readonly status: OverviewToolStatus;
  readonly result?: string | undefined;
}

export interface OverviewMessage {
  readonly id: string;
  readonly role: 'user' | 'assistant';
  readonly occurredAt: string;
  readonly turnId?: string | undefined;
  readonly tools: readonly OverviewTool[];
}

export interface SessionOverviewProps {
  readonly statusKey: string;
  readonly statusLabel: string;
  readonly isRunning: boolean;
  readonly sessionLabel: string;
  readonly folderPath: string | undefined;
  readonly modelLabel: string;
  readonly turns: readonly TurnSummary[];
  readonly messages: readonly OverviewMessage[];
  readonly errorMessage: string | null;
  readonly formatTime: (occurredAt: string) => string;
  readonly onSetFolder: () => void;
  readonly onJumpToMessage: (messageId: string) => void;
}

function toolPath(tool: OverviewTool): string | undefined {
  try {
    const parsed = JSON.parse(tool.arguments) as unknown;
    if (typeof parsed === 'object' && parsed !== null && 'path' in parsed) {
      const value = (parsed as { path: unknown }).path;
      return typeof value === 'string' ? value : undefined;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

type FileEntry = {
  readonly path: string;
  readonly operation: '读取' | '写入';
  readonly state: string;
  readonly ok: boolean;
  readonly messageId: string;
};

/** Latest read or write of each path in the Session, newest first. */
function collectFiles(messages: readonly OverviewMessage[]): FileEntry[] {
  const byPath = new Map<string, FileEntry>();
  for (const message of messages) {
    for (const tool of message.tools) {
      if (tool.name !== 'read_file' && tool.name !== 'write_file') {
        continue;
      }
      const path = toolPath(tool);
      if (path === undefined) {
        continue;
      }
      const rejected = tool.result?.includes('tool-approval-rejected') === true;
      const state =
        tool.status === 'completed'
          ? tool.name === 'read_file'
            ? '已读取'
            : '已写入'
          : tool.status === 'failed'
            ? rejected
              ? '已拒绝'
              : '失败'
            : '进行中';
      byPath.delete(path);
      byPath.set(path, {
        path,
        operation: tool.name === 'read_file' ? '读取' : '写入',
        state,
        ok: tool.status === 'completed',
        messageId: message.id,
      });
    }
  }
  return [...byPath.values()].reverse();
}

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

/**
 * Right-hand overview of the active Session: folder and model, live run
 * timing, token usage and cache hit rate per Turn, touched files, and the
 * full tool timeline. Everything comes from durable Session data plus the
 * live run, so it survives refreshes and Session switches.
 */
export function SessionOverview(props: SessionOverviewProps): ReactElement {
  const now = useNow(props.isRunning);
  const totals = sumUsage(props.turns.map((turn) => turn.usage));
  const hitRate = cacheHitRate(totals);
  const toolCount = props.turns.reduce((sum, turn) => sum + turn.toolCalls, 0);
  const failedTools = props.turns.reduce((sum, turn) => sum + turn.failedToolCalls, 0);
  const lastTurn = props.turns.at(-1);
  const speed = outputTokensPerSecond(props.turns);
  const files = collectFiles(props.messages);
  const timeline = props.messages
    .flatMap((message) => message.tools.map((tool) => ({ tool, message })))
    .reverse();
  const firstAssistantOfTurn = new Map<string, string>();
  for (const message of props.messages) {
    if (
      message.role === 'assistant' &&
      message.turnId !== undefined &&
      !firstAssistantOfTurn.has(message.turnId)
    ) {
      firstAssistantOfTurn.set(message.turnId, message.id);
    }
  }

  return (
    <>
      <section className="activity-section overview-section" aria-label="会话概览">
        <button className="overview-folder" type="button" onClick={props.onSetFolder}>
          <FolderOpen aria-hidden="true" />
          <span>{props.folderPath ?? '未设置项目文件夹'}</span>
          <small>{props.folderPath === undefined ? '设置' : '更改'}</small>
        </button>
        <p className="overview-model">{props.modelLabel}</p>
        <p className="overview-status">
          <span className={`status-pulse status-pulse-${props.statusKey}`} aria-hidden="true" />
          <strong className={`run-status run-status-${props.statusKey}`}>
            {props.statusLabel}
          </strong>
          {props.isRunning && lastTurn !== undefined ? (
            <span>· 已运行 {formatDuration(turnDurationMs(lastTurn, now))}</span>
          ) : null}
          {speed === undefined ? null : <span>· {Math.round(speed)} token/s</span>}
        </p>
        <p className="overview-counts">
          {props.turns.length} 轮 · {toolCount} 次工具
          {failedTools > 0 ? ` · ${failedTools} 次失败` : ''}
        </p>
        <small className="overview-session" aria-label={`会话 #${props.sessionLabel}`}>
          会话 #{props.sessionLabel}
        </small>
      </section>

      {props.errorMessage !== null ? (
        <section className="activity-section error-section" aria-label="运行错误">
          <div className="activity-section-heading">
            <h3>运行错误</h3>
            <span className="status-badge status-failed">错误</span>
          </div>
          <p className="error-message">{props.errorMessage}</p>
        </section>
      ) : null}

      <section className="activity-section" aria-label="Token 用量">
        <div className="activity-section-heading">
          <h3>Token</h3>
          <span className="activity-state">缓存命中 {formatPercent(hitRate)}</span>
        </div>
        {totals === undefined ? (
          <p className="activity-hint">模型返回用量后会显示在这里。</p>
        ) : (
          <>
            <dl className="token-totals">
              <div>
                <dt>输入</dt>
                <dd>{formatTokens(totals.inputTokens)}</dd>
              </div>
              <div>
                <dt>命中缓存</dt>
                <dd>{formatTokens(totals.cacheReadTokens)}</dd>
              </div>
              <div>
                <dt>输出</dt>
                <dd>{formatTokens(totals.outputTokens)}</dd>
              </div>
              <div>
                <dt>思考</dt>
                <dd>{formatTokens(totals.reasoningTokens)}</dd>
              </div>
            </dl>
            <div
              className="cache-bar"
              role="meter"
              aria-label="缓存命中率"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={hitRate === undefined ? 0 : Math.round(hitRate * 100)}
            >
              <span style={{ width: `${Math.round((hitRate ?? 0) * 100)}%` }} />
            </div>
          </>
        )}
        {props.turns.length === 0 ? null : (
          <ol className="turn-usage-list" aria-label="每轮用量">
            {props.turns.map((turn, index) => {
              const targetId = firstAssistantOfTurn.get(turn.turnId);
              return (
                <li key={turn.turnId}>
                  <button
                    type="button"
                    disabled={targetId === undefined}
                    onClick={() => targetId !== undefined && props.onJumpToMessage(targetId)}
                  >
                    <span>第 {index + 1} 轮</span>
                    <span>
                      {formatTokens(turn.usage?.inputTokens)} /{' '}
                      {formatTokens(turn.usage?.outputTokens)}
                    </span>
                    <span>命中 {formatPercent(cacheHitRate(turn.usage))}</span>
                  </button>
                </li>
              );
            })}
          </ol>
        )}
      </section>

      <section className="activity-section" aria-label="文件">
        <div className="activity-section-heading">
          <h3>文件</h3>
          <span className="activity-state">{files.length} 个</span>
        </div>
        {files.length === 0 ? (
          <p className="activity-hint">Agent 读写文件后会列在这里。</p>
        ) : (
          <ul className="file-list">
            {files.map((file) => (
              <li key={file.path}>
                <button type="button" onClick={() => props.onJumpToMessage(file.messageId)}>
                  <FileText aria-hidden="true" />
                  <span className="file-op">{file.operation}</span>
                  <code>{file.path}</code>
                  <span className={file.ok ? 'file-state-ok' : 'file-state-bad'}>{file.state}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="activity-section" aria-label="工具调用">
        <div className="activity-section-heading">
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
                key={tool.toolCallId}
                tool={tool}
                showTime={props.formatTime(message.occurredAt)}
              />
            ))}
          </div>
        )}
      </section>
    </>
  );
}
