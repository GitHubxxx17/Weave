import { filePathSchema } from './file-context-types.js';
export interface FileMention {
  readonly start: number;
  readonly end: number;
  readonly query: string;
}
export function findFileMention(text: string, start: number, end: number): FileMention | undefined {
  if (start !== end || start < 0 || start > text.length) return undefined;
  const before = text.slice(0, start);
  const match = /(?:^|\s)@([^\s@]*)$/u.exec(before);
  if (match === null || match[1]!.length > 256) return undefined;
  const tokenStart = before.length - match[1]!.length - 1;
  const suffix = /^[^\s@]*/u.exec(text.slice(start))?.[0] ?? '';
  return { start: tokenStart, end: start + suffix.length, query: match[1]! };
}
function isSubsequence(path: string, query: string): boolean {
  const characters = [...query];
  let index = 0;
  for (const character of path) if (character === characters[index]) index += 1;
  return index === characters.length;
}
function compareCodePoints(left: string, right: string): number {
  const a = [...left];
  const b = [...right];
  for (let i = 0; i < Math.min(a.length, b.length); i += 1) {
    const difference = a[i]!.codePointAt(0)! - b[i]!.codePointAt(0)!;
    if (difference !== 0) return difference;
  }
  return a.length - b.length;
}
/** Stable advisory ranking, independent of the browser's locale. */
export function rankFileCandidates(paths: readonly string[], query: string): readonly string[] {
  if (query.length > 256) return [];
  const needle = query.toLowerCase();
  return [...new Set(paths)]
    .filter((path) => filePathSchema.safeParse(path).success)
    .map((path) => {
      const value = path.toLowerCase();
      const name = value.slice(value.lastIndexOf('/') + 1);
      const score =
        needle === '' || name === needle
          ? 0
          : name.startsWith(needle)
            ? 1
            : value.startsWith(needle)
              ? 2
              : value.includes(needle)
                ? 3
                : isSubsequence(value, needle)
                  ? 4
                  : 5;
      return { path, score };
    })
    .filter(({ score }) => score < 5)
    .sort(
      (a, b) =>
        a.score - b.score || a.path.length - b.path.length || compareCodePoints(a.path, b.path),
    )
    .slice(0, 20)
    .map(({ path }) => path);
}
