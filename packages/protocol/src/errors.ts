import { z } from 'zod';

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

export interface LlmError {
  readonly code: LlmErrorCode;
  readonly message: string;
  readonly retryable: boolean;
  readonly provider?: string;
  readonly status?: number;
}

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
