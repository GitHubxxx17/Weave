import { Bot, Check, Pencil, Plus, Trash2 } from 'lucide-react';
import type { ReactElement } from 'react';

import type { ProviderDescriptor } from '../features/providers/provider-types.js';
import type { useProviderSettings } from './use-provider-settings.js';

type ProviderSettingsState = ReturnType<typeof useProviderSettings>;

export type ProviderSettingsViewProps = {
  readonly providerSettings: ProviderSettingsState['providerSettings'];
  readonly providerMutation: ProviderSettingsState['providerMutation'];
  readonly openProviderForm: (provider?: ProviderDescriptor) => void;
  readonly setDefaultProvider: (providerId: string) => Promise<void>;
  readonly setProviderToDelete: (provider: ProviderDescriptor) => void;
};

/** The "模型服务" settings page: configured Providers and their actions. */
export function ProviderSettingsView({
  providerSettings,
  providerMutation,
  openProviderForm,
  setDefaultProvider,
  setProviderToDelete,
}: ProviderSettingsViewProps): ReactElement {
  return (
    <div className="provider-settings-view">
      <div className="product-view-heading provider-settings-heading">
        <div>
          <p>配置</p>
          <h2>模型服务</h2>
          <span>管理 Weave 使用的 AI 服务和默认模型。</span>
        </div>
        {providerSettings.canManage ? (
          <button
            className="primary-button"
            type="button"
            onClick={() => openProviderForm()}
            disabled={providerMutation !== 'idle'}
          >
            <Plus aria-hidden="true" />
            添加 AI 服务
          </button>
        ) : null}
      </div>
      <div className="provider-settings-section-heading">
        <div>
          <h3>已配置的服务</h3>
          <span>{providerSettings.providers.length} 个服务</span>
        </div>
        <span className="provider-settings-section-status">
          <span className="connection-dot" aria-hidden="true" />
          本地配置
        </span>
      </div>
      <div className="provider-settings-list" aria-label="Provider 列表">
        {providerSettings.providers.map((provider) => (
          <article
            className={`provider-settings-item${provider.id === providerSettings.defaultProvider ? ' provider-settings-item-default' : ''}`}
            key={provider.id}
          >
            <div className="provider-settings-main">
              <div className="provider-settings-icon" aria-hidden="true">
                <Bot />
              </div>
              <div className="provider-settings-copy">
                <strong>{provider.label}</strong>
                <span>{provider.id}</span>
              </div>
            </div>
            <div className="provider-settings-details">
              <div className="provider-detail-row">
                <span>模型</span>
                <strong>{provider.defaultModel ?? '未设置默认模型'}</strong>
              </div>
              <div className="provider-detail-row">
                <span>接口</span>
                <strong>{provider.baseUrl ?? '本地运行时'}</strong>
              </div>
            </div>
            <div className="provider-settings-side">
              <div className="provider-settings-status">
                <span
                  className={
                    provider.hasApiKey ? 'provider-status-ready' : 'provider-status-warning'
                  }
                >
                  <span className="provider-status-dot" aria-hidden="true" />
                  {provider.hasApiKey ? '可用' : '需要配置 API Key'}
                </span>
                {provider.id === providerSettings.defaultProvider ? (
                  <span className="provider-default-mark">
                    <Check aria-hidden="true" />
                    默认
                  </span>
                ) : null}
              </div>
              {providerSettings.canManage && provider.editable ? (
                <div className="provider-settings-actions">
                  {provider.id !== providerSettings.defaultProvider ? (
                    <button
                      className="provider-action-button"
                      type="button"
                      onClick={() => void setDefaultProvider(provider.id)}
                      disabled={providerMutation !== 'idle' || !provider.hasApiKey}
                    >
                      设为默认
                    </button>
                  ) : null}
                  <button
                    className="provider-action-button"
                    type="button"
                    aria-label={`编辑 Provider ${provider.label}`}
                    onClick={() => openProviderForm(provider)}
                    disabled={providerMutation !== 'idle'}
                  >
                    <Pencil aria-hidden="true" />
                    编辑
                  </button>
                  <button
                    className="provider-action-button provider-action-button-danger"
                    type="button"
                    aria-label={`删除 Provider ${provider.label}`}
                    onClick={() => setProviderToDelete(provider)}
                    disabled={providerMutation !== 'idle'}
                  >
                    <Trash2 aria-hidden="true" />
                    删除
                  </button>
                </div>
              ) : null}
            </div>
          </article>
        ))}
      </div>
      <p className="provider-settings-note">
        {providerSettings.canManage
          ? 'API Key 只保存在本机的系统密钥存储中，页面不会回显已保存的密钥。'
          : '浏览器开发模式下，Provider 通过 .env 只读配置；需要管理 API Key 时请使用 Desktop。'}
      </p>
    </div>
  );
}
