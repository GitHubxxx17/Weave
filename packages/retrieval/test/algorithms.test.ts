import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import {
  retrievalPreparedDocumentsSchema,
  type RetrievalCapturedDocument,
  type RetrievalManifest,
} from '@weave/protocol';
import { describe, expect, it } from 'vitest';
import { prepareDocuments } from '../src/chunking.js';
import { buildLexicalMatch } from '../src/lexical-query.js';
import { retrievalManifestDigest } from '../src/identity.js';
import { diversifyRetrievalCandidates, fuseRetrievalCandidates } from '../src/rrf.js';

const digest = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
const projectId = 'c0d33757-d44a-4f1e-a923-7f3852d7532c';
const capturedAt = '2026-11-23T01:02:03Z';

function file(path: string, body: string): RetrievalCapturedDocument {
  return {
    source: {
      kind: 'workspace',
      sourceKey: `workspace:${path}`,
      path,
      sourceSha256: digest(body),
      sourceBytes: Buffer.byteLength(body),
      fileObjectDigest: 'a'.repeat(64),
    },
    title: path.split('/').at(-1)!,
    lexicalMetadata: { tags: [] },
    body,
    capturedAt,
  };
}

const memory: RetrievalCapturedDocument = {
  source: {
    kind: 'memory',
    sourceKey: 'memory:2f96c057-2d2e-4d76-b788-f26b9715de1d',
    ref: {
      scope: { kind: 'project', projectId },
      memoryId: '2f96c057-2d2e-4d76-b788-f26b9715de1d',
      revision: 1,
      sha256: 'b'.repeat(64),
    },
    sourceSha256: digest('Repeatable on macOS'),
    sourceBytes: 19,
  },
  title: 'Test notes',
  lexicalMetadata: { tags: ['冷启动'] },
  body: 'Repeatable on macOS',
  capturedAt,
};

describe('retrieval chunk preparation', () => {
  it('preserves CRLF, lone CR, Unicode, checksums and inclusive line ranges', () => {
    const body = '🚀启动\r\n第二行\r\n\nend\rlast';
    const result = prepareDocuments([file('src/main.ts', body)]);
    expect(result.chunks).toHaveLength(1);
    expect(result.chunks[0]).toMatchObject({
      text: body,
      identity: {
        startLine: 1,
        endLine: 5,
        startColumn: 0,
        endColumn: 4,
        textBytes: 32,
        textSha256: digest(body),
      },
    });
    expect(retrievalPreparedDocumentsSchema.safeParse(result).success).toBe(true);
  });

  it('uses complete lines for bounded overlap and drops the artificial trailing empty line', () => {
    const body = '1234567890\n'.repeat(82);
    const result = prepareDocuments([file('notes.txt', body)]);
    expect(
      result.chunks.map(({ identity }) => [
        identity.startLine,
        identity.endLine,
        identity.textBytes,
      ]),
    ).toEqual([
      [1, 80, 880],
      [73, 82, 110],
    ]);
    expect(result.chunks[0]!.identity.chunkId).not.toBe(result.chunks[1]!.identity.chunkId);
    const wide = prepareDocuments([
      file('wide.txt', `${'a'.repeat(1999)}\n${'b'.repeat(199)}\n${'c'.repeat(1999)}\n`),
    ]);
    expect(
      wide.chunks.map(({ identity }) => [identity.startLine, identity.endLine, identity.textBytes]),
    ).toEqual([
      [1, 1, 2000],
      [2, 2, 200],
      [3, 3, 2000],
    ]);
  });

  it('splits long lines without breaking a codepoint or CRLF and preserves exact columns', () => {
    const body = `${'a'.repeat(2047)}🚀\r\nnext`;
    const result = prepareDocuments([file('wide.txt', body)]);
    expect(
      result.chunks.map(({ identity, text }) => [
        identity.startLine,
        identity.endLine,
        identity.startColumn,
        identity.endColumn,
        Buffer.byteLength(text),
      ]),
    ).toEqual([
      [1, 1, 0, 2047, 2047],
      [1, 2, 2047, 4, 10],
    ]);
    expect(result.chunks.map(({ text }) => text).join('')).toBe(body);
    expect(retrievalPreparedDocumentsSchema.safeParse(result).success).toBe(true);
  });

  it('sorts sources canonically, preserves exact bodies and rejects bad or duplicate captures as a unit', () => {
    const a = file('a.ts', 'one');
    const b = file('b.ts', 'one');
    const result = prepareDocuments([b, a]);
    expect(result).toEqual(prepareDocuments([a, b]));
    expect(result.sources.map(({ source }) => source.sourceKey)).toEqual([
      'workspace:a.ts',
      'workspace:b.ts',
    ]);
    expect(result.chunks[0]!.identity.chunkId).not.toBe(result.chunks[1]!.identity.chunkId);
    expect(result.metrics).toEqual({
      files: 2,
      memories: 0,
      sources: 2,
      captureBytes: 6,
      chunks: 2,
      chunkTextBytes: 6,
    });
    expect(prepareDocuments([]).chunks).toEqual([]);
    expect(() => prepareDocuments([a, a])).toThrow(
      expect.objectContaining({ code: 'retrieval-invalid-input' }),
    );
    expect(() => prepareDocuments([a, { ...b, body: 'two' }])).toThrow(
      expect.objectContaining({ code: 'retrieval-invalid-input' }),
    );
    expect(Object.isFrozen(result.sources[0]?.source)).toBe(true);
  });

  it('rejects an over-budget batch without returning a partial preparation', () => {
    const body = 'a'.repeat(262_144);
    expect(() =>
      prepareDocuments(Array.from({ length: 65 }, (_, index) => file(`d${index}.txt`, body))),
    ).toThrow(expect.objectContaining({ code: 'retrieval-limit' }));
  });
});

