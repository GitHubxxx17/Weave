import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { hookImpacts } from '@weave/plugin';

/**
 * Studio cannot import `@weave/*`, so `plugin-review.ts` keeps a mirror of the
 * hook risk table. This contract test keeps the mirror equal to the host table.
 */
describe('Studio hook risk mirror', () => {
  it('lists the same hooks with the same level and wording as @weave/plugin', async () => {
    const source = await readFile(
      fileURLToPath(new URL('../../studio/src/features/plugins/plugin-review.ts', import.meta.url)),
      'utf8',
    );
    const mirror = Object.fromEntries(
      [
        ...source.matchAll(
          /'(weave\.[a-z.]+)': \{ level: '(high|medium|low)', description: '([^']+)' \}/g,
        ),
      ].map(([, id, level, description]) => [id, { level, description }]),
    );
    expect(mirror).toEqual(
      Object.fromEntries(
        Object.entries(hookImpacts).map(([id, impact]) => [
          id,
          { level: impact.level, description: impact.description },
        ]),
      ),
    );
  });
});
