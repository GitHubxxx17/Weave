import { useEffect, useRef, useState, type ReactElement } from 'react';

import { PluginDialog, pluginDialogError } from '../plugins/plugin-dialog.js';
import { McpApiError } from './mcp-api.js';
import type { McpServerRecord } from './mcp-types.js';

import './mcp-dialog.css';

export interface McpDecisionDialogProps {
  readonly server: McpServerRecord;
  readonly action: 'disable' | 'revoke' | 'remove';
  readonly expectedSequence: number;
  readonly busy: boolean;
  readonly stale: boolean;
  readonly hasRunningSessions: boolean;
  readonly onConfirm: (immediate: boolean) => Promise<void>;
  readonly onCancel: () => void;
  readonly getFallbackFocus: () => HTMLElement | null;
}

const decisions = {
  disable: {
    title: '停用',
    button: '确认停用',
    effect:
      '停用会保留当前配置的信任，后续新回合使用不包含此服务的新一代。再次启用无需重新信任相同摘要。',
  },
  revoke: {
    title: '撤销信任',
    button: '确认撤销信任',
    effect: '撤销会清除启动信任并停用服务。再次启动需要重新审阅并信任当前配置。',
  },
  remove: {
    title: '移除',
    button: '确认移除',
    effect: '移除会删除常规服务配置并清除信任，保留授权历史。旧回合持有的连接会在回合结束后释放。',
  },
} as const;
const staleMessage = '配置或授权已变化，本次决定已失效。请关闭后重新确认。';

export function McpDecisionDialog({
  server,
  action,
  expectedSequence,
  busy,
  stale,
  hasRunningSessions,
  onConfirm,
  onCancel,
  getFallbackFocus,
}: McpDecisionDialogProps): ReactElement {
  const [captured] = useState(() => ({ label: server.config.label, action, expectedSequence }));
  const decision = decisions[captured.action];
  const cancelRef = useRef<HTMLButtonElement>(null);
  const submitted = useRef(false);
  const active = useRef(true);
  const [immediate, setImmediate] = useState(false);
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
  const submit = async (): Promise<void> => {
    if (!canSubmit || submitted.current) return;
    submitted.current = true;
    setSubmitting(true);
    setError(undefined);
    try {
      await onConfirm(immediate);
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
      title={`${decision.title}「${captured.label}」？`}
      cancelRef={cancelRef}
      onCancel={onCancel}
      getFallbackFocus={getFallbackFocus}
      actions={
        <>
          <button ref={cancelRef} type="button" onClick={onCancel}>
            取消
          </button>
          <button type="button" disabled={!canSubmit} onClick={() => void submit()}>
            {decision.button}
          </button>
        </>
      }
    >
      <p>{decision.effect}</p>
      <p>默认从下一回合起生效，已固定在旧代的回合可以继续使用原连接。</p>
      <p className="plugin-dialog-note">本次授权序号：{captured.expectedSequence}</p>
      <label className="plugin-immediate-choice">
        <input
          type="checkbox"
          checked={immediate}
          disabled={!canSubmit}
          onChange={(event) => setImmediate(event.target.checked)}
        />
        立即生效（取消所有进行中的回合）
      </label>
      <p className="plugin-dialog-note">
        立即生效会取消 Server
        中所有会话在当前代和已退役代进行中的回合，不限于此服务或当前界面可见的会话。
      </p>
      {hasRunningSessions ? (
        <p className="plugin-dialog-warning">当前界面已知有回合正在运行，立即生效会中断它们。</p>
      ) : null}
      {error === undefined && !expired ? null : (
        <p role="alert" className="plugin-dialog-error">
          {expired ? staleMessage : error}
        </p>
      )}
    </PluginDialog>
  );
}
