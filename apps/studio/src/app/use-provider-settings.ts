import { useEffect, useState, type FormEvent } from 'react';

import { createProviderApi, ProviderApiError } from '../features/providers/provider-api.js';
import {
  customProviderPresetId,
  findModelPresetId,
  findProviderPreset,
} from '../features/providers/provider-presets.js';
import type { ProviderDescriptor, ProviderSettings } from '../features/providers/provider-types.js';
import { fallbackProviderSettings } from './app-constants.js';
import {
  readReasoningEffort,
  reasoningEffortSchema,
  writeReasoningEffort,
} from './composer-preferences.js';
import type { ProviderFormState } from './app-types.js';
import { parseProviderNumberField } from './form-select.js';

const providerApi = createProviderApi();

export type ProviderMutation = 'idle' | 'saving' | 'deleting' | 'defaulting';

export type UseProviderSettingsOptions = {
  /** Shows (or clears with `null`) the App-level notice banner. */
  readonly onNotice: (message: string | null) => void;
};

/** Maps a Provider API failure to the message shown in the form or the notice banner. */
export function providerErrorMessage(error: unknown): string {
  if (!(error instanceof ProviderApiError)) {
    return 'Provider 配置暂时不可用，请稍后重试';
  }
  switch (error.code) {
    case 'provider-settings-secret-unavailable':
      return '系统密钥存储不可用，请在桌面端重试';
    case 'provider-settings-duplicate':
      return 'Provider ID 已存在，请换一个 ID';
    case 'provider-settings-protected':
      return '这个 Provider 由系统或插件管理，不能从此处修改';
    case 'provider-settings-provider-invalid':
      return 'Provider 客户端创建失败，请检查地址和配置';
    case 'provider-settings-api-key-required':
      return '修改了 API 地址，请重新填写 API Key';
    case 'provider-api-network':
      return '无法连接到本地服务，请确认后端已经启动';
    default:
      return error.message;
  }
}

/**
 * Owns the Provider list, the selected Provider/model/reasoning effort for new runs,
 * and the add/edit/delete Provider form state. Loads the list once on mount.
 */
