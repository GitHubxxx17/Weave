import { type ReactElement } from 'react';
import {
  Check,
  ChevronRight,
  CircleAlert,
  FilePen,
  FileText,
  LoaderCircle,
  Search,
  Wrench,
  type LucideIcon,
} from 'lucide-react';

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

function parseArguments(argumentsText: string): unknown {
  try {
    return JSON.parse(argumentsText) as unknown;
  } catch {
    return undefined;
  }
}

/** Pulls a `path` argument out for the collapsed heading, when present. */
function toolTarget(parsed: unknown): string | undefined {
  if (typeof parsed === 'object' && parsed !== null && 'path' in parsed) {
    const value = (parsed as { path: unknown }).path;
    return typeof value === 'string' ? value : undefined;
  }
  return undefined;
}

/** Shows JSON arguments indented; anything else is shown as received. */
function formatArguments(argumentsText: string, parsed: unknown): string {
  return parsed === undefined ? argumentsText : JSON.stringify(parsed, null, 2);
}

function toolIcon(name: string): LucideIcon {
  if (name === 'read_file') {
    return FileText;
  }
  if (name === 'write_file') {
    return FilePen;
  }
  return name.includes('search') ? Search : Wrench;
}

function statusLabel(tool: ToolStepData): string {
  return tool.status === 'failed' && tool.result?.includes('tool-approval-rejected') === true
    ? '已拒绝'
    : statusLabels[tool.status];
}

/**
 * One tool call rendered as a compact, collapsed row.
 *
 * The heading shows the tool, its target path, and its status; the formatted
 * arguments and the result are revealed on expand inside bounded scroll boxes
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
  const parsed = parseArguments(tool.arguments);
  const target = toolTarget(parsed);
  const Icon = toolIcon(tool.name);
  const label = statusLabel(tool);

  return (
    <details
      className={`tool-step tool-step-${tool.status}`}
      data-tool-call-id={tool.toolCallId}
      open={defaultOpen}
    >
      <summary className="tool-step-heading">
        <ChevronRight className="disclosure-icon" aria-hidden="true" />
        <span className="tool-step-icon" aria-hidden="true">
          <Icon />
        </span>
        <strong className="tool-step-name">{tool.name}</strong>
        <code className="tool-step-target" title={target}>
          {target ?? ''}
        </code>
        {showTime === undefined ? null : <span className="tool-step-time">{showTime}</span>}
        <span className={`tool-step-status tool-step-status-${tool.status}`} title={label}>
          {tool.status === 'completed' ? <Check aria-hidden="true" /> : null}
          {tool.status === 'executing' ? (
            <LoaderCircle className="spin-icon" aria-hidden="true" />
          ) : null}
          {tool.status === 'failed' ? <CircleAlert aria-hidden="true" /> : null}
          <span className={tool.status === 'completed' ? 'sr-only' : undefined}>{label}</span>
        </span>
      </summary>
      <div className="tool-step-body">
        <div className="tool-step-block">
          <span className="tool-step-label">参数</span>
          <pre className="tool-step-code" data-tool-parameters="" tabIndex={-1}>
            {formatArguments(tool.arguments, parsed)}
          </pre>
        </div>
        {tool.result !== undefined && tool.result !== '' ? (
          <div className="tool-step-block">
            <span className="tool-step-label">结果</span>
            <pre className="tool-step-code tool-step-code-result">{tool.result}</pre>
          </div>
        ) : null}
      </div>
    </details>
  );
}
