import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchPanelCatalog, fetchPanelData } from '../src/features/panel/plugin-panel-api.js';
afterEach(() => vi.unstubAllGlobals());
const catalog = {
  schemaVersion: 1,
  serverEpoch: 'a'.repeat(32),
  generation: 1,
  authorityEpoch: 1,
  acceptingRuns: true,
  panels: [],
};
describe('bounded panel HTTP', () => {
  it('reads actual bytes and preserves caller signal', async () => {
    const fn = vi.fn(async () => new Response(JSON.stringify(catalog)));
    vi.stubGlobal('fetch', fn);
    const signal = new AbortController().signal;
    expect(await fetchPanelCatalog(signal)).toEqual(catalog);
    expect(fn.mock.calls[0]?.[1]).toEqual(expect.objectContaining({ signal }));
  });
  it('rejects actual byte overflow regardless of Content-Length', async () => {
    vi.stubGlobal(
      'fetch',
      async () => new Response(' '.repeat(1048577), { headers: { 'Content-Length': '1' } }),
    );
    await expect(fetchPanelCatalog(new AbortController().signal)).rejects.toMatchObject({
      code: 'panel-invalid-response',
    });
  });
  it('rejects malformed UTF8 and bounded invalid error envelopes', async () => {
    vi.stubGlobal('fetch', async () => new Response(new Uint8Array([0xff, 0xfe])));
    await expect(fetchPanelCatalog(new AbortController().signal)).rejects.toMatchObject({
      code: 'panel-invalid-response',
    });
    vi.stubGlobal(
      'fetch',
      async () =>
        new Response(
          JSON.stringify({ error: { code: 'panel-stale', message: 'x'.repeat(2048) } }),
          { status: 409 },
        ),
    );
    await expect(fetchPanelCatalog(new AbortController().signal)).rejects.toMatchObject({
      code: 'panel-invalid-response',
    });
  });
  it('rejects mismatched response request identity', async () => {
    vi.stubGlobal(
      'fetch',
      async () =>
        new Response(
          JSON.stringify({
            ...catalog,
            acceptingRuns: undefined,
            panels: undefined,
            panelRef: 'b'.repeat(32),
            panelId: 'plugin:p/r',
            sessionId: 'other',
            lastSequence: 0,
            state: 'empty',
            sources: [],
            blocks: [],
          }),
        ),
    );
    await expect(
      fetchPanelData('session', 'b'.repeat(32), new AbortController().signal),
    ).rejects.toMatchObject({ code: 'panel-invalid-response' });
  });
});
