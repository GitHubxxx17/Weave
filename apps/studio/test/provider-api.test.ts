// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createProviderApi, ProviderApiError } from '../src/features/providers/provider-api.js';

describe('Provider API client', () => {
  const fetchMock = vi.fn();

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
              defaultModel: 'deepseek-chat',
            },
          ],
          defaultProvider: 'deepseek',
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
          defaultModel: 'deepseek-chat',
        },
      ],
      defaultProvider: 'deepseek',
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
      new Response(JSON.stringify({ providers: [], defaultProvider: 'deepseek' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
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
});
