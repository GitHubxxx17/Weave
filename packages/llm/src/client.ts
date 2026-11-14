import type { LlmRequest, StreamEvent } from '@weave/protocol';
import type { LlmStreamOptions } from './types.js';

/**
 * Provider-independent streaming interface used by Runtime.
 *
 * Implementations may use different provider SDKs or wire protocols, but they
 * must expose the same normalized `StreamEvent` sequence to callers.
 */
export interface LlmClient {
  /**
   * Streams normalized model events for one request.
   *
   * @param request Provider-independent model request.
   * @param options Cancellation and timeout controls for this stream.
   * @returns An async iterable of normalized model events.
   */
  stream(request: LlmRequest, options?: LlmStreamOptions): AsyncIterable<StreamEvent>;
}
