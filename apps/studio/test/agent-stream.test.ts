// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';

import { AgentStreamError, parseSseFrame } from '../src/features/agent/agent-stream.js';

describe('SSE frame parsing', () => {
  it('parses CRLF frames, joins data lines, and ignores empty/comment lines', () => {
    expect(
      parseSseFrame(
        ': keep-alive\r\n\r\nevent: custom\r\ndata: {"type":"text-\r\ndata: delta","text":"ok"}\r\n\r\n',
      ),
    ).toEqual({
      event: 'custom',
      data: '{"type":"text-\ndelta","text":"ok"}',
    });
  });

  it('ignores empty and comment-only frames', () => {
    expect(parseSseFrame('\r\n: comment\r\n\r\n')).toBeNull();
  });
});

describe('AgentStreamError', () => {
  it('exports the documented error type', () => {
    const error = new AgentStreamError('agent-stream-protocol', 'Agent stream failed');

    expect(error).toBeInstanceOf(Error);
    expect(error.code).toBe('agent-stream-protocol');
    expect(error.message).toBe('agent-stream-protocol: Agent stream failed');
    expect(error.name).toBe('AgentStreamError');
  });
});
