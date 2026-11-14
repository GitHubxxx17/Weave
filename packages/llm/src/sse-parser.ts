import type { ParsedSseFrame, SseParserState } from './types.js';

const frameBoundaryPattern = /\r\n\r\n|\n\n/;

/**
 * Extracts one complete SSE frame from a frame-sized string.
 *
 * SSE allows multiple `data:` lines and comment lines. The parser keeps only
 * data lines and joins them with newlines according to the event-stream model.
 */
function parseFrame(frame: string): ParsedSseFrame | undefined {
  const dataLines = frame
    .split(/\r?\n/)
    .filter((line) => line !== '' && !line.startsWith(':'))
    .filter((line) => line.startsWith('data:'))
    .map((line) => (line.startsWith('data: ') ? line.slice(6) : line.slice(5)));

  return dataLines.length > 0 ? { data: dataLines.join('\n') } : undefined;
}

function parseCompleteFrames(buffer: string): {
  readonly buffer: string;
  readonly frames: readonly ParsedSseFrame[];
} {
  const frames: ParsedSseFrame[] = [];
  let remaining = buffer;

  while (true) {
    const boundary = frameBoundaryPattern.exec(remaining);
    if (boundary === null) {
      break;
    }

    const frame = parseFrame(remaining.slice(0, boundary.index));
    if (frame !== undefined) {
      frames.push(frame);
    }
    remaining = remaining.slice(boundary.index + boundary[0].length);
  }

  return { buffer: remaining, frames };
}

export function createSseParserState(): SseParserState {
  return { buffer: '' };
}

/**
 * Pushes one arbitrary network chunk into the SSE parser.
 *
 * Chunks may split a frame at any byte boundary, so incomplete content is
 * returned as the next parser state instead of being emitted prematurely.
 *
 * @param state State returned by the previous parser call.
 * @param chunk Decoded text from the latest network chunk.
 * @returns The new parser state and every complete frame found in the chunk.
 */
export function pushSseChunk(
  state: SseParserState,
  chunk: string,
): {
  readonly state: SseParserState;
  readonly frames: readonly ParsedSseFrame[];
} {
  const parsed = parseCompleteFrames(state.buffer + chunk);
  return {
    state: { buffer: parsed.buffer },
    frames: parsed.frames,
  };
}

/**
 * Flushes the parser at stream end.
 *
 * This handles a final frame that has no trailing blank line while preserving
 * the same frame parsing rules as `pushSseChunk`.
 */
export function flushSseParser(state: SseParserState): {
  readonly state: SseParserState;
  readonly frames: readonly ParsedSseFrame[];
} {
  const frame = parseFrame(state.buffer);
  return {
    state: { buffer: '' },
    frames: frame === undefined ? [] : [frame],
  };
}

/**
 * Decodes UTF-8 chunks while preserving multi-byte characters split across
 * chunk boundaries.
 */
export function decodeSseChunks(chunks: Iterable<Uint8Array>): string {
  const decoder = new TextDecoder();
  let decoded = '';

  for (const chunk of chunks) {
    decoded += decoder.decode(chunk, { stream: true });
  }

  return decoded + decoder.decode();
}
