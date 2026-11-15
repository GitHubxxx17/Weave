import { describe, expect, it } from 'vitest';
import {
  ToolExecutionError,
  toolExecutionRequestSchema,
} from '@weave/runtime';

describe('Tool Pipeline contracts', () => {
  it('accepts a valid tool execution request', () => {
    const result = toolExecutionRequestSchema.safeParse({
      toolCallId: 'call-1',
      name: 'echo',
      arguments: '{"text":"hello"}',
    });

    expect(result.success).toBe(true);
  });

  it('rejects an empty tool name and negative timeout', () => {
    const result = toolExecutionRequestSchema.safeParse({
      toolCallId: 'call-1',
      name: '',
      arguments: '{}',
      timeoutMs: -1,
    });

    expect(result.success).toBe(false);
  });

  it('exposes a stable error code and cause', () => {
    const cause = new Error('provider detail');
    const error = new ToolExecutionError('tool-execution-failed', 'Tool failed', {
      cause,
    });

    expect(error.name).toBe('ToolExecutionError');
    expect(error.code).toBe('tool-execution-failed');
    expect(error.cause).toBe(cause);
  });
});
