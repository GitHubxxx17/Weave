import { describe, expect, it } from 'vitest';

import { HookRegistry, defineHook, type PolicyVote } from '../src/hook.js';

describe('HookRegistry observe', () => {
  it('runs listeners and isolates a failing one', async () => {
    const hook = defineHook<{ x: number }>({ id: 'o', mode: 'observe' });
    const registry = new HookRegistry();
    const seen: number[] = [];
    registry.on(
      hook,
      () => {
        throw new Error('boom');
      },
      'p1',
    );
    registry.on(
      hook,
      (input) => {
        seen.push(input.x);
      },
      'p2',
    );
    const failed: string[] = [];
    await registry.runObserve(hook, { x: 5 }, (_error, pluginId) => failed.push(pluginId));
    expect(seen).toEqual([5]);
    expect(failed).toEqual(['p1']);
  });
});

describe('HookRegistry wrap', () => {
  it('composes middleware outer-to-inner in registration order', async () => {
    const hook = defineHook<string, string>({ id: 'w', mode: 'wrap' });
    const registry = new HookRegistry();
    const trace: string[] = [];
    registry.on(
      hook,
      async (input, next) => {
        trace.push('p1-before');
        const result = await next(`${input}1`);
        trace.push('p1-after');
        return `${result}A`;
      },
      'p1',
    );
    registry.on(
      hook,
      async (input, next) => {
        trace.push('p2-before');
        const result = await next(`${input}2`);
        trace.push('p2-after');
        return `${result}B`;
      },
      'p2',
    );
    const output = await registry.runWrap(hook, 'x', async (input) => {
      trace.push(`base:${input}`);
      return 'R';
    });
    expect(trace).toEqual(['p1-before', 'p2-before', 'base:x12', 'p2-after', 'p1-after']);
    expect(output).toBe('RBA');
  });
});

describe('HookRegistry decide', () => {
  it('merges votes as deny > ask > abstain', async () => {
    const hook = defineHook<unknown, PolicyVote>({ id: 'd', mode: 'decide' });
    const registry = new HookRegistry();
    registry.on(hook, () => 'abstain', 'p1');
    registry.on(hook, () => 'ask', 'p2');
    expect(await registry.runDecide(hook, {})).toBe('ask');
    registry.on(hook, () => 'deny', 'p3');
    expect(await registry.runDecide(hook, {})).toBe('deny');
  });

  it('permits (abstain) when every handler abstains', async () => {
    const hook = defineHook<unknown, PolicyVote>({ id: 'd2', mode: 'decide' });
    const registry = new HookRegistry();
    registry.on(hook, () => 'abstain', 'p1');
    expect(await registry.runDecide(hook, {})).toBe('abstain');
  });

  it('refuses to run a decide hook through runWrap', async () => {
    const hook = defineHook<number, number>({ id: 'x', mode: 'decide' });
    const registry = new HookRegistry();
    await expect(registry.runWrap(hook, 1, async (input) => input)).rejects.toBeInstanceOf(Error);
  });
});