describe('retrieval lexical matching', () => {
  it('matches code parts, Han substrings and reviewed Memory tags in actual FTS5', () => {
    const documents = [
      file('src/cache_loader.ts', '// 完成缓存更新\nexport function getHTTPResponse() {}'),
      memory,
      file('readme.md', 'hello world'),
    ];
    const prepared = prepareDocuments(documents);
    const db = new DatabaseSync(':memory:');
    try {
      db.exec(
        'CREATE VIRTUAL TABLE idx USING fts5(sourceKey UNINDEXED, title, body, terms, tokenize=unicode61)',
      );
      const insert = db.prepare('INSERT INTO idx VALUES (?, ?, ?, ?)');
      for (const chunk of prepared.chunks) {
        const doc = documents.find(({ source }) => source.sourceKey === chunk.identity.sourceKey)!;
        insert.run(doc.source.sourceKey, doc.title, chunk.text, chunk.terms);
      }
      const matched = (query: string) =>
        db.prepare('SELECT sourceKey FROM idx WHERE idx MATCH ?').all(buildLexicalMatch(query)!);
      for (const query of ['cache.loader', 'HTTP response', 'ｈｔｔｐ', '缓存']) {
        expect(matched(query)).toEqual([{ sourceKey: 'workspace:src/cache_loader.ts' }]);
      }
      expect(matched('冷启动')).toEqual([{ sourceKey: memory.source.sourceKey }]);
      expect(prepared.chunks[0]?.text).toBe(memory.body);
      expect(matched('NO_SUCH_COLUMN: absent* NOT "hello world" ()')).toEqual([
        { sourceKey: 'workspace:readme.md' },
      ]);
    } finally {
      db.close();
    }
  });

  it('caps terms and rejects malformed or oversized query input', () => {
    expect(buildLexicalMatch('xyz OR xyz')).toEqual('"xyz" OR "or"');
    expect(buildLexicalMatch('.. :: ( *)')).toBeUndefined();
    expect(
      buildLexicalMatch(Array.from({ length: 33 }, (_, i) => `s${i}`).join(' '))?.split(' OR '),
    ).toHaveLength(32);
    expect(() => buildLexicalMatch('教'.repeat(513))).toThrow(
      expect.objectContaining({ code: 'retrieval-invalid-input' }),
    );
    expect(() => buildLexicalMatch('\uD800')).toThrow(
      expect.objectContaining({ code: 'retrieval-invalid-input' }),
    );
  });
});

