import { lookup as nodeLookup } from 'node:dns/promises';
import { request as httpsRequest } from 'node:https';
import type { ClientRequest, IncomingMessage } from 'node:http';
import { isIP, type LookupFunction } from 'node:net';
import type { TLSSocket } from 'node:tls';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';
import type { Transform } from 'node:stream';
import { isPublicAddress, sameNetworkAddress } from './address-policy.js';
import { WebToolError } from './errors.js';
import type { Address, HttpResponseData, WebHttpClient } from './types.js';
import { networkHostname, parsePublicHttpsUrl } from './url-policy.js';

function abortError(): DOMException {
  return new DOMException('The web request was cancelled.', 'AbortError');
}
function checkSignal(signal: AbortSignal): void {
  if (signal.aborted) throw abortError();
}
function networkError(): WebToolError {
  return new WebToolError(
    'web-network-failed',
    'The HTTPS request failed. Try the public URL again.',
  );
}
function tooLarge(): WebToolError {
  return new WebToolError(
    'web-response-too-large',
    'The web response exceeds the supported size. Use a smaller page.',
  );
}

async function resolveAddress(
  hostname: string,
  signal: AbortSignal,
  lookup: (hostname: string) => Promise<readonly Address[]>,
): Promise<Address> {
  checkSignal(signal);
  const literal = isIP(hostname);
  if (literal === 4 || literal === 6) return { address: hostname, family: literal };
  const answers = await new Promise<readonly Address[]>((resolve, reject) => {
    const onAbort = () => reject(abortError());
    signal.addEventListener('abort', onAbort, { once: true });
    // Both handlers remain attached even if cancellation wins; late DNS cannot create a socket.
    void Promise.resolve()
      .then(() => {
        checkSignal(signal);
        return lookup(hostname);
      })
      .then(resolve, () =>
        reject(
          signal.aborted
            ? abortError()
            : new WebToolError(
                'web-dns-failed',
                'The public hostname could not be resolved. Try again.',
              ),
        ),
      )
      .finally(() => signal.removeEventListener('abort', onAbort));
  });
  checkSignal(signal);
  if (!Array.isArray(answers) || answers.length === 0 || answers.length > 16)
    throw new WebToolError(
      'web-dns-failed',
      'The public hostname has no supported DNS answer. Try another URL.',
    );
  if (
    answers.some(
      (answer) =>
        typeof answer?.address !== 'string' ||
        (answer.family !== 4 && answer.family !== 6) ||
        isIP(answer.address) !== answer.family ||
        !isPublicAddress(answer.address),
    )
  )
    throw new WebToolError(
      'web-url-blocked',
      'The hostname must resolve only to public addresses. Use a public HTTPS URL.',
    );
  return { ...answers[0]! };
}

const meaningfulHeaders = new Set([
  'content-type',
  'content-encoding',
  'content-disposition',
  'content-length',
  'location',
  'retry-after',
]);
const singletonHeaders = new Set([
  'content-type',
  'content-encoding',
  'content-disposition',
  'content-length',
  'location',
]);
function responseHeaders(response: IncomingMessage): Readonly<Record<string, string>> {
  const raw = response.rawHeaders;
  if (raw.length % 2 !== 0) throw networkError();
  if (raw.length / 2 > 64) throw tooLarge();
  let total = 0;
  const headers: Record<string, string> = {};
  const seen = new Set<string>();
  for (let index = 0; index < raw.length; index += 2) {
    const name = raw[index]!;
    const value = raw[index + 1]!;
    total += Buffer.byteLength(name) + Buffer.byteLength(value) + 4;
    if (total > 16_384) throw tooLarge();
    const key = name.toLowerCase();
    if (singletonHeaders.has(key) && seen.has(key)) throw networkError();
    seen.add(key);
    if (meaningfulHeaders.has(key)) headers[key] = value;
  }
  return headers;
}

function decoderFor(encoding: string | undefined): Transform | undefined {
  switch (encoding?.trim().toLowerCase() ?? 'identity') {
    case 'identity':
      return undefined;
    case 'gzip':
      return createGunzip();
    case 'br':
      return createBrotliDecompress();
    case 'deflate':
      return createInflate();
    default:
      throw new WebToolError(
        'web-content-unsupported',
        'The response encoding is unsupported. Use another page.',
      );
  }
}

