import { createHash } from 'node:crypto';
import { retrievalLimits, type RetrievalEmbeddingBatchDescription } from '@weave/protocol';
import { z } from 'zod';
import type {
  EmbeddingBatch,
  EmbeddingClient,
  EmbeddingInput,
  EmbeddingVector,
} from './embedding-types.js';
import { createLlmError } from './errors.js';
import type { LlmError, LlmErrorCode } from './types.js';

const endpoint = 'https://api.openai.com/v1/embeddings';
const identity = Object.freeze({
  provider: 'openai',
  endpointId: 'openai.embeddings.v1',
  destination: 'api.openai.com',
  model: 'text-embedding-3-small',
  dimensions: retrievalLimits.embeddingDimensions,
  adapterVersion: 'weave.openai-embedding.v1',
} as const satisfies EmbeddingClient['identity']);

const {
  maxChunks,
  maxEmbeddingBatch: maxInputs,
  maxChunkBytes: maxInputBytes,
  maxEmbeddingRequestBytes: maxRequestBytes,
  maxEmbeddingResponseBytes: maxResponseBytes,
  maxEmbeddingRequests: maxRequests,
  maxEmbeddingRequestMs: requestTimeoutMs,
} = retrievalLimits;

const digestSchema = z
  .string()
  .regex(/^[0-9a-f]{64}$/u)
  .length(64);
const keySchema = z
  .string()
  .min(1)
  .max(512)
  .refine((key) => !/[^\x21-\x7e]/u.test(key));
const inputSchema = z.strictObject({
  id: z.string().min(1),
  text: z.string().min(1).max(maxInputBytes),
  sha256: digestSchema,
});
const batchInputSchema = z.array(inputSchema).min(1).max(maxInputs);
const batchDescriptionSchema = z.strictObject({
  batch: z
    .number()
    .int()
    .nonnegative()
    .max(maxChunks - 1),
  chunkIds: z.array(z.string()).min(1).max(maxInputs),
  inputDigests: z.array(digestSchema).min(1).max(maxInputs),
  inputBytes: z.number().int().positive(),
  requestBytes: z.number().int().positive().max(maxRequestBytes),
  requestBodyDigest: digestSchema,
});
const approvedBatchSchema = z.strictObject({
  inputs: batchInputSchema,
  description: batchDescriptionSchema,
});
const providerVectorSchema = z
  .custom<unknown[]>((value) => Array.isArray(value) && value.length === identity.dimensions)
  .pipe(z.array(z.number().finite()));
const providerRowsSchema = z
  .custom<unknown[]>((value) => Array.isArray(value) && value.length <= maxInputs)
  .pipe(
    z.array(
      z.object({
        object: z.literal('embedding'),
        index: z.number().int().nonnegative(),
        embedding: providerVectorSchema,
      }),
    ),
  );
const responseSchema = z.object({
  object: z.literal('list'),
  model: z.literal(identity.model),
  data: providerRowsSchema,
});

export interface OpenAiEmbeddingClientOptions {
  readonly apiKey: string;
  /** Transport injection for host tests. The endpoint and request policy stay fixed. */
  readonly fetch?: typeof fetch;
}

const errorMessages: Readonly<Record<LlmErrorCode, string>> = {
  authentication: 'Embedding authentication failed',
  'rate-limit': 'Embedding provider rate limit reached',
  timeout: 'Embedding request timed out',
  network: 'Embedding transport failed',
  'invalid-request': 'Embedding request is invalid',
  'context-overflow': 'Embedding inputs exceed provider limits',
  provider: 'Embedding provider request failed',
  protocol: 'Embedding provider response is invalid',
  cancelled: 'Embedding request was cancelled',
};

function embeddingError(code: LlmErrorCode, status?: number): LlmError {
  return createLlmError({
    code,
    message: errorMessages[code],
    provider: identity.provider,
    retryable: false,
    ...(status === undefined ? {} : { status }),
  });
}

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function assertExactInput(input: EmbeddingInput): void {
  // Lone surrogates would be replaced in the raw UTF-8 digest, allowing distinct
  // serialized strings to share that digest.
  if (
    /[\uD800-\uDFFF]/u.test(input.text) ||
    Buffer.byteLength(input.text, 'utf8') > maxInputBytes ||
    sha256(input.text) !== input.sha256
  ) {
    throw embeddingError('invalid-request');
  }
}