describe('retrieval candidate fusion', () => {
  const documents = [file('z.ts', 'z'), file('a.ts', 'a'), file('v.ts', 'v'), file('l.ts', 'l')];
  function candidate(document: RetrievalCapturedDocument) {
    return {
      source: document.source,
      title: document.title,
      chunk: prepareDocuments([document]).chunks[0]!.identity,
      text: document.body,
    };
  }

  it('uses one-based reciprocal ranks with stable tie and separate single-lane contributions', () => {
    const [z, a, v, l] = documents.map(candidate);
    const ranked = fuseRetrievalCandidates([z!, a!, l!], [a!, z!, v!]);
    expect(ranked.map((row) => row.source.sourceKey)).toEqual([
      'workspace:a.ts',
      'workspace:z.ts',
      'workspace:l.ts',
      'workspace:v.ts',
    ]);
    expect(ranked[0]).toMatchObject({ lexicalRank: 2, vectorRank: 1, rrfScore: 1 / 62 + 1 / 61 });
    expect(ranked[2]).toMatchObject({ lexicalRank: 3, rrfScore: 1 / 63 });
    expect(ranked[2]?.vectorRank).toBeUndefined();
  });

  it('removes overlapping chunks and caps each source after ranking', () => {
    const doc = file('long.ts', 'a\n'.repeat(320));
    const long = prepareDocuments([doc]).chunks.map(({ identity, text }) => ({
      source: doc.source,
      title: doc.title,
      chunk: identity,
      text,
    }));
    const other = candidate(documents[0]!);
    expect(
      diversifyRetrievalCandidates([...long, other]).map(({ chunk }) => [
        chunk.sourceKey,
        chunk.ordinal,
      ]),
    ).toEqual([
      ['workspace:long.ts', 0],
      ['workspace:long.ts', 2],
      ['workspace:z.ts', 0],
    ]);
  });
});

describe('retrieval manifest digest', () => {
  it('binds filters and content metadata while ignoring the capture clock and object key order', () => {
    const { metrics, ...prepared } = prepareDocuments([file('src/a.ts', 'a')]);
    const manifest: Omit<RetrievalManifest, 'manifestDigest'> = {
      ...prepared,
      project: { projectId, folderRevision: 0, rootDigest: 'c'.repeat(64) },
      mode: 'lexical',
      selection: {
        workspace: { enabled: true, paths: { include: [], exclude: [] } },
        memoryRefs: [],
      },
      counts: { ...metrics, discovered: 1, selected: 1, skipped: 0 },
      coverage: {
        discovery: 'git',
        truncated: false,
        skippedDetailsTruncated: false,
        skipCounts: [],
      },
    };
    const initial = retrievalManifestDigest(manifest);
    expect(
      retrievalManifestDigest({
        ...manifest,
        sources: [{ ...manifest.sources[0]!, capturedAt: '2026-11-23T02:00:00Z' }],
        project: { rootDigest: 'c'.repeat(64), folderRevision: 0, projectId },
      }),
    ).toBe(initial);
    expect(
      retrievalManifestDigest({
        ...manifest,
        selection: {
          ...manifest.selection,
          workspace: { enabled: true, paths: { include: ['src'], exclude: [] } },
        },
      }),
    ).not.toBe(initial);
    expect(
      retrievalManifestDigest({
        ...manifest,
        sources: [{ ...manifest.sources[0]!, title: 'Alias' }],
      }),
    ).not.toBe(initial);
  });
});
