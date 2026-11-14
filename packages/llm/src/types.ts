export type { LlmError, LlmErrorCode, LlmRequest, StreamEvent } from '@weave/protocol';

export interface SseParserState {
  readonly buffer: string;
}

export interface ParsedSseFrame {
  readonly data: string;
}

export interface LlmStreamOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}
