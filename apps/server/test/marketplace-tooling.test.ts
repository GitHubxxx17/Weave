import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeDeclarativeSkillFixture } from './support/declarative-skill-fixture.js';
import type { GithubPluginAcquirer } from '@weave/plugin-host';
import { afterEach, describe, expect, it } from 'vitest';
import {
  generateMarketplaceIndex,
  prepareMarketplaceSubmission,
  writeMarketplaceSubmission,
} from '../src/marketplace-tooling.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'weave-marketplace-tools-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const submissionsDirectory = join(root, 'submissions');
  await mkdir(submissionsDirectory);
  return { root, submissionsDirectory, outputFile: join(root, 'index.json') };
}
function manifest(id = 'community-notes', version = '1.0.0') {
  return {
    id,
    name: 'Notes',
    version,
    apiVersion: '1.0.0',
    capabilities: ['tool'],
    contributes: { tools: ['note'] },
    permissions: ['workspace:read'],
  };
}
function source() {
  return {
    repository: 'https://github.com/developer/notes',
    commit: 'a'.repeat(40),
    subdirectory: 'plugin',
  };
}
function submission(id = 'community-notes', version = '1.0.0') {
  return {
    id,
    name: 'Notes',
    description: 'Workspace notes',
    publisher: 'Independent developer',
    tags: ['notes'],
    releases: [{ manifest: manifest(id, version), source: source() }],
  };
}

