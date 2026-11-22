import { useEffect, useId, useRef, useState, type ReactElement } from 'react';
import type {
  ComposerDraftController,
  ComposerOwner,
  PreparedInsertion,
} from '../composer/use-composer-draft.js';
import { preparePanelCommand } from './plugin-panel-api.js';
import type { PanelBlock, PluginPanelDescriptor } from './plugin-panel-types.js';
import { samePanelAuthority, type PanelAuthority } from './use-plugin-panel-data.js';
type Form = Extract<PanelBlock, { type: 'form' }>;
export function PluginPanelForm({
  form,
  descriptor,
  authority,
  owner,
  visible,
  composer,
  onUnavailable,
}: {
  readonly form: Form;
  readonly descriptor: PluginPanelDescriptor;
  readonly authority: PanelAuthority;
  readonly owner: ComposerOwner;
  readonly visible: boolean;
  readonly composer: ComposerDraftController;
  readonly onUnavailable?: () => void;
}): ReactElement {
  const id = useId();
  const [values, setValues] = useState<Record<string, string | boolean>>(() =>
    Object.fromEntries(
      form.fields.map((f) => [
        f.id,
        f.type === 'boolean' ? (f.default ?? false) : (f.default ?? ''),
      ]),
    ),
  );
  const [status, setStatus] = useState('');
  const [pending, setPending] = useState<PreparedInsertion | null>(null);
  const request = useRef<AbortController | null>(null);
  const latest = useRef({ visible, owner, descriptor, authority });
  latest.current = { visible, owner, descriptor, authority };
  useEffect(() => () => request.current?.abort(), []);
  async function prepare(): Promise<void> {
    if (!visible || owner.sessionId === '' || descriptor.state !== 'available') return;
    for (const f of form.fields) {
      const v = values[f.id];
      if (
        (f.type === 'text' && f.required && (typeof v !== 'string' || v.trim() === '')) ||
        (f.type === 'select' && f.required && v === '')
      ) {
        setStatus('请填写必填字段');
        return;
      }
      if (f.type === 'select' && v !== '' && !f.options.some((o) => o.value === v)) {
        setStatus('请选择有效选项');
        return;
      }
    }
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    const requestEpoch = composer.beginPrepare(form.id);
    const insertion: PreparedInsertion = {
      ...authority,
      owner,
      panelRef: descriptor.panelRef,
      formId: form.id,
      requestEpoch,
      text: '',
    };
    const valid = () =>
      !controller.signal.aborted && latest.current.visible && composer.isPreparedCurrent(insertion);
    setPending(insertion);
    setStatus('');
    try {
      if (!valid()) return;
      const result = await preparePanelCommand(
        owner.sessionId,
        descriptor.panelRef,
        { formId: form.id, values },
        controller.signal,
      );
      if (!valid()) return;
      if (
        !samePanelAuthority(result, authority) ||
        result.panelId !== descriptor.panelId ||
        result.panelRef !== descriptor.panelRef ||
        result.sessionId !== owner.sessionId ||
        result.formId !== form.id ||
        result.command !== form.submit.command
      )
        throw new Error('invalid');
      if (composer.insertPrepared({ ...insertion, text: result.text }) === 'inserted')
        setStatus('已准备文本，请检查并点击发送');
    } catch (error) {
      if (
        valid() &&
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        ['panel-stale', 'panel-unavailable', 'panel-not-found'].includes(String(error.code))
      ) {
        composer.invalidatePanel();
        onUnavailable?.();
      } else if (valid()) setStatus('无法准备文本，请重试');
    } finally {
      if (
        request.current === controller &&
        !controller.signal.aborted &&
        composer.isRequestCurrent(insertion)
      )
        setPending(null);
    }
  }
  return (
    <form
      className="plugin-panel-form"
      onSubmit={(e) => {
        e.preventDefault();
        void prepare();
      }}
    >
      <fieldset
        disabled={
          !visible ||
          owner.sessionId === '' ||
          descriptor.state !== 'available' ||
          (pending !== null && composer.isPreparedCurrent(pending))
        }
      >
        {form.fields.map((field) => (
          <label key={field.id} htmlFor={`${id}-${field.id}`}>
            {field.label}
            {field.type === 'boolean' ? (
              <input
                id={`${id}-${field.id}`}
                type="checkbox"
                checked={values[field.id] === true}
                onChange={(e) => setValues((v) => ({ ...v, [field.id]: e.target.checked }))}
              />
            ) : field.type === 'select' ? (
              <select
                id={`${id}-${field.id}`}
                required={field.required}
                value={String(values[field.id] ?? '')}
                onChange={(e) => setValues((v) => ({ ...v, [field.id]: e.target.value }))}
              >
                <option value="">请选择</option>
                {field.options.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            ) : (
              <input
                id={`${id}-${field.id}`}
                type="text"
                maxLength={2048}
                required={field.required}
                value={String(values[field.id] ?? '')}
                onChange={(e) => setValues((v) => ({ ...v, [field.id]: e.target.value }))}
              />
            )}
          </label>
        ))}
        <button type="submit">{form.submit.label}</button>
      </fieldset>
      {status ? <p role="status">{status}</p> : null}
      {owner.sessionId === '' ? <p>请先创建会话以准备文本</p> : null}
    </form>
  );
}
