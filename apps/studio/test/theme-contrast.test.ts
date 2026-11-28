import { describe, expect, it } from 'vitest';

// 与 color-tokens.test.ts 相同：Studio 测试不引入 node:fs，用 import.meta.glob 读 CSS 源码。
const css = Object.values(
  import.meta.glob<string>('../src/app/app.css', {
    query: '?raw',
    import: 'default',
    eager: true,
  }),
)[0];

type Rgba = readonly [number, number, number, number];

function blockVariables(text: string, opener: RegExp): Map<string, string> {
  const stripped = text.replace(/\/\*[\s\S]*?\*\//g, '');
  const start = opener.exec(stripped);
  const variables = new Map<string, string>();
  if (!start) return variables;
  const end = stripped.indexOf('\n}', start.index);
  for (const match of stripped
    .slice(start.index, end)
    .matchAll(/^\s+(--[\w-]+)\s*:\s*([^;]+);/gm)) {
    variables.set(match[1] ?? '', (match[2] ?? '').trim());
  }
  return variables;
}

export function parseColor(value: string): Rgba {
  const hex = /^#([0-9a-f]{3,8})$/i.exec(value);
  if (hex?.[1]) {
    let digits = hex[1];
    if (digits.length === 3 || digits.length === 4) {
      digits = [...digits].map((digit) => digit + digit).join('');
    }
    const channel = (index: number): number => parseInt(digits.slice(index * 2, index * 2 + 2), 16);
    return [channel(0), channel(1), channel(2), digits.length === 8 ? channel(3) / 255 : 1];
  }
  const fn = /^rgba?\(\s*(\d+)\s+(\d+)\s+(\d+)\s*(?:\/\s*([\d.]+)(%?))?\s*\)$/.exec(value);
  if (fn) {
    const alpha = fn[4] === undefined ? 1 : fn[5] === '%' ? Number(fn[4]) / 100 : Number(fn[4]);
    return [Number(fn[1]), Number(fn[2]), Number(fn[3]), alpha];
  }
  throw new Error(`无法解析颜色：${value}`);
}

/** 把半透明前景叠到不透明底色上。 */
function over(foreground: Rgba, background: Rgba): Rgba {
  const alpha = foreground[3];
  return [
    foreground[0] * alpha + background[0] * (1 - alpha),
    foreground[1] * alpha + background[1] * (1 - alpha),
    foreground[2] * alpha + background[2] * (1 - alpha),
    1,
  ];
}

function luminance([r, g, b]: Rgba): number {
  const linear = [r, g, b].map((value) => {
    const channel = value / 255;
    return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * (linear[0] ?? 0) + 0.7152 * (linear[1] ?? 0) + 0.0722 * (linear[2] ?? 0);
}

export function contrastRatio(a: Rgba, b: Rgba): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return ((light ?? 0) + 0.05) / ((dark ?? 0) + 0.05);
}

type Level = 'text' | 'secondary' | 'button';
const minimum: Record<Level, number> = { text: 4.5, secondary: 3, button: 4.5 };

interface Pair {
  readonly fg: string;
  readonly bg: string;
  readonly level: Level;
  /** 半透明底色（如差异高亮）先叠到该底色上再计算。 */
  readonly under?: string;
}

/** 文字/底色配对。设计文档 2026-11-27-studio-color-tokens-design.md 的"对比度"一节与此一致。 */
export const pairs: readonly Pair[] = [
  { fg: '--ink', bg: '--app-bg', level: 'text' },
  { fg: '--ink', bg: '--surface', level: 'text' },
  { fg: '--ink', bg: '--surface-soft', level: 'text' },
  { fg: '--ink', bg: '--surface-muted', level: 'text' },
  { fg: '--ink', bg: '--surface-hover', level: 'text' },
  { fg: '--ink', bg: '--user-message-bg', level: 'text' },
  { fg: '--ink-soft', bg: '--surface', level: 'text' },
  { fg: '--ink-soft', bg: '--app-bg', level: 'text' },
  { fg: '--text-body', bg: '--surface', level: 'text' },
  { fg: '--page-text', bg: '--surface', level: 'text' },
  { fg: '--nav-text', bg: '--nav', level: 'secondary' },
  { fg: '--ink-soft', bg: '--nav-hover', level: 'text' },
  { fg: '--muted', bg: '--surface', level: 'secondary' },
  { fg: '--muted', bg: '--app-bg', level: 'secondary' },
  { fg: '--muted', bg: '--surface-soft', level: 'secondary' },
  { fg: '--subtle', bg: '--surface', level: 'secondary' },
  { fg: '--subtle', bg: '--app-bg', level: 'secondary' },
  { fg: '--text-on-accent', bg: '--accent', level: 'button' },
  { fg: '--text-on-accent', bg: '--accent-dark', level: 'button' },
  { fg: '--text-on-accent', bg: '--retrieval-primary', level: 'button' },
  { fg: '--text-on-accent', bg: '--memory-primary', level: 'button' },
  { fg: '--accent', bg: '--surface', level: 'text' },
  { fg: '--accent-dark', bg: '--surface', level: 'text' },
  { fg: '--accent-dark', bg: '--accent-soft', level: 'text' },
  { fg: '--chip-action-text', bg: '--surface', level: 'secondary' },
  { fg: '--text-on-overlay', bg: '--overlay-chip-bg', level: 'text', under: '--surface' },
  { fg: '--text-on-overlay', bg: '--overlay-backdrop-strong', level: 'text', under: '--surface' },
  { fg: '--danger-text', bg: '--danger-soft', level: 'text' },
  { fg: '--danger-text', bg: '--surface', level: 'text' },
  { fg: '--danger-text', bg: '--danger-button-bg', level: 'text' },
  { fg: '--danger-text-hover', bg: '--danger-button-bg-hover', level: 'text' },
  { fg: '--plugin-danger-text', bg: '--plugin-danger-bg', level: 'text' },
  { fg: '--danger', bg: '--surface', level: 'secondary' },
  { fg: '--warning', bg: '--warning-surface', level: 'secondary' },
  { fg: '--warning', bg: '--surface', level: 'secondary' },
  { fg: '--success', bg: '--surface', level: 'secondary' },
  { fg: '--success', bg: '--success-soft', level: 'secondary' },
  { fg: '--diff-added-text', bg: '--diff-added-bg', level: 'text', under: '--surface' },
  { fg: '--diff-removed-text', bg: '--diff-removed-bg', level: 'text', under: '--surface' },
  { fg: '--status-called-text', bg: '--status-called-bg', level: 'text' },
  { fg: '--status-executing-text', bg: '--status-executing-bg', level: 'text' },
  { fg: '--status-completed-text', bg: '--status-completed-bg', level: 'text' },
  { fg: '--status-failed-text', bg: '--status-failed-bg', level: 'text' },
  { fg: '--task-text-secondary', bg: '--surface', level: 'text' },
  { fg: '--task-text-muted', bg: '--surface', level: 'secondary' },
  { fg: '--task-warning-text', bg: '--surface', level: 'text' },
  { fg: '--task-error-text', bg: '--surface', level: 'text' },
  { fg: '--memory-text-muted', bg: '--surface', level: 'secondary' },
  { fg: '--memory-list-text', bg: '--memory-list-bg', level: 'text' },
  { fg: '--memory-list-meta', bg: '--memory-list-bg', level: 'secondary' },
  { fg: '--memory-list-text', bg: '--memory-selected-bg', level: 'text' },
  { fg: '--memory-badge-text', bg: '--memory-badge-bg', level: 'text' },
  { fg: '--memory-badge-reviewed-text', bg: '--memory-badge-reviewed-bg', level: 'text' },
  { fg: '--memory-tag-text', bg: '--memory-tag-bg', level: 'text' },
  { fg: '--memory-access-text', bg: '--memory-access-bg', level: 'text' },
  { fg: '--memory-detail-meta', bg: '--surface', level: 'secondary' },
  { fg: '--memory-empty-text', bg: '--surface', level: 'secondary' },
  { fg: '--memory-history-meta', bg: '--surface', level: 'secondary' },
  { fg: '--memory-editor-hint', bg: '--surface', level: 'secondary' },
  { fg: '--memory-alert-text', bg: '--surface', level: 'text' },
  { fg: '--retrieval-text-muted', bg: '--surface', level: 'secondary' },
  { fg: '--retrieval-alert-text', bg: '--surface', level: 'text' },
  { fg: '--retrieval-egress-text', bg: '--retrieval-egress-bg', level: 'text' },
  { fg: '--page-text', bg: '--retrieval-code-bg', level: 'text' },
];

function evaluate(variables: Map<string, string>): Array<{ pair: Pair; ratio: number }> {
  const get = (name: string): Rgba => {
    const value = variables.get(name);
    if (value === undefined) throw new Error(`缺少变量 ${name}`);
    return parseColor(value);
  };
  return pairs.map((pair) => {
    const base = pair.under === undefined ? undefined : get(pair.under);
    const bg = base === undefined ? get(pair.bg) : over(get(pair.bg), base);
    const fg = over(get(pair.fg), bg);
    return { pair, ratio: contrastRatio(fg, bg) };
  });
}

const light = blockVariables(css ?? '', /^:root\s*\{/m);
const dark = blockVariables(css ?? '', /^:root\[data-theme='dark'\]\s*\{/m);

const describePair = ({ pair, ratio }: { pair: Pair; ratio: number }): string =>
  `${pair.fg} / ${pair.bg} = ${ratio.toFixed(2)}（需要 ${minimum[pair.level]}）`;

describe('主题对比度（WCAG）', () => {
  it('对比度算法与已知值一致', () => {
    expect(contrastRatio(parseColor('#000000'), parseColor('#ffffff'))).toBeCloseTo(21, 1);
    expect(contrastRatio(parseColor('#777777'), parseColor('#ffffff'))).toBeCloseTo(4.48, 1);
    expect(parseColor('rgb(52 192 143 / 16%)')[3]).toBeCloseTo(0.16);
    expect(parseColor('#8885')[3]).toBeCloseTo(0x55 / 255);
  });

  it('读到了浅色和深色两组变量', () => {
    expect(light.size).toBeGreaterThan(150);
    expect(dark.size).toBe(light.size);
  });

  it('深色：全部配对达到要求（正文 4.5、次要文字 3、强调按钮 4.5）', () => {
    const failures = evaluate(dark).filter(({ pair, ratio }) => ratio < minimum[pair.level]);
    expect(failures.map(describePair)).toEqual([]);
  });

  it('浅色：全部配对达到要求（正文 4.5、次要文字 3、强调按钮 4.5）', () => {
    const results = evaluate(light);
    expect(results.every(({ ratio }) => Number.isFinite(ratio) && ratio >= 1)).toBe(true);
    const failures = results.filter(({ pair, ratio }) => ratio < minimum[pair.level]);
    expect(failures.map(describePair)).toEqual([]);
  });
});
