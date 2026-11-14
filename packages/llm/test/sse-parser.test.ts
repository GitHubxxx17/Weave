import { describe, expect, it } from 'vitest';
import {
  createSseParserState,
  decodeSseChunks,
  flushSseParser,
  pushSseChunk,
} from '../src/index.js';

describe('SSE parser', () => {
  it('parses one complete data frame', () => {
    const result = pushSseChunk(createSseParserState(), 'data: {"value":1}\n\n');

    expect(result.frames).toEqual([{ data: '{"value":1}' }]);
    expect(result.state.buffer).toBe('');
  });

  it('keeps an incomplete frame in the buffer', () => {
    const first = pushSseChunk(createSseParserState(), 'data: {"value":');
    const second = pushSseChunk(first.state, '1}\n\n');

    expect(first.frames).toEqual([]);
    expect(second.frames).toEqual([{ data: '{"value":1}' }]);
  });

  it('parses multiple frames from one chunk', () => {
    const result = pushSseChunk(createSseParserState(), 'data: first\n\ndata: second\n\n');

    expect(result.frames).toEqual([{ data: 'first' }, { data: 'second' }]);
  });

  it('supports CRLF and ignores comment lines', () => {
    const result = pushSseChunk(createSseParserState(), ': keep-alive\r\ndata: value\r\n\r\n');

    expect(result.frames).toEqual([{ data: 'value' }]);
  });

  it('flushes a final frame without a trailing blank line', () => {
    const result = flushSseParser({
      buffer: 'data: final',
    });

    expect(result.frames).toEqual([{ data: 'final' }]);
    expect(result.state.buffer).toBe('');
  });

  it('joins multiple data lines with a newline', () => {
    const result = pushSseChunk(
      createSseParserState(),
      'event: message\ndata: first\ndata: second\n\n',
    );

    expect(result.frames).toEqual([{ data: 'first\nsecond' }]);
  });

  it('does not emit frames without data lines', () => {
    const result = pushSseChunk(createSseParserState(), ': keep-alive\nid: 1\n\n');

    expect(result.frames).toEqual([]);
  });

  it('keeps the DONE marker as data', () => {
    const result = pushSseChunk(createSseParserState(), 'data: [DONE]\n\n');

    expect(result.frames).toEqual([{ data: '[DONE]' }]);
  });

  it('preserves UTF-8 characters split across byte chunks', () => {
    const bytes = new TextEncoder().encode('data: 你好\n\n');
    const result = decodeSseChunks([bytes.slice(0, 7), bytes.slice(7)]);

    expect(result).toBe('data: 你好\n\n');
  });
});
