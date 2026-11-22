import type { Message, ToolDefinition } from '@weave/protocol';
import { describe, expect, it } from 'vitest';
import {
  estimateMessageTokens,
  estimateToolsTokens,
  estimateTokens,
} from '../src/context/token-estimate.js';

describe('estimateTokens', () => {
  it('counts an empty string as zero', () => {
    expect(estimateTokens('')).toBe(0);
  });

  it('counts ASCII text at roughly a quarter token per character', () => {
    // 11 characters * 0.25 = 2.75, rounded up.
    expect(estimateTokens('hello world')).toBe(3);
  });

  it('counts CJK characters as about one token each', () => {
    expect(estimateTokens('你好世界')).toBe(4);
  });

  it('counts full-width punctuation as wide characters', () => {
    // Three ideographic characters plus one full-width comma.
    expect(estimateTokens('你好，吗')).toBe(4);
  });

  it('mixes wide and narrow characters additively', () => {
    // 2 CJK (2) + 4 ASCII (1) = 3.
    expect(estimateTokens('你好code')).toBe(3);
  });

  it('grows monotonically with longer input', () => {
    expect(estimateTokens('a'.repeat(100))).toBeGreaterThan(estimateTokens('a'.repeat(10)));
  });
});

describe('estimateMessageTokens', () => {
  it('includes per-message framing overhead', () => {
    const message: Message = { role: 'user', content: [{ type: 'text', text: '' }] };
    // Only the overhead remains for empty content.
    expect(estimateMessageTokens(message)).toBe(4);
  });

  it('adds the text of every content block', () => {
    const message: Message = {
      role: 'user',
      content: [
        { type: 'text', text: 'hello world' },
        { type: 'text', text: '你好' },
      ],
    };
    // 4 overhead + 3 (ascii) + 2 (cjk).
    expect(estimateMessageTokens(message)).toBe(9);
  });

  it('counts an image and excludes reasoning that is not sent', () => {
    const message: Message = {
      role: 'user',
      content: [
        { type: 'image', mediaType: 'image/png', data: 'aGVsbG8=' },
        { type: 'reasoning', text: '隐'.repeat(5000) },
      ],
    };

    expect(estimateMessageTokens(message)).toBe(1028);
  });

  it('accounts for assistant tool calls with their own framing', () => {
    const withCall: Message = {
      role: 'assistant',
      content: [{ type: 'text', text: '' }],
      toolCalls: [{ id: 'c1', name: 'read_file', arguments: '{"path":"README.md"}' }],
    };
    const withoutCall: Message = {
      role: 'assistant',
      content: [{ type: 'text', text: '' }],
    };
    expect(estimateMessageTokens(withCall)).toBeGreaterThan(estimateMessageTokens(withoutCall));
  });
});

describe('estimateToolsTokens', () => {
  it('returns zero when tools are absent or empty', () => {
    expect(estimateToolsTokens(undefined)).toBe(0);
    expect(estimateToolsTokens([])).toBe(0);
  });

  it('counts name, description, and serialized parameters', () => {
    const tools: ToolDefinition[] = [
      {
        name: 'read_file',
        description: 'Read a file',
        parameters: { type: 'object', properties: { path: { type: 'string' } } },
      },
    ];
    expect(estimateToolsTokens(tools)).toBeGreaterThan(0);
  });

  it('grows with the number of tools', () => {
    const one: ToolDefinition[] = [{ name: 'a', description: 'x', parameters: {} }];
    const two: ToolDefinition[] = [...one, { name: 'b', description: 'y', parameters: {} }];
    expect(estimateToolsTokens(two)).toBeGreaterThan(estimateToolsTokens(one));
  });
});
