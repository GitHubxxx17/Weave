import { describe, expect, it } from 'vitest';

import {
  cacheHitRate,
  describeModelSteps,
  formatDuration,
  formatPercent,
  formatTokens,
  outputTokensPerSecond,
  sumUsage,
  turnDurationMs,
} from '../src/features/conversation/turn-stats.js';
import type { TurnSummary } from '../src/features/workspace/workspace-types.js';

const turn: TurnSummary = {
  turnId: 'turn-1',
  status: 'completed',
  startedAt: '2026-11-17T09:00:00.000Z',
  completedAt: '2026-11-17T09:00:18.600Z',
  model: 'deepseek-flash',
  usage: { inputTokens: 12_400, outputTokens: 860, cacheReadTokens: 10_044 },
  modelSteps: [
    {
      startedAt: '2026-11-17T09:00:00.000Z',
      completedAt: '2026-11-17T09:00:04.000Z',
      usage: { inputTokens: 6000, outputTokens: 400, cacheReadTokens: 4800 },
    },
    {
      startedAt: '2026-11-17T09:00:14.000Z',
      completedAt: '2026-11-17T09:00:18.600Z',
      usage: { inputTokens: 6400, outputTokens: 460, cacheReadTokens: 5244 },
    },
  ],
  toolCalls: 1,
  failedToolCalls: 0,
};

describe('turn stats', () => {
  it('formats token counts compactly', () => {
    expect(formatTokens(undefined)).toBe('—');
    expect(formatTokens(860)).toBe('860');
    expect(formatTokens(1000)).toBe('1k');
    expect(formatTokens(12_400)).toBe('12k');
    expect(formatTokens(9_860)).toBe('9.9k');
    expect(formatTokens(1_250_000)).toBe('1.3M');
  });

  it('computes the cache hit rate only when both counters are known', () => {
    expect(cacheHitRate({ inputTokens: 100, cacheReadTokens: 81 })).toBeCloseTo(0.81);
    expect(cacheHitRate({ inputTokens: 100 })).toBeUndefined();
    expect(cacheHitRate({ inputTokens: 0, cacheReadTokens: 0 })).toBeUndefined();
    expect(formatPercent(0.812)).toBe('81%');
    expect(formatPercent(undefined)).toBe('—');
  });

  it('sums usage without turning unreported fields into zero', () => {
    expect(sumUsage([undefined])).toBeUndefined();
    expect(sumUsage([{ inputTokens: 1, outputTokens: 2 }, { inputTokens: 3 }])).toEqual({
      inputTokens: 4,
      outputTokens: 2,
    });
  });

  it('measures Turn duration and model output speed', () => {
    expect(turnDurationMs(turn)).toBe(18_600);
    expect(formatDuration(18_600)).toBe('18.6 秒');
    expect(formatDuration(125_000)).toBe('2 分 05 秒');
    expect(formatDuration(420)).toBe('420 毫秒');
    // 860 output tokens over 4.0 s + 4.6 s of model time, tool time excluded.
    expect(outputTokensPerSecond([turn])).toBeCloseTo(860 / 8.6);
  });

  it('describes each model step for the hover breakdown', () => {
    expect(describeModelSteps(turn)).toBe(
      '第 1 次模型调用：输入 6k（命中 80%）· 输出 400 · 4.0 秒\n' +
        '第 2 次模型调用：输入 6.4k（命中 82%）· 输出 460 · 4.6 秒',
    );
  });
});
