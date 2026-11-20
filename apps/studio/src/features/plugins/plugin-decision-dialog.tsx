import { useEffect, useRef, useState, type ReactElement } from 'react';

import { PluginDialog, pluginDialogError } from './plugin-dialog.js';
import type { PluginListItem } from './plugin-types.js';

export interface PluginDecisionDialogProps {
  readonly plugin: PluginListItem;
  readonly action: 'disable' | 'revoke';
  readonly hasRunningSessions: boolean;
  readonly busy: boolean;
  readonly onCancel: () => void;
  readonly onConfirm: (immediate: boolean) => Promise<void>;
  readonly getFallbackFocus: () => HTMLElement | null;
}

export function PluginDecisionDialog({
  plugin,
  action,
  hasRunningSessions,
  busy,
  onCancel,
  onConfirm,
  getFallbackFocus,
}: PluginDecisionDialogProps): ReactElement {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const submitted = useRef(false);
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  const [immediate, setImmediate] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | undefined>();
  useEffect(() => {
    setImmediate(false);
  }, [hasRunningSessions]);

  const isRevoke = action === 'revoke';
  const canSubmit = !busy && !submitting;
  const submit = async (): Promise<void> => {
    if (!canSubmit || submitted.current) return;
    submitted.current = true;
    const chosenImmediate = hasRunningSessions && immediate;
    setSubmitting(true);
    setError(undefined);
    try {
      await onConfirm(chosenImmediate);
      if (active.current) onCancel();
    } catch (reason: unknown) {
      if (!active.current) return;
      setError(pluginDialogError(reason));
      setSubmitting(false);
      submitted.current = false;
    }
  };

  return (
    <PluginDialog
      title={isRevoke ? `撤销「${plugin.name}」的信任？` : `停用「${plugin.name}」？`}
      cancelRef={cancelRef}
      onCancel={onCancel}
      getFallbackFocus={getFallbackFocus}
      actions={
        <>
          <button ref={cancelRef} type="button" onClick={onCancel}>
            取消
          </button>
          <button type="button" onClick={() => void submit()} disabled={!canSubmit}>
            {isRevoke ? '确认撤销信任' : '确认停用'}
          </button>
        </>
      }
    >
      <p>此操作将于下一回合起生效。</p>
      {hasRunningSessions ? (
        <label className="plugin-immediate-choice">
          <input
            type="checkbox"
            checked={immediate}
            onChange={(event) => setImmediate(event.target.checked)}
            disabled={!canSubmit}
          />
          立即生效（取消进行中的回合）
        </label>
      ) : null}
      {hasRunningSessions ? (
        <p className="plugin-dialog-note">立即生效会取消当前代和已退役代中的所有进行中回合。</p>
      ) : null}
      {error === undefined ? null : (
        <p role="alert" className="plugin-dialog-error">
          {error}
        </p>
      )}
    </PluginDialog>
  );
}
