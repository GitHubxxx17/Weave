import type { BundledLanguage } from 'shiki';

/**
 * Lazy Shiki syntax highlighting for the read-only file viewer. Shiki (the
 * engine VS Code uses) is dynamically imported on first use so it never weighs
 * on the initial bundle, and languages load on demand. A single light theme is
 * used because Studio is light-themed; switch to a dual theme if a dark mode
 * lands. Any failure falls back to plain text at the call site.
 */

const THEME = 'github-light';

/** Don't highlight very large files; it is slow and the viewer caps content anyway. */
const maxHighlightBytes = 400_000;

/** File extension (lowercased) → Shiki bundled language id. */
const extensionLanguage: Record<string, BundledLanguage> = {
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'jsx',
  ts: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  tsx: 'tsx',
  json: 'json',
  jsonc: 'jsonc',
  html: 'html',
  htm: 'html',
  vue: 'vue',
  svelte: 'svelte',
  css: 'css',
  scss: 'scss',
  less: 'less',
  md: 'markdown',
  markdown: 'markdown',
  py: 'python',
  rb: 'ruby',
  go: 'go',
  rs: 'rust',
  java: 'java',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  cc: 'cpp',
  hpp: 'cpp',
  cs: 'csharp',
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  yml: 'yaml',
  yaml: 'yaml',
  toml: 'toml',
  ini: 'ini',
  sql: 'sql',
  graphql: 'graphql',
  gql: 'graphql',
  xml: 'xml',
  php: 'php',
  kt: 'kotlin',
  swift: 'swift',
};

/** Resolves a Shiki language for a path, or undefined for plain text. */
export function languageForPath(path: string): BundledLanguage | undefined {
  const name = (path.split('/').pop() ?? path).toLowerCase();
  if (name === 'dockerfile') {
    return 'docker';
  }
  const dot = name.lastIndexOf('.');
  if (dot < 0) {
    return undefined;
  }
  return extensionLanguage[name.slice(dot + 1)];
}

type Highlighter = {
  codeToHtml: (code: string, options: { lang: string; theme: string }) => string;
  loadLanguage: (lang: BundledLanguage) => Promise<void>;
  getLoadedLanguages: () => string[];
};

let highlighterPromise: Promise<Highlighter> | null = null;

async function getHighlighter(): Promise<Highlighter> {
  if (highlighterPromise === null) {
    highlighterPromise = import('shiki').then(({ createHighlighter }) =>
      createHighlighter({ themes: [THEME], langs: [] }),
    ) as Promise<Highlighter>;
  }
  return highlighterPromise;
}

/**
 * Highlights `code` as `language` and returns Shiki's `<pre class="shiki">`
 * HTML (the code text is escaped by Shiki). Returns `undefined` when the file
 * is too large or highlighting fails, so the caller renders plain text.
 */
export async function highlightToHtml(
  code: string,
  language: BundledLanguage,
): Promise<string | undefined> {
  if (code.length > maxHighlightBytes) {
    return undefined;
  }
  try {
    const highlighter = await getHighlighter();
    if (!highlighter.getLoadedLanguages().includes(language)) {
      await highlighter.loadLanguage(language);
    }
    return highlighter.codeToHtml(code, { lang: language, theme: THEME });
  } catch {
    return undefined;
  }
}
