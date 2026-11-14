export interface SseParserState {
  readonly buffer: string;
}

export interface ParsedSseFrame {
  readonly data: string;
}
