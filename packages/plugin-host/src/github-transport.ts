import { GithubAcquisitionError, invalid, tooLarge } from './github-source.js';

export const maxFileBytes = 20 * 1024 * 1024;
export const maxMetadataBytes = 2 * 1024 * 1024;

export interface GithubTransport {
  read(url: string, metadata: boolean, expectedBytes?: number): Promise<Uint8Array>;
}

/** Request lifetime includes response-body consumption, not just response headers. */
export function createGithubTransport(fetcher: typeof fetch, signal: AbortSignal): GithubTransport {
  return {
    async read(url, metadata, expectedBytes) {
      signal.throwIfAborted();
      const request = new AbortController();
      const abort = () => request.abort(signal.reason);
      signal.addEventListener('abort', abort, { once: true });
      const timer = setTimeout(
        () =>
          request.abort(
            new GithubAcquisitionError(
              'plugin-github-timeout',
              'The GitHub plugin acquisition timed out',
            ),
          ),
        15_000,
      );
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      let cancellation: Promise<void> | undefined;
      const cancelReader = () => {
        if (reader !== undefined && cancellation === undefined)
          cancellation = reader.cancel().catch(() => undefined);
      };
      request.signal.addEventListener('abort', cancelReader, { once: true });
      try {
        const response = await fetcher(url, {
          redirect: 'error',
          credentials: 'omit',
          signal: request.signal,
          headers: {
            accept: metadata ? 'application/vnd.github+json' : 'application/octet-stream',
          },
        });
        reader = response.body?.getReader();
        request.signal.throwIfAborted();
        if (response.status === 403 || response.status === 429)
          throw new GithubAcquisitionError(
            'plugin-github-rate-limited',
            'The public GitHub API rate limit was reached',
          );
        if (response.status === 404 || response.status >= 500)
          throw new GithubAcquisitionError(
            'plugin-github-unavailable',
            'The GitHub plugin source is unavailable',
          );
        if (response.status !== 200 || response.redirected) throw invalid();
        const limit = metadata ? maxMetadataBytes : maxFileBytes;
        const declared = response.headers.get('content-length');
        const encoding = response.headers.get('content-encoding')?.trim().toLowerCase();
        if (declared !== null) {
          if (!/^\d+$/.test(declared) || !Number.isSafeInteger(Number(declared))) throw invalid();
          if (Number(declared) > limit) throw tooLarge();
          // Fetch decodes compressed bodies while retaining their wire Content-Length.
          if (
            expectedBytes !== undefined &&
            (encoding === undefined || encoding === 'identity') &&
            Number(declared) !== expectedBytes
          )
            throw invalid();
        }
        if (response.body === null) {
          if (expectedBytes !== undefined && expectedBytes !== 0) throw invalid();
          return new Uint8Array();
        }
        if (reader === undefined) throw invalid();
        const chunks: Uint8Array[] = [];
        let bytes = 0;
        while (true) {
          request.signal.throwIfAborted();
          const { done, value } = await reader.read();
          request.signal.throwIfAborted();
          if (done) break;
          bytes += value.byteLength;
          if (bytes > limit) throw tooLarge();
          if (expectedBytes !== undefined && bytes > expectedBytes) throw invalid();
          chunks.push(value);
        }
        if (expectedBytes !== undefined && bytes !== expectedBytes) throw invalid();
        const result = new Uint8Array(bytes);
        let offset = 0;
        for (const chunk of chunks) {
          result.set(chunk, offset);
          offset += chunk.byteLength;
        }
        return result;
      } catch (error: unknown) {
        if (signal.aborted) throw signal.reason;
        if (request.signal.aborted) throw request.signal.reason;
        if (error instanceof GithubAcquisitionError) throw error;
        throw new GithubAcquisitionError(
          'plugin-github-unavailable',
          'The GitHub plugin source is unavailable',
          { cause: error },
        );
      } finally {
        clearTimeout(timer);
        signal.removeEventListener('abort', abort);
        request.signal.removeEventListener('abort', cancelReader);
        cancelReader();
        await cancellation;
        reader?.releaseLock();
      }
    },
  };
}
