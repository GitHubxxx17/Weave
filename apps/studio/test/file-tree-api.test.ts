import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchFileContent } from '../src/features/files-tree/file-tree-api.js';
import { fetchFileDiff } from '../src/features/files-tree/file-diff-api.js';
afterEach(() => vi.unstubAllGlobals());
describe('file read cancellation signals', () => {
  it('forwards exact AbortSignals for content and diff and validates the returned payload', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({
          path: 'a file.txt',
          content: 'same',
          bytes: 4,
          truncated: false,
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          path: 'a file.txt',
          oldContent: 'a',
          newContent: 'b',
          changed: true,
          tracked: true,
        }),
      );
    vi.stubGlobal('fetch', fetch);
    const first = new AbortController(),
      second = new AbortController();
    expect((await fetchFileContent('p 1', 'a file.txt', { signal: first.signal })).content).toBe(
      'same',
    );
    expect((await fetchFileDiff('p 1', 'a file.txt', { signal: second.signal })).changed).toBe(
      true,
    );
    expect(fetch.mock.calls[0]?.[0]).toContain('/projects/p%201/file?path=a%20file.txt');
    expect(fetch.mock.calls[0]?.[1]?.signal).toBe(first.signal);
    expect(fetch.mock.calls[1]?.[1]?.signal).toBe(second.signal);
  });
  it('preserves the abort rejection rather than converting it to a connection error', async () => {
    const controller = new AbortController();
    controller.abort();
    const cause = new DOMException('aborted', 'AbortError');
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(cause));
    await expect(fetchFileContent('p', 'a', { signal: controller.signal })).rejects.toBe(cause);
    await expect(fetchFileDiff('p', 'a', { signal: controller.signal })).rejects.toBe(cause);
  });
});
