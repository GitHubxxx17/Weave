import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { projectManagedCatalog } from '../src/managed-plugin-catalog.js';
import { createSqlitePluginAuthorityDatabase } from '../src/plugin-authority-store.js';
import { importInput } from './support/plugin-authority-fixtures.js';

describe('GitHub plugin authority provenance', () => {
  it.each(['github', 'local-directory'] as const)(
    'retains the first %s source across no-op imports and SQLite reopen',
    async (firstKind) => {
      const directory = await mkdtemp(join(tmpdir(), 'weave-github-provenance-'));
      const filename = join(directory, 'authority.sqlite');
      const github = {
        kind: 'github' as const,
        repository: 'https://github.com/weave/notes',
        commit: 'a'.repeat(40),
        subdirectory: 'plugins/notes',
      };
      const local = { kind: 'local-directory' as const, sourceDirectory: '/private/local-source' };
      const first = firstKind === 'github' ? github : local;
      const second = firstKind === 'github' ? local : github;
      let authority = createSqlitePluginAuthorityDatabase({ filename });
      try {
        const initial = importInput('first', 0);
        if (initial.prepared.kind !== 'import') throw new Error('fixture');
        authority.commitSync({ ...initial, prepared: { ...initial.prepared, provenance: first } });
        const repeated = importInput('second', 1);
        if (repeated.prepared.kind !== 'import') throw new Error('fixture');
        const result = authority.commitSync({
          ...repeated,
          prepared: { ...repeated.prepared, provenance: second },
        });
        expect(result).toMatchObject({
          operation: { evidence: { provenance: second }, decision: { changed: false } },
        });
        await authority.close();
        authority = createSqlitePluginAuthorityDatabase({ filename });
        const snapshot = authority.snapshotSync();
        expect(snapshot.heads).toEqual({
          installSequence: 1,
          trustSequence: 0,
          operationSequence: 2,
        });
        expect(snapshot.installations[0]?.candidates[0]?.provenance).toEqual(first);
        const catalog = projectManagedCatalog(snapshot, {
          generation: { id: 1, acceptingRuns: true },
          members: [],
        });
        const projected = catalog.plugins[0]?.candidates[0];
        expect(projected).toMatchObject({ provenance: firstKind });
        expect(projected).toEqual(
          firstKind === 'github'
            ? expect.objectContaining({
                github: {
                  repository: github.repository,
                  commit: github.commit,
                  subdirectory: github.subdirectory,
                },
              })
            : expect.not.objectContaining({ github: expect.anything() }),
        );
        expect(JSON.stringify(catalog)).not.toContain(local.sourceDirectory);
      } finally {
        await authority.close();
        await rm(directory, { recursive: true, force: true });
      }
    },
  );
});
