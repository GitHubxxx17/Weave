import { estimateTokens } from './context/token-estimate.js';
import { WorkspaceFileError } from './workspace-file-types.js';

/**
 * Pure text helpers for the Workspace file tools: binary detection, paged
 * reads, and exact-text edits with a reviewable diff. No filesystem access.
 */

/** Bytes inspected when deciding whether a file is binary. */
const binaryProbeBytes = 8000;

/** Size caps for one `read_file` page. */
export interface FilePageCaps {
  /** Keeps a page under the Tool Pipeline result cap so it is never cut silently. */
  readonly maxBytes: number;
  /** Keeps a page under the context builder's per-result token cap. */
  readonly maxTokens: number;
}

export const defaultFilePageCaps: FilePageCaps = { maxBytes: 28_000, maxTokens: 6_000 };

/** Unified diff lines kept in an edit's Approval summary. */
const maxDiffLines = 200;
/** Context lines shown around each changed region. */
const diffContextLines = 3;
/** Lines kept in the snippet returned to the model after an edit. */
const maxSnippetLines = 20;

/** True when the leading bytes contain a NUL byte, the usual mark of a binary file. */
export function isBinaryContent(bytes: Uint8Array): boolean {
  const end = Math.min(bytes.byteLength, binaryProbeBytes);
  for (let index = 0; index < end; index += 1) {
    if (bytes[index] === 0) {
      return true;
    }
  }
  return false;
}

/** Splits text into lines; a trailing newline does not start an extra line. */
export function splitLines(content: string): string[] {
  if (content === '') {
    return [];
  }
  const lines = content.split('\n');
  if (lines[lines.length - 1] === '') {
    lines.pop();
  }
  return lines;
}

/** Number of lines in `content`, counted the same way as {@link splitLines}. */
export function countLines(content: string): number {
  return splitLines(content).length;
}

function shortenLine(line: string, caps: FilePageCaps): string {
  let cut = line;
  while (
    cut.length > 0 &&
    (Buffer.byteLength(cut, 'utf8') > caps.maxBytes - 200 ||
      estimateTokens(cut) > caps.maxTokens - 50)
  ) {
    cut = cut.slice(0, Math.floor(cut.length * 0.8));
  }
  return cut;
}

/**
 * Returns one page of a text file for the model.
 *
 * A file that fits in one page is returned unchanged, byte for byte, so an
 * exact-text edit can copy from it. Otherwise the page ends with a line that
 * states the shown range, the total, and the `offset` of the next page.
 */
export function formatFilePage(
  content: string,
  offset: number,
  limit: number,
  caps: FilePageCaps = defaultFilePageCaps,
): string {
  const lines = splitLines(content);
  const total = lines.length;
  if (
    offset === 1 &&
    total <= limit &&
    Buffer.byteLength(content, 'utf8') <= caps.maxBytes &&
    estimateTokens(content) <= caps.maxTokens
  ) {
    return content;
  }
  if (offset > Math.max(total, 1)) {
    throw new WorkspaceFileError(
      'workspace-file-invalid-input',
      `offset ${offset} is beyond the end of the file, which has ${total} lines`,
    );
  }

  const selected: string[] = [];
  let bytes = 0;
  let tokens = 0;
  let longLine = false;
  for (let index = offset - 1; index < total && selected.length < limit; index += 1) {
    const line = lines[index] ?? '';
    const lineBytes = Buffer.byteLength(line, 'utf8') + 1;
    const lineTokens = estimateTokens(line) + 1;
    if (bytes + lineBytes > caps.maxBytes || tokens + lineTokens > caps.maxTokens) {
      if (selected.length === 0) {
        selected.push(shortenLine(line, caps));
        longLine = true;
      }
      break;
    }
    selected.push(line);
    bytes += lineBytes;
    tokens += lineTokens;
  }

  const last = offset + selected.length - 1;
  const notes: string[] = [];
  if (longLine) {
    notes.push(`第 ${offset} 行过长，只显示了开头部分`);
  }
  notes.push(
    last < total
      ? `已显示第 ${offset}–${last} 行，共 ${total} 行。继续读取请传 offset: ${last + 1}`
      : `已显示第 ${offset}–${last} 行，共 ${total} 行，已到文件末尾`,
  );
  return `${selected.join('\n')}\n\n[${notes.join('；')}]`;
}

