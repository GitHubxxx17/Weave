/** A common Provider configuration that can be used to prefill the settings form. */
export type ProviderPreset = {
  readonly id: string;
  readonly label: string;
  readonly baseUrl: string;
  readonly models: readonly string[];
};

/**
 * Common OpenAI-compatible endpoints shown as form suggestions.
 *
 * The preset only fills public connection metadata. API keys are always entered
 * by the user and are handled by the existing Desktop secret-storage flow.
 */
export const providerPresets: readonly ProviderPreset[] = [
  {
    id: 'deepseek',
    label: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com',
    models: ['deepseek-flash', 'deepseek-v4-pro'],
  },
  {
    id: 'openai',
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    models: ['gpt-4o', 'gpt-4o-mini'],
  },
  {
    id: 'google',
    label: 'Google Gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    models: ['gemini-2.5-pro', 'gemini-2.5-flash'],
  },
  {
    id: 'moonshot',
    label: 'Moonshot',
    baseUrl: 'https://api.moonshot.cn/v1',
    models: ['kimi-k2', 'moonshot-v1-8k'],
  },
  {
    id: 'zhipu',
    label: '智谱 AI',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    models: ['glm-4.5', 'glm-4.5-air'],
  },
  {
    id: 'qwen',
    label: '通义千问',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    models: ['qwen-plus', 'qwen-turbo'],
  },
];

export const customProviderPresetId = 'custom';

export function findProviderPreset(providerId: string): ProviderPreset | undefined {
  return providerPresets.find((preset) => preset.id === providerId);
}

export function findModelPresetId(
  providerPreset: ProviderPreset | undefined,
  model: string,
): string {
  return providerPreset?.models.includes(model) === true ? model : customProviderPresetId;
}