function serializeRequest(inputs: readonly EmbeddingInput[]): string {
  return JSON.stringify({
    model: identity.model,
    input: inputs.map(({ text }) => text),
    dimensions: identity.dimensions,
    encoding_format: 'float',
  });
}

function describeBatch(
  batch: number,
  inputs: readonly EmbeddingInput[],
  body: string,
): RetrievalEmbeddingBatchDescription {
  return Object.freeze({
    batch,
    chunkIds: Object.freeze(inputs.map(({ id }) => id)),
    inputDigests: Object.freeze(inputs.map(({ sha256 }) => sha256)),
    inputBytes: inputs.reduce((total, { text }) => total + Buffer.byteLength(text, 'utf8'), 0),
    requestBytes: Buffer.byteLength(body, 'utf8'),
    requestBodyDigest: sha256(body),
  });
}

/** Packs the exact ordered wire inputs without credentials, side effects, or a raw body result. */
export function describeOpenAiEmbeddingBatches(
  inputs: readonly EmbeddingInput[],
): readonly EmbeddingBatch[] {
  if (!Array.isArray(inputs) || inputs.length > maxChunks) throw embeddingError('invalid-request');
  const batches: EmbeddingBatch[] = [];
  let current: EmbeddingInput[] = [];
  let body = '';

  function flush(): void {
    batches.push(
      Object.freeze({
        description: describeBatch(batches.length, current, body),
        inputs: Object.freeze(current),
      }),
    );
    current = [];
  }

  for (const input of inputs) {
    const parsed = inputSchema.safeParse(input);
    if (!parsed.success) throw embeddingError('invalid-request');
    assertExactInput(parsed.data);
    const snapshot = Object.freeze(parsed.data);

    if (current.length === maxInputs) flush();
    let candidate = serializeRequest([...current, snapshot]);
    if (current.length > 0 && Buffer.byteLength(candidate, 'utf8') > maxRequestBytes) {
      flush();
      candidate = serializeRequest([snapshot]);
    }
    if (Buffer.byteLength(candidate, 'utf8') > maxRequestBytes) {
      throw embeddingError('invalid-request');
    }
    current.push(snapshot);
    body = candidate;
  }
  if (current.length > 0) flush();
  return Object.freeze(batches);
}

function encodeApprovedBatch(batch: EmbeddingBatch) {
  const parsed = approvedBatchSchema.safeParse(batch);
  if (!parsed.success) throw embeddingError('invalid-request');

  const inputs = parsed.data.inputs;
  const supplied = parsed.data.description;
  for (const input of inputs) assertExactInput(input);
  const body = serializeRequest(inputs);
  const description = describeBatch(supplied.batch, inputs, body);
  if (
    description.requestBytes > maxRequestBytes ||
    supplied.requestBytes !== description.requestBytes ||
    supplied.inputBytes !== description.inputBytes ||
    supplied.requestBodyDigest !== description.requestBodyDigest ||
    supplied.chunkIds.length !== inputs.length ||
    supplied.inputDigests.length !== inputs.length ||
    inputs.some(
      ({ id, sha256 }, index) =>
        supplied.chunkIds[index] !== id || supplied.inputDigests[index] !== sha256,
    )
  ) {
    throw embeddingError('invalid-request');
  }
  return { inputs, body, description };
}

function statusCode(status: number): LlmErrorCode {
  if (status === 401 || status === 403) return 'authentication';
  if (status === 429) return 'rate-limit';
  if (status === 400 || status === 422) return 'invalid-request';
  if (status === 413) return 'context-overflow';
  return 'provider';
}

function assertTime(deadline: number): void {
  if (Date.now() >= deadline) throw embeddingError('timeout');
}

