import { describe, expect, it } from 'vitest';
import { freezeExecutionInput } from '../src/agent-execution-input.js';

const input = {
  provider: 'provider-one',
  model: 'model-one',
  permissionMode: 'ask' as const,
  userMessage: { role: 'user' as const, content: [{ type: 'text' as const, text: 'immutable' }] },
};
const descriptor = {
  id: 'provider-one',
  label: 'One',
  type: 'mock' as const,
  temperature: 0.4,
  maxTokens: 1200,
  contextWindowTokens: 32000,
};

describe('execution sampling snapshot', () => {
  it('freezes public sampling defaults without serializing provider resources', () => {
    const result = freezeExecutionInput(input, descriptor);
    expect(result).toEqual({
      ...input,
      useProviderDefaults: false,
      temperature: 0.4,
      maxTokens: 1200,
    });
    expect(result).not.toHaveProperty('contextWindowTokens');
    result.userMessage.content[0]!.text = 'changed';
    expect(input.userMessage.content[0]!.text).toBe('immutable');
  });
  it('retains explicit settings and respects disabled defaults and absence', () => {
    expect(
      freezeExecutionInput({ ...input, temperature: 0, maxTokens: 321 }, descriptor),
    ).toMatchObject({ temperature: 0, maxTokens: 321, useProviderDefaults: false });
    expect(freezeExecutionInput({ ...input, useProviderDefaults: false }, descriptor)).toEqual({
      ...input,
      useProviderDefaults: false,
    });
    expect(freezeExecutionInput(input, undefined)).toEqual({
      ...input,
      useProviderDefaults: false,
    });
  });
  it('samples the descriptor at acceptance rather than retaining it for later execution', () => {
    const mutable = { ...descriptor };
    const first = freezeExecutionInput(input, mutable);
    mutable.temperature = 1.8;
    mutable.maxTokens = 6000;
    expect(first).toMatchObject({ temperature: 0.4, maxTokens: 1200 });
    expect(freezeExecutionInput(input, mutable)).toMatchObject({
      temperature: 1.8,
      maxTokens: 6000,
    });
  });
});
