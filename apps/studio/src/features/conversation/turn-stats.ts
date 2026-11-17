import type { TurnSummary, TurnUsage } from '../workspace/workspace-types.js';

const usageFields = [
  'inputTokens',
  'outputTokens',
  'totalTokens',
  'cacheReadTokens',
  'cacheWriteTokens',
  'reasoningTokens',
] as const;

/**
 * Adds usage field by field. A field appears only when some input reported it,
 * so an unreported counter is never shown as zero.
 */
export function sumUsage(usages: readonly (TurnUsage | undefined)[]): TurnUsage | undefined {
  const reported = usages.filter((usage): usage is TurnUsage => usage !== undefined);
  if (reported.length === 0) {
    return undefined;
  }
  const total: Record<string, number> = {};
  for (const usage of reported) {
    for (const field of usageFields) {
      const value = usage[field];
      if (value !== undefined) {
        total[field] = (total[field] ?? 0) + value;
      }
    }
  }
  return total as TurnUsage;
}

/** Share of input tokens served from the provider cache, or undefined if unknown. */
export function cacheHitRate(usage: TurnUsage | undefined): number | undefined {
  if (
    usage?.inputTokens === undefined ||
    usage.cacheReadTokens === undefined ||
    usage.inputTokens === 0
  ) {
    return undefined;
  }
  return Math.min(1, usage.cacheReadTokens / usage.inputTokens);
}

/** Compact token count: 860, 12.4k, 1.2M. */
export function formatTokens(value: number | undefined): string {
  if (value === undefined) {
    return '—';
  }
  if (value < 1000) {
    return String(value);
  }
  if (value < 1_000_000) {
    return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0).replace(/\.0$/, '')}k`;
  }
  return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
}

export function formatPercent(rate: number | undefined): string {
  return rate === undefined ? '—' : `${Math.round(rate * 100)}%`;
}

function elapsedMs(startedAt: string, completedAt: string | undefined, now: number): number {
  const start = Date.parse(startedAt);
  const end = completedAt === undefined ? now : Date.parse(completedAt);
  return Number.isNaN(start) || Number.isNaN(end) ? 0 : Math.max(0, end - start);
}

/** Wall-clock duration of a Turn; a running Turn is measured up to `now`. */
export function turnDurationMs(turn: TurnSummary, now = Date.now()): number {
  return elapsedMs(turn.startedAt, turn.completedAt, now);
}

/** 860 毫秒 / 18.6 秒 / 2 分 05 秒 */
export function formatDuration(ms: number): string {
  if (ms < 1000) {
    return `${ms} 毫秒`;
  }
  if (ms < 60_000) {
    return `${(ms / 1000).toFixed(1)} 秒`;
  }
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.floor((ms % 60_000) / 1000);
  return `${minutes} 分 ${String(seconds).padStart(2, '0')} 秒`;
}

/**
 * Output tokens per second across the model steps that reported usage.
 * Tool execution time is excluded, so the number reflects model speed.
 */
export function outputTokensPerSecond(turns: readonly TurnSummary[]): number | undefined {
  let tokens = 0;
  let ms = 0;
  for (const turn of turns) {
    for (const step of turn.modelSteps) {
      if (step.usage?.outputTokens === undefined || step.completedAt === undefined) {
        continue;
      }
      tokens += step.usage.outputTokens;
      ms += elapsedMs(step.startedAt, step.completedAt, 0);
    }
  }
  return ms === 0 ? undefined : tokens / (ms / 1000);
}

/** One line per model step, used as the hover breakdown of a reply's usage. */
export function describeModelSteps(turn: TurnSummary): string {
  return turn.modelSteps
    .map((step, index) => {
      const usage = step.usage;
      const duration =
        step.completedAt === undefined
          ? ''
          : ` · ${formatDuration(elapsedMs(step.startedAt, step.completedAt, 0))}`;
      return usage === undefined
        ? `第 ${index + 1} 次模型调用：未返回用量${duration}`
        : `第 ${index + 1} 次模型调用：输入 ${formatTokens(usage.inputTokens)}（命中 ${formatPercent(
            cacheHitRate(usage),
          )}）· 输出 ${formatTokens(usage.outputTokens)}${duration}`;
    })
    .join('\n');
}