function scheduleDeadline(deadline: number, expire: () => void): () => void {
  let timer: ReturnType<typeof setTimeout>;
  const arm = (): void => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      expire();
      return;
    }
    timer = setTimeout(arm, Math.min(remaining, 2_147_483_647));
  };
  timer = setTimeout(arm, Math.min(Math.max(0, deadline - Date.now()), 2_147_483_647));
  return () => clearTimeout(timer);
}

async function readResponse(
  response: Response,
  signal: AbortSignal,
  assertCurrent: () => void,
): Promise<unknown> {
  if (!response.ok || response.redirected) {
    await response.body?.cancel().catch(() => undefined);
    assertCurrent();
    throw embeddingError(statusCode(response.status), response.status);
  }
  if (response.body === null) {
    assertCurrent();
    throw embeddingError('protocol');
  }

  const reader = response.body.getReader();
  let cancellation: Promise<void> | undefined;
  const cancel = (): void => {
    cancellation ??= reader.cancel().catch(() => undefined);
  };
  signal.addEventListener('abort', cancel, { once: true });
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let size = 0;
  let json = '';
  let eof = false;
  try {
    assertCurrent();
    while (!eof) {
      const frame = await reader.read().catch(() => {
        assertCurrent();
        throw embeddingError('network');
      });
      assertCurrent();
      if (frame.done) {
        eof = true;
        break;
      }
      size += frame.value.byteLength;
      if (size > maxResponseBytes) throw embeddingError('protocol');
      try {
        json += decoder.decode(frame.value, { stream: true });
      } catch {
        throw embeddingError('protocol');
      }
    }
    try {
      return JSON.parse(json + decoder.decode()) as unknown;
    } catch {
      throw embeddingError('protocol');
    }
  } finally {
    signal.removeEventListener('abort', cancel);
    if (!eof) cancel();
    await cancellation;
    reader.releaseLock();
  }
}

function normalizeVector(id: string, embedding: readonly number[]): EmbeddingVector {
  let sumSquares = 0;
  for (const value of embedding) sumSquares += value * value;
  const norm = Math.sqrt(sumSquares);
  if (norm === 0 || !Number.isFinite(norm)) throw embeddingError('protocol');

  const bytes = Buffer.alloc(identity.dimensions * 4);
  let normalizedSumSquares = 0;
  const values = embedding.map((value, index) => {
    const rounded = Math.fround(value / norm);
    if (!Number.isFinite(rounded)) throw embeddingError('protocol');
    const normalized = rounded === 0 ? 0 : rounded;
    normalizedSumSquares += normalized * normalized;
    bytes.writeFloatLE(normalized, index * 4);
    return normalized;
  });
  // Subnormal squared values may round before the norm is computed.
  if (Math.abs(normalizedSumSquares - 1) > 1e-6) throw embeddingError('protocol');
  return Object.freeze({ id, values: Object.freeze(values), sha256: sha256(bytes) });
}

function mapResponse(
  payload: unknown,
  inputs: readonly EmbeddingInput[],
): readonly EmbeddingVector[] {
  const parsed = responseSchema.safeParse(payload);
  if (!parsed.success || parsed.data.data.length !== inputs.length) {
    throw embeddingError('protocol');
  }
  const vectors: EmbeddingVector[] = [];
  for (const { index, embedding } of parsed.data.data) {
    const input = inputs[index];
    if (input === undefined || vectors[index] !== undefined) throw embeddingError('protocol');
    vectors[index] = normalizeVector(input.id, embedding);
  }
  return Object.freeze(vectors);
}

