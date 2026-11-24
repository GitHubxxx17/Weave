import { describe, it, test } from 'vitest';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
// @ts-expect-error Node-only performance tooling is JavaScript.
import {
  createTreeScenario,
  treeOptionsSchema,
  viewerOptionsSchema,
  treeResponse,
} from './performance/tree-scenario.mjs';

describe('synthetic Explorer workload', () => {
  it('bounds enumeration choices before generating bodies', () => {
    assert.throws(() => treeOptionsSchema.parse({ fileCount: 50001, shape: 'wide-root' }));
    assert.throws(() => treeOptionsSchema.parse({ fileCount: 1000, shape: 'deep' }));
    assert.throws(() => viewerOptionsSchema.parse({ bytes: 2_000_001 }));
  });
  it('generates exact stable wide-root/wide-src paths and first/middle/last identities', () => {
    for (const fileCount of [1000, 10000, 50000])
      for (const shape of ['wide-root', 'wide-src']) {
        const a = createTreeScenario({ fileCount, shape });
        const b = createTreeScenario({ fileCount, shape });
        assert.deepEqual(a.listing, b.listing);
        assert.equal(a.listing.files.length, fileCount);
        assert.equal(new Set(a.listing.files).size, fileCount);
        assert.equal(a.listing.truncated, false);
        assert.deepEqual(
          a.sentinels.map(({ index }) => index),
          [0, fileCount / 2, fileCount - 1],
        );
        for (const sentinel of a.sentinels)
          assert.equal(a.listing.files[sentinel.index], sentinel.path);
        assert.equal(
          a.listing.files.every((path) =>
            shape === 'wide-src' ? path.startsWith('src/') : !path.includes('/'),
          ),
          true,
        );
      }
  });
  it('serves only listed exact project paths through production-shaped bodies', () => {
    const scenario = createTreeScenario({ fileCount: 1000, shape: 'wide-src' });
    const path = scenario.sentinels[1].path;
    const file = treeResponse(
      scenario,
      '/projects/benchmark-project/file',
      new URLSearchParams({ path }),
    );
    assert.equal(file.status, 200);
    assert.equal(file.body.path, path);
    assert.equal(file.body.bytes, Buffer.byteLength(file.body.content));
    assert.equal(file.body.truncated, false);
    const diff = treeResponse(
      scenario,
      '/projects/benchmark-project/file-diff',
      new URLSearchParams({ path }),
    );
    assert.equal(diff.body.changed, true);
    assert.equal(diff.body.tracked, true);
    for (const path of [
      '../package.json',
      '/etc/passwd',
      'src/unknown.ts',
      'src/%2e%2e/package.json',
    ]) {
      assert.equal(
        treeResponse(scenario, '/projects/benchmark-project/file', new URLSearchParams({ path }))
          .status,
        404,
      );
    }
    assert.equal(
      treeResponse(scenario, '/projects/other/file', new URLSearchParams({ path })).status,
      404,
    );
    assert.equal(
      treeResponse(scenario, '/projects/benchmark-project/unknown', new URLSearchParams({ path }))
        .status,
      404,
    );
  });
  it('makes bounded exact UTF-8 viewer sizes across ascii/multibyte and line shapes', () => {
    for (const bytes of [102400, 409600, 1992294])
      for (const encoding of ['ascii', 'multibyte'])
        for (const lineShape of ['single', 'multi']) {
          const scenario = createTreeScenario({
            fileCount: 1000,
            shape: 'wide-root',
            viewer: { bytes, encoding, lineShape },
          });
          const result = treeResponse(
            scenario,
            '/projects/benchmark-project/file',
            new URLSearchParams({ path: scenario.sentinels[0].path }),
          );
          assert.equal(Buffer.byteLength(result.body.content), bytes);
          assert.equal(result.body.content.includes('\n'), lineShape === 'multi');
          assert.ok(result.body.content.length <= bytes);
        }
  });
});

import { createHash } from 'node:crypto';

