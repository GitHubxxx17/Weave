import { createPluginSdk } from '@weave/plugin';
import { describe, expect, it, vi } from 'vitest';
import { searchTavily } from '../../../plugins/official/weave-web-source/src/tavily.js';
import type { WebHttpClient } from '../../../plugins/official/weave-web-source/src/types.js';

const key = 'tvly-secret12';
const config = { provider: 'tavily' as const, apiKey: key };
const input = { query: '准确 query\nwith context', maxResults: 2 };
const signal = new AbortController().signal;
function fixture(value: unknown, status = 200, headers: Record<string, string> = {}) {
  const request = vi.fn<WebHttpClient['request']>().mockResolvedValue({
    status,
    headers,
    bytes: Buffer.from(JSON.stringify(value)),
  });
  return { http: { request }, request };
}
const source = (url = 'https://example.com/article') => ({ title: '标题', url, content: '正文' });

describe('official Tavily adapter', () => {
  it('sends exactly one fixed request with only the validated query and frozen credential', async () => {
    const f = fixture({ results: [source()], unused: { secret: key } });
    const result = await searchTavily(createPluginSdk().z, f.http, config, input, signal);
    expect(f.request).toHaveBeenCalledTimes(1);
    const sent = f.request.mock.calls[0]![0];
    expect(sent.url.href).toBe('https://api.tavily.com/search');
    expect(sent).toMatchObject({
      method: 'POST',
      signal,
      maxWireBytes: 524288,
      maxDecodedBytes: 524288,
    });
    expect(sent.headers).toEqual({
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'Accept-Encoding': 'identity',
      'User-Agent': 'Weave-Web/0.1.0',
    });
    expect(JSON.parse(Buffer.from(sent.body!).toString('utf8'))).toEqual({
      query: input.query,
      max_results: 2,
      search_depth: 'basic',
      chunks_per_source: 1,
      topic: 'general',
      auto_parameters: false,
      include_answer: false,
      include_raw_content: false,
      include_images: false,
      include_image_descriptions: false,
      include_favicon: false,
      include_usage: false,
    });
    expect(result).toEqual({
      sources: [{ title: '标题', url: 'https://example.com/article', excerpt: '正文' }],
      omittedResults: 0,
    });
    expect(JSON.stringify(result)).not.toContain(key);
  });

  it('filters unsafe, duplicate and excess URLs preserving provider order and full canonical sources', async () => {
    const f = fixture({
      results: [
        source('https://EXAMPLE.com:443/a'),
        source('https://example.com/a'),
        source('http://example.com/a'),
        source('https://127.0.0.1/'),
        source('https://example.org/b'),
        source('https://example.net/c'),
      ],
    });
    expect(await searchTavily(createPluginSdk().z, f.http, config, input, signal)).toEqual({
      sources: [
        { title: '标题', url: 'https://example.com/a', excerpt: '正文' },
        { title: '标题', url: 'https://example.org/b', excerpt: '正文' },
      ],
      omittedResults: 4,
    });
  });

  it('accepts empty results and omits a source containing literal or mixed encoded host key', async () => {
    for (const results of [
      [],
      [source(`https://example.com/${key}`), source('https://example.com/tvly-secret%31%32')],
    ]) {
      const f = fixture({ results });
      expect(await searchTavily(createPluginSdk().z, f.http, config, input, signal)).toEqual({
        sources: [],
        omittedResults: results.length,
      });
    }
  });

  it.each([
    [301, 'web-redirect-blocked'],
    [401, 'web-search-auth-failed'],
    [403, 'web-search-auth-failed'],
    [429, 'web-rate-limited'],
    [432, 'web-search-quota-exceeded'],
    [433, 'web-search-quota-exceeded'],
    [434, 'web-rate-limited'],
    [500, 'web-http-error'],
  ])('maps status %s before parsing unsafe bodies', async (status, code) => {
    const f = fixture({ rawError: key }, status as number, { 'retry-after': '12' });
    await expect(
      searchTavily(createPluginSdk().z, f.http, config, input, signal),
    ).rejects.toMatchObject({ code });
    expect(f.request).toHaveBeenCalledTimes(1);
    try {
      await searchTavily(createPluginSdk().z, f.http, config, input, signal);
    } catch (error) {
      expect(String(error)).not.toContain(key);
      expect(error).not.toHaveProperty('cause');
    }
  });

  it.each(['12', '0', '3600', '3601', '-1', '1.5', '1\nsecret', 'Mon, 01 Jan 2026 00:00:00 GMT'])(
    'bounds Retry-After %s',
    async (retryAfter) => {
      const f = fixture({}, 429, { 'retry-after': retryAfter });
      try {
        await searchTavily(createPluginSdk().z, f.http, config, input, signal);
        expect.fail('must fail');
      } catch (error) {
        const message = (error as Error).message;
        if (/^(?:0|[1-9][0-9]*)$/.test(retryAfter) && Number(retryAfter) <= 3600)
          expect(message).toContain(`${Number(retryAfter)}`);
        else expect(message).not.toContain(retryAfter);
      }
    },
  );

  it.each([
    {},
    { results: null },
    { results: [source(), { ...source(), score: Infinity }] },
    { results: [{ ...source(), title: 'x'.repeat(4097) }] },
    { results: [{ ...source(), content: 'x'.repeat(65537) }] },
    { results: Array.from({ length: 21 }, () => source()) },
  ])('rejects invalid provider shape without exposing the response', async (value) => {
    const f = fixture(value);
    await expect(
      searchTavily(createPluginSdk().z, f.http, config, input, signal),
    ).rejects.toMatchObject({ code: 'web-provider-response-invalid' });
  });

  it('rejects malformed UTF-8/JSON, oversize raw JSON and native failures safely', async () => {
    for (const bytes of [Buffer.from([255]), Buffer.from('{bad'), Buffer.alloc(524289, 32)]) {
      const request = vi
        .fn<WebHttpClient['request']>()
        .mockResolvedValue({ status: 200, headers: {}, bytes });
      await expect(
        searchTavily(createPluginSdk().z, { request }, config, input, signal),
      ).rejects.toMatchObject({
        code: bytes.length > 524288 ? 'web-response-too-large' : 'web-provider-response-invalid',
      });
    }
    const request = vi.fn<WebHttpClient['request']>().mockRejectedValue(new Error(`raw ${key}`));
    await expect(
      searchTavily(createPluginSdk().z, { request }, config, input, signal),
    ).rejects.toMatchObject({ code: 'web-network-failed' });
  });
  it('prioritizes cancellation before and after the HTTP boundary without disclosing abort reasons', async () => {
    const aborted = new AbortController();
    aborted.abort(new Error(key));
    const f = fixture({ results: [] });
    await expect(
      searchTavily(createPluginSdk().z, f.http, config, input, aborted.signal),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(f.request).not.toHaveBeenCalled();
    const during = new AbortController();
    const request: WebHttpClient['request'] = async () => {
      during.abort(new Error(key));
      throw new Error(key);
    };
    await expect(
      searchTavily(createPluginSdk().z, { request }, config, input, during.signal),
    ).rejects.toMatchObject({ name: 'AbortError', message: 'The operation was aborted' });
  });
});
