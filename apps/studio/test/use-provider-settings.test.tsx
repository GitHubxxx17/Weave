// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { FormEvent } from 'react';

import { ProviderApiError } from '../src/features/providers/provider-api.js';
import type { ProviderSettings } from '../src/features/providers/provider-types.js';
import { useProviderSettings } from '../src/app/use-provider-settings.js';

const api = vi.hoisted(() => ({
  listProviders: vi.fn(),
  createProvider: vi.fn(),
  updateProvider: vi.fn(),
  deleteProvider: vi.fn(),
  setDefaultProvider: vi.fn(),
}));

vi.mock('../src/features/providers/provider-api.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/features/providers/provider-api.js')>()),
  createProviderApi: () => api,
}));

const deepseek = {
  id: 'deepseek',
  label: 'DeepSeek',
  type: 'openai-compatible' as const,
  baseUrl: 'https://api.deepseek.com',
  defaultModel: 'deepseek-chat',
  hasApiKey: true,
  editable: true,
};
const mock = {
  id: 'mock',
  label: '本地模型',
  type: 'mock' as const,
  defaultModel: 'weave-local-demo',
  hasApiKey: false,
  editable: false,
};
const settings = (defaultProvider: string): ProviderSettings => ({
  providers: [mock, deepseek],
  defaultProvider,
  canManage: true,
});
const submitEvent = { preventDefault: vi.fn() } as unknown as FormEvent<HTMLFormElement>;

beforeEach(() => {
  api.listProviders.mockResolvedValue(settings('deepseek'));
});

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

it('starts on the local model and selects the default Provider once the list loads', async () => {
  const onNotice = vi.fn();
  const { result } = renderHook(() => useProviderSettings({ onNotice }));
  expect(result.current.selectedProviderId).toBe('mock');
  expect(result.current.selectedModel).toBe('weave-local-demo');

  await waitFor(() => expect(result.current.selectedProviderId).toBe('deepseek'));
  expect(result.current.selectedModel).toBe('deepseek-chat');
  expect(result.current.selectedProvider?.label).toBe('DeepSeek');
  expect(onNotice).not.toHaveBeenCalled();
});

it('keeps the local model and reports a notice when the list cannot load', async () => {
  api.listProviders.mockRejectedValue(new ProviderApiError('provider-api-network', 'x', 0));
  const onNotice = vi.fn();
  const { result } = renderHook(() => useProviderSettings({ onNotice }));

  await waitFor(() =>
    expect(onNotice).toHaveBeenCalledWith('无法连接到本地服务，当前使用本地模型'),
  );
  expect(result.current.selectedProviderId).toBe('mock');
});

it('opens a create form, applies a preset and validates required fields', async () => {
  const { result } = renderHook(() => useProviderSettings({ onNotice: vi.fn() }));
  await waitFor(() => expect(result.current.selectedProviderId).toBe('deepseek'));

  act(() => result.current.openProviderForm());
  expect(result.current.providerForm?.mode).toBe('create');
  expect(result.current.providerForm?.makeDefault).toBe(false);

  await act(async () => {
    await result.current.saveProvider(submitEvent);
  });
  expect(result.current.providerFormError).toBe('请填写完整的 Provider 信息');
  expect(api.createProvider).not.toHaveBeenCalled();

  act(() => result.current.chooseProviderPreset('deepseek'));
  expect(result.current.providerForm?.id).toBe('deepseek');
  expect(result.current.providerForm?.baseUrl).not.toBe('');
});

it('saves a Provider, refreshes the list, closes the form and reports a notice', async () => {
  const onNotice = vi.fn();
  const { result } = renderHook(() => useProviderSettings({ onNotice }));
  await waitFor(() => expect(result.current.selectedProviderId).toBe('deepseek'));
  api.createProvider.mockResolvedValue(deepseek);

  act(() => result.current.openProviderForm());
  act(() => {
    result.current.updateProviderForm('id', 'other');
    result.current.updateProviderForm('label', 'Other');
    result.current.updateProviderForm('baseUrl', 'https://example.com');
    result.current.updateProviderForm('apiKey', 'secret');
    result.current.updateProviderForm('defaultModel', 'm1');
  });
  await act(async () => {
    await result.current.saveProvider(submitEvent);
  });

  expect(api.createProvider).toHaveBeenCalledWith(
    expect.objectContaining({ id: 'other', label: 'Other', defaultModel: 'm1', apiKey: 'secret' }),
  );
  expect(result.current.providerForm).toBeNull();
  expect(result.current.providerMutation).toBe('idle');
  expect(onNotice).toHaveBeenCalledWith('Provider 已保存');
});

it('rejects out-of-range sampling values before calling the API', async () => {
  const { result } = renderHook(() => useProviderSettings({ onNotice: vi.fn() }));
  await waitFor(() => expect(result.current.selectedProviderId).toBe('deepseek'));

  act(() => result.current.openProviderForm(deepseek));
  act(() => result.current.updateProviderForm('temperature', '3'));
  await act(async () => {
    await result.current.saveProvider(submitEvent);
  });

  expect(result.current.providerFormError).toContain('采样参数格式不对');
  expect(api.updateProvider).not.toHaveBeenCalled();
});

it('maps API failures to the form error and keeps the form open', async () => {
  const { result } = renderHook(() => useProviderSettings({ onNotice: vi.fn() }));
  await waitFor(() => expect(result.current.selectedProviderId).toBe('deepseek'));
  api.updateProvider.mockRejectedValue(
    new ProviderApiError('provider-settings-duplicate', 'x', 409),
  );

  act(() => result.current.openProviderForm(deepseek));
  await act(async () => {
    await result.current.saveProvider(submitEvent);
  });

  expect(result.current.providerFormError).toBe('Provider ID 已存在，请换一个 ID');
  expect(result.current.providerForm).not.toBeNull();
  expect(result.current.providerMutation).toBe('idle');
});

it('switches the selected Provider when the default changes and clears it on delete', async () => {
  const onNotice = vi.fn();
  const { result } = renderHook(() => useProviderSettings({ onNotice }));
  await waitFor(() => expect(result.current.selectedProviderId).toBe('deepseek'));

  api.setDefaultProvider.mockResolvedValue(settings('mock'));
  await act(async () => {
    await result.current.setDefaultProvider('mock');
  });
  expect(onNotice).toHaveBeenCalledWith('默认 Provider 已更新');
  expect(result.current.providerSettings.defaultProvider).toBe('mock');
  // The current selection survives while it still exists.
  expect(result.current.selectedProviderId).toBe('deepseek');

  api.deleteProvider.mockResolvedValue(undefined);
  api.listProviders.mockResolvedValue({ ...settings('mock'), providers: [mock] });
  act(() => result.current.setProviderToDelete(deepseek));
  await act(async () => {
    await result.current.deleteProvider();
  });
  expect(api.deleteProvider).toHaveBeenCalledWith('deepseek');
  expect(result.current.providerToDelete).toBeNull();
  expect(result.current.selectedProviderId).toBe('mock');
  expect(onNotice).toHaveBeenCalledWith('Provider 已删除');
});