/** Creates one host-owned OpenAI client. All its users share the same two transport slots. */
export function createOpenAiEmbeddingClient(
  options: OpenAiEmbeddingClientOptions,
): EmbeddingClient {
  const credential = keySchema.safeParse(options.apiKey);
  if (!credential.success) throw embeddingError('invalid-request');
  const apiKey = credential.data;
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const shutdown = new AbortController();
  const waiters = new Set<() => void>();
  const operations = new Set<Promise<readonly EmbeddingVector[]>>();
  let closed = false;
  let inFlight = 0;

  function assertOpen(): void {
    if (closed) throw embeddingError('cancelled');
  }

  function releaseSlot(): void {
    inFlight -= 1;
    for (const wake of waiters) {
      if (inFlight === maxRequests) break;
      wake();
    }
  }

  function acquireSlot(signal: AbortSignal, deadline: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const expire = (): void => fail('timeout');
      const abort = (): void => fail('cancelled');
      const stopTimer = scheduleDeadline(deadline, expire);

      function cleanup(): void {
        stopTimer();
        signal.removeEventListener('abort', abort);
        waiters.delete(wake);
      }

      function fail(code: LlmErrorCode): void {
        cleanup();
        reject(embeddingError(code));
      }

      function wake(): void {
        if (signal.aborted || closed) {
          abort();
        } else if (Date.now() >= deadline) {
          expire();
        } else {
          cleanup();
          inFlight += 1;
          resolve();
        }
      }

      if (inFlight < maxRequests || signal.aborted || closed) {
        wake();
      } else {
        waiters.add(wake);
        signal.addEventListener('abort', abort, { once: true });
      }
    });
  }

  async function executeBatch(
    batch: EmbeddingBatch,
    { signal, deadline, beforeSendSync }: Parameters<EmbeddingClient['embedBatch']>[1],
  ): Promise<readonly EmbeddingVector[]> {
    assertOpen();
    if (!Number.isSafeInteger(deadline) || typeof beforeSendSync !== 'function') {
      throw embeddingError('invalid-request');
    }
    const waitingSignal = AbortSignal.any([signal, shutdown.signal]);
    if (waitingSignal.aborted) throw embeddingError('cancelled');
    assertTime(deadline);
    const { inputs, body, description } = encodeApprovedBatch(batch);
    await acquireSlot(waitingSignal, deadline);

    const requestDeadline = Math.min(deadline, Date.now() + requestTimeoutMs);
    const timeout = new AbortController();
    const requestSignal = AbortSignal.any([waitingSignal, timeout.signal]);
    const stopTimer = scheduleDeadline(requestDeadline, () => timeout.abort());
    function assertCurrent(): void {
      assertOpen();
      if (waitingSignal.aborted) throw embeddingError('cancelled');
      if (timeout.signal.aborted) throw embeddingError('timeout');
      assertTime(requestDeadline);
    }

    try {
      const init: RequestInit = {
        method: 'POST',
        redirect: 'error',
        headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
        body,
        signal: requestSignal,
      };
      assertCurrent();
      const result: unknown = beforeSendSync(description);
      if (result !== undefined) {
        if (result instanceof Promise) void result.catch(() => undefined);
        throw embeddingError('invalid-request');
      }
      // Authorization and the transport invocation run on the same call stack.
      assertCurrent();
      let response: Response;
      try {
        response = await fetchImpl(endpoint, init);
      } catch {
        assertCurrent();
        throw embeddingError('network');
      }
      const payload = await readResponse(response, requestSignal, assertCurrent);
      const vectors = mapResponse(payload, inputs);
      assertCurrent();
      return vectors;
    } finally {
      stopTimer();
      releaseSlot();
    }
  }

  function closeSync(): void {
    closed = true;
  }

  async function drain(): Promise<void> {
    closeSync();
    shutdown.abort();
    if (operations.size === 0) return;
    const finished = Promise.allSettled(operations);
    let stopTimer: () => void = () => undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      stopTimer = scheduleDeadline(Date.now() + requestTimeoutMs, () =>
        reject(embeddingError('timeout')),
      );
    });
    try {
      await Promise.race([finished, deadline]);
    } finally {
      stopTimer();
    }
  }

  return Object.freeze({
    identity,
    describeBatches(inputs: readonly EmbeddingInput[]) {
      assertOpen();
      return describeOpenAiEmbeddingBatches(inputs);
    },
    embedBatch(
      batch: EmbeddingBatch,
      runtimeOptions: Parameters<EmbeddingClient['embedBatch']>[1],
    ) {
      const operation = executeBatch(batch, runtimeOptions);
      operations.add(operation);
      const forget = (): void => {
        operations.delete(operation);
      };
      void operation.then(forget, forget);
      return operation;
    },
    closeSync,
    drain,
    close: drain,
  });
}