/** Start indexes of the non-overlapping occurrences of `needle`, in order. */
export function findOccurrences(haystack: string, needle: string): number[] {
  const result: number[] = [];
  let from = 0;
  while (needle !== '') {
    const index = haystack.indexOf(needle, from);
    if (index === -1) {
      break;
    }
    result.push(index);
    from = index + needle.length;
  }
  return result;
}

/** Input of {@link planTextEdit}. */
export interface TextEditRequest {
  readonly oldText: string;
  readonly newText: string;
  readonly replaceAll?: boolean | undefined;
}

/** Outcome of an exact-text edit, computed without touching the filesystem. */
export interface TextEditPlan {
  readonly updated: string;
  readonly replacements: number;
  readonly linesAdded: number;
  readonly linesRemoved: number;
  /** Unified diff of the change for the Approval card, capped at 200 lines. */
  readonly diff: string;
  readonly diffTruncated: boolean;
  /** Numbered lines around the first change, as they read after the edit. */
  readonly snippet: string;
}

interface EditSegment {
  readonly start: number;
  end: number;
  readonly occurrences: number[];
}

interface EditHunk {
  readonly oldStart: number;
  readonly newStart: number;
  readonly removed: readonly string[];
  readonly added: readonly string[];
}

function displayLine(line: string): string {
  return line.endsWith('\r') ? line.slice(0, -1) : line;
}

function countNewlines(text: string, from: number, to: number): number {
  let count = 0;
  for (let index = text.indexOf('\n', from); index !== -1 && index < to;) {
    count += 1;
    index = text.indexOf('\n', index + 1);
  }
  return count;
}

/**
 * Applies an exact-text replacement and describes it.
 *
 * Throws `workspace-edit-noop`, `workspace-edit-no-match` or
 * `workspace-edit-ambiguous` with a message the model can act on. When the
 * file uses CRLF and the request uses LF, the request is matched as CRLF.
 */
