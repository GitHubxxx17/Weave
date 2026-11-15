import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createToolRegistry, type ToolDefinition } from '../src/index.js';

const echoTool: ToolDefinition<{ text: string }, string> = {
  name: 'echo',
  description: 'Returns the input text',
  parameters: {
    type: 'object',
    properties: { text: { type: 'string' } },
  },
  inputSchema: z.object({ text: z.string() }),
  execute: ({ text }) => text,
};

describe('Tool Registry', () => {
  it('registers and finds a tool', () => {
    const registry = createToolRegistry();
    registry.register(echoTool);

    expect(registry.get('echo')).toBe(echoTool);
    expect(registry.list()).toEqual([echoTool]);
  });

  it('rejects duplicate names', () => {
    const registry = createToolRegistry();
    registry.register(echoTool);

    expect(() => registry.register(echoTool)).toThrow(/already registered/);
  });

  it('returns a stable snapshot from list', () => {
    const registry = createToolRegistry();
    registry.register(echoTool);
    const listed = registry.list();

    expect(() => (listed as ToolDefinition[]).push(echoTool)).toThrow();
    expect(registry.list()).toHaveLength(1);
  });

  it('rejects malformed approval requirements', () => {
    const registry = createToolRegistry();

    expect(() =>
      registry.register({
        ...echoTool,
        name: 'protected',
        approval: {
          operation: '',
          risk: 'high',
          summarize: () => ({
            summary: 'protected operation',
            inputSummary: {},
          }),
        },
      }),
    ).toThrow('Invalid tool definition');
  });
});