test('viewer fixtures expose exact listed txt/ts siblings without changing total rows', () => {
  for (const bytes of [102400, 409600, 1992294])
    for (const encoding of ['ascii', 'multibyte'])
      for (const lineShape of ['single', 'multi']) {
        const tree = createTreeScenario({
          fileCount: 1000,
          shape: 'wide-root',
          viewer: { bytes, encoding, lineShape },
        });
        const metadata = tree.viewerMetadata;
        assert.ok(metadata);
        assert.equal(tree.listing.files.length, 1000);
        assert.ok(tree.listing.files.includes(metadata.plainPath));
        assert.ok(tree.listing.files.includes(metadata.highlightPath));
        assert.ok(metadata.plainPath.endsWith('.txt'));
        assert.ok(metadata.highlightPath.endsWith('.ts'));
        const plain = tree.file(metadata.plainPath),
          highlight = tree.file(metadata.highlightPath);
        assert.equal(plain.content, highlight.content);
        assert.equal(plain.bytes, bytes);
        assert.equal(Buffer.byteLength(plain.content), bytes);
        assert.equal(metadata.codeUnits, plain.content.length);
        assert.equal(metadata.lineCount, plain.content.split('\n').length);
        assert.equal(
          metadata.longestLine,
          Math.max(...plain.content.split('\n').map((x) => x.length)),
        );
        assert.equal(metadata.expectedHighlight, plain.content.length <= 400000);
        assert.equal(
          metadata.contentHash,
          createHash('sha256').update(plain.content).digest('hex'),
        );
        const diff = tree.diff(metadata.highlightPath);
        assert.notEqual(diff.oldContent, diff.newContent);
        assert.equal(Buffer.byteLength(diff.oldContent), bytes);
        assert.equal(Buffer.byteLength(diff.newContent), bytes);
        assert.equal(diff.newContent, plain.content);
        assert.equal('truncated' in diff, false);
        assert.equal(
          treeResponse(
            tree,
            '/projects/benchmark-project/file',
            new URLSearchParams({ path: metadata.plainPath }),
          ).status,
          200,
        );
      }
});

test('plain sibling is not authorized when viewer mode is absent', () => {
  const tree = createTreeScenario({ fileCount: 1000, shape: 'wide-root' });
  assert.equal(tree.viewerMetadata, undefined);
  assert.equal(
    treeResponse(
      tree,
      '/projects/benchmark-project/file',
      new URLSearchParams({ path: 'file-00999.txt' }),
    ).status,
    404,
  );
});

// @ts-expect-error Node-only performance tooling is JavaScript.
import { startPerformanceFixture } from './performance/fixture.mjs';

test('isolated HTTP tree routes expose only listed synthetic bytes and no-store', async () => {
  const fixture = await startPerformanceFixture({
    count: 100,
    variant: 'markdown',
    tree: {
      fileCount: 1000,
      shape: 'wide-src',
      viewer: { bytes: 102400, encoding: 'multibyte', lineShape: 'multi' },
    },
  });
  try {
    const listing = await fetch(`${fixture.url}/projects/benchmark-project/tree`);
    assert.equal(listing.headers.get('cache-control'), 'no-store');
    const body = await listing.json();
    assert.equal(body.files.length, 1000);
    assert.equal(body.source, 'git');
    const file = await fetch(
      `${fixture.url}/projects/benchmark-project/file?path=${encodeURIComponent(fixture.tree.viewer.plainPath)}`,
    ).then((response) => response.json());
    assert.equal(Buffer.byteLength(file.content), 102400);
    assert.equal(file.path, fixture.tree.viewer.plainPath);
    const diff = await fetch(
      `${fixture.url}/projects/benchmark-project/file-diff?path=${encodeURIComponent(fixture.tree.viewer.highlightPath)}`,
    ).then((response) => response.json());
    assert.equal(diff.newContent, file.content);
    for (const path of ['../package.json', '/etc/passwd', 'src/missing.ts']) {
      assert.equal(
        (
          await fetch(
            `${fixture.url}/projects/benchmark-project/file?path=${encodeURIComponent(path)}`,
          )
        ).status,
        404,
      );
    }
    assert.equal((await fetch(`${fixture.url}/projects/other/tree`)).status, 404);
  } finally {
    await fixture.close();
  }
});
