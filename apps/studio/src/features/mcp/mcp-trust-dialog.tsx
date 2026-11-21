import { useEffect, useId, useRef, useState, type ReactElement } from 'react';

import { PluginDialog, pluginDialogError } from '../plugins/plugin-dialog.js';
import { McpApiError } from './mcp-api.js';
import { diffMcpConfig, type McpReview } from './mcp-review.js';

import './mcp-dialog.css';

export interface McpTrustDialogProps {
  readonly review: McpReview;
  readonly busy: boolean;
  readonly stale: boolean;
  readonly onTrust: (review: McpReview) => Promise<void>;
  readonly onCancel: () => void;
  readonly getFallbackFocus: () => HTMLElement | null;
}

const fieldNames = {
  label: '显示名称',
  command: '启动程序',
  args: '参数',
  cwd: '工作目录',
  env: '环境引用',
} as const;
const staleMessage = '配置或授权已变化，本次审阅已失效。请关闭后重新审阅。';

/** Reviews only the canonical configuration captured when the dialog opened. */
export function McpTrustDialog({
  review: initialReview,
  busy,
  stale,
  onTrust,
  onCancel,
  getFallbackFocus,
}: McpTrustDialogProps): ReactElement {
  const [review] = useState(() => initialReview);
  const warningId = useId();
  const cancelRef = useRef<HTMLButtonElement>(null);
  const submitted = useRef(false);
  const active = useRef(true);
  const [submitting, setSubmitting] = useState(false);
  const [invalidated, setInvalidated] = useState(false);
  const [error, setError] = useState<string>();
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  const expired = stale || invalidated;
  const canSubmit = !busy && !submitting && !expired;
  const changes =
    review.reviewedConfig === undefined ? [] : diffMcpConfig(review.reviewedConfig, review.config);
  const submit = async (): Promise<void> => {
    if (!canSubmit || submitted.current) return;
    submitted.current = true;
    setSubmitting(true);
    setError(undefined);
    try {
      await onTrust(review);
      if (active.current) onCancel();
    } catch (reason: unknown) {
      if (!active.current) return;
      if (reason instanceof McpApiError && reason.status === 409) {
        setInvalidated(true);
        setError(staleMessage);
      } else setError(pluginDialogError(reason));
      submitted.current = false;
      setSubmitting(false);
    }
  };
  return (
    <PluginDialog
      title={`审阅并信任「${review.config.label}」`}
      descriptionId={warningId}
      cancelRef={cancelRef}
      onCancel={onCancel}
      getFallbackFocus={getFallbackFocus}
      fixedContent={
        <p id={warningId} className="plugin-dialog-warning">
          信任并启用会启动这个本地程序，使用当前系统用户的普通进程权限。它能读写该用户可访问的文件并联网；这不是沙箱。
        </p>
      }
      actions={
        <>
          <button ref={cancelRef} type="button" onClick={onCancel}>
            取消
          </button>
          <button type="button" disabled={!canSubmit} onClick={() => void submit()}>
            信任并启用
          </button>
        </>
      }
    >
      <p>
        只信任你了解来源的启动配置。下面是 Server 返回的规范配置；确认后会信任并启用这个精确摘要。
      </p>
      <div className="plugin-review-identity">
        <dl>
          <div>
            <dt>ID</dt>
            <dd>{review.config.id}</dd>
          </div>
          <div>
            <dt>显示名称</dt>
            <dd>{review.config.label}</dd>
          </div>
          <div>
            <dt>传输</dt>
            <dd>stdio</dd>
          </div>
          <div>
            <dt>启动程序</dt>
            <dd>
              <code>{review.config.command}</code>
            </dd>
          </div>
          <div>
            <dt>工作目录</dt>
            <dd>
              <code>{review.config.cwd}</code>
            </dd>
          </div>
          <div>
            <dt>配置摘要</dt>
            <dd>
              <input aria-label="完整配置摘要" readOnly value={review.configDigest} />
            </dd>
          </div>
          <div>
            <dt>授权序号</dt>
            <dd>{review.authoritySequence}</dd>
          </div>
        </dl>
      </div>
      <section aria-label="启动参数">
        <h3>原样启动参数（按顺序）</h3>
        {review.config.args.length === 0 ? (
          <p>无参数</p>
        ) : (
          <ol className="mcp-argument-list">
            {review.config.args.map((arg, index) => (
              <li key={index}>
                <code>{JSON.stringify(arg)}</code>
              </li>
            ))}
          </ol>
        )}
      </section>
      <section aria-label="显式环境引用">
        <h3>显式环境引用</h3>
        {Object.keys(review.config.env).length === 0 ? (
          <p>无显式环境引用</p>
        ) : (
          <dl className="mcp-reference-list">
            {Object.entries(review.config.env).map(([target, reference]) => (
              <div key={target}>
                <dt>
                  <code>{target}</code>
                </dt>
                <dd>
                  ← <code>{reference.fromHostEnv}</code>
                </dd>
              </div>
            ))}
          </dl>
        )}
        <p className="plugin-dialog-note">
          这里只显示目标变量与宿主引用名，不显示凭据值。引用值在每次创建连接时读取，值轮换无需重新信任；引用名变化需要重新审阅。
        </p>
      </section>
      {review.reviewedConfig === undefined ? null : (
        <section className="plugin-review-differences" aria-label="配置差异">
          <h3>与上次审阅配置的差异</h3>
          {changes.length === 0 ? (
            <p>配置字段没有变化。历史审阅不代表当前仍受信任。</p>
          ) : (
            changes.map((change) => (
              <div key={change.field}>
                <h4>{fieldNames[change.field]}</h4>
                <p>上次审阅</p>
                <pre>{change.before}</pre>
                <p>当前配置</p>
                <pre>{change.after}</pre>
              </div>
            ))
          )}
          <p className="plugin-dialog-note">
            显示名称只是展示信息；启动字段决定信任摘要。回到旧配置也不会自动恢复信任。
          </p>
        </section>
      )}
      <section className="mcp-launch-details" aria-label="启动权限说明">
        <h3>启动与工具调用权限</h3>
        <p>
          信任覆盖规范程序路径、原样参数、工作目录和显式环境引用，不是代码签名，不能证明程序、脚本或依赖内容没有变化。
        </p>
        <p>
          即使没有显式环境引用，SDK 仍继承系统环境允许列表。显式引用之外的秘密不会由 Studio 读取。
        </p>
        <details>
          <summary>系统环境继承列表</summary>
          <p>POSIX：HOME、LOGNAME、PATH、SHELL、TERM、USER。</p>
          <p>
            Windows：APPDATA、COMSPEC、HOMEDRIVE、HOMEPATH、LOCALAPPDATA、PATH、PATHEXT、PROCESSOR_ARCHITECTURE、PROGRAMDATA、PROGRAMFILES、PROGRAMFILES(X86)、PROGRAMW6432、SYSTEMDRIVE、SYSTEMROOT、TEMP、USERNAME、USERPROFILE、WINDIR。
          </p>
        </details>
        <p>
          工具清单在启动后才会获取。工具描述、schema 和 annotations 是第三方声明，不能豁免权限。所有
          MCP 工具均视为高风险，ask/trust 模式逐次审批，yolo
          沿用现有策略。工具审批不会限制已经运行的程序权限。
        </p>
      </section>
      {error === undefined && !expired ? null : (
        <p role="alert" className="plugin-dialog-error">
          {expired ? staleMessage : error}
        </p>
      )}
    </PluginDialog>
  );
}
