import type { ParsedSseFrame, SseParserState } from './types.js';

const frameBoundaryPattern = /\r\n\r\n|\n\n/;

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

export function decodeSseChunks(chunks: Iterable<Uint8Array>): string {
  const decoder = new TextDecoder();
  let decoded = '';

  for (const chunk of chunks) {
    decoded += decoder.decode(chunk, { stream: true });
  }

  return decoded + decoder.decode();
}
