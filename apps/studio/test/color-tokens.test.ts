import { describe, expect, it } from 'vitest';

// Studio 运行在浏览器里，测试也不引入 node:fs；用 Vite 的 import.meta.glob 以原始文本读取源码。
const sources = import.meta.glob<string>(
  ['../src/**/*.css', '../src/**/*.ts', '../src/**/*.tsx', '../index.html'],
  { query: '?raw', import: 'default', eager: true },
);
const sourceFiles = new Map(
  Object.entries(sources).map(([path, text]) => [path.replace(/^\.\.\//, ''), text]),
);
const tokenFile = 'src/app/app.css';

/**
 * 颜色字面量只允许出现在 app.css 的 `:root` 变量定义块里。
 * 确需例外时写在这里，并说明原因；白名单项如果不再被使用，测试同样失败。
 */
const allowedLiterals: ReadonlyArray<{ file: string; literal: string; reason: string }> = [
  {
    file: 'src/features/panel/terminal-panel.tsx',
    literal: '#10131a',
    reason:
      'xterm.js 的 theme 需要具体颜色值，不能传 CSS 变量；深色主题接入时再改为读取 --terminal-bg',
  },
  {
    file: 'src/features/panel/terminal-panel.tsx',
    literal: '#e7e9f1',
    reason: 'xterm.js 的 theme 需要具体颜色值，不能传 CSS 变量；深色主题接入时再改为读取变量',
  },
];

const namedColors = new Set(
  (
    'aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue blueviolet brown ' +
    'burlywood cadetblue chartreuse chocolate coral cornflowerblue cornsilk crimson cyan darkblue darkcyan ' +
    'darkgoldenrod darkgray darkgreen darkgrey darkkhaki darkmagenta darkolivegreen darkorange darkorchid ' +
    'darkred darksalmon darkseagreen darkslateblue darkslategray darkslategrey darkturquoise darkviolet ' +
    'deeppink deepskyblue dimgray dimgrey dodgerblue firebrick floralwhite forestgreen fuchsia gainsboro ' +
    'ghostwhite gold goldenrod gray green greenyellow grey honeydew hotpink indianred indigo ivory khaki ' +
    'lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan lightgoldenrodyellow ' +
    'lightgray lightgreen lightgrey lightpink lightsalmon lightseagreen lightskyblue lightslategray ' +
    'lightslategrey lightsteelblue lightyellow lime limegreen linen magenta maroon mediumaquamarine ' +
    'mediumblue mediumorchid mediumpurple mediumseagreen mediumslateblue mediumspringgreen mediumturquoise ' +
    'mediumvioletred midnightblue mintcream mistyrose moccasin navajowhite navy oldlace olive olivedrab ' +
    'orange orangered orchid palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff peru ' +
    'pink plum powderblue purple rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown ' +
    'seagreen seashell sienna silver skyblue slateblue slategray slategrey snow springgreen steelblue tan ' +
    'teal thistle tomato turquoise violet wheat white whitesmoke yellow yellowgreen'
  ).split(' '),
);

const functionColor = /\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\(/i;
const hexColor = /#(?:[0-9a-f]{8}|[0-9a-f]{6}|[0-9a-f]{3,4})(?![0-9a-z_-])/i;

interface Finding {
  file: string;
  line: number;
  literal: string;
}

/** 把块注释替换成等长空白，保留行号。 */
function blankComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, (match) => match.replace(/[^\n]/g, ' '));
}

function cssFindings(file: string, text: string): Finding[] {
  const findings: Finding[] = [];
  const lines = blankComments(text).split('\n');
  let inRoot = false;
  lines.forEach((raw, index) => {
    const line = raw;
    if (file === tokenFile && /^:root(?:\[data-theme='dark'\])?\s*\{/.test(line)) {
      inRoot = true;
      return;
    }
    if (inRoot) {
      if (/^\}/.test(line)) {
        inRoot = false;
      }
      return;
    }
    const value = line
      .replace(/(['"]).*?\1/g, '""')
      .replace(/--[\w-]+/g, '')
      .replace(/url\([^)]*\)/g, '');
    const hex = hexColor.exec(value);
    if (hex) {
      findings.push({ file, line: index + 1, literal: hex[0] });
      return;
    }
    const fn = functionColor.exec(value);
    if (fn) {
      findings.push({ file, line: index + 1, literal: fn[0] });
      return;
    }
    const colon = value.indexOf(':');
    if (colon < 0) {
      return;
    }
    for (const word of value
      .slice(colon + 1)
      .toLowerCase()
      .match(/[a-z]+/g) ?? []) {
      if (namedColors.has(word)) {
        findings.push({ file, line: index + 1, literal: word });
        return;
      }
    }
  });
  return findings;
}

function scriptFindings(file: string, text: string): Finding[] {
  const findings: Finding[] = [];
  text.split('\n').forEach((line, index) => {
    if (/^\s*(?:\/\/|\*|\/\*)/.test(line)) {
      return;
    }
    const quoted = [...line.matchAll(/['"`](#(?:[0-9a-f]{8}|[0-9a-f]{6}|[0-9a-f]{3,4}))['"`]/gi)];
    if (quoted.length > 0) {
      for (const match of quoted) {
        findings.push({ file, line: index + 1, literal: match[1] ?? '' });
      }
      return;
    }
    const fn = functionColor.exec(line);
    if (fn) {
      findings.push({ file, line: index + 1, literal: fn[0] });
      return;
    }
    const attribute = /\b(?:fill|stroke|stopColor|floodColor)=["']([^"']+)["']/.exec(line);
    if (attribute?.[1] && !/^(?:none|currentColor|inherit|transparent|url\()/.test(attribute[1])) {
      findings.push({ file, line: index + 1, literal: attribute[1] });
    }
  });
  return findings;
}

function collectFindings(): Finding[] {
  const findings: Finding[] = [];
  for (const [file, text] of sourceFiles) {
    if (file.endsWith('.css')) {
      findings.push(...cssFindings(file, text));
    } else {
      findings.push(...scriptFindings(file, text));
    }
  }
  return findings;
}

/** 取出以 opener 开头的顶层块里的 `--name: value` 定义。 */
function blockVariables(css: string, opener: RegExp): Map<string, string> {
  const start = opener.exec(css);
  const variables = new Map<string, string>();
  if (!start) return variables;
  const end = css.indexOf('\n}', start.index);
  for (const match of css.slice(start.index, end).matchAll(/^\s+(--[\w-]+)\s*:\s*([^;]+);/gm)) {
    variables.set(match[1] ?? '', (match[2] ?? '').trim());
  }
  return variables;
}

describe('Studio 颜色变量', () => {
  it(':root 变量定义块之外没有颜色字面量', () => {
    const unexpected = collectFindings().filter(
      (finding) =>
        !allowedLiterals.some(
          (allowed) => allowed.file === finding.file && allowed.literal === finding.literal,
        ),
    );
    expect(
      unexpected.map((finding) => `${finding.file}:${finding.line} ${finding.literal}`),
    ).toEqual([]);
  });

  it('白名单里的每一项都仍在使用', () => {
    const findings = collectFindings();
    const stale = allowedLiterals.filter(
      (allowed) =>
        !findings.some(
          (finding) => finding.file === allowed.file && finding.literal === allowed.literal,
        ),
    );
    expect(stale).toEqual([]);
  });

  it('功能样式文件不自己定义颜色变量', () => {
    const offenders = [...sourceFiles]
      .filter(([file]) => file.endsWith('.css') && file !== tokenFile)
      .filter(([, text]) => /^\s*--[\w-]+\s*:/m.test(blankComments(text)))
      .map(([file]) => file);
    expect(offenders).toEqual([]);
  });

  it(":root[data-theme='dark'] 覆盖浅色定义的每一个变量，且没有多余变量", () => {
    const css = blankComments(sourceFiles.get(tokenFile) ?? '');
    const light = blockVariables(css, /^:root\s*\{/m);
    const dark = blockVariables(css, /^:root\[data-theme='dark'\]\s*\{/m);
    expect(light.size).toBeGreaterThan(150);
    expect([...light.keys()].filter((name) => !dark.has(name))).toEqual([]);
    expect([...dark.keys()].filter((name) => !light.has(name))).toEqual([]);
  });

  it('扫描确实覆盖到了样式与脚本文件', () => {
    expect(sourceFiles.has(tokenFile)).toBe(true);
    expect(sourceFiles.has('src/features/panel/terminal-panel.tsx')).toBe(true);
    expect(sourceFiles.has('index.html')).toBe(true);
  });
});
