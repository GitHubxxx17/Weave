import { useEffect, useState, type ReactElement } from 'react';
import {
  CheckCircle2,
  ChevronRight,
  CircleAlert,
  LoaderCircle,
  Square,
  StopCircle,
} from 'lucide-react';
import type { AgentTaskResultPointer, AgentTaskView } from './task-types.js';
import { stopAllTasksKey } from './use-agent-tasks.js';
import './task-panel.css';

const reasonLabels: Record<NonNullable<AgentTaskView['reason']>, string> = {
  'preparation-failed': '准备任务失败',
  'preparation-interrupted': '准备任务时中断',
  'generation-unavailable': '所需运行配置已不可用',
  'agent-step-limit': '已达到步数上限',
  'child-failed': '子任务运行失败',
  'child-interrupted': '子任务运行中断',
  'task-cancelled': '已请求停止任务',
  'parent-stop': '父会话运行已停止',
  'task-deadline': '已达到执行时限',
  'workspace-changed': '项目工作区已变更',
  'generation-revoked': '运行配置已撤销',
  'ownership-lost': '任务执行权已变更',
  shutdown: '运行时已关闭',
};

const permissionLabels: Record<AgentTaskView['permissionMode'], string> = {
  ask: '常规',
  trust: '信任',
  yolo: '完全访问',
};

export function isSettledTask(task: AgentTaskView): boolean {
  return ['completed', 'failed', 'cancelled', 'interrupted'].includes(task.status);
}

function statusLabel(task: AgentTaskView): string {
  if (task.reason === 'agent-step-limit') return '未完成答复';
  return (
    (
      {
        preparing: '准备中',
        queued: '排队中',
        running: '运行中',
        cancelling: '停止中',
        blocked: '已阻塞',
        completed: '已完成',
        failed: '失败',
        cancelled: '已停止',
        interrupted: '已中断',
      } as Record<string, string>
    )[task.status] ?? task.status
  );
}

function elapsed(acceptedAt: string, now: number, settledAt?: string): string {
  const end = settledAt === undefined ? now : Date.parse(settledAt);
  const seconds = Math.max(0, Math.floor((end - Date.parse(acceptedAt)) / 1000));
  return seconds < 60 ? `${seconds} 秒` : `${Math.floor(seconds / 60)} 分钟`;
}

export interface AgentTaskPanelProps {
  readonly tasks: readonly AgentTaskView[];
  readonly pending: ReadonlySet<string>;
  readonly onOpen: (task: AgentTaskView, result?: AgentTaskResultPointer) => void;
  readonly onStop: (taskId?: string) => void;
  readonly onPrepare?: (prompt: string, access: 'read-only' | 'workspace') => void;
  readonly onLoadMore?: () => void;
  readonly hasMore?: boolean;
  readonly loadingPage?: boolean;
  readonly totalCount?: number | undefined;
  readonly error?: string | undefined;
}

