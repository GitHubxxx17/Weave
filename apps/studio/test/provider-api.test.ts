// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createProviderApi, ProviderApiError } from '../src/features/providers/provider-api.js';

describe('Provider API client', () => {
  const fetchMock = vi.fn();
  const publicDeepSeek = {
    id: 'deepseek',
    label: 'DeepSeek',
    type: 'openai-compatible' as const,
    baseUrl: 'https://api.deepseek.com',
    defaultModel: 'deepseek-chat',
    hasApiKey: true,
    editable: true,
  };
  const validInput = {
    id: 'deepseek',
    label: 'DeepSeek',
    type: 'openai-compatible' as const,
    baseUrl: 'https://api.deepseek.com',
    apiKey: 'deepseek-secret',
    defaultModel: 'deepseek-chat',
    makeDefault: true,
  };

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    delete window.weaveDesktop;
    vi.restoreAllMocks();
    fetchMock.mockReset();
  });

  it('validates public Provider metadata with Zod', async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          providers: [
            {
              id: 'deepseek',
              label: 'DeepSeek',
              type: 'openai-compatible',
              baseUrl: 'https://api.deepseek.com',
              defaultModel: 'deepseek-chat',
              hasApiKey: true,
              editable: true,
            },
          ],
          defaultProvider: 'deepseek',
          canManage: true,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );

    await expect(createProviderApi().listProviders()).resolves.toEqual({
      providers: [
        {
          id: 'deepseek',
          label: 'DeepSeek',
          type: 'openai-compatible',
          baseUrl: 'https://api.deepseek.com',
          defaultModel: 'deepseek-chat',
          hasApiKey: true,
          editable: true,
        },
      ],
      defaultProvider: 'deepseek',
      canManage: true,
    });
    expect(fetchMock).toHaveBeenCalledWith('/settings/providers', { method: 'GET' });
  });

  it('maps non-200 responses to a stable ProviderApiError', async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          error: {
            code: 'provider-service-unavailable',
            message: 'Provider service is not available',
          },
        }),
        { status: 503, headers: { 'content-type': 'application/json' } },
      ),
    );

    await expect(createProviderApi().listProviders()).rejects.toMatchObject({
      name: 'ProviderApiError',
      code: 'provider-service-unavailable',
      status: 503,
    });
  });

  it('uses the desktop Server URL for Provider requests', async () => {
    window.weaveDesktop = {
      isDesktop: true,
      serverUrl: 'http://127.0.0.1:46321/',
    };
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({ providers: [], defaultProvider: 'deepseek', canManage: false }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      ),
    );

    await createProviderApi().listProviders();

    expect(fetchMock).toHaveBeenCalledWith('http://127.0.0.1:46321/settings/providers', {
      method: 'GET',
    });
  });

  it('rejects malformed successful responses', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ providers: [{ id: 'deepseek' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

    const error = await createProviderApi()
      .listProviders()
      .catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(ProviderApiError);
    expect(error).toMatchObject({
      code: 'provider-api-protocol',
      status: 200,
    });
  });

  it('creates a Provider with the local Server API', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ provider: publicDeepSeek }), {
        status: 201,
        headers: { 'content-type': 'application/json' },
      }),
    );

    await expect(createProviderApi().createProvider(validInput)).resolves.toEqual(publicDeepSeek);
    expect(fetchMock).toHaveBeenCalledWith('/settings/providers', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(validInput),
    });
  });

  it('patches without placing the previous API key into the request', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ provider: publicDeepSeek }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

    await createProviderApi().updateProvider('deepseek', {
      label: 'DeepSeek',
      apiKey: '',
    });

    expect(fetchMock.mock.calls[0]?.[0]).toBe('/settings/providers/deepseek');
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      method: 'PATCH',
      body: JSON.stringify({ label: 'DeepSeek', apiKey: '' }),
    });
  });

  it('deletes a Provider without parsing a response body', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));

    await expect(createProviderApi().deleteProvider('deep seek')).resolves.toBeUndefined();

    expect(fetchMock).toHaveBeenCalledWith('/settings/providers/deep%20seek', {
      method: 'DELETE',
    });
  });

  it('sets the default Provider and validates the returned settings', async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          providers: [publicDeepSeek],
          defaultProvider: 'deepseek',
          canManage: true,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );

    await expect(createProviderApi().setDefaultProvider('deepseek')).resolves.toEqual({
      providers: [publicDeepSeek],
      defaultProvider: 'deepseek',
      canManage: true,
    });
    expect(fetchMock).toHaveBeenCalledWith('/settings/providers/deepseek/default', {
      method: 'POST',
    });
  });

  it('maps Provider API errors without exposing secret response fields', async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          error: { code: 'provider-settings-secret-unavailable', message: '系统密钥存储不可用' },
          apiKey: 'should-never-be-returned',
        }),
        { status: 503 },
      ),
    );

    const error = await createProviderApi()
      .createProvider(validInput)
      .catch((reason: unknown) => reason);

    expect(error).toMatchObject({
      code: 'provider-settings-secret-unavailable',
      status: 503,
    });
    expect(error).not.toHaveProperty('apiKey');
  });
});
