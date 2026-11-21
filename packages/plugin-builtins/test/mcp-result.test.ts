import type { McpCallResult } from '@weave/mcp-client';
import { describe, expect, it } from 'vitest';
import { formatMcpResult, McpToolError, redactMcpText } from '../src/mcp-result.js';

const context = { serverId: 'local-service', toolName: 'read data' };

function captureError(result: McpCallResult): McpToolError {
  try {
    formatMcpResult(result, context);
    throw new Error('Expected an MCP tool failure');
  } catch (error) {
    expect(error).toBeInstanceOf(McpToolError);
    return error as McpToolError;
  }
}

describe('redactMcpText', () => {
  it('replaces all literal known values without changing the caller list', () => {
    const values = Object.freeze(['short', 'short-and-long', '', '.*[value]']);
    expect(redactMcpText('short-and-long short .*[' + 'value] short', values)).toBe(
      '[REDACTED] [REDACTED] [REDACTED] [REDACTED]',
    );
    expect(values).toEqual(['short', 'short-and-long', '', '.*[value]']);
  });

  it('does not reinterpret replacement markers as another secret', () => {
    expect(redactMcpText('secret REDACTED', ['secret', 'REDACTED'])).toBe('[REDACTED] [REDACTED]');
    expect(redactMcpText('plain text')).toBe('plain text');
  });
});

