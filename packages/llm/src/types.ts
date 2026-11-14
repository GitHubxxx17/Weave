export type { LlmError, LlmErrorCode, LlmRequest, StreamEvent } from '@weave/protocol';

/**
 * Parser state carried between arbitrary network chunks.
 *
 * A network chunk is not guaranteed to end at an SSE frame boundary, so the
 * parser retains incomplete data here until the next chunk arrives.
 */
export interface SseParserState {
  readonly buffer: string;
}

/** One complete SSE frame after its `data:` lines have been joined. */
export interface ParsedSseFrame {
  readonly data: string;
}

/**
 * Controls cancellation and timeout behavior for an LLM stream.
 */
export interface LlmStreamOptions {
  /** Cancels the provider request when aborted. */
  readonly signal?: AbortSignal;
  /** Maximum request duration in milliseconds. */
  readonly timeoutMs?: number;
}