export function AgentTaskPanel({
  tasks,
  pending,
  onOpen,
  onStop,
  onPrepare,
  onLoadMore,
  hasMore,
  loadingPage,
  totalCount = tasks.length,
  error,
}: AgentTaskPanelProps): ReactElement {
  const [prompt, setPrompt] = useState('');
  const [access, setAccess] = useState<'read-only' | 'workspace'>('read-only');
  const [now, setNow] = useState(Date.now);
  const hasLiveTasks = tasks.some((task) => !isSettledTask(task));
  useEffect(() => {
    if (!hasLiveTasks) return;
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [hasLiveTasks]);
  return (
    <section className="task-panel" aria-label="子任务列表">
      {error === undefined ? null : (
        <p className="task-panel-error" role="alert">
          {error}
        </p>
      )}
      {tasks.length === 0 ? (
        <p className="task-empty">当前会话还没有子任务。</p>
      ) : (
        <ul className="task-list">
          {tasks.map((task) => {
            const terminal = isSettledTask(task);
            const stopping = pending.has(task.taskId) || task.status === 'cancelling';
            return (
              <li className={`task-item task-item-${task.status}`} key={task.taskId}>
                <div className="task-item-marker" aria-hidden="true">
                  {terminal ? (
                    <CheckCircle2 />
                  ) : (
                    <LoaderCircle className={task.status === 'running' ? 'task-spin' : ''} />
                  )}
                </div>
                <div className="task-item-body">
                  <div className="task-item-heading">
                    <button
                      className="task-item-title"
                      type="button"
                      onClick={() => onOpen(task)}
                      aria-label={`打开子会话：${task.title}`}
                    >
                      {task.title}
                      <ChevronRight aria-hidden="true" />
                    </button>
                    <span className="task-item-status">{statusLabel(task)}</span>
                  </div>
                  <div className="task-item-meta">
                    <span>{task.access === 'workspace' ? '共享工作区' : '只读'}</span>
                    <span>权限：{permissionLabels[task.permissionMode]}</span>
                    <span>{elapsed(task.acceptedAt, now, task.settledAt)}</span>
                    {task.pendingApprovalCount > 0 ? (
                      <strong>待审批 {task.pendingApprovalCount}</strong>
                    ) : null}
                  </div>
                  {task.preview === '' ? null : (
                    <p className="task-item-preview">
                      {task.preview}
                      {task.previewTruncated ? ' …' : ''}
                    </p>
                  )}
                  {task.permissionMode === 'yolo' ? (
                    <p className="task-item-note task-item-warning" role="note">
                      <CircleAlert aria-hidden="true" />
                      完全访问：该子任务继承父回合权限，
                      {task.access === 'workspace' ? '写入和命令都不经审批' : '操作不经审批'}
                    </p>
                  ) : null}
                  {task.reason === undefined ? null : (
                    <p className="task-item-note">
                      <CircleAlert aria-hidden="true" />
                      {reasonLabels[task.reason]}
                    </p>
                  )}
                  {terminal && task.resultKind === 'none' ? (
                    <p className="task-item-note">没有答复文本</p>
                  ) : null}
                  {task.resultKind !== 'none' && task.result !== undefined ? (
                    <button
                      className="task-item-result"
                      type="button"
                      onClick={() => onOpen(task, task.result)}
                      aria-label={`查看全文：${task.title}`}
                    >
                      {task.resultKind === 'final-answer' ? '查看最终答复' : '部分输出'}
                    </button>
                  ) : null}
                </div>
                {terminal ? null : (
                  <button
                    className="task-stop-button"
                    type="button"
                    disabled={stopping}
                    onClick={() => onStop(task.taskId)}
                    aria-label={`停止任务：${task.title}`}
                    title="停止任务"
                  >
                    {stopping ? <LoaderCircle className="task-spin" /> : <Square />}
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {hasMore === true ? (
        <button
          className="task-load-more"
          type="button"
          disabled={loadingPage}
          onClick={onLoadMore}
        >
          {loadingPage ? '正在加载…' : `加载更多（${tasks.length}/${totalCount}）`}
        </button>
      ) : null}
      {tasks.some((task) => !isSettledTask(task)) ? (
        <button
          className="task-stop-all"
          type="button"
          disabled={pending.has(stopAllTasksKey)}
          onClick={() => onStop()}
        >
          <StopCircle aria-hidden="true" />
          停止全部子任务
        </button>
      ) : null}
      {onPrepare === undefined ? null : (
        <div className="task-delegate">
          <label htmlFor="task-delegation-prompt">委派说明</label>
          <textarea
            id="task-delegation-prompt"
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            placeholder="准备一条明确的子任务说明"
            rows={2}
          />
          <div className="task-delegate-row">
            <label htmlFor="task-access">访问权限</label>
            <select
              id="task-access"
              aria-label="子任务访问权限"
              value={access}
              onChange={(event) => setAccess(event.target.value as typeof access)}
            >
              <option value="read-only">只读</option>
              <option value="workspace">共享工作区</option>
            </select>
            <button
              type="button"
              disabled={prompt.trim() === ''}
              onClick={() => onPrepare(prompt.trim(), access)}
            >
              添加到会话草稿
            </button>
          </div>
          <p>子任务共享当前项目文件夹。启用写入时，请避免同时修改相同文件。</p>
          <p>子任务继承父会话的提供方、模型和采样设置，启动时使用主机当前的连接配置。</p>
          <p>发送草稿后，由父会话的模型决定是否委派。</p>
        </div>
      )}
    </section>
  );
}
