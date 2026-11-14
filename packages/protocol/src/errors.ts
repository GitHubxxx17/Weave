import { z } from 'zod';

/**
 * Stable error categories exposed by the LLM boundary.
 *
 * Runtime policies can use these categories to decide whether to retry,
 * change the request, ask for user input, or stop immediately.
 */
export type LlmErrorCode =
  | 'authentication'
  | 'rate-limit'
  | 'timeout'
  | 'network'
  | 'invalid-request'
  | 'context-overflow'
  | 'provider'
  | 'protocol'
  | 'cancelled';

/**
 * Provider-independent error returned by an LLM client.
 *
 * Provider-specific response shapes must be normalized into this structure
 * before they reach Runtime or a control-plane adapter.
 */
export interface LlmError {
  /** Stable category used by retry and user-facing error policies. */
  readonly code: LlmErrorCode;
  /** Sanitized diagnostic message; secrets must not be exposed here. */
  readonly message: string;
  /** Whether retrying the same logical request may be reasonable. */
  readonly retryable: boolean;
  /** Provider identifier when the error originated in a model adapter. */
  readonly provider?: string;
  /** HTTP status when the provider returned an HTTP response. */
  readonly status?: number;
}

/**
 * Validates normalized LLM errors before they cross a process or storage
 * boundary.
 */
export const llmErrorSchema = z
  .object({
    code: z.enum([
      'authentication',
      'rate-limit',
      'timeout',
      'network',
      'invalid-request',
      'context-overflow',
      'provider',
      'protocol',
      'cancelled',
    ]),
    message: z.string(),
    retryable: z.boolean(),
    provider: z.string().optional(),
    status: z.number().finite().optional(),
  })
  .passthrough();