describe('formatMcpResult', () => {
  it('attributes text and structured JSON to the service and original tool', () => {
    const result: McpCallResult = {
      content: [
        { type: 'text', text: 'First' },
        { type: 'text', text: 'Second' },
      ],
      structuredContent: { count: 2, entries: ['a', 'b'] },
    };
    const text = formatMcpResult(result, context);
    expect(text).toContain('local-service');
    expect(text).toContain('read data');
    expect(text).toContain('First\nSecond');
    expect(text).toContain('{"count":2,"entries":["a","b"]}');
    expect(result.structuredContent).toEqual({ count: 2, entries: ['a', 'b'] });
  });

  it.each([null, false, 0, '', ['one', 2]])('preserves defined structured JSON %j', (value) => {
    expect(formatMcpResult({ content: [], structuredContent: value }, context)).toContain(
      JSON.stringify(value),
    );
  });

  it('summarizes mixed binary and resource blocks by fixed type counts only', () => {
    const text = formatMcpResult(
      {
        content: [
          { type: 'text', text: 'usable text' },
          { type: 'image', data: 'private-base64', mimeType: 'image/png' },
          { type: 'audio', data: 'private-audio', mimeType: 'audio/wav' },
          { type: 'audio', data: 'private-audio2' },
          { type: 'resource_link', uri: 'https://private.example/token' },
          { type: 'resource', resource: { uri: 'file:///private/credentials', text: 'private' } },
          { type: 'private-arbitrary-type', uri: 'file:///private' },
        ],
      },
      context,
    );
    expect(text).toContain('usable text');
    expect(text).toMatch(/image[^\n]*1/);
    expect(text).toMatch(/audio[^\n]*2/);
    expect(text).toContain('resource_link');
    expect(text).toContain('resource');
    expect(text).toContain('unknown');
    expect(text).not.toContain('private');
    expect(text).not.toContain('base64');
    expect(text).not.toContain('https:');
    expect(text).not.toContain('file:');
  });

  it('accepts structured JSON alongside unsupported blocks without text', () => {
    expect(
      formatMcpResult(
        { content: [{ type: 'image', data: 'private' }], structuredContent: { count: 1 } },
        context,
      ),
    ).toContain('{"count":1}');
  });

  it.each(
    [
      [{ type: 'image', data: 'private' }],
      [
        { type: 'text', text: '' },
        { type: 'audio', data: 'private' },
      ],
      [
        { type: 'text', text: ' \n ' },
        { type: 'resource_link', uri: 'file:///private' },
      ],
    ].map((content) => ({ content })),
  )('rejects only-unsupported content with a stable error: %j', ({ content }) => {
    const error = captureError({ content });
    expect(error.code).toBe('mcp-unsupported-result');
    expect(error.message).not.toContain('private');
    expect(error).not.toHaveProperty('cause');
  });

  it('accepts a legitimate empty result and empty text', () => {
    expect(() => formatMcpResult({ content: [] }, context)).not.toThrow();
    expect(() => formatMcpResult({ content: [{ type: 'text', text: '' }] }, context)).not.toThrow();
  });

  it('redacts attribution, text and nested structured JSON before exposing output', () => {
    const text = formatMcpResult(
      {
        content: [{ type: 'text', text: 'credential-token and credential' }],
        structuredContent: { 'credential-token': { secret: 'credential-token' } },
      },
      {
        serverId: 'credential-token',
        toolName: 'credential',
        redactValues: Object.freeze(['credential', 'credential-token', '']),
      },
    );
    expect(text).not.toContain('credential');
    expect(text).not.toContain('-token');
    expect(text).toContain('[REDACTED]');
  });

  it('keeps successful output intact for the shared Pipeline byte budget', () => {
    const text = '界'.repeat(20_000);
    const formatted = formatMcpResult({ content: [{ type: 'text', text }] }, context);
    expect(formatted).toContain(text);
    expect(Buffer.byteLength(formatted)).toBeGreaterThan(32_000);
  });

  it('redacts JSON string values before escaping changes the credential spelling', () => {
    const secret = 'line one\n"line two"\\';
    const text = formatMcpResult(
      { content: [], structuredContent: { [secret]: secret } },
      { ...context, redactValues: [secret] },
    );
    expect(text).toContain('{"[REDACTED]":"[REDACTED]"}');
    expect(text).not.toContain('line one');
  });

  it('throws isError results with useful redacted text and structured summary', () => {
    const error = captureError({
      isError: true,
      content: [{ type: 'text', text: 'Missing required field x' }],
      structuredContent: { required: 'x' },
    });
    expect(error.code).toBe('mcp-tool-error');
    expect(error.message).toContain('Missing required field x');
    expect(error.message).toContain('{"required":"x"}');
    expect(error).not.toHaveProperty('cause');
  });

  it('keeps unsupported type counts in a mixed error without exposing block payloads', () => {
    const error = captureError({
      isError: true,
      content: [
        { type: 'text', text: 'The lookup failed' },
        { type: 'resource_link', uri: 'file:///private-credential' },
      ],
    });
    expect(error.code).toBe('mcp-tool-error');
    expect(error.message).toContain('The lookup failed');
    expect(error.message).toContain('resource_link: 1');
    expect(error.message).not.toContain('private-credential');
  });

  it('prioritizes isError over unsupported-result and supplies a fixed empty-error summary', () => {
    const error = captureError({ isError: true, content: [{ type: 'image', data: 'private' }] });
    expect(error.code).toBe('mcp-tool-error');
    expect(error.message).toMatch(/failed|error/i);
    expect(error.message).not.toContain('private');
  });

  it('redacts before clipping error summaries to 4 KiB at a valid UTF-8 boundary', () => {
    const secret = 'sensitive-credential';
    let error: unknown;
    try {
      formatMcpResult(
        {
          isError: true,
          content: [{ type: 'text', text: `${'界'.repeat(1330)}${secret}${'界'.repeat(100)}` }],
        },
        { ...context, redactValues: [secret] },
      );
    } catch (failure) {
      error = failure;
    }
    expect(error).toBeInstanceOf(McpToolError);
    const message = (error as Error).message;
    expect(Buffer.byteLength(message)).toBeLessThanOrEqual(4096);
    expect(message).not.toContain(secret);
    expect(message).not.toContain('sensitive-');
    expect(message).not.toContain('\uFFFD');
    expect(message).toMatch(/truncat/i);
  });

  it('serializes deep valid structured data without relying on recursive JSON.stringify', () => {
    let structured: unknown = 0;
    for (let index = 0; index < 6000; index++) structured = [structured];
    const text = formatMcpResult({ content: [], structuredContent: structured }, context);
    expect(text).toContain(`${'['.repeat(6000)}0${']'.repeat(6000)}`);
  });

  it('converts malformed structured data to a fixed failure without leaking serialization errors', () => {
    const structured: Record<string, unknown> = {};
    structured.self = structured;
    const error = captureError({ content: [], structuredContent: structured });
    expect(error.code).toBe('mcp-unsupported-result');
    expect(error.message).not.toContain('circular');
    expect(error).not.toHaveProperty('cause');
  });

  it('preserves shared JSON references and own prototype-shadowing data keys', () => {
    const shared = JSON.parse('{"__proto__":1,"toString":2}') as unknown;
    const result = formatMcpResult({ content: [], structuredContent: [shared, shared] }, context);
    expect(result).toContain('[{"__proto__":1,"toString":2},{"__proto__":1,"toString":2}]');
  });

  it('rejects structured accessors without invoking or exposing them', () => {
    let reads = 0;
    const structured = Object.defineProperty({}, 'value', {
      enumerable: true,
      get() {
        reads++;
        throw new Error('private getter');
      },
    });
    const error = captureError({ content: [], structuredContent: structured });
    expect(error.code).toBe('mcp-unsupported-result');
    expect(error.message).not.toContain('private getter');
    expect(reads).toBe(0);
  });
});
