import { Trash2, X } from 'lucide-react';
import type { ReactElement } from 'react';

import {
  customProviderPresetId,
  findProviderPreset,
  providerPresets,
} from '../features/providers/provider-presets.js';
import type { ProviderDescriptor } from '../features/providers/provider-types.js';
import { FormSelect } from './form-select.js';
import type { useProviderSettings } from './use-provider-settings.js';

type ProviderSettingsState = ReturnType<typeof useProviderSettings>;

export type ProviderFormDialogProps = Pick<
  ProviderSettingsState,
  | 'providerFormError'
  | 'providerMutation'
  | 'chooseProviderPreset'
  | 'chooseModelPreset'
  | 'closeProviderForm'
  | 'updateProviderForm'
  | 'saveProvider'
> & {
  readonly providerForm: NonNullable<ProviderSettingsState['providerForm']>;
};

/** Create or edit a Provider. */
export function ProviderFormDialog({
  providerForm,
  providerFormError,
  providerMutation,
  chooseProviderPreset,
  chooseModelPreset,
  closeProviderForm,
  updateProviderForm,
  saveProvider,
}: ProviderFormDialogProps): ReactElement {
  return (
    <div
      className="dialog-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          closeProviderForm();
        }
      }}
    >
      <section
        className="project-dialog provider-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="provider-dialog-title"
      >
        <header className="project-dialog-header">
          <div>
            <p>模型服务</p>
            <h2 id="provider-dialog-title">
              {providerForm.mode === 'create' ? '添加 AI 服务' : '编辑 Provider'}
            </h2>
          </div>
          <button
            className="icon-button"
            type="button"
            aria-label="关闭 Provider 表单"
            onClick={closeProviderForm}
            disabled={providerMutation === 'saving'}
          >
            <X aria-hidden="true" />
          </button>
        </header>
        <form className="project-dialog-form" onSubmit={(event) => void saveProvider(event)}>
          <label className="provider-form-field">
            <span>供应商</span>
            <FormSelect
              label="供应商"
              value={providerForm.providerPresetId}
              placeholder="选择常见供应商"
              options={[
                ...providerPresets.map((preset) => ({
                  value: preset.id,
                  label: preset.label,
                })),
                { value: customProviderPresetId, label: '自定义供应商' },
              ]}
              onChange={chooseProviderPreset}
            />
          </label>
          <div className="provider-form-grid">
            <label className="provider-form-field">
              <span>
                {providerForm.providerPresetId === customProviderPresetId
                  ? '自定义供应商名称'
                  : '显示名称'}
              </span>
              <input
                aria-label={
                  providerForm.providerPresetId === customProviderPresetId
                    ? '自定义供应商名称'
                    : '显示名称'
                }
                value={providerForm.label}
                onChange={(event) => updateProviderForm('label', event.target.value)}
                placeholder="例如 DeepSeek"
                autoFocus
              />
            </label>
            <label className="provider-form-field">
              <span>Provider ID</span>
              <input
                aria-label="Provider ID"
                value={providerForm.id}
                onChange={(event) => updateProviderForm('id', event.target.value)}
                placeholder="例如 deepseek"
                disabled={providerForm.mode === 'edit'}
              />
            </label>
          </div>
          <label className="provider-form-field">
            <span>API 地址</span>
            <input
              aria-label="API 地址"
              type="url"
              value={providerForm.baseUrl}
              onChange={(event) => updateProviderForm('baseUrl', event.target.value)}
              placeholder="https://api.deepseek.com"
            />
          </label>
          <label className="provider-form-field">
            <span>API Key</span>
            <input
              aria-label="API Key"
              type="password"
              value={providerForm.apiKey}
              onChange={(event) => updateProviderForm('apiKey', event.target.value)}
              placeholder={providerForm.mode === 'edit' ? '留空表示保持当前密钥' : '输入 API Key'}
              autoComplete="new-password"
            />
          </label>
          {findProviderPreset(providerForm.providerPresetId) !== undefined ? (
            <label className="provider-form-field">
              <span>默认模型</span>
              <FormSelect
                label="默认模型"
                value={providerForm.modelPresetId}
                placeholder="选择默认模型"
                options={[
                  ...(findProviderPreset(providerForm.providerPresetId)?.models ?? []).map(
                    (model) => ({
                      value: model,
                      label: model,
                    }),
                  ),
                  { value: customProviderPresetId, label: '自定义模型' },
                ]}
                onChange={chooseModelPreset}
              />
            </label>
          ) : null}
          {findProviderPreset(providerForm.providerPresetId) !== undefined &&
          providerForm.modelPresetId === customProviderPresetId ? (
            <label className="provider-form-field">
              <span>自定义模型</span>
              <input
                aria-label="自定义模型"
                value={providerForm.defaultModel}
                onChange={(event) => updateProviderForm('defaultModel', event.target.value)}
                placeholder="输入模型名称"
              />
            </label>
          ) : null}
          {findProviderPreset(providerForm.providerPresetId) === undefined ? (
            <label className="provider-form-field">
              <span>
                {providerForm.providerPresetId === customProviderPresetId
                  ? '自定义模型'
                  : '默认模型'}
              </span>
              <input
                aria-label={
                  providerForm.providerPresetId === customProviderPresetId
                    ? '自定义模型'
                    : '默认模型'
                }
                value={providerForm.defaultModel}
                onChange={(event) => updateProviderForm('defaultModel', event.target.value)}
                placeholder="例如 deepseek-flash"
              />
            </label>
          ) : null}
          <div className="provider-form-grid">
            <label className="provider-form-field">
              <span>Temperature（可选）</span>
              <input
                aria-label="Temperature"
                type="number"
                min={0}
                max={2}
                step={0.1}
                value={providerForm.temperature}
                onChange={(event) => updateProviderForm('temperature', event.target.value)}
                placeholder="默认 1.0"
              />
            </label>
            <label className="provider-form-field">
              <span>最大输出 token（可选）</span>
              <input
                aria-label="最大输出 token"
                type="number"
                min={1}
                step={1}
                value={providerForm.maxTokens}
                onChange={(event) => updateProviderForm('maxTokens', event.target.value)}
                placeholder="默认 4096"
              />
            </label>
          </div>
          <label className="provider-form-field">
            <span>上下文窗口 token（可选）</span>
            <input
              aria-label="上下文窗口 token"
              type="number"
              min={1}
              step={1}
              value={providerForm.contextWindowTokens}
              onChange={(event) => updateProviderForm('contextWindowTokens', event.target.value)}
              placeholder="默认 128000"
            />
          </label>
          <p className="project-dialog-note">
            留空即用默认：温度与最大输出跟随模型（常见 1.0 / 4096），上下文窗口为
            128000；设置后仅作用于该 Provider，对话未显式指定时才生效。
          </p>
          <label className="provider-checkbox-field">
            <input
              type="checkbox"
              checked={providerForm.makeDefault}
              onChange={(event) => updateProviderForm('makeDefault', event.target.checked)}
            />
            <span>设为默认 Provider</span>
          </label>
          {providerForm.mode === 'edit' ? (
            <label className="provider-checkbox-field provider-checkbox-danger">
              <input
                type="checkbox"
                checked={providerForm.clearApiKey}
                onChange={(event) => updateProviderForm('clearApiKey', event.target.checked)}
              />
              <span>清除当前密钥</span>
            </label>
          ) : null}
          {providerForm.mode === 'edit' ? (
            <p className="project-dialog-note">
              留空表示保持当前密钥，修改 API 地址时需要重新填写；清除密钥后 Provider
              将不能用于对话。
            </p>
          ) : null}
          {providerFormError !== null ? (
            <p className="provider-form-error" role="alert">
              {providerFormError}
            </p>
          ) : null}
          <footer className="project-dialog-actions">
            <button
              className="secondary-button"
              type="button"
              onClick={closeProviderForm}
              disabled={providerMutation === 'saving'}
            >
              取消
            </button>
            <button
              className="primary-button"
              type="submit"
              disabled={providerMutation === 'saving'}
            >
              {providerMutation === 'saving' ? '保存中...' : '保存 Provider'}
            </button>
          </footer>
        </form>
      </section>
    </div>
  );
}

