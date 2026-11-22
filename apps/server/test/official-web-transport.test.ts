import type { request as httpsRequest } from 'node:https';
import { EventEmitter, getEventListeners } from 'node:events';
import { brotliCompressSync, deflateSync, gzipSync } from 'node:zlib';
import { describe, expect, it, vi } from 'vitest';
import { WebToolError } from '../../../plugins/official/weave-web-source/src/errors.js';
import { createWebHttpClient } from '../../../plugins/official/weave-web-source/src/transport.js';
import { sameNetworkAddress } from '../../../plugins/official/weave-web-source/src/address-policy.js';

class FakeSocket extends EventEmitter {
  remoteAddress: string | undefined;
  constructor(address: string) {
    super();
    this.remoteAddress = address;
  }
}
class FakeResponse extends EventEmitter {
  socket = new FakeSocket('93.184.216.34');
  complete = false;
  pause(): void {}
  resume(): void {}
  statusCode = 200;
  headers: Record<string, string> = { 'content-type': 'text/plain' };
  rawHeaders: string[] = ['content-type', 'text/plain'];
  destroyed = false;
  destroy(): void {
    this.destroyed = true;
  }
  emitBody(body: Uint8Array): void {
    this.emit('data', body);
    this.complete = true;
    this.emit('end');
  }
}
class FakeRequest extends EventEmitter {
  readonly socket = new FakeSocket('93.184.216.34');
  readonly writes: Uint8Array[] = [];
  destroyed = false;
  end(body?: Uint8Array): void {
    if (body !== undefined) this.writes.push(body);
  }
  write(body: Uint8Array): boolean {
    this.writes.push(body);
    return true;
  }
  destroy(): void {
    this.destroyed = true;
    this.emit('close');
  }
}

interface Harness {
  readonly request: FakeRequest;
  readonly response: FakeResponse;
  readonly requestImpl: ReturnType<typeof vi.fn>;
  respond(): void;
}
function harness(status = 200, body = new TextEncoder().encode('hello'), autoBody = true): Harness {
  const request = new FakeRequest();
  const response = new FakeResponse();
  response.statusCode = status;
  const requestImpl = vi.fn((_options: unknown, callback: (response: FakeResponse) => void) => {
    queueMicrotask(() => {
      request.emit('socket', request.socket);
      queueMicrotask(() => request.socket.emit('secureConnect'));
      queueMicrotask(() => {
        response.socket = request.socket;
        callback(response);
        if (autoBody) queueMicrotask(() => response.emitBody(body));
      });
    });
    return request;
  });
  return {
    request,
    response,
    requestImpl,
    respond() {
      response.emitBody(body);
    },
  };
}

