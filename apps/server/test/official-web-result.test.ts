import { describe, expect, it } from 'vitest';
import { htmlToText } from '../../../plugins/official/weave-web-source/src/html-text.js';
import {
  buildFetchResult,
  buildSearchResult,
  containsKnownSecret,
  redactDisplayText,
} from '../../../plugins/official/weave-web-source/src/result.js';
const now = new Date('2026-11-23T00:00:00.000Z');
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
const key = 'tvly-secret12';

describe('official web text and citation results', () => {
  it('extracts title and visible block/list text without scripts or hidden containers', () => {
    const result = htmlToText(
      '<!doctype html><head><title>A &amp; B</title><meta><script>bad1</script></head><body><h1>Hello</h1><p x=">">中文 &lt;x&gt; &#128512; &#x1f680;</p><!--bad2--><script>bad3 <p>x</p></script><style>bad4</style><template><p>bad5</p></template><noscript>bad6</noscript><svg>bad7</svg><ul><li>One</li><li>Two<br>tail</li></ul><a href="https://other.test">Visible link</a></body>',
    );
    expect(result.title).toBe('A & B');
    expect(result.text).toBe('Hello\n中文 <x> 😀 🚀\n- One\n- Two\ntail\nVisible link');
    expect(result.text).not.toMatch(/bad[1-7]|https:\/\//);
  });
  it('handles raw text end boundaries, quoted attributes, nested hidden content and malformed tags', () => {
    expect(
      htmlToText(
        '<script>x</scripture><p>hidden</p></script><p title="a>b">safe</p><template><template>x</template>y</template><p>end',
      ),
    ).toEqual({ title: '', text: 'safe\nend' });
    expect(htmlToText('first < broken')).toEqual({ title: '', text: 'first < broken' });
    expect(htmlToText('<p>first</p><!--unfinished secret')).toEqual({ title: '', text: 'first' });
    expect(
      htmlToText(`<script>const mark = "<div title='";</script><p>Visible article</p>`),
    ).toEqual({ title: '', text: 'Visible article' });
    expect(
      htmlToText(
        '<script/>hidden</script><style/>hidden</style><template/>hidden</template><noscript/>hidden</noscript><svg/><p>safe</p>',
      ),
    ).toEqual({ title: '', text: 'safe' });
  });
  it('decodes only scalar numeric/basic named entities and normalizes spaces', () => {
    expect(htmlToText('&constructor; &toString; &hasOwnProperty;').text).toBe(
      '&constructor; &toString; &hasOwnProperty;',
    );
    expect(
      htmlToText('<p>&quot; &apos; &nbsp; &#x0; &#55296; &#1114112; &unknown; &#65;</p>').text,
    ).toBe('" \' &#x0; &#55296; &#1114112; &unknown; A');
  });
  it('matches literal and one-layer mixed percent octets without changing unrelated case', () => {
    for (const text of [key, 'tvly-secret%31%32', '%74vly%2Dsecret12', '%74%76%6cy-secret12']) {
      expect(containsKnownSecret(text, [key])).toBe(true);
      expect(redactDisplayText(`before ${text} after`, [key])).toBe('before [REDACTED] after');
    }
    expect(containsKnownSecret('TVLY-secret12', [key])).toBe(false);
    expect(containsKnownSecret('%2574vly-secret12', [key])).toBe(false);
    expect(redactDisplayText('a[b].c a%5Bb%5D.c', ['a[b].c'])).toBe('[REDACTED] [REDACTED]');
  });
  it('redacts encoded UTF-8 scalars and literal secrets beside malformed octets', () => {
    expect(redactDisplayText('prefix %E4%B8%AD%F0%9F%98%80 suffix', ['中😀'])).toBe(
      'prefix [REDACTED] suffix',
    );
    expect(redactDisplayText('%EF%BB%BFsecret', ['\uFEFFsecret'])).toBe('[REDACTED]');
    expect(redactDisplayText(`%FF ${key} ${key}`, [key])).toBe('%FF [REDACTED] [REDACTED]');
    expect(redactDisplayText('ordinary %61 text', [])).toBe('ordinary %61 text');
  });
  it('omits entire secret-bearing sources, redacts display fields and preserves accepted citations', () => {
    const result = buildSearchResult(
      { query: `query ${key}`, maxResults: 5 },
      [
        { title: key, url: 'https://example.com/a?q=one%20two', excerpt: 'tvly-secret%31%32' },
        { title: 'bad', url: `https://example.com/${key}`, excerpt: 'secret source' },
      ],
      0,
      now,
      [key],
    );
    expect(result.sources).toEqual([
      {
        id: 'S1',
        title: '[REDACTED]',
        url: 'https://example.com/a?q=one%20two',
        excerpt: '[REDACTED]',
      },
    ]);
    expect(result.query).toBe('query [REDACTED]');
    expect(result.omittedResults).toBe(1);
    expect(JSON.stringify(result)).not.toContain(key);
  });
  it('keeps full canonical source URLs while bounding JSON with multi-byte/escaped text', () => {
    const sources = Array.from({ length: 5 }, (_, i) => ({
      title: '😀'.repeat(200),
      url: `https://example.com/${i}?q=${'a'.repeat(1900)}`,
      excerpt: '😀"\\'.repeat(800),
    }));
    const result = buildSearchResult(
      { query: '中'.repeat(512), maxResults: 5 },
      sources,
      0,
      now,
      [],
    );
    expect(bytes(result)).toBeLessThanOrEqual(12288);
    expect(result.sources.length).toBeGreaterThan(0);
    expect(result.sources[0]!.url).toBe(sources[0]!.url);
    expect(
      result.sources.every(
        (source) => [...source.title].length <= 160 && [...source.excerpt].length <= 800,
      ),
    ).toBe(true);
    expect(result.omittedResults).toBe(5 - result.sources.length);
    expect(result.truncated).toBe(true);
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
  });
  it('bounds fetch by codepoints and exact complete JSON bytes including escaping', () => {
    const result = buildFetchResult(
      { url: 'https://example.com/start', maxChars: 8000 },
      new URL('https://example.com/final'),
      'text/html',
      '😀'.repeat(200),
      '\\"😀中'.repeat(8000),
      now,
      [],
    );
    expect(result.source).toMatchObject({
      requestedUrl: 'https://example.com/start',
      url: 'https://example.com/final',
    });
    expect(bytes(result)).toBeLessThanOrEqual(12288);
    expect([...result.text].length).toBeLessThanOrEqual(8000);
    expect(result.truncated).toBe(true);
    expect(result.text).not.toMatch(/[\uD800-\uDBFF]$/);
  });
  it('can exactly fill the serialized JSON byte limit and marks only actual truncation', () => {
    const empty = buildFetchResult(
      { url: 'https://example.com/', maxChars: 8000 },
      new URL('https://example.com/'),
      'text/plain',
      '',
      '',
      now,
      [],
    );
    expect(empty.truncated).toBe(false);
    const text = '\\'.repeat(8000);
    const result = buildFetchResult(
      { url: 'https://example.com/', maxChars: 8000 },
      new URL('https://example.com/'),
      'text/plain',
      '',
      text,
      now,
      [],
    );
    expect(bytes(result)).toBeLessThanOrEqual(12288);
    expect(bytes({ ...result, text: result.text + '\\' })).toBeGreaterThan(12288);
  });
  it('fails safely for required secret-bearing URL and impossible fixed metadata', () => {
    for (const [requested, final] of [
      [`https://example.com/${key}`, 'https://example.com/'],
      ['https://example.com/', 'https://example.com/tvly-secret%31%32'],
    ]) {
      expect(() =>
        buildFetchResult(
          { url: requested!, maxChars: 6000 },
          new URL(final!),
          'text/plain',
          '',
          'body',
          now,
          [key],
        ),
      ).toThrowError(expect.objectContaining({ code: 'web-url-blocked' }));
    }
    expect(() =>
      buildFetchResult(
        { url: 'https://example.com/', maxChars: 6000 },
        new URL('https://example.com/'),
        'x'.repeat(13000),
        '',
        'body',
        now,
        [],
      ),
    ).toThrowError(expect.objectContaining({ code: 'web-result-too-large' }));
  });
});