export type ProviderDeleteDialogProps = Pick<
  ProviderSettingsState,
  'providerMutation' | 'deleteProvider'
> & {
  readonly providerToDelete: ProviderDescriptor;
  readonly setProviderToDelete: (provider: null) => void;
};

/** Confirms removing a Provider and its stored key. */
export function ProviderDeleteDialog({
  providerToDelete,
  providerMutation,
  deleteProvider,
  setProviderToDelete,
}: ProviderDeleteDialogProps): ReactElement {
  return (
    <div
      className="dialog-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          setProviderToDelete(null);
        }
      }}
    >
      <section
        className="project-dialog session-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="delete-provider-dialog-title"
      >
        <header className="project-dialog-header">
          <div>
            <p>删除确认</p>
            <h2 id="delete-provider-dialog-title">删除 Provider</h2>
          </div>
          <button
            className="icon-button"
            type="button"
            aria-label="关闭删除确认"
            onClick={() => setProviderToDelete(null)}
            disabled={providerMutation === 'deleting'}
          >
            <X aria-hidden="true" />
          </button>
        </header>
        <div className="project-dialog-form">
          <p className="delete-session-warning">
            确定删除「{providerToDelete.label}」吗？已保存的密钥和配置会从本机移除。
          </p>
          <footer className="project-dialog-actions">
            <button
              className="secondary-button"
              type="button"
              onClick={() => setProviderToDelete(null)}
              disabled={providerMutation === 'deleting'}
            >
              取消
            </button>
            <button
              className="danger-button"
              type="button"
              onClick={() => void deleteProvider()}
              disabled={providerMutation === 'deleting'}
            >
              <Trash2 aria-hidden="true" />
              {providerMutation === 'deleting' ? '删除中...' : '确认删除'}
            </button>
          </footer>
        </div>
      </section>
    </div>
  );
}
