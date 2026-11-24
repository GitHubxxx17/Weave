const loopback = /^(localhost|127\.0\.0\.1|\[::1\])(?::([0-9]{1,5}))?$/;
const authority = /^(?:[a-z0-9]|[a-z0-9][a-z0-9.-]*[a-z0-9]|\[[0-9a-f:.]+\])(?::([0-9]{1,5}))?$/i;

/** Hosts a listening address may use without requiring an access token. */
export function isLoopbackListenHost(host: string): boolean {
  return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
}

/** True for the wildcard listen addresses that accept every local interface. */
export function isWildcardListenHost(host: string): boolean {
  return host === '0.0.0.0' || host === '::' || host === '[::]';
}

/** No URL normalization may turn a remote or ambiguous authority into loopback. */
export function isLoopbackAuthority(value: string): boolean {
  const match = loopback.exec(value);
  return match !== null && (match[2] === undefined || Number(match[2]) <= 65535);
}

/**
 * Builds the trusted `Host` value for a non-loopback listener.
 *
 * Wildcard listeners cannot know which interface address a client uses, so they
 * trust any hostname on the listening port; the access token still gates every
 * request. A concrete address trusts exactly `<address>:<port>`.
 */
export function createTrustedHost(host: string, port: number): string {
  if (isWildcardListenHost(host)) return `*:${port}`;
  const bracketed = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
  return `${bracketed}:${port}`.toLowerCase();
}

/**
 * Admits loopback authorities and, when configured, the exact trusted `Host`.
 *
 * `trustedHost` is `<host>:<port>` or `*:<port>`. It is supplied only when the
 * Server listens beyond loopback; without it behavior is loopback-only.
 */
export function isTrustedAuthority(value: string, trustedHost?: string): boolean {
  if (isLoopbackAuthority(value)) return true;
  if (trustedHost === undefined) return false;
  const lowered = value.toLowerCase();
  if (!trustedHost.startsWith('*:')) return lowered === trustedHost;
  const match = authority.exec(lowered);
  return match !== null && match[1] === trustedHost.slice(2);
}
