import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ESLint } from 'eslint';

const eslint = new ESLint({ cwd: resolve(import.meta.dirname, '../../..') });
async function errors(filePath: string, source: string) {
  const [result] = await eslint.lintText(source, { filePath });
  return result?.messages
    .filter((message) => message.ruleId?.startsWith('weave/'))
    .map((message) => message.messageId);
}
describe('memory package boundaries', () => {
  it('allows only Protocol in the Memory leaf and allows its declared Server consumer', async () => {
    expect(
      await errors(
        'packages/memory/src/fixture.ts',
        "import type { MemoryRef } from '@weave/protocol'; export type Ref = MemoryRef;",
      ),
    ).toEqual([]);
    expect(
      await errors(
        'apps/server/src/fixture.ts',
        "export { createSqliteMemoryStore } from '@weave/memory';",
      ),
    ).toEqual([]);
    expect(
      await errors('packages/memory/src/fixture.ts', "export * from '@weave/runtime';"),
    ).toEqual(['undeclaredDependency']);
    expect(
      await errors('packages/runtime/src/fixture.ts', "export * from '@weave/memory';"),
    ).toEqual(['undeclaredDependency']);
    expect(
      await errors('packages/memory/src/fixture.ts', "export * from '../../runtime/src/index.js';"),
    ).toEqual(['relativeWorkspaceImport']);
  });
});
