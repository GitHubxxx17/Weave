import { describe, expect, it } from 'vitest';
import { createPluginSdk } from '@weave/plugin';
import { readSearchConfiguration } from '../../../plugins/official/weave-web-source/src/config.js';
import { createWebSchemas } from '../../../plugins/official/weave-web-source/src/schemas.js';

const z = createPluginSdk().z;

describe('official web input and selected configuration', () => {
  it('requires an explicit single provider and its own valid credential', () => {
    expect(readSearchConfiguration(z, {})).toEqual({ status: 'unconfigured' });
    expect(readSearchConfiguration(z, { provider: 'none', apiKey: 'valid-own-key' })).toEqual({
      status: 'unconfigured',
    });
    expect(readSearchConfiguration(z, { provider: 'tavily' })).toEqual({ status: 'unconfigured' });
    for (const input of [
      { provider: 'unknown', apiKey: 'valid-own-key' },
      { provider: '', apiKey: 'valid-own-key' },
      { provider: 'tavily', apiKey: '' },
      { provider: 'tavily', apiKey: 'valid-own-key\nInjected: true' },
      { provider: 'tavily', apiKey: ' key-with-space' },
      { provider: 'tavily', apiKey: 'a'.repeat(513) },
    ])
      expect(readSearchConfiguration(z, input)).toEqual({ status: 'invalid' });
    const input = { provider: 'tavily', apiKey: 'valid-own-key' };
    const captured = readSearchConfiguration(z, input);
    input.apiKey = 'changed-own-key';
    expect(captured).toEqual({
      status: 'ready',
      value: { provider: 'tavily', apiKey: 'valid-own-key' },
    });
    expect(Object.isFrozen(captured)).toBe(true);
    if (captured.status === 'ready') expect(Object.isFrozen(captured.value)).toBe(true);
  });

  it('closes schemas, preserves exact outbound text after deliberate query trim, and bounds Unicode', () => {
    const schemas = createWebSchemas(z);
    expect(schemas.search.parse({ query: '  中文 query\n\t ' })).toEqual({
      query: '中文 query',
      maxResults: 5,
    });
    expect(schemas.fetch.parse({ url: 'https://example.com/' })).toEqual({
      url: 'https://example.com/',
      maxChars: 6000,
    });
    for (const input of [
      { query: '' },
      { query: ' \n ' },
      { query: 'x', extra: true },
      { query: '\0' },
      { query: '\u0001' },
      { query: '\ud800' },
      { query: 'x'.repeat(513) },
      { query: 'x', maxResults: 0 },
      { query: 'x', maxResults: 6 },
      { query: 'x', maxResults: 1.5 },
    ])
      expect(schemas.search.safeParse(input).success).toBe(false);
    expect(schemas.search.safeParse({ query: '😀'.repeat(256) }).success).toBe(true);
    expect(schemas.search.safeParse({ query: '😀'.repeat(257) }).success).toBe(false);
    for (const input of [
      { url: 'https://example.com/', headers: {} },
      { url: 'x'.repeat(2049) },
      { url: '\ud800' },
      { url: 'https://example.com/', maxChars: 255 },
      { url: 'https://example.com/', maxChars: 8001 },
    ])
      expect(schemas.fetch.safeParse(input).success).toBe(false);
    // Semantic URL policy runs in protected callbacks, preserving safe web error codes.
    expect(schemas.fetch.safeParse({ url: 'https://127.0.0.1/' }).success).toBe(true);
  });
});
