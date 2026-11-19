import { describe, expect, it } from 'vitest';
import {
  contentPartSchema,
  llmRequestSchema,
  messageSchema,
  streamEventSchema,
  tokenUsageSchema,
  toolCallSchema,
} from '../src/index.js';

describe('protocol schemas', () => {
  it('accepts a text user message', () => {
    expect(
      messageSchema.parse({
        role: 'user',
        content: [{ type: 'text', text: '分析项目' }],
      }),
    ).toEqual({
      role: 'user',
      content: [{ type: 'text', text: '分析项目' }],
    });
  });

  it('rejects an unknown message role', () => {
    expect(() =>
      messageSchema.parse({
        role: 'developer',
        content: [{ type: 'text', text: 'invalid' }],
      }),
    ).toThrow();
  });

  it('keeps tool arguments as a string', () => {
    expect(
      toolCallSchema.parse({
        id: 'call-1',
        name: 'read_file',
        arguments: '{"path":"README.md"}',
      }).arguments,
    ).toBe('{"path":"README.md"}');
  });

  it('rejects negative usage values', () => {
    expect(() => tokenUsageSchema.parse({ inputTokens: -1 })).toThrow();
  });

  it('requires model and messages in an LLM request', () => {
    expect(() => llmRequestSchema.parse({ provider: 'mock' })).toThrow();
  });

  it('validates content parts', () => {
    expect(() => contentPartSchema.parse({ type: 'image', url: 'image.png' })).toThrow();
  });

  it('accepts an image content part with media type and base64 data', () => {
    expect(
      contentPartSchema.parse({ type: 'image', mediaType: 'image/png', data: 'aGVsbG8=' }),
    ).toEqual({ type: 'image', mediaType: 'image/png', data: 'aGVsbG8=' });
  });

  it('rejects an image part with empty data', () => {
    expect(() =>
      contentPartSchema.parse({ type: 'image', mediaType: 'image/png', data: '' }),
    ).toThrow();
  });

  it('accepts a user message mixing text and image parts', () => {
    const parsed = messageSchema.parse({
      role: 'user',
      content: [
        { type: 'text', text: '看这张图' },
        { type: 'image', mediaType: 'image/jpeg', data: 'Zm9v' },
      ],
    });
    expect(parsed.content).toHaveLength(2);
    expect(parsed.content[1]).toEqual({ type: 'image', mediaType: 'image/jpeg', data: 'Zm9v' });
  });

  it('rejects error stream events because LLM failures reject the stream', () => {
    expect(() =>
      streamEventSchema.parse({
        type: 'error',
        error: {
          code: 'network',
          message: 'connection failed',
          provider: 'test',
          retryable: true,
        },
      }),
    ).toThrow();
  });
});
