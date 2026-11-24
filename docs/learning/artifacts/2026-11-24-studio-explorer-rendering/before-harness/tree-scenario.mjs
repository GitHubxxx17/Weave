import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { z } from 'zod';

export const viewerOptionsSchema = z.strictObject({
  bytes: z.number().int().min(1).max(2_000_000).default(102400),
  encoding: z.enum(['ascii', 'multibyte']).default('ascii'),
  lineShape: z.enum(['single', 'multi']).default('multi'),
});
export const treeOptionsSchema = z.strictObject({
  fileCount: z.union([z.literal(1000), z.literal(10000), z.literal(50000)]),
  shape: z.enum(['wide-root', 'wide-src']),
  truncated: z.boolean().default(false),
  viewer: viewerOptionsSchema.optional(),
});
const error = { error: { code: 'benchmark-not-found', message: 'Unknown synthetic path' } };

function viewerText({ bytes, encoding, lineShape }) {
  const unit = encoding === 'ascii' ? 'const bounded = 42;' : 'const 范围 = "中文";';
  const block = unit + (lineShape === 'multi' ? '\n' : ' ');
  const blockBytes = Buffer.byteLength(block);
  const copies = Math.floor(bytes / blockBytes);
  return block.repeat(copies) + ' '.repeat(bytes - copies * blockBytes);
}

/** Synthetic production DTOs. There are no disk, Git, provider or workspace reads. */
export function createTreeScenario(input) {
  const options = treeOptionsSchema.parse(input);
  const prefix = options.shape === 'wide-src' ? 'src/' : '';
  const files = Array.from({ length: options.fileCount }, (_, index) => `${prefix}file-${String(index).padStart(5, '0')}.ts`);
  const pathSet = new Set(files);
  const listing = { files, source: 'git', truncated: options.truncated };
  const sentinels = [0, options.fileCount / 2, options.fileCount - 1].map((index) => ({ index, path: files[index] }));
  const content = options.viewer === undefined ? undefined : viewerText(options.viewer);
  const hash = createHash('sha256').update(JSON.stringify({ options, listing })).digest('hex');
  return {
    options, listing, sentinels, hash,
    contains: (path) => pathSet.has(path),
    file: (path) => {
      const body = content ?? `// ${path}\nexport const identity = ${JSON.stringify(['benchmark-project', path])};\n`;
      return { path, content: body, bytes: Buffer.byteLength(body), truncated: false };
    },
    diff: (path) => {
      const next = content ?? `// ${path}\nexport const status = 'after';\n`;
      const old = options.viewer === undefined ? `// ${path}\nexport const status = 'before';\n` : next.replace('const ', 'let   ');
      return { path, oldContent: old, newContent: next, changed: true, tracked: true };
    },
  };
}

export function treeResponse(scenario, pathname, query) {
  const match = /^\/projects\/benchmark-project\/(tree|file|file-diff)$/.exec(pathname);
  if (match === null) return { status: 404, body: error };
  if (match[1] === 'tree') return { status: 200, body: scenario.listing };
  const path = query.get('path');
  if (path === null || !scenario.contains(path)) return { status: 404, body: error };
  return { status: 200, body: match[1] === 'file' ? scenario.file(path) : scenario.diff(path) };
}
