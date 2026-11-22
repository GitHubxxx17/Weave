import {
  maxPluginMarketplaceBytes,
  pluginMarketplaceIndexSchema,
  type PluginMarketplaceCatalog,
} from './plugin-marketplace.js';
import type { MarketplaceSourceErrorCode } from './plugin-marketplace-source-types.js';

export class MarketplaceFetchError extends Error {
  constructor(readonly code: MarketplaceSourceErrorCode) {
    super('Marketplace index refresh failed');
  }
}
export async function fetchMarketplaceCatalog(
  url: string,
  fetch: typeof globalThis.fetch,
  abort: AbortController,
  reservedIds: readonly string[],
): Promise<PluginMarketplaceCatalog> {
  const timer = setTimeout(() => abort.abort(new MarketplaceFetchError('timeout')), 15_000);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let response: Response | undefined;
  let completed = false;
  const aborted = new Promise<never>((_resolve, reject) => {
    if (abort.signal.aborted) reject(abort.signal.reason);
    else abort.signal.addEventListener('abort', () => reject(abort.signal.reason), { once: true });
  });
  // Even a custom transport that throws synchronously must not leave rejection
  // from the cleanup abort unobserved.
  void aborted.catch(() => undefined);
  const bounded = <T>(operation: Promise<T>): Promise<T> => Promise.race([operation, aborted]);
  try {
    const requested = fetch(url, {
      method: 'GET',
      credentials: 'omit',
      redirect: 'error',
      referrerPolicy: 'no-referrer',
      headers: { Accept: 'application/json' },
      signal: abort.signal,
    });
    void requested.then(
      (late) => {
        if (abort.signal.aborted) void late.body?.cancel().catch(() => undefined);
      },
      () => undefined,
    );
    response = await bounded(requested);
    if (!response.ok || response.redirected) throw new MarketplaceFetchError('network');
    const declared = response.headers.get('Content-Length');
    if (
      declared !== null &&
      (!/^\d+$/.test(declared) || Number(declared) > maxPluginMarketplaceBytes)
    )
      throw new MarketplaceFetchError('too-large');
    if (response.body === null) throw new MarketplaceFetchError('invalid-index');
    reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    while (true) {
      const next = await bounded(reader.read());
      if (next.done) {
        completed = true;
        break;
      }
      length += next.value.byteLength;
      if (length > maxPluginMarketplaceBytes) throw new MarketplaceFetchError('too-large');
      chunks.push(next.value);
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    try {
      const payload: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
      const parsed = pluginMarketplaceIndexSchema.parse(payload);
      if (parsed.plugins.some(({ id }) => reservedIds.includes(id))) throw new Error();
      return { communityStatus: 'ready', plugins: parsed.plugins };
    } catch {
      throw new MarketplaceFetchError('invalid-index');
    }
  } catch (error) {
    if (abort.signal.aborted && abort.signal.reason instanceof MarketplaceFetchError)
      throw abort.signal.reason;
    if (error instanceof MarketplaceFetchError) throw error;
    throw new MarketplaceFetchError('network');
  } finally {
    clearTimeout(timer);
    if (!completed && reader !== undefined) void reader.cancel().catch(() => undefined);
    if (!completed && reader === undefined) void response?.body?.cancel().catch(() => undefined);
    if (!abort.signal.aborted) abort.abort();
  }
}