export function createWebHttpClient(
  deps: {
    readonly lookup?: (hostname: string) => Promise<readonly Address[]>;
    readonly request?: typeof httpsRequest;
  } = {},
): WebHttpClient {
  const lookup =
    deps.lookup ??
    (async (hostname: string) =>
      nodeLookup(hostname, { all: true, verbatim: true }) as Promise<readonly Address[]>);
  const request = deps.request ?? httpsRequest;
  return {
    async request(input): Promise<HttpResponseData> {
      checkSignal(input.signal);
      const url = parsePublicHttpsUrl(input.url.href);
      const hostname = networkHostname(url);
      if (input.body !== undefined && input.body.byteLength > 4096)
        throw new WebToolError(
          'web-response-too-large',
          'The web request exceeds the supported size. Use a shorter query.',
        );
      if (
        ![input.maxWireBytes, input.maxDecodedBytes].every(
          (bound) => Number.isSafeInteger(bound) && bound >= 0,
        )
      )
        throw networkError();
      const pin = await resolveAddress(hostname, input.signal, lookup);
      checkSignal(input.signal);
      const pinnedLookup: LookupFunction = (_hostname, options, callback) => {
        if (input.signal.aborted) {
          callback(new Error('The web request was cancelled.'), '', pin.family);
          return;
        }
        if (options.all) callback(null, [{ ...pin }]);
        else callback(null, pin.address, pin.family);
      };
      return new Promise<HttpResponseData>((resolve, reject) => {
        let activeRequest: ClientRequest | undefined;
        let activeResponse: IncomingMessage | undefined;
        let decoder: Transform | undefined;
        let settled = false;
        let connected = false;
        const cleanup = () => input.signal.removeEventListener('abort', onAbort);
        const destroy = () => {
          decoder?.destroy();
          activeResponse?.destroy();
          activeRequest?.destroy();
        };
        const fail = (error: WebToolError | DOMException) => {
          if (settled) return;
          settled = true;
          cleanup();
          destroy();
          reject(error);
        };
        const succeed = (result: HttpResponseData) => {
          if (settled) return;
          if (input.signal.aborted) {
            fail(abortError());
            return;
          }
          settled = true;
          cleanup();
          destroy();
          resolve(result);
        };
        const onAbort = () => fail(abortError());
        const onError = (error?: unknown) =>
          fail(
            input.signal.aborted
              ? abortError()
              : typeof error === 'object' &&
                  error !== null &&
                  'code' in error &&
                  error.code === 'HPE_HEADER_OVERFLOW'
                ? tooLarge()
                : networkError(),
          );
        input.signal.addEventListener('abort', onAbort, { once: true });
        try {
          checkSignal(input.signal);
          activeRequest = request(
            {
              protocol: 'https:',
              hostname,
              port: 443,
              path: `${url.pathname}${url.search}`,
              method: input.method,
              headers: { ...input.headers, Host: url.host },
              ...(isIP(hostname) === 0 ? { servername: hostname } : {}),
              rejectUnauthorized: true,
              agent: false,
              lookup: pinnedLookup,
              maxHeaderSize: 16_384,
            },
            (response) => {
              activeResponse = response;
              // Keep native error handlers through destruction, including late callbacks.
              response.on('error', onError);
              if (settled) {
                response.destroy();
                return;
              }
              if (input.signal.aborted) {
                fail(abortError());
                return;
              }
              if (
                !connected ||
                !sameNetworkAddress(response.socket.remoteAddress ?? '', pin.address)
              ) {
                fail(networkError());
                return;
              }
              let headers: Readonly<Record<string, string>>;
              try {
                headers = responseHeaders(response);
              } catch (error) {
                fail(error instanceof WebToolError ? error : networkError());
                return;
              }
              const status = response.statusCode;
              if (status === undefined || status < 100 || status > 599) {
                fail(networkError());
                return;
              }
              if (status < 200 || status >= 300) {
                succeed({ status, headers, bytes: new Uint8Array() });
                return;
              }
              const length = headers['content-length'];
              if (
                length !== undefined &&
                (!/^\d+$/.test(length) || BigInt(length) > BigInt(input.maxWireBytes))
              ) {
                fail(tooLarge());
                return;
              }
              try {
                decoder = decoderFor(headers['content-encoding']);
              } catch (error) {
                fail(error instanceof WebToolError ? error : networkError());
                return;
              }
              const chunks: Buffer[] = [];
              let wireBytes = 0;
              let decodedBytes = 0;
              const decoded = (chunk: Uint8Array) => {
                if (settled) return;
                decodedBytes += chunk.byteLength;
                if (decodedBytes > input.maxDecodedBytes) {
                  fail(tooLarge());
                  return;
                }
                chunks.push(Buffer.from(chunk));
              };
              const complete = () =>
                succeed({ status, headers, bytes: Buffer.concat(chunks, decodedBytes) });
              decoder?.on('error', onError);
              decoder?.on('data', decoded);
              decoder?.on('end', complete);
              response.on('aborted', onError);
              response.on('close', () => {
                if (!response.complete && !settled) onError();
              });
              response.on('data', (chunk: Buffer) => {
                if (settled) return;
                if (input.signal.aborted) {
                  fail(abortError());
                  return;
                }
                wireBytes += chunk.byteLength;
                if (wireBytes > input.maxWireBytes) {
                  fail(tooLarge());
                  return;
                }
                if (decoder === undefined) decoded(chunk);
                else if (!decoder.write(chunk)) {
                  response.pause();
                  decoder.once('drain', () => {
                    if (!settled) response.resume();
                  });
                }
              });
              response.on('end', () => {
                if (settled) return;
                if (decoder === undefined) complete();
                else decoder.end();
              });
            },
          );
          // Installing this listener immediately also absorbs native errors after cancellation.
          activeRequest.on('error', onError);
          activeRequest.on('socket', (socket: TLSSocket) => {
            socket.on('error', onError);
            socket.once('secureConnect', () => {
              if (settled) return;
              if (input.signal.aborted) {
                fail(abortError());
                return;
              }
              if (!sameNetworkAddress(socket.remoteAddress ?? '', pin.address)) {
                fail(networkError());
                return;
              }
              connected = true;
              activeRequest?.end(input.body);
            });
          });
          if (input.signal.aborted) onAbort();
        } catch (error) {
          fail(
            input.signal.aborted
              ? abortError()
              : error instanceof WebToolError
                ? error
                : networkError(),
          );
        }
      });
    },
  };
}