describe('official web HTTPS transport', () => {
  const input = (signal = new AbortController().signal) => ({
    url: new URL('https://example.com/'),
    method: 'GET' as const,
    headers: {},
    signal,
    maxWireBytes: 512,
    maxDecodedBytes: 512,
  });

  it.each([
    [],
    Array.from({ length: 17 }, () => ({ address: '93.184.216.34', family: 4 as const })),
  ])('rejects unsupported DNS answer count', async (answers) => {
    const request = vi.fn();
    await expect(
      createWebHttpClient({ lookup: async () => answers, request }).request(input()),
    ).rejects.toMatchObject({ code: 'web-dns-failed' });
    expect(request).not.toHaveBeenCalled();
  });

  it('cancels pending DNS without a late socket or native error leak', async () => {
    let finish!: (value: readonly { address: string; family: 4 }[]) => void;
    const lookup = vi.fn(
      () =>
        new Promise<readonly { address: string; family: 4 }[]>((resolve) => {
          finish = resolve;
        }),
    );
    const request = vi.fn();
    const controller = new AbortController();
    const pending = createWebHttpClient({ lookup, request }).request(input(controller.signal));
    await vi.waitFor(() => expect(lookup).toHaveBeenCalledTimes(1));
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
    finish([{ address: '93.184.216.34', family: 4 }]);
    await Promise.resolve();
    expect(request).not.toHaveBeenCalled();
  });

  it('maps native resolver and request failures to fixed errors with no causes', async () => {
    const native = new Error('private-secret-key');
    const client = createWebHttpClient({
      lookup: async () => {
        throw native;
      },
    });
    const error = await client.request(input()).catch((value: unknown) => value);
    expect(error).toMatchObject({ code: 'web-dns-failed' });
    expect(error).not.toHaveProperty('cause');
    expect((error as Error).message).not.toContain('private-secret-key');
    const failedRequest = createWebHttpClient({
      lookup: async () => [{ address: '93.184.216.34', family: 4 }],
      request: (() => {
        throw native;
      }) as typeof httpsRequest,
    });
    await expect(failedRequest.request(input())).rejects.toMatchObject({
      code: 'web-network-failed',
    });
  });

  it('maps Node header-parser overflow to the response size error', async () => {
    const h = harness(200, new Uint8Array(), false);
    const client = createWebHttpClient({
      lookup: async () => [{ address: '93.184.216.34', family: 4 }],
      request: h.requestImpl as unknown as typeof httpsRequest,
    });
    const pending = client.request(input());
    const rejected = expect(pending).rejects.toMatchObject({ code: 'web-response-too-large' });
    await vi.waitFor(() => expect(h.requestImpl).toHaveBeenCalled());
    h.request.emit(
      'error',
      Object.assign(new Error('private parser details'), { code: 'HPE_HEADER_OVERFLOW' }),
    );
    await rejected;
  });

  it('normalizes only mapped socket equality while public literal input stays blocked', () => {
    expect(sameNetworkAddress('::ffff:5db8:d822', '93.184.216.34')).toBe(true);
    expect(sameNetworkAddress('::ffff:93.184.216.34', '93.184.216.34')).toBe(true);
    expect(sameNetworkAddress('2606:4700:4700:0:0:0:0:1111', '2606:4700:4700::1111')).toBe(true);
    expect(sameNetworkAddress('::1', '93.184.216.34')).toBe(false);
  });
  it('rejects mixed public/private DNS answers before creating a request', async () => {
    const request = vi.fn();
    const client = createWebHttpClient({
      lookup: async () => [
        { address: '93.184.216.34', family: 4 },
        { address: '127.0.0.1', family: 4 },
      ],
      request,
    });
    await expect(
      client.request({
        url: new URL('https://example.com/'),
        method: 'GET',
        headers: {},
        signal: new AbortController().signal,
        maxWireBytes: 512,
        maxDecodedBytes: 512,
      }),
    ).rejects.toMatchObject({ code: 'web-url-blocked' });
    expect(request).not.toHaveBeenCalled();
  });

  it('pins the first validated address and preserves HTTPS host/SNI settings', async () => {
    const h = harness();
    const lookup = vi.fn(async () => [{ address: '93.184.216.34', family: 4 as const }]);
    const client = createWebHttpClient({
      lookup,
      request: h.requestImpl as unknown as typeof httpsRequest,
    });
    const pending = client.request({
      url: new URL('https://Example.com/path?q=1'),
      method: 'POST',
      headers: { accept: 'application/json' },
      body: new TextEncoder().encode('body'),
      signal: new AbortController().signal,
      maxWireBytes: 512,
      maxDecodedBytes: 512,
    });
    await vi.waitFor(() => expect(h.requestImpl).toHaveBeenCalled());
    const options = h.requestImpl.mock.calls[0]![0] as Record<string, unknown>;
    expect(options.hostname).toBe('example.com');
    expect(options.servername).toBe('example.com');
    expect(options.port).toBe(443);
    expect(options.agent).toBe(false);
    expect(options.rejectUnauthorized).toBe(true);
    expect(options.headers).toMatchObject({ Host: 'example.com' });
    expect(options.lookup).toEqual(expect.any(Function));
    const callback = options.lookup as (
      host: string,
      options: unknown,
      callback: (error: unknown, address: unknown, family?: unknown) => void,
    ) => void;
    const lookupResult = new Promise<unknown>((resolve, reject) =>
      callback('example.com', {}, (error: unknown, address: unknown, family: unknown) =>
        error ? reject(error) : resolve({ address, family }),
      ),
    );
    await expect(lookupResult).resolves.toEqual({ address: '93.184.216.34', family: 4 });
    expect(lookup).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(h.request.writes).toHaveLength(1));
    h.respond();
    await expect(pending).resolves.toMatchObject({ status: 200, bytes: Buffer.from('hello') });
  });

  it('does not send body when the TLS socket address differs from the validated pin', async () => {
    const h = harness();
    h.request.socket.remoteAddress = '93.184.216.35';
    const client = createWebHttpClient({
      lookup: async () => [{ address: '93.184.216.34', family: 4 }],
      request: h.requestImpl as unknown as typeof httpsRequest,
    });
    await expect(
      client.request({
        url: new URL('https://example.com/'),
        method: 'POST',
        headers: {},
        body: new Uint8Array([1]),
        signal: new AbortController().signal,
        maxWireBytes: 512,
        maxDecodedBytes: 512,
      }),
    ).rejects.toMatchObject({ code: 'web-network-failed' });
    expect(h.request.writes).toHaveLength(0);
    expect(h.request.destroyed).toBe(true);
  });

  it('bypasses DNS for public IPv6 literals and removes brackets from the connection hostname', async () => {
    const h = harness();
    h.request.socket.remoteAddress = '2606:4700:4700::1111';
    const lookup = vi.fn();
    const client = createWebHttpClient({
      lookup,
      request: h.requestImpl as unknown as typeof httpsRequest,
    });
    const pending = client.request({
      url: new URL('https://[2606:4700:4700::1111]/'),
      method: 'GET',
      headers: {},
      signal: new AbortController().signal,
      maxWireBytes: 512,
      maxDecodedBytes: 512,
    });
    await vi.waitFor(() => expect(h.requestImpl).toHaveBeenCalled());
    const options = h.requestImpl.mock.calls[0]![0] as Record<string, unknown>;
    expect(options.hostname).toBe('2606:4700:4700::1111');
    expect(options.servername).toBeUndefined();
    expect(lookup).not.toHaveBeenCalled();
    h.respond();
    await pending;
  });

  it('returns non-2xx status after headers without reading or decoding the body', async () => {
    const h = harness(429, new Uint8Array(2_000));
    h.response.headers = { 'content-encoding': 'made-up' };
    h.response.rawHeaders = ['content-encoding', 'made-up'];
    const client = createWebHttpClient({
      lookup: async () => [{ address: '93.184.216.34', family: 4 }],
      request: h.requestImpl as unknown as typeof httpsRequest,
    });
    const pending = client.request({
      url: new URL('https://example.com/'),
      method: 'GET',
      headers: {},
      signal: new AbortController().signal,
      maxWireBytes: 1,
      maxDecodedBytes: 1,
    });
    await vi.waitFor(() => expect(h.response.destroyed).toBe(true));
    await expect(pending).resolves.toMatchObject({ status: 429, bytes: new Uint8Array() });
  });

  it('rejects duplicate semantic headers and excessive wire bytes', async () => {
    const duplicate = harness();
    duplicate.response.rawHeaders = ['content-type', 'text/plain', 'Content-Type', 'text/html'];
    const duplicateClient = createWebHttpClient({
      lookup: async () => [{ address: '93.184.216.34', family: 4 }],
      request: duplicate.requestImpl as unknown as typeof httpsRequest,
    });
    const duplicatePending = duplicateClient.request({
      url: new URL('https://example.com/'),
      method: 'GET',
      headers: {},
      signal: new AbortController().signal,
      maxWireBytes: 512,
      maxDecodedBytes: 512,
    });
    await expect(duplicatePending).rejects.toMatchObject({ code: 'web-network-failed' });
    expect(duplicate.response.destroyed).toBe(true);

    const large = harness(200, new Uint8Array(2));
    const largeClient = createWebHttpClient({
      lookup: async () => [{ address: '93.184.216.34', family: 4 }],
      request: large.requestImpl as unknown as typeof httpsRequest,
    });
    const largePending = largeClient.request({
      url: new URL('https://example.com/'),
      method: 'GET',
      headers: {},
      signal: new AbortController().signal,
      maxWireBytes: 1,
      maxDecodedBytes: 512,
    });
    await expect(largePending).rejects.toMatchObject({ code: 'web-response-too-large' });
    expect(large.response.destroyed).toBe(true);
  });

  it('counts compressed wire bytes and decoded bytes separately', async () => {
    const compressed = gzipSync(new TextEncoder().encode('hello'));
    const h = harness(200, compressed);
    h.response.headers = { 'content-encoding': 'gzip' };
    h.response.rawHeaders = ['content-encoding', 'gzip'];
    const client = createWebHttpClient({
      lookup: async () => [{ address: '93.184.216.34', family: 4 }],
      request: h.requestImpl as unknown as typeof httpsRequest,
    });
    const pending = client.request({
      url: new URL('https://example.com/'),
      method: 'GET',
      headers: {},
      signal: new AbortController().signal,
      maxWireBytes: compressed.length,
      maxDecodedBytes: 5,
    });
    await vi.waitFor(() => expect(h.requestImpl).toHaveBeenCalled());
    await expect(pending).resolves.toMatchObject({ bytes: Buffer.from('hello') });
  });

  it.each([
    ['gzip', gzipSync],
    ['br', brotliCompressSync],
    ['deflate', deflateSync],
  ] as const)(
    'supports %s and rejects decoded expansion above the cap',
    async (encoding, compress) => {
      const h = harness(200, compress(Buffer.alloc(513, 0x61)));
      h.response.rawHeaders = ['content-encoding', encoding];
      const client = createWebHttpClient({
        lookup: async () => [{ address: '93.184.216.34', family: 4 }],
        request: h.requestImpl as unknown as typeof httpsRequest,
      });
      await expect(client.request(input())).rejects.toMatchObject({
        code: 'web-response-too-large',
      });
      expect(h.response.destroyed).toBe(true);
    },
  );

  it.each([
    ['br', brotliCompressSync],
    ['deflate', deflateSync],
  ] as const)('decodes a bounded %s response', async (encoding, compress) => {
    const h = harness(200, compress(Buffer.from('bounded text')));
    h.response.rawHeaders = ['content-encoding', encoding];
    const client = createWebHttpClient({
      lookup: async () => [{ address: '93.184.216.34', family: 4 }],
      request: h.requestImpl as unknown as typeof httpsRequest,
    });
    const result = await client.request(input());
    expect(Buffer.from(result.bytes).toString()).toBe('bounded text');
  });

  it('safely rejects malformed compressed data', async () => {
    const h = harness(200, Buffer.from('not gzip private data'));
    h.response.rawHeaders = ['content-encoding', 'gzip'];
    const client = createWebHttpClient({
      lookup: async () => [{ address: '93.184.216.34', family: 4 }],
      request: h.requestImpl as unknown as typeof httpsRequest,
    });
    await expect(client.request(input())).rejects.toMatchObject({ code: 'web-network-failed' });
    expect(h.response.destroyed).toBe(true);
  });

  it('cancels during TLS connection without writing request data', async () => {
    const request = new FakeRequest();
    const native = vi.fn(() => request);
    const controller = new AbortController();
    const client = createWebHttpClient({
      lookup: async () => [{ address: '93.184.216.34', family: 4 }],
      request: native as unknown as typeof httpsRequest,
    });
    const pending = client.request({
      ...input(controller.signal),
      method: 'POST',
      body: Buffer.from('private-body'),
    });
    await vi.waitFor(() => expect(native).toHaveBeenCalled());
    request.emit('socket', request.socket);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    request.socket.emit('secureConnect');
    expect(request.writes).toHaveLength(0);
    expect(request.destroyed).toBe(true);
    expect(() => request.socket.emit('error', new Error('late TLS private data'))).not.toThrow();
  });

  it('cancels during decompression and absorbs late stream errors', async () => {
    const h = harness(200, new Uint8Array(), false);
    h.response.rawHeaders = ['content-encoding', 'gzip'];
    const controller = new AbortController();
    const client = createWebHttpClient({
      lookup: async () => [{ address: '93.184.216.34', family: 4 }],
      request: h.requestImpl as unknown as typeof httpsRequest,
    });
    const pending = client.request(input(controller.signal));
    await vi.waitFor(() => expect(h.requestImpl).toHaveBeenCalled());
    h.response.emit('data', gzipSync(Buffer.alloc(512, 0x61)));
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(h.response.destroyed).toBe(true);
    expect(() => h.response.emit('error', new Error('late decode error'))).not.toThrow();
  });

  it.each(['made-up', 'gzip, br'])(
    'rejects unsupported encoding %s before reading body',
    async (encoding) => {
      const h = harness();
      h.response.rawHeaders = ['content-encoding', encoding];
      const client = createWebHttpClient({
        lookup: async () => [{ address: '93.184.216.34', family: 4 }],
        request: h.requestImpl as unknown as typeof httpsRequest,
      });
      await expect(client.request(input())).rejects.toMatchObject({
        code: 'web-content-unsupported',
      });
      expect(h.response.destroyed).toBe(true);
    },
  );

  it.each([
    [Array.from({ length: 65 }, (_, index) => [`x-${index}`, '1']).flat()],
    [['x-big', 'x'.repeat(16_384)]],
    [['content-length', '513']],
  ])('rejects header and declared body limits', async (rawHeaders) => {
    const h = harness();
    h.response.rawHeaders = rawHeaders;
    const client = createWebHttpClient({
      lookup: async () => [{ address: '93.184.216.34', family: 4 }],
      request: h.requestImpl as unknown as typeof httpsRequest,
    });
    await expect(client.request(input())).rejects.toMatchObject({ code: 'web-response-too-large' });
  });

  it('counts actual bytes despite a false small Content-Length and accepts exact byte caps', async () => {
    const h = harness(200, new Uint8Array(513));
    h.response.rawHeaders = ['content-length', '1'];
    const client = createWebHttpClient({
      lookup: async () => [{ address: '93.184.216.34', family: 4 }],
      request: h.requestImpl as unknown as typeof httpsRequest,
    });
    await expect(client.request(input())).rejects.toMatchObject({ code: 'web-response-too-large' });
    const exact = harness(200, new Uint8Array(512));
    const exactClient = createWebHttpClient({
      lookup: async () => [{ address: '93.184.216.34', family: 4 }],
      request: exact.requestImpl as unknown as typeof httpsRequest,
    });
    expect((await exactClient.request(input())).bytes.byteLength).toBe(512);
  });

  it('destroys the request on cancellation and preserves AbortError', async () => {
    const h = harness(200, new Uint8Array(), false);
    const controller = new AbortController();
    const client = createWebHttpClient({
      lookup: async () => [{ address: '93.184.216.34', family: 4 }],
      request: h.requestImpl as unknown as typeof httpsRequest,
    });
    const pending = client.request({
      url: new URL('https://example.com/'),
      method: 'GET',
      headers: {},
      signal: controller.signal,
      maxWireBytes: 512,
      maxDecodedBytes: 512,
    });
    await vi.waitFor(() => expect(h.requestImpl).toHaveBeenCalled());
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(h.request.destroyed).toBe(true);
    expect(() => h.request.emit('error', new Error('late native secret'))).not.toThrow();
    expect(() => h.response.emit('error', new Error('late response secret'))).not.toThrow();
  });

  it('keeps WebToolError messages safe', () => {
    expect(new WebToolError('web-network-failed', 'x'.repeat(301)).message).toHaveLength(300);
  });
});
