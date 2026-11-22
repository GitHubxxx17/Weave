export type WebErrorCode =
  | 'web-search-not-configured'
  | 'web-config-invalid'
  | 'web-url-blocked'
  | 'web-dns-failed'
  | 'web-network-failed'
  | 'web-timeout'
  | 'web-redirect-blocked'
  | 'web-http-error'
  | 'web-search-auth-failed'
  | 'web-rate-limited'
  | 'web-search-quota-exceeded'
  | 'web-provider-response-invalid'
  | 'web-content-unsupported'
  | 'web-response-too-large'
  | 'web-result-too-large';

/** Safe, plugin-owned details only; never attach native/provider error causes. */
export class WebToolError extends Error {
  readonly code: WebErrorCode;

  constructor(code: WebErrorCode, message: string) {
    super(message.slice(0, 300));
    this.name = 'WebToolError';
    this.code = code;
  }
}
