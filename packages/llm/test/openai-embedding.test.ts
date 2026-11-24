import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EmbeddingClient, EmbeddingInput } from '../src/embedding-types.js';
import {
  createOpenAiEmbeddingClient,
  describeOpenAiEmbeddingBatches as describeBatches,
} from '../src/openai-embedding.js';

const testKey = 'fixture-key';
const testText = 'fixture-text';
const model = 'text-embedding-3-small';
const endpoint = 'https://api.openai.com/v1/embeddings';

const input = (text: string, id = 'chunk') =>
  ({ id, text, sha256: createHash('sha256').update(text).digest('hex') }) satisfies EmbeddingInput;

function payload(
  rows: readonly { index: number; embedding: readonly number[] }[] = [
    { index: 0, embedding: unit(1) },
  ],
) {
  return {
    object: 'list',
    model,
    data: rows.map((row) => ({ object: 'embedding', ...row })),
    usage: { prompt_tokens: 1, total_tokens: 1 },
  };
}

const unit = (...leading: number[]) => [...leading, ...Array<number>(512 - leading.length).fill(0)];

function transport() {
  return vi.fn<typeof fetch>(async () => Response.json(payload()));
}

function options(overrides: Partial<Parameters<EmbeddingClient['embedBatch']>[1]> = {}) {
  return {
    signal: new AbortController().signal,
    deadline: Date.now() + 60_000,
    beforeSendSync: () => undefined,
    ...overrides,
  };
}

