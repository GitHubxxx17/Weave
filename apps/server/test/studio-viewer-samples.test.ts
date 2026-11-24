import { test } from 'vitest';
import assert from 'node:assert/strict';
// @ts-expect-error Node-only performance tooling is JavaScript.
import { viewerCases, viewerSamples } from './performance/viewer-samples.mjs';
const options = {
  sizes: [102400, 409600, 1992294],
  encodings: ['ascii', 'multibyte'],
  lineShapes: ['single', 'multi'],
  repeats: 3,
};

test('viewer matrix is exactly 36 independent cases', () => {
  const cases = [...viewerCases(options)];
  assert.equal(cases.length, 36);
  assert.equal(new Set(cases.map((c) => JSON.stringify(c))).size, 36);
  for (const bytes of options.sizes)
    for (const encoding of options.encodings)
      for (const lineShape of options.lineShapes)
        assert.deepEqual(
          cases
            .filter(
              (c) => c.bytes === bytes && c.encoding === encoding && c.lineShape === lineShape,
            )
            .map((c) => c.repeat),
          [0, 1, 2],
        );
});

test('sample failure is retained, closed, then next case owns a fresh fixture/browser', async () => {
  const events = [];
  let identity = 0;
  const observations = [];
  for await (const observation of viewerSamples(
    { ...options, sizes: [102400], encodings: ['ascii'], lineShapes: ['single'], repeats: 3 },
    {
      async startFixture() {
        const id = ++identity;
        events.push(`fixture:${id}`);
        return {
          id,
          tree: { hash: `hash-${id}` },
          close: async () => events.push(`fixture-close:${id}`),
        };
      },
      async openBrowser(f) {
        events.push(`browser:${f.id}`);
      },
      async probe(f) {
        events.push(`probe:${f.id}`);
        if (f.id === 2) throw Error('phase deadline');
        return { failures: [], value: f.id };
      },
      async closeBrowser(f) {
        events.push(`browser-close:${f.id}`);
      },
    },
  ))
    observations.push(observation);
  assert.deepEqual(
    observations.map((x) => x.status),
    ['passed', 'failed', 'passed'],
  );
  assert.equal(observations[1].failure.message, 'phase deadline');
  assert.equal(observations[2].result.value, 3);
  assert.deepEqual(events, [
    'fixture:1',
    'browser:1',
    'probe:1',
    'browser-close:1',
    'fixture-close:1',
    'fixture:2',
    'browser:2',
    'probe:2',
    'browser-close:2',
    'fixture-close:2',
    'fixture:3',
    'browser:3',
    'probe:3',
    'browser-close:3',
    'fixture-close:3',
  ]);
});

test('closing generator early does not leak its completed sample owner', async () => {
  let closed = 0;
  const iterator = viewerSamples(options, {
    startFixture: async () => ({ close: async () => closed++ }),
    openBrowser: async () => {},
    probe: async () => ({ failures: [] }),
    closeBrowser: async () => closed++,
  });
  await iterator.next();
  await iterator.return();
  assert.equal(closed, 2);
});