export function planTextEdit(content: string, request: TextEditRequest): TextEditPlan {
  if (request.oldText === request.newText) {
    throw new WorkspaceFileError('workspace-edit-noop', 'oldText and newText are identical');
  }

  let oldText = request.oldText;
  let newText = request.newText;
  let occurrences = findOccurrences(content, oldText);
  if (
    occurrences.length === 0 &&
    content.includes('\r\n') &&
    oldText.includes('\n') &&
    !oldText.includes('\r\n')
  ) {
    const crlfOldText = oldText.replace(/\n/g, '\r\n');
    const crlfOccurrences = findOccurrences(content, crlfOldText);
    if (crlfOccurrences.length > 0) {
      oldText = crlfOldText;
      newText = newText.replace(/\r?\n/g, '\r\n');
      occurrences = crlfOccurrences;
    }
  }

  if (occurrences.length === 0) {
    throw new WorkspaceFileError(
      'workspace-edit-no-match',
      'oldText was not found in the file. Check spaces, indentation and line breaks, or read the file again.',
    );
  }
  if (occurrences.length > 1 && request.replaceAll !== true) {
    const lineNumbers: number[] = [];
    let line = 1;
    let position = 0;
    for (const index of occurrences.slice(0, 10)) {
      line += countNewlines(content, position, index);
      position = index;
      lineNumbers.push(line);
    }
    throw new WorkspaceFileError(
      'workspace-edit-ambiguous',
      `oldText matches ${occurrences.length} places (lines ${lineNumbers.join(', ')}${
        occurrences.length > 10 ? ', …' : ''
      }). Include more surrounding text to make it unique, or pass replaceAll: true.`,
    );
  }

  const used = request.replaceAll === true ? occurrences : occurrences.slice(0, 1);

  // Group occurrences whose lines touch, so one line edited twice is one hunk.
  const segments: EditSegment[] = [];
  for (const index of used) {
    const start = content.lastIndexOf('\n', index - 1) + 1;
    const newlineAfter = content.indexOf('\n', index + oldText.length);
    const end = newlineAfter === -1 ? content.length : newlineAfter;
    const previous = segments[segments.length - 1];
    if (previous !== undefined && start <= previous.end) {
      previous.end = Math.max(previous.end, end);
      previous.occurrences.push(index);
    } else {
      segments.push({ start, end, occurrences: [index] });
    }
  }

  let updated = '';
  let cursor = 0;
  for (const index of used) {
    updated += content.slice(cursor, index) + newText;
    cursor = index + oldText.length;
  }
  updated += content.slice(cursor);

  const hunks: EditHunk[] = [];
  let linesAdded = 0;
  let linesRemoved = 0;
  let lineDelta = 0;
  let lineAtCursor = 1;
  let lineCursor = 0;
  for (const segment of segments) {
    lineAtCursor += countNewlines(content, lineCursor, segment.start);
    lineCursor = segment.start;
    const oldSegment = content.slice(segment.start, segment.end);
    let newSegment = '';
    let segmentCursor = segment.start;
    for (const index of segment.occurrences) {
      newSegment += content.slice(segmentCursor, index) + newText;
      segmentCursor = index + oldText.length;
    }
    newSegment += content.slice(segmentCursor, segment.end);

    const oldLines = oldSegment.split('\n');
    const newLines = newSegment.split('\n');
    let prefix = 0;
    while (
      prefix < oldLines.length &&
      prefix < newLines.length &&
      oldLines[prefix] === newLines[prefix]
    ) {
      prefix += 1;
    }
    let suffix = 0;
    while (
      suffix < oldLines.length - prefix &&
      suffix < newLines.length - prefix &&
      oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
    ) {
      suffix += 1;
    }
    const removed = oldLines.slice(prefix, oldLines.length - suffix);
    const added = newLines.slice(prefix, newLines.length - suffix);
    const oldStart = lineAtCursor + prefix;
    hunks.push({ oldStart, newStart: oldStart + lineDelta, removed, added });
    linesRemoved += removed.length;
    linesAdded += added.length;
    lineDelta += added.length - removed.length;
  }

  const updatedLines = splitLines(updated);
  const diffLines: string[] = [];
  let diffTruncated = false;
  for (const hunk of hunks) {
    const beforeStart = Math.max(1, hunk.newStart - diffContextLines);
    const before = updatedLines.slice(beforeStart - 1, hunk.newStart - 1);
    const afterStart = hunk.newStart - 1 + hunk.added.length;
    const after = updatedLines.slice(afterStart, afterStart + diffContextLines);
    const block = [
      `@@ -${hunk.oldStart - before.length},${before.length + hunk.removed.length + after.length} +${
        hunk.newStart - before.length
      },${before.length + hunk.added.length + after.length} @@`,
      ...before.map((line) => ` ${displayLine(line)}`),
      ...hunk.removed.map((line) => `-${displayLine(line)}`),
      ...hunk.added.map((line) => `+${displayLine(line)}`),
      ...after.map((line) => ` ${displayLine(line)}`),
    ];
    if (diffLines.length + block.length > maxDiffLines) {
      diffLines.push(...block.slice(0, Math.max(0, maxDiffLines - diffLines.length)));
      diffTruncated = true;
      break;
    }
    diffLines.push(...block);
  }

  const first = hunks[0];
  let snippet = '';
  if (first !== undefined) {
    const total = updatedLines.length;
    const from = Math.max(1, first.newStart - 2);
    const to = Math.min(total, first.newStart + Math.max(first.added.length, 1) - 1 + 2);
    const numbered: string[] = [];
    for (let line = from; line <= to && numbered.length < maxSnippetLines; line += 1) {
      numbered.push(`${line}: ${displayLine(updatedLines[line - 1] ?? '')}`);
    }
    snippet = numbered.join('\n');
  }

  return {
    updated,
    replacements: used.length,
    linesAdded,
    linesRemoved,
    diff: diffLines.join('\n'),
    diffTruncated,
    snippet,
  };
}
