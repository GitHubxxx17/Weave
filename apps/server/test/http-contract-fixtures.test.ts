import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { captureHttpContract, type HttpContractFixtures } from './http-contract-capture.js';

const directory = fileURLToPath(new URL('../../../test/fixtures/http-contract/', import.meta.url));
const update = process.env.WEAVE_UPDATE_HTTP_CONTRACT === '1';
const regenerate =
  'Studio reads these files in apps/studio/test/http-contract.test.ts. If the Server change is intended, regenerate with: ' +
  'WEAVE_UPDATE_HTTP_CONTRACT=1 pnpm --filter @weave/server exec vitest run --root ../.. --config vitest.config.ts apps/server/test/http-contract-fixtures.test.ts && pnpm format';

describe('Server HTTP contract fixtures consumed by Studio', () => {
  it('match what the real Server currently sends', async () => {
    const actual = await captureHttpContract();
    const names = Object.keys(actual) as (keyof HttpContractFixtures)[];
    if (update) {
      await mkdir(directory, { recursive: true });
      for (const name of names)
        await writeFile(`${directory}${name}.json`, `${JSON.stringify(actual[name], null, 2)}\n`);
    }
    for (const name of names) {
      const stored = JSON.parse(await readFile(`${directory}${name}.json`, 'utf8')) as unknown;
      expect(actual[name], `${name}.json is stale. ${regenerate}`).toEqual(stored);
    }
  }, 60_000);
});
