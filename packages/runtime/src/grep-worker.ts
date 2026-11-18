import { lstatSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parentPort, workerData } from 'node:worker_threads';

/**
 * Worker thread behind the `grep` tool.
 *
 * Matching runs here so a pathological regular expression can be stopped with
 * `Worker.terminate()` without blocking the Server's event loop. The file must
 * only import `node:` modules: in source form it is loaded as `.ts` through
 * Node's type stripping, which does not resolve relative `.js` imports.
 */

export interface GrepTask {
  readonly root: string;
  /** `/`-separated paths relative to `root`. */
  readonly files: readonly string[];
  readonly pattern: string;
  readonly regex: boolean;
  readonly ignoreCase: boolean;
  readonly contextLines: number;
  readonly maxOutputLines: number;
  readonly maxLinesPerFile: number;
  readonly maxFileBytes: number;
  readonly maxLineLength: number;
}

export interface GrepLine {
  readonly line: number;
  readonly text: string;
  readonly match: boolean;
}

export interface GrepFileResult {
  readonly file: string;
  /** Contiguous runs of matched and context lines. */
  readonly blocks: readonly (readonly GrepLine[])[];
}

export type GrepOutcome =
  | {
      readonly ok: true;
      readonly results: readonly GrepFileResult[];
      readonly totalMatches: number;
      readonly filesWithMatches: number;
      readonly scannedFiles: number;
      readonly truncated: boolean;
    }
  | { readonly ok: false; readonly code: 'invalid-pattern'; readonly message: string };

function shorten(text: string, maxLength: number): string {
  return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
}

function isBinary(bytes: Buffer): boolean {
  const end = Math.min(bytes.byteLength, 8000);
  for (let index = 0; index < end; index += 1) {
    if (bytes[index] === 0) {
      return true;
    }
  }
  return false;
}

export function runGrep(task: GrepTask): GrepOutcome {
  let matches: (line: string) => boolean;
  if (task.regex) {
    let expression: RegExp;
    try {
      expression = new RegExp(task.pattern, task.ignoreCase ? 'i' : '');
    } catch (error: unknown) {
      return {
        ok: false,
        code: 'invalid-pattern',
        message: error instanceof Error ? error.message : 'Invalid regular expression',
      };
    }
    matches = (line) => expression.test(line);
  } else if (task.ignoreCase) {
    const needle = task.pattern.toLowerCase();
    matches = (line) => line.toLowerCase().includes(needle);
  } else {
    matches = (line) => line.includes(task.pattern);
  }

  const results: GrepFileResult[] = [];
  let outputLines = 0;
  let totalMatches = 0;
  let filesWithMatches = 0;
  let scannedFiles = 0;
  // Some file had more matches than it may show; other files still show theirs.
  let fileTruncated = false;
  // The output budget is spent; later files are only counted.
  let budgetSpent = false;

  for (const file of task.files) {
    const absolutePath = path.join(task.root, file);
    let bytes: Buffer;
    try {
      const metadata = lstatSync(absolutePath);
      if (!metadata.isFile() || metadata.size > task.maxFileBytes) {
        continue;
      }
      bytes = readFileSync(absolutePath);
    } catch {
      continue;
    }
    if (isBinary(bytes)) {
      continue;
    }
    scannedFiles += 1;

    const lines = bytes.toString('utf8').split('\n');
    const matched: number[] = [];
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index] ?? '';
      if (matches(line.endsWith('\r') ? line.slice(0, -1) : line)) {
        matched.push(index);
      }
    }
    if (matched.length === 0) {
      continue;
    }
    filesWithMatches += 1;
    totalMatches += matched.length;
    if (budgetSpent) {
      continue;
    }

    // Build contiguous blocks of matched lines and their context.
    const shown = matched.slice(0, task.maxLinesPerFile);
    if (shown.length < matched.length) {
      fileTruncated = true;
    }
    const blocks: GrepLine[][] = [];
    let current: GrepLine[] = [];
    let lastIndex = -2;
    const matchedSet = new Set(shown);
    for (const index of shown) {
      const from = Math.max(0, index - task.contextLines);
      const to = Math.min(lines.length - 1, index + task.contextLines);
      for (let lineIndex = Math.max(from, lastIndex + 1); lineIndex <= to; lineIndex += 1) {
        if (lineIndex > lastIndex + 1 && current.length > 0) {
          blocks.push(current);
          current = [];
        }
        const raw = lines[lineIndex] ?? '';
        current.push({
          line: lineIndex + 1,
          text: shorten(raw.endsWith('\r') ? raw.slice(0, -1) : raw, task.maxLineLength),
          match: matchedSet.has(lineIndex),
        });
        lastIndex = lineIndex;
      }
    }
    if (current.length > 0) {
      blocks.push(current);
    }

    const lineCount = blocks.reduce((sum, block) => sum + block.length, 0);
    if (outputLines + lineCount > task.maxOutputLines) {
      budgetSpent = true;
      continue;
    }
    outputLines += lineCount;
    results.push({ file, blocks });
  }

  return {
    ok: true,
    results,
    totalMatches,
    filesWithMatches,
    scannedFiles,
    truncated: fileTruncated || budgetSpent,
  };
}

/** Message shape that marks `workerData` as a grep task. */
export interface GrepWorkerData {
  readonly kind: 'weave-grep';
  readonly task: GrepTask;
}

function isGrepWorkerData(value: unknown): value is GrepWorkerData {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { kind?: unknown }).kind === 'weave-grep'
  );
}

if (parentPort !== null && isGrepWorkerData(workerData)) {
  parentPort.postMessage(runGrep(workerData.task));
}