export function useProviderSettings({ onNotice }: UseProviderSettingsOptions) {
  const [reasoningOverrides, setReasoningOverrides] = useState<Readonly<Record<string, string>>>(
    {},
  );
  const [providerSettings, setProviderSettings] =
    useState<ProviderSettings>(fallbackProviderSettings);
  const [selectedProviderId, setSelectedProviderId] = useState(
    fallbackProviderSettings.defaultProvider,
  );
  const [selectedModel, setSelectedModel] = useState(
    fallbackProviderSettings.providers[0]?.defaultModel ?? '',
  );
  const [providerForm, setProviderForm] = useState<ProviderFormState | null>(null);
  const [providerFormError, setProviderFormError] = useState<string | null>(null);
  const [providerMutation, setProviderMutation] = useState<ProviderMutation>('idle');
  const [providerToDelete, setProviderToDelete] = useState<ProviderDescriptor | null>(null);

  const selectedProvider =
    providerSettings.providers.find((provider) => provider.id === selectedProviderId) ??
    providerSettings.providers[0];

  const reasoningKey = `${selectedProviderId}\u0000${selectedModel}`;
  const reasoningEffort =
    reasoningOverrides[reasoningKey] ?? readReasoningEffort(selectedProviderId, selectedModel);

  /** Remembers the effort for one Provider + model, whether or not it is selected now. */
  function setReasoningEffortFor(provider: string, model: string, value: string): void {
    const parsed = reasoningEffortSchema.safeParse(value);
    if (!parsed.success) return;
    writeReasoningEffort(provider, model, parsed.data);
    setReasoningOverrides((current) => ({
      ...current,
      [`${provider}\u0000${model}`]: parsed.data,
    }));
  }
  function setReasoningEffort(value: string): void {
    setReasoningEffortFor(selectedProviderId, selectedModel, value);
  }

  function applyProviderSettings(settings: ProviderSettings): void {
    setProviderSettings(settings);
    const nextProvider =
      settings.providers.find((provider) => provider.id === selectedProviderId) ??
      settings.providers.find((provider) => provider.id === settings.defaultProvider) ??
      settings.providers[0];
    if (nextProvider !== undefined) {
      setSelectedProviderId(nextProvider.id);
      setSelectedModel(nextProvider.defaultModel ?? '');
    }
  }

  async function refreshProviderSettings(): Promise<ProviderSettings> {
    const settings = await providerApi.listProviders();
    applyProviderSettings(settings);
    return settings;
  }

  useEffect(() => {
    let disposed = false;

    async function loadProviders(): Promise<void> {
      try {
        const settings = await providerApi.listProviders();
        if (disposed || settings.providers.length === 0) {
          return;
        }

        const [firstProvider] = settings.providers;
        const defaultProvider =
          settings.providers.find((provider) => provider.id === settings.defaultProvider) ??
          firstProvider;
        if (defaultProvider === undefined) {
          return;
        }
        setProviderSettings(settings);
        setSelectedProviderId(defaultProvider.id);
        setSelectedModel(defaultProvider.defaultModel ?? '');
      } catch (error: unknown) {
        if (!disposed) {
          onNotice(
            error instanceof ProviderApiError && error.code === 'provider-api-network'
              ? '无法连接到本地服务，当前使用本地模型'
              : 'Provider 配置加载失败，当前使用本地模型',
          );
        }
      }
    }

    void loadProviders();
    return () => {
      disposed = true;
    };
    // The list loads once on mount; `onNotice` is the stable notice setter.
  }, []);

  function openProviderForm(provider?: ProviderDescriptor): void {
    setProviderFormError(null);
    const providerPreset = provider === undefined ? undefined : findProviderPreset(provider.id);
    setProviderForm(
      provider === undefined
        ? {
            mode: 'create',
            editingId: null,
            providerPresetId: '',
            modelPresetId: customProviderPresetId,
            id: '',
            label: '',
            baseUrl: '',
            apiKey: '',
            defaultModel: '',
            makeDefault: providerSettings.providers.length === 0,
            clearApiKey: false,
            contextWindowTokens: '',
            temperature: '',
            maxTokens: '',
          }
        : {
            mode: 'edit',
            editingId: provider.id,
            providerPresetId: providerPreset?.id ?? customProviderPresetId,
            modelPresetId: findModelPresetId(providerPreset, provider.defaultModel ?? ''),
            id: provider.id,
            label: provider.label,
            baseUrl: provider.baseUrl ?? '',
            apiKey: '',
            defaultModel: provider.defaultModel ?? '',
            makeDefault: provider.id === providerSettings.defaultProvider,
            clearApiKey: false,
            contextWindowTokens:
              provider.contextWindowTokens === undefined
                ? ''
                : String(provider.contextWindowTokens),
            temperature: provider.temperature === undefined ? '' : String(provider.temperature),
            maxTokens: provider.maxTokens === undefined ? '' : String(provider.maxTokens),
          },
    );
  }

  function closeProviderForm(): void {
    if (providerMutation === 'saving') {
      return;
    }
    setProviderForm(null);
    setProviderFormError(null);
  }

  function updateProviderForm<K extends keyof ProviderFormState>(
    key: K,
    value: ProviderFormState[K],
  ): void {
    setProviderForm((current) => (current === null ? current : { ...current, [key]: value }));
  }

  function chooseProviderPreset(presetId: string): void {
    setProviderForm((current) => {
      if (current === null) {
        return current;
      }

      if (presetId === customProviderPresetId) {
        return {
          ...current,
          providerPresetId: customProviderPresetId,
          modelPresetId: customProviderPresetId,
          id: current.mode === 'create' ? '' : current.id,
          label: current.mode === 'create' ? '' : current.label,
          baseUrl: current.mode === 'create' ? '' : current.baseUrl,
          defaultModel: current.mode === 'create' ? '' : current.defaultModel,
        };
      }

      const preset = findProviderPreset(presetId);
      if (preset === undefined) {
        return current;
      }

      return {
        ...current,
        providerPresetId: preset.id,
        modelPresetId: preset.models[0] ?? customProviderPresetId,
        id: current.mode === 'create' ? preset.id : current.id,
        label: preset.label,
        baseUrl: preset.baseUrl,
        defaultModel: preset.models[0] ?? '',
      };
    });
  }

  function chooseModelPreset(modelPresetId: string): void {
    setProviderForm((current) => {
      if (current === null) {
        return current;
      }

      return {
        ...current,
        modelPresetId,
        defaultModel: modelPresetId === customProviderPresetId ? '' : modelPresetId,
      };
    });
  }

  async function saveProvider(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const form = providerForm;
    if (form === null) {
      return;
    }
    if (
      form.id.trim() === '' ||
      form.label.trim() === '' ||
      form.baseUrl.trim() === '' ||
      form.defaultModel.trim() === '' ||
      (form.mode === 'create' && form.apiKey.trim() === '')
    ) {
      setProviderFormError('请填写完整的 Provider 信息');
      return;
    }

    const temperature = parseProviderNumberField(form.temperature, 'temperature');
    const maxTokens = parseProviderNumberField(form.maxTokens, 'positiveInt');
    const contextWindowTokens = parseProviderNumberField(form.contextWindowTokens, 'positiveInt');
    if (!temperature.ok || !maxTokens.ok || !contextWindowTokens.ok) {
      setProviderFormError('采样参数格式不对：温度 0–2，最大输出 token 与上下文窗口须为正整数');
      return;
    }

    setProviderMutation('saving');
    setProviderFormError(null);
    try {
      if (form.mode === 'create') {
        await providerApi.createProvider({
          id: form.id.trim(),
          label: form.label.trim(),
          type: 'openai-compatible',
          baseUrl: form.baseUrl.trim(),
          apiKey: form.apiKey,
          defaultModel: form.defaultModel.trim(),
          makeDefault: form.makeDefault,
          ...(contextWindowTokens.value === undefined
            ? {}
            : { contextWindowTokens: contextWindowTokens.value }),
          ...(temperature.value === undefined ? {} : { temperature: temperature.value }),
          ...(maxTokens.value === undefined ? {} : { maxTokens: maxTokens.value }),
        });
      } else if (form.editingId !== null) {
        await providerApi.updateProvider(form.editingId, {
          label: form.label.trim(),
          baseUrl: form.baseUrl.trim(),
          apiKey: form.apiKey,
          defaultModel: form.defaultModel.trim(),
          makeDefault: form.makeDefault,
          contextWindowTokens: contextWindowTokens.value ?? null,
          temperature: temperature.value ?? null,
          maxTokens: maxTokens.value ?? null,
          ...(form.clearApiKey ? { clearApiKey: true } : {}),
        });
      }
      await refreshProviderSettings();
      setProviderForm(null);
      onNotice('Provider 已保存');
    } catch (error: unknown) {
      setProviderFormError(providerErrorMessage(error));
    } finally {
      setProviderMutation('idle');
    }
  }

  async function setDefaultProvider(providerId: string): Promise<void> {
    setProviderMutation('defaulting');
    onNotice(null);
    try {
      const settings = await providerApi.setDefaultProvider(providerId);
      applyProviderSettings(settings);
      onNotice('默认 Provider 已更新');
    } catch (error: unknown) {
      onNotice(providerErrorMessage(error));
    } finally {
      setProviderMutation('idle');
    }
  }

  async function deleteProvider(): Promise<void> {
    const provider = providerToDelete;
    if (provider === null) {
      return;
    }
    setProviderMutation('deleting');
    try {
      await providerApi.deleteProvider(provider.id);
      await refreshProviderSettings();
      setProviderToDelete(null);
      onNotice('Provider 已删除');
    } catch (error: unknown) {
      onNotice(providerErrorMessage(error));
    } finally {
      setProviderMutation('idle');
    }
  }

  return {
    providerSettings,
    selectedProviderId,
    setSelectedProviderId,
    selectedModel,
    setSelectedModel,
    selectedProvider,
    reasoningEffort,
    setReasoningEffort,
    setReasoningEffortFor,
    providerForm,
    providerFormError,
    providerMutation,
    providerToDelete,
    setProviderToDelete,
    openProviderForm,
    closeProviderForm,
    updateProviderForm,
    chooseProviderPreset,
    chooseModelPreset,
    saveProvider,
    setDefaultProvider,
    deleteProvider,
  };
}
