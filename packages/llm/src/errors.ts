import type { LlmError, LlmErrorCode } from '@weave/protocol';

const retryableByCode: Readonly<Record<LlmErrorCode, boolean>> = {
  authentication: false,
  'invalid-request': false,
  'context-overflow': false,
  cancelled: false,
  'rate-limit': true,
  timeout: true,
  network: true,
  provider: false,
  protocol: false,
};

function sanitizeMessage(message: string): string {
  const withoutControlCharacters = Array.from(message, (character) =>
    character.charCodeAt(0) <= 0x1f || character.charCodeAt(0) === 0x7f ? ' ' : character,
  ).join('');

  return withoutControlCharacters
    .replace(/authorization\s*:\s*bearer\s+\S+/gi, 'authorization: [redacted]')
    .replace(/bearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/(?:api[-_ ]?key|apikey)\s*[:=]\s*\S+/gi, 'api-key: [redacted]')
    .replace(/\bsk-[A-Za-z0-9_-]+\b/g, '[redacted]');
}

/**
 * Creates a normalized LLM error and applies the default retry policy.
 *
 * Diagnostic messages are sanitized before returning so provider responses
 * cannot accidentally expose authorization headers or API keys.
 *
 * @param input Provider-independent error data with an optional retry override.
 * @returns A normalized, secret-sanitized LLM error.
 */
export function createLlmError(
  input: Omit<LlmError, 'retryable'> & { readonly retryable?: boolean },
): LlmError {
  const { retryable, message, ...rest } = input;

  return {
    ...rest,
    message: sanitizeMessage(message),
    retryable: retryable ?? retryableByCode[input.code],
  };
}
