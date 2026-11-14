import type { LlmRequest, StreamEvent } from '@weave/protocol';
import type { LlmStreamOptions } from './types.js';

export interface LlmClient {
  stream(request: LlmRequest, options?: LlmStreamOptions): AsyncIterable<StreamEvent>;
}
