import { type ReactElement } from 'react';

export type ToolStepStatus = 'called' | 'executing' | 'completed' | 'failed';

export interface ToolStepData {
  readonly toolCallId: string;
  readonly name: string;
  readonly arguments: string;
  readonly status: ToolStepStatus;
  readonly result?: string | undefined;
}

const statusLabels: Record<ToolStepStatus, string> = {
  called: '已调用',
  executing: '执行中',
  completed: '已完成',
  failed: '失败',
};

/** Pulls a `path` argument out for the collapsed heading, when present. */
function toolTarget(argumentsText: string): string | undefined {
  try {
    const parsed = JSON.parse(argumentsText) as unknown;
    if (typeof parsed === 'object' && parsed !== null && 'path' in parsed) {
      const value = (parsed as { path: unknown }).path;
      return typeof value === 'string' ? value : undefined;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

/**
 * One tool call rendered as a collapsed row.
 *
 * Only the tool name, target path, and status show by default; the full
 * arguments and result are revealed on expand and scroll inside a bounded box
 * so a large file never stretches the conversation.
 */
export function ToolStep({
  tool,
  defaultOpen = false,
  showTime,
}: {
  readonly tool: ToolStepData;
  readonly defaultOpen?: boolean;
  readonly showTime?: string;
}): ReactElement {
  const target = toolTarget(tool.arguments);
  return (
    <details className="tool-step" open={defaultOpen}>
      <summary className="tool-step-heading">
        {showTime === undefined ? null : <span className="tool-step-time">{showTime}</span>}
        <strong>{tool.name}</strong>
        {target === undefined ? null : <code className="tool-step-target">{target}</code>}
        <span className={`status-badge status-${tool.status}`}>{statusLabels[tool.status]}</span>
      </summary>
      <div className="tool-step-body">
        <pre className="tool-step-args">{tool.arguments}</pre>
        {tool.result !== undefined && tool.result !== '' ? (
          <pre className="tool-step-result">{tool.result}</pre>
        ) : null}
      </div>
    </details>
  );
}