// Removing deterministic sorting, shared schema validation or bounded file reads
// would make the resulting published catalog unsafe or dependent on local order.
describe('marketplace index generation', () => {
  it('refuses an unknown protected identity in submission writes and generator write/check without replacing files', async () => {
    const paths = await fixture();
    const entry = submission('weave-official-skills', '9999.0.0');
    const submissionFile = join(paths.submissionsDirectory, `${entry.id}.json`);
    await expect(writeMarketplaceSubmission(submissionFile, entry)).rejects.toThrow();
    await expect(readFile(submissionFile)).rejects.toMatchObject({ code: 'ENOENT' });
    await writeFile(submissionFile, JSON.stringify(entry));
    await writeFile(paths.outputFile, 'preserved');
    for (const mode of ['write', 'check'] as const) {
      await expect(generateMarketplaceIndex({ ...paths, mode })).rejects.toThrow();
      expect(await readFile(paths.outputFile, 'utf8')).toBe('preserved');
    }
  });

  it('generates an honest empty catalog and ignores the submission guide', async () => {
    const paths = await fixture();
    await writeFile(join(paths.submissionsDirectory, 'README.md'), 'submission instructions');
    expect(await generateMarketplaceIndex({ ...paths, mode: 'write' })).toEqual({
      plugins: 0,
      changed: true,
    });
    expect(await readFile(paths.outputFile, 'utf8')).toBe(
      '{\n  "schemaVersion": 1,\n  "plugins": []\n}\n',
    );
    expect(await generateMarketplaceIndex({ ...paths, mode: 'check' })).toEqual({
      plugins: 0,
      changed: false,
    });
  });

  it('sorts entries and large numeric release versions without losing manifest fields', async () => {
    const paths = await fixture();
    const notes = submission('z-notes', '9007199254740993.0.0');
    notes.releases.push({
      manifest: manifest('z-notes', '9007199254740992.0.0'),
      source: source(),
    });
    notes.releases.reverse();
    await writeFile(join(paths.submissionsDirectory, 'z-notes.json'), JSON.stringify(notes));
    await writeFile(
      join(paths.submissionsDirectory, 'a-notes.json'),
      JSON.stringify(submission('a-notes')),
    );
    await generateMarketplaceIndex({ ...paths, mode: 'write' });
    const result = JSON.parse(await readFile(paths.outputFile, 'utf8'));
    expect(result.plugins.map((entry: { id: string }) => entry.id)).toEqual(['a-notes', 'z-notes']);
    expect(
      result.plugins[1].releases.map(
        (entry: { manifest: { version: string } }) => entry.manifest.version,
      ),
    ).toEqual(['9007199254740993.0.0', '9007199254740992.0.0']);
    expect(result.plugins[1].releases[0].manifest.permissions).toEqual(['workspace:read']);
    expect(await generateMarketplaceIndex({ ...paths, mode: 'write' })).toEqual({
      plugins: 2,
      changed: false,
    });
  });

  it('reports drift without changing the checked-in output', async () => {
    const paths = await fixture();
    await writeFile(paths.outputFile, 'original');
    await expect(generateMarketplaceIndex({ ...paths, mode: 'check' })).rejects.toThrow(
      'out of date',
    );
    expect(await readFile(paths.outputFile, 'utf8')).toBe('original');
  });

  it.each([
    [
      'undeclared permissions',
      (entry: ReturnType<typeof submission>) => {
        delete (entry.releases[0]!.manifest as { permissions?: string[] }).permissions;
      },
    ],
    [
      'mutable Git ref',
      (entry: ReturnType<typeof submission>) => {
        entry.releases[0]!.source.commit = 'main';
      },
    ],
    [
      'unknown official claim',
      (entry: ReturnType<typeof submission>) => {
        Object.assign(entry, { category: 'official' });
      },
    ],
    [
      'mismatched release id',
      (entry: ReturnType<typeof submission>) => {
        entry.releases[0]!.manifest.id = 'other';
      },
    ],
    [
      'reserved identity',
      (entry: ReturnType<typeof submission>) => {
        entry.id = entry.releases[0]!.manifest.id = 'tool-registry';
      },
    ],
    [
      'duplicate version',
      (entry: ReturnType<typeof submission>) => {
        entry.releases.push(entry.releases[0]!);
      },
    ],
  ])('rejects %s before replacing output', async (_label, mutate) => {
    const paths = await fixture();
    const entry = submission();
    mutate(entry);
    await writeFile(paths.outputFile, 'preserved');
    await writeFile(join(paths.submissionsDirectory, `${entry.id}.json`), JSON.stringify(entry));
    await expect(generateMarketplaceIndex({ ...paths, mode: 'write' })).rejects.toThrow();
    expect(await readFile(paths.outputFile, 'utf8')).toBe('preserved');
  });

  it('rejects duplicate identities even under distinct filenames', async () => {
    const paths = await fixture();
    await writeFile(join(paths.submissionsDirectory, 'one.json'), JSON.stringify(submission()));
    await writeFile(join(paths.submissionsDirectory, 'two.json'), JSON.stringify(submission()));
    await expect(generateMarketplaceIndex({ ...paths, mode: 'write' })).rejects.toThrow();
  });

  it('rejects symlink submissions and never follows an output symlink', async () => {
    const paths = await fixture();
    const target = join(paths.root, 'target.json');
    await writeFile(target, JSON.stringify(submission()));
    await symlink(target, join(paths.submissionsDirectory, 'community-notes.json'));
    await expect(generateMarketplaceIndex({ ...paths, mode: 'write' })).rejects.toThrow();
    await rm(join(paths.submissionsDirectory, 'community-notes.json'));
    await symlink(target, paths.outputFile);
    await expect(generateMarketplaceIndex({ ...paths, mode: 'write' })).rejects.toThrow();
    expect(await readFile(target, 'utf8')).toBe(JSON.stringify(submission()));
  });

  it('rejects oversized and malformed UTF-8 input without publishing', async () => {
    const paths = await fixture();
    const file = join(paths.submissionsDirectory, 'community-notes.json');
    await writeFile(file, Buffer.alloc(512 * 1024 + 1, 32));
    await expect(generateMarketplaceIndex({ ...paths, mode: 'write' })).rejects.toThrow();
    await writeFile(file, Buffer.from([0xff]));
    await expect(generateMarketplaceIndex({ ...paths, mode: 'write' })).rejects.toThrow();
    await expect(readFile(paths.outputFile)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('preparing a marketplace submission', () => {
  it('rejects an acquired but unrecognized protected manifest through shared admission and releases the scratch source', async () => {
    const { root } = await fixture();
    const payload = join(root, 'protected-skills');
    await writeDeclarativeSkillFixture(payload, { id: 'weave-official-skills' });
    let released = false;
    const acquirer: GithubPluginAcquirer = {
      async withSource(_source, use) {
        try {
          return await use(payload, new AbortController().signal);
        } finally {
          released = true;
        }
      },
    };
    await expect(
      prepareMarketplaceSubmission(
        { name: 'Weave', description: 'Skills', publisher: 'Weave', tags: [], source: source() },
        { acquirer },
      ),
    ).rejects.toThrow();
    expect(released).toBe(true);
  });

  it('inspects a fixed no-entry Skill source and preserves its full manifest in schema-1 submissions', async () => {
    const { root } = await fixture();
    const payload = join(root, 'skills-plugin');
    const actual = await writeDeclarativeSkillFixture(payload, { id: 'community-notes' });
    let released = false;
    const acquirer: GithubPluginAcquirer = {
      async withSource(selected, use) {
        expect(selected).toEqual(source());
        try {
          return await use(payload, new AbortController().signal);
        } finally {
          released = true;
        }
      },
    };
    const result = await prepareMarketplaceSubmission(
      {
        name: 'Notes',
        description: 'Workspace notes',
        publisher: 'Independent developer',
        tags: ['notes'],
        source: source(),
      },
      { acquirer },
    );
    expect(result.releases).toEqual([{ manifest: actual, source: source() }]);
    expect(released).toBe(true);
    await writeFile(join(payload, 'skills/review/SKILL.md'), 'invalid Skill document');
    await expect(
      prepareMarketplaceSubmission(
        {
          name: 'Notes',
          description: 'Workspace notes',
          publisher: 'Independent developer',
          tags: ['notes'],
          source: source(),
        },
        { acquirer },
      ),
    ).rejects.toThrow();
  });

  it('reads the acquired descriptor without importing executable plugin code', async () => {
    const { root } = await fixture();
    const payload = join(root, 'plugin');
    await mkdir(payload);
    await writeFile(
      join(payload, 'weave-plugin.json'),
      JSON.stringify({ schemaVersion: 1, entry: 'index.mjs', manifest: manifest() }),
    );
    await writeFile(join(payload, 'index.mjs'), 'throw new Error("must never execute")');
    let settled = false;
    const acquirer: GithubPluginAcquirer = {
      async withSource(_source, use) {
        try {
          return await use(payload, new AbortController().signal);
        } finally {
          settled = true;
        }
      },
    };
    const request = {
      name: 'Notes',
      description: 'Workspace notes',
      publisher: 'Independent developer',
      tags: ['notes'],
      source: source(),
    };
    expect(await prepareMarketplaceSubmission(request, { acquirer })).toEqual(submission());
    expect(settled).toBe(true);
  });

  it('prepares engine-declaring releases offline without inventing a host compatibility version', async () => {
    const { root } = await fixture();
    const payload = join(root, 'engine-skills');
    const actual = await writeDeclarativeSkillFixture(payload, {
      id: 'community-notes',
      engines: { weave: '>=1.0.0' },
    });
    const acquirer: GithubPluginAcquirer = {
      async withSource(_source, use) {
        return use(payload, new AbortController().signal);
      },
    };
    const result = await prepareMarketplaceSubmission(
      {
        name: 'Notes',
        description: 'Workspace notes',
        publisher: 'Independent developer',
        tags: [],
        source: source(),
      },
      { acquirer },
    );
    expect(result.releases[0]?.manifest).toEqual(actual);
  });

  it('rejects noncanonical sources before acquiring and validates actual manifest declarations', async () => {
    const { root } = await fixture();
    let calls = 0;
    const acquirer: GithubPluginAcquirer = {
      async withSource(_source, use) {
        calls++;
        return use(root, new AbortController().signal);
      },
    };
    const request = {
      name: 'Notes',
      description: 'Workspace notes',
      publisher: 'Independent developer',
      tags: [],
      source: { ...source(), commit: 'main' },
    };
    await expect(prepareMarketplaceSubmission(request, { acquirer })).rejects.toThrow();
    expect(calls).toBe(0);
    await writeFile(
      join(root, 'weave-plugin.json'),
      JSON.stringify({
        schemaVersion: 1,
        entry: 'index.mjs',
        manifest: { ...manifest(), permissions: undefined },
      }),
    );
    await expect(
      prepareMarketplaceSubmission({ ...request, source: source() }, { acquirer }),
    ).rejects.toThrow();
    expect(calls).toBe(1);
  });

  it('refuses to overwrite an existing submission file', async () => {
    const { root } = await fixture();
    const output = join(root, 'community-notes.json');
    await writeMarketplaceSubmission(output, submission());
    await expect(writeMarketplaceSubmission(output, submission())).rejects.toThrow();
    expect(JSON.parse(await readFile(output, 'utf8'))).toEqual(submission());
  });
});