function batch(client: EmbeddingClient, ...inputs: EmbeddingInput[]) {
  const [first] = client.describeBatches(inputs.length === 0 ? [input(testText)] : inputs);
  if (first === undefined) throw new Error('Expected one batch');
  return first;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((finish) => {
    resolve = finish;
  });
  return { promise, resolve };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('OpenAI embeddings', () => {
  it('packs and sends one exact fixed OpenAI request', async () => {
    const fetch = transport();
    const client = createOpenAiEmbeddingClient({ apiKey: testKey, fetch });
    const approved = batch(client, input('中\n\\"'));
    expect(describeBatches(approved.inputs)).toEqual([approved]);
    expect(fetch).not.toHaveBeenCalled();
    expect(approved.description).toEqual({
      batch: 0,
      chunkIds: ['chunk'],
      inputDigests: [input('中\n\\"').sha256],
      inputBytes: 6,
      requestBytes: 99,
      requestBodyDigest: '38b5e7c487ae49a815a17580621c8d5e8ce97f897cc4fcad314da3e94b3bce88',
    });
    expect(client.identity).toEqual({
      provider: 'openai',
      endpointId: 'openai.embeddings.v1',
      destination: 'api.openai.com',
      model,
      dimensions: 512,
      adapterVersion: 'weave.openai-embedding.v1',
    });
    expect(Object.isFrozen(approved.description.chunkIds)).toBe(true);
    expect(Object.isFrozen(approved.inputs[0])).toBe(true);

    await client.embedBatch(approved, options());
    expect(fetch).toHaveBeenCalledOnce();
    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(url).toBe(endpoint);
    expect(init).toMatchObject({ method: 'POST', redirect: 'error' });
    expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${testKey}`);
    expect(new Headers(init?.headers).get('content-type')).toBe('application/json');
    expect(init?.body).toBe(
      String.raw`{"model":"text-embedding-3-small","input":["中\n\\\""],"dimensions":512,"encoding_format":"float"}`,
    );
  });

  it('packs 16 inputs and splits before the exact escaped request byte limit', () => {
    const short = Array.from({ length: 17 }, (_, index) => input('😀'.repeat(512), String(index)));
    expect(describeBatches(short).map(({ inputs }) => inputs.length)).toEqual([16, 1]);
    expect(describeBatches([])).toEqual([]);
    const slashes = Array.from({ length: 9 }, (_, index) =>
      input('\\'.repeat(2048), String(index)),
    );
    const exact = describeBatches([...slashes, input('\\'.repeat(1989) + 'x')]);
    expect(exact.map(({ description }) => description.requestBytes)).toEqual([40960]);
    const longer = [...slashes, input('\\'.repeat(1989) + 'xx')];
    const split = describeBatches(longer);
    expect(split.map(({ description }) => description.batch)).toEqual([0, 1]);
    expect(split.flatMap(({ inputs }) => inputs)).toEqual(longer);
    expect(split.map(({ inputs }) => inputs.length)).toEqual([9, 1]);
  });

  it.each(['', 'a'.repeat(2049), '\ud800'])('refuses invalid input bytes %#', (text) => {
    expect(() => describeBatches([input(text)])).toThrow(
      expect.objectContaining({ code: 'invalid-request' }),
    );
  });

  it.each(['', 'key ', 'key\n', '密钥', 'x'.repeat(513)])('refuses invalid key %#', (apiKey) => {
    expect(() => createOpenAiEmbeddingClient({ fetch: transport(), apiKey })).toThrow(
      expect.objectContaining({ code: 'invalid-request' }),
    );
  });

  it('rebuilds request metadata and rejects a false digest before admission', async () => {
    const fetch = transport();
    const client = createOpenAiEmbeddingClient({ apiKey: testKey, fetch });
    const approved = batch(client);
    const beforeSendSync = vi.fn(() => undefined);
    await expect(
      client.embedBatch(
        {
          ...approved,
          description: { ...approved.description, requestBodyDigest: '0'.repeat(64) },
        },
        options({ beforeSendSync }),
      ),
    ).rejects.toMatchObject({ code: 'invalid-request' });
    await expect(
      client.embedBatch(
        {
          ...approved,
          inputs: [{ id: 'chunk', text: 'replaced', sha256: approved.inputs[0]!.sha256 }],
        },
        options({ beforeSendSync }),
      ),
    ).rejects.toMatchObject({ code: 'invalid-request' });
    expect(beforeSendSync).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('restores input order and hashes canonical normalized little-endian Float32 bytes', async () => {
    const fetch = vi.fn<typeof fetch>(
      async () =>
        new Response(
          JSON.stringify(
            payload([
              { index: 1, embedding: unit(0, 1) },
              { index: 0, embedding: unit(3, 4, 0.125) },
            ]),
          ).replace(',0.125,', ',-0,'),
        ),
    );
    const client = createOpenAiEmbeddingClient({ apiKey: testKey, fetch });
    const result = await client.embedBatch(
      batch(client, input('first', 'a'), input('second', 'b')),
      options(),
    );
    expect(result.map(({ id }) => id)).toEqual(['a', 'b']);
    expect(result[0]).toEqual({
      id: 'a',
      values: unit(0.6000000238418579, 0.800000011920929),
      sha256: '2cdd74c082e797454606fd2bd5ac4852cb42e0081ffc90c1890bbc25b24c8065',
    });
    expect(result[1]?.values).toEqual(unit(0, 1));
  });

  it.each([
    ['model', JSON.stringify({ ...payload(), model: 'other' })],
    ['count', JSON.stringify(payload([]))],
    ['dimensions', JSON.stringify(payload([{ index: 0, embedding: [1] }]))],
    ['out-of-range index', JSON.stringify(payload([{ index: 1, embedding: unit(1) }]))],
    [
      'base64 encoding',
      JSON.stringify({
        ...payload(),
        data: [{ object: 'embedding', index: 0, embedding: 'base64' }],
      }),
    ],
    ['zero vector', JSON.stringify(payload([{ index: 0, embedding: unit() }]))],
    ['overflowing norm', JSON.stringify(payload([{ index: 0, embedding: unit(1e200) }]))],
    [
      'inaccurate subnormal norm',
      JSON.stringify(payload([{ index: 0, embedding: unit(2.3e-162) }])),
    ],
    [
      'nonfinite JSON number',
      JSON.stringify(payload([{ index: 0, embedding: unit(1.5) }])).replace('1.5', '1e309'),
    ],
    ['invalid JSON', '{"data":'],
    ['invalid UTF-8', Uint8Array.of(255)],
  ])('rejects %s in a provider response', async (_case, body) => {
    const fetch = vi.fn<typeof fetch>(async () => new Response(body));
    const client = createOpenAiEmbeddingClient({ apiKey: testKey, fetch });
    await expect(client.embedBatch(batch(client), options())).rejects.toMatchObject({
      code: 'protocol',
    });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('rejects duplicate provider indices even when the row count matches', async () => {
    const fetch = vi.fn<typeof fetch>(async () =>
      Response.json(
        payload([
          { index: 0, embedding: unit(1) },
          { index: 0, embedding: unit(1) },
        ]),
      ),
    );
    const client = createOpenAiEmbeddingClient({ apiKey: testKey, fetch });
    await expect(
      client.embedBatch(batch(client, input('first', 'a'), input('second', 'b')), options()),
    ).rejects.toMatchObject({ code: 'protocol' });
  });

  it('enforces the observed response size and cancels the overflowing reader', async () => {
    const encoded = Buffer.from(JSON.stringify(payload()));
    const padding = Buffer.alloc(2_097_152 - encoded.byteLength, 32);
    const cancelled = vi.fn();
    const overflow = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoded);
        controller.enqueue(padding);
        controller.enqueue(Uint8Array.of(32));
      },
      cancel: cancelled,
    });
    const fetch = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(Buffer.concat([encoded, padding])))
      .mockResolvedValueOnce(new Response(overflow, { headers: { 'content-length': '1' } }));
    const client = createOpenAiEmbeddingClient({ apiKey: testKey, fetch });
    await expect(client.embedBatch(batch(client), options())).resolves.toHaveLength(1);
    await expect(client.embedBatch(batch(client), options())).rejects.toMatchObject({
      code: 'protocol',
    });
    expect(cancelled).toHaveBeenCalledOnce();
    expect(overflow.locked).toBe(false);
  });

  it.each([
    [401, 'authentication'],
    [429, 'rate-limit'],
    [500, 'provider'],
  ] as const)(
    'classifies HTTP %i and cancels diagnostics without returning their contents',
    async (status, code) => {
      const cancelled = vi.fn();
      const body = new ReadableStream({ cancel: cancelled });
      const fetch = vi.fn<typeof fetch>(
        async () =>
          new Response(body, {
            status,
            statusText: `${testKey} ${testText}`,
          }),
      );
      const client = createOpenAiEmbeddingClient({ apiKey: testKey, fetch });
      const error = await client
        .embedBatch(batch(client), options())
        .catch((caught: unknown) => caught);
      expect(error).toMatchObject({ code, status, retryable: false });
      expect(JSON.stringify(error)).not.toMatch(/fixture-key|fixture-text/);
      expect(cancelled).toHaveBeenCalledOnce();
      expect(fetch).toHaveBeenCalledOnce();
    },
  );

  it.each(['fetch', 'reader'] as const)('removes secrets from a %s failure', async (kind) => {
    const cause = { code: 'protocol', message: `${testKey} ${testText}` };
    const fetch = vi.fn<typeof fetch>(async () => {
      if (kind === 'fetch') throw cause;
      const body = new ReadableStream({ start: (controller) => controller.error(cause) });
      return new Response(body);
    });
    const client = createOpenAiEmbeddingClient({ apiKey: testKey, fetch });
    const error = await client
      .embedBatch(batch(client), options())
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: 'network', retryable: false });
    expect(JSON.stringify(error)).not.toMatch(/fixture-key|fixture-text/);
    expect(error).not.toHaveProperty('cause');
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('holds two shared slots through response reading and honors a queued revocation', async () => {
    const response = new TextEncoder().encode(JSON.stringify(payload()));
    const bodies: ReadableStreamDefaultController<Uint8Array>[] = [];
    let admitMicrotask = false;
    const fetch = vi.fn<typeof fetch>(async () => {
      expect(admitMicrotask).toBe(false);
      return new Response(
        new ReadableStream<Uint8Array>({
          start: (controller) => {
            bodies.push(controller);
          },
        }),
      );
    });
    const client = createOpenAiEmbeddingClient({ apiKey: testKey, fetch });
    const first = client.embedBatch(batch(client, input('first')), options());
    const second = client.embedBatch(batch(client, input('second')), options());
    const revoked = new Error('authority revoked');
    const beforeSendSync = vi.fn((): undefined => {
      throw revoked;
    });
    const third = client.embedBatch(batch(client, input('third')), options({ beforeSendSync }));
    const rejected = expect(third).rejects.toBe(revoked);
    const queryAdmission = vi.fn(() => {
      queueMicrotask(() => {
        admitMicrotask = true;
      });
      return undefined;
    });
    const query = client.embedBatch(
      batch(client, input('query')),
      options({ beforeSendSync: queryAdmission }),
    );
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    expect(beforeSendSync).not.toHaveBeenCalled();
    expect(queryAdmission).not.toHaveBeenCalled();
    bodies[0]!.enqueue(response);
    bodies[0]!.close();
    await first;
    await rejected;
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(3));
    expect(queryAdmission).toHaveBeenCalledOnce();
    expect(admitMicrotask).toBe(true);
    for (const body of bodies.slice(1)) {
      body.enqueue(response);
      body.close();
    }
    await Promise.all([second, query]);
  });

  it('rejects a callback returning a Promise without a fetch', async () => {
    const fetch = transport();
    const client = createOpenAiEmbeddingClient({ apiKey: testKey, fetch });
    const callback = (() =>
      Promise.reject(new Error('unsafe callback result'))) as unknown as () => undefined;
    await expect(
      client.embedBatch(batch(client), options({ beforeSendSync: callback })),
    ).rejects.toMatchObject({
      code: 'invalid-request',
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('uses the approved bytes even if a caller mutates the queued batch', async () => {
    const held = deferred<void>();
    let sends = 0;
    const fetch = vi.fn<typeof globalThis.fetch>(async () => {
      sends += 1;
      if (sends <= 2) await held.promise;
      return Response.json(payload());
    });
    const client = createOpenAiEmbeddingClient({ apiKey: testKey, fetch });
    const heldRequests = [
      client.embedBatch(batch(client, input('first')), options()),
      client.embedBatch(batch(client, input('second')), options()),
    ];
    const approved = batch(client, input('approved'));
    const queued = { description: { ...approved.description }, inputs: [{ ...input('approved') }] };
    const admission = vi.fn(() => undefined);
    const pending = client.embedBatch(queued, options({ beforeSendSync: admission }));
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    queued.inputs[0]!.text = 'replacement';
    queued.description.requestBodyDigest = '0'.repeat(64);
    held.resolve();
    await Promise.all([...heldRequests, pending]);

    expect(admission).toHaveBeenCalledWith(approved.description);
    const [, init] = fetch.mock.calls[2] ?? [];
    expect(JSON.parse(String(init?.body))).toMatchObject({ input: ['approved'] });
  });

  it('honors queued abort and absolute deadlines without spending a slot', async () => {
    vi.useFakeTimers();
    const held = deferred<void>();
    const fetch = vi.fn<typeof fetch>(async () => {
      await held.promise;
      return Response.json(payload());
    });
    const client = createOpenAiEmbeddingClient({ apiKey: testKey, fetch });
    const first = client.embedBatch(batch(client), options());
    const second = client.embedBatch(batch(client), options());
    const controller = new AbortController();
    const beforeSendSync = vi.fn(() => undefined);
    const aborted = expect(
      client.embedBatch(
        batch(client),
        options({
          signal: controller.signal,
          beforeSendSync,
        }),
      ),
    ).rejects.toMatchObject({ code: 'cancelled' });
    const timedOut = expect(
      client.embedBatch(
        batch(client),
        options({
          deadline: Date.now() + 5,
          beforeSendSync,
        }),
      ),
    ).rejects.toMatchObject({ code: 'timeout' });
    controller.abort(testText);
    await vi.advanceTimersByTimeAsync(5);
    await Promise.all([aborted, timedOut]);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(beforeSendSync).not.toHaveBeenCalled();
    held.resolve();
    await Promise.all([first, second]);
    await expect(client.embedBatch(batch(client), options())).resolves.toHaveLength(1);
  });

  it('aborts transport at the request timeout and never repeats a send', async () => {
    vi.useFakeTimers();
    const fetch = vi.fn<typeof fetch>(
      async (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error(testText)), {
            once: true,
          });
        }),
    );
    const client = createOpenAiEmbeddingClient({ apiKey: testKey, fetch });
    const result = expect(client.embedBatch(batch(client), options())).rejects.toMatchObject({
      code: 'timeout',
      retryable: false,
    });
    await vi.advanceTimersByTimeAsync(30_000);
    await result;
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('fences sends synchronously and holds drain until actual response cleanup', async () => {
    const released = deferred<void>();
    const cancel = vi.fn(() => released.promise);
    const fetch = vi.fn<typeof fetch>(async () => new Response(new ReadableStream({ cancel })));
    const client = createOpenAiEmbeddingClient({ apiKey: testKey, fetch });
    const approved = batch(client);
    const first = expect(client.embedBatch(approved, options())).rejects.toMatchObject({
      code: 'cancelled',
    });
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    client.closeSync();
    expect(cancel).not.toHaveBeenCalled();
    await expect(client.embedBatch(approved, options())).rejects.toMatchObject({
      code: 'cancelled',
    });
    let drained = false;
    const draining = client.drain().then(() => {
      drained = true;
    });
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());
    expect(drained).toBe(false);
    released.resolve();
    await Promise.all([first, draining]);
    expect(drained).toBe(true);
    await client.close();
  });

  it('retains an unfinished transport across a timed out drain', async () => {
    vi.useFakeTimers();
    const held = deferred<Response>();
    const fetch = vi.fn<typeof fetch>(() => held.promise);
    const client = createOpenAiEmbeddingClient({ apiKey: testKey, fetch });
    const first = expect(client.embedBatch(batch(client), options())).rejects.toMatchObject({
      code: 'cancelled',
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(fetch).toHaveBeenCalledOnce();
    const timeout = expect(client.drain()).rejects.toMatchObject({ code: 'timeout' });
    await vi.advanceTimersByTimeAsync(30_000);
    await timeout;
    let drained = false;
    const retry = client.close().then(() => {
      drained = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(drained).toBe(false);
    const cancel = vi.fn();
    held.resolve(new Response(new ReadableStream({ cancel })));
    await Promise.all([first, retry]);
    expect(drained).toBe(true);
    expect(cancel).toHaveBeenCalledOnce();
  });
});
