import { isIP } from 'node:net';
import { isPublicAddress } from './address-policy.js';
import { WebToolError } from './errors.js';

function blocked(): never {
  throw new WebToolError(
    'web-url-blocked',
    'Use a public HTTPS URL on port 443 without credentials or fragments.',
  );
}

export function networkHostname(url: URL): string {
  return url.hostname.startsWith('[') ? url.hostname.slice(1, -1) : url.hostname;
}

/** Pure semantic validation; call inside summarize and execute, never a throwing Zod refinement. */
export function parsePublicHttpsUrl(input: string): URL {
  if (
    typeof input !== 'string' ||
    input.length === 0 ||
    input.length > 2048 ||
    Buffer.byteLength(input, 'utf8') > 4096 ||
    input !== input.trim() ||
    /[\\\p{Cc}\p{Cs}]/u.test(input) ||
    input.includes('#')
  )
    blocked();
  // Require explicit authority: WHATWG repairs missing/extra slashes and erases
  // empty userinfo markers before the parsed username/password checks can see them.
  const authority = /^https:\/\/([^/?#]+)/i.exec(input)?.[1];
  if (authority === undefined || authority.includes('@')) blocked();
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    blocked();
  }
  if (
    url.protocol !== 'https:' ||
    url.username !== '' ||
    url.password !== '' ||
    url.port !== '' ||
    url.hash !== ''
  )
    blocked();
  if (url.hostname.endsWith('.')) url.hostname = url.hostname.slice(0, -1);
  const hostname = networkHostname(url);
  const family = isIP(hostname);
  if (family !== 0) {
    if (!isPublicAddress(hostname)) blocked();
  } else {
    if (
      hostname.length > 253 ||
      !hostname.includes('.') ||
      hostname.split('.').some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label)) ||
      ['localhost', 'local', 'internal', 'home.arpa'].some(
        (name) => hostname === name || hostname.endsWith(`.${name}`),
      )
    )
      blocked();
  }
  if (url.href.length > 2048 || Buffer.byteLength(url.href, 'utf8') > 4096) blocked();
  return url;
}
