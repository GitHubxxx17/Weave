import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createSkillScanBudget,
  discoverSkillBundles,
  parseSkillDocument,
  pinSkillBundle,
  readPinnedSkillResource,
  diffManifests,
  parseDescriptor,
  type SkillRootInput,
} from '../src/index.js';

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    roots.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});
const sha = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');
const document = (name = 'review', body = ' Instructions.\n', extra = ''): string =>
  `---\nname: ${name}\ndescription: Review changes\n${extra}---\n${body}`;
async function fixture(): Promise<SkillRootInput> {
  const directory = await mkdtemp(path.join(tmpdir(), 'weave-skills-'));
  roots.push(directory);
  await mkdir(path.join(directory, 'review', 'references'), { recursive: true });
  await writeFile(path.join(directory, 'review', 'SKILL.md'), document());
  await writeFile(path.join(directory, 'review', 'references', 'check.md'), 'Check code.\r\n');
  return { id: 'test-root', directory, label: 'Test Skills' };
}

describe('Skill document parser', () => {
  it('supports YAML quoted/block scalars and normalizes only the instruction newlines', () => {
    const parsed = parseSkillDocument(
      '\ufeff---\r\nname: review\r\ndescription: >-\r\n  Review\r\n  changes\r\nlicense: MIT\r\nmetadata:\r\n  author: Weave\r\ndisable-model-invocation: true\r\nuser-invocable: false\r\n---\r\n Keep spacing. \r\n',
      'review',
    );
    expect(parsed).toEqual({
      name: 'review',
      description: 'Review changes',
      instructions: ' Keep spacing. \n',
      invocation: { user: false, model: false },
      license: 'MIT',
      metadata: { author: 'Weave' },
    });
    expect(Object.isFrozen(parsed.invocation)).toBe(true);
  });

  it.each([
    ['missing frontmatter', 'name: review\nbody'],
    ['missing name', '---\ndescription: Fine\n---\nBody'],
    ['wrong name', document('other')],
    ['duplicate keys', document('review', 'Body', 'name: again\n')],
    ['YAML alias', document('review', 'Body', 'metadata: &m {a: b}\nother: *m\n')],
    ['YAML tag', document('review', 'Body', 'other: !custom value\n')],
    ['nested metadata', document('review', 'Body', 'metadata:\n  nested:\n    key: value\n')],
    ['unknown nested value', document('review', 'Body', 'other: [nested]\n')],
    ['unknown number', document('review', 'Body', 'other: 12\n')],
    ['invalid policy', document('review', 'Body', 'user-invocable: maybe\n')],
    ['blank description', '---\nname: review\ndescription: " "\n---\nBody'],
    ['blank body', document('review', ' \n')],
    ['NUL', document('review', 'bad\0body')],
    ['oversized frontmatter', document('review', 'Body', `other: ${'x'.repeat(8192)}\n`)],
    ['oversized document', document('review', 'x'.repeat(65536))],
  ])('rejects %s', (_label, source) => {
    expect(() => parseSkillDocument(source, 'review')).toThrowError(
      expect.objectContaining({ code: 'skill-invalid-document' }),
    );
  });

  it('keeps unknown scalar metadata inert and defaults both invocation flags to true', () => {
    expect(
      parseSkillDocument(document('review', 'Body\n', 'unknown: value\n'), 'review'),
    ).toMatchObject({ invocation: { user: true, model: true }, instructions: 'Body\n' });
  });
});

describe('bounded disk Skill bundles', () => {
  it('discovers inert deterministic identities, pins exact bytes and reads unchanged UTF-8 resources', async () => {
    const root = await fixture();
    const result = await discoverSkillBundles({ root });
    expect(result).toMatchObject({ complete: true, truncated: false, issues: [] });
    expect(result.bundles).toHaveLength(1);
    const bundle = result.bundles[0]!;
    const resource = { path: 'references/check.md', sha256: sha('Check code.\r\n'), bytes: 13 };
    const instructionSha256 = sha(' Instructions.\n');
    expect(bundle.resources).toEqual([resource]);
    expect(bundle.handle).toEqual({
      rootId: root.id,
      name: 'review',
      instructionSha256,
      bundleSha256: sha(
        JSON.stringify([
          'review',
          'Review changes',
          true,
          true,
          instructionSha256,
          [[resource.path, resource.sha256, resource.bytes]],
        ]),
      ),
    });
    expect(JSON.stringify(result)).not.toContain(root.directory);
    const pinned = await pinSkillBundle({ root, handle: bundle.handle });
    expect(pinned.instructions).toBe(' Instructions.\n');
    expect(Object.isFrozen(pinned)).toBe(true);
    expect(await readPinnedSkillResource({ root, bundle: pinned, path: resource.path })).toEqual({
      text: 'Check code.\r\n',
      sha256: resource.sha256,
    });
  });

  it('detects metadata, instructions and resource-only edits before pinning', async () => {
    const root = await fixture();
    const handle = (await discoverSkillBundles({ root })).bundles[0]!.handle;
    await writeFile(path.join(root.directory, 'review', 'references', 'check.md'), 'Changed');
    await expect(pinSkillBundle({ root, handle })).rejects.toMatchObject({
      code: 'skill-source-changed',
    });
    const changed = (await discoverSkillBundles({ root })).bundles[0]!.handle;
    expect(changed.instructionSha256).toBe(handle.instructionSha256);
    expect(changed.bundleSha256).not.toBe(handle.bundleSha256);
    await writeFile(
      path.join(root.directory, 'review', 'SKILL.md'),
      document().replace('Review changes', 'Changed description'),
    );
    await expect(pinSkillBundle({ root, handle: changed })).rejects.toMatchObject({
      code: 'skill-source-changed',
    });
  });

  it('rejects root confusion, edits after pinning, unlisted files and unsafe resource paths', async () => {
    const root = await fixture();
    const handle = (await discoverSkillBundles({ root })).bundles[0]!.handle;
    await expect(pinSkillBundle({ root: { ...root, id: 'other' }, handle })).rejects.toMatchObject({
      code: 'skill-source-changed',
    });
    const pinned = await pinSkillBundle({ root, handle });
    for (const resourcePath of [
      '../outside',
      '/tmp/out',
      'a\\b',
      'C:/a',
      'a//b',
      './a',
      'https://host',
      'unlisted.txt',
    ]) {
      await expect(
        readPinnedSkillResource({ root, bundle: pinned, path: resourcePath }),
      ).rejects.toMatchObject({ code: 'skill-unsafe-entry' });
    }
    await writeFile(path.join(root.directory, 'review', 'references', 'check.md'), 'Changed');
    await expect(
      readPinnedSkillResource({ root, bundle: pinned, path: 'references/check.md' }),
    ).rejects.toMatchObject({ code: 'skill-source-changed' });
  });

  it('reports invalid candidates without losing healthy Skills and never descends into arbitrary folders', async () => {
    const root = await fixture();
    await mkdir(path.join(root.directory, 'bad'));
    await writeFile(path.join(root.directory, 'bad', 'SKILL.md'), 'bad YAML');
    await writeFile(path.join(root.directory, 'ignored.md'), document('ignored'));
    const result = await discoverSkillBundles({ root });
    expect(result.bundles.map((bundle) => bundle.name)).toEqual(['review']);
    expect(result.complete).toBe(false);
    expect(result.issues).toContainEqual({ code: 'invalid-document', name: 'bad' });
  });

  it('distinguishes a missing root from invalid roots and rejects links at every level', async () => {
    const root = await fixture();
    expect(
      await discoverSkillBundles({
        root: { ...root, directory: path.join(root.directory, 'missing') },
      }),
    ).toMatchObject({ complete: true, bundles: [] });
    const link = path.join(root.directory, 'link');
    await symlink(path.join(root.directory, 'review'), link);
    expect(await discoverSkillBundles({ root: { ...root, directory: link } })).toMatchObject({
      complete: false,
      issues: [{ code: 'unsafe-entry' }],
    });
    await symlink('references/check.md', path.join(root.directory, 'review', 'linked.md'));
    expect((await discoverSkillBundles({ root })).bundles).toEqual([]);
    const regular = path.join(root.directory, 'regular');
    await writeFile(regular, 'not directory');
    expect(await discoverSkillBundles({ root: { ...root, directory: regular } })).toMatchObject({
      complete: false,
      issues: [{ code: 'unsafe-entry' }],
    });
  });

  it('reports an existing empty root removed after listing as incomplete', async () => {
    const root = await fixture();
    await rm(path.join(root.directory, 'review'), { recursive: true });
    const canonical = await fs.realpath(root.directory);
    const original = fs.opendir;
    vi.spyOn(fs, 'opendir').mockImplementation(async (file, options) => {
      const directory = await original(file, options);
      if (String(file) === canonical) {
        const close = directory.close.bind(directory);
        vi.spyOn(directory, 'close').mockImplementation(async () => {
          await close();
          await rm(root.directory, { recursive: true });
        });
      }
      return directory;
    });
    expect(await discoverSkillBundles({ root })).toMatchObject({
      complete: false,
      bundles: [],
      issues: [{ code: 'source-changed' }],
    });
  });

  it('bounds root candidates and shared scan bytes, marking incomplete observations explicitly', async () => {
    const root = await fixture();
    const budget = createSkillScanBudget(1);
    expect(await discoverSkillBundles({ root, budget })).toMatchObject({
      complete: false,
      truncated: true,
      issues: [{ code: 'limit-exceeded', name: 'review' }],
    });
    expect(budget.remainingBytes).toBe(0);
    for (let i = 0; i < 129; i++) await mkdir(path.join(root.directory, `s${i}`));
    const result = await discoverSkillBundles({ root });
    expect(result.complete).toBe(false);
    expect(result.truncated).toBe(true);
    expect(result.issues.some((issue) => issue.code === 'limit-exceeded')).toBe(true);
  });

  it('does not execute scripts and rejects non-UTF8 resources on text read', async () => {
    const root = await fixture();
    const marker = path.join(root.directory, 'executed');
    await writeFile(
      path.join(root.directory, 'review', 'danger.mjs'),
      `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(marker)}, 'bad');`,
    );
    await writeFile(path.join(root.directory, 'review', 'binary.dat'), Buffer.from([255, 254, 0]));
    const handle = (await discoverSkillBundles({ root })).bundles[0]!.handle;
    const pinned = await pinSkillBundle({ root, handle });
    await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(
      readPinnedSkillResource({ root, bundle: pinned, path: 'binary.dat' }),
    ).rejects.toMatchObject({ code: 'skill-unsupported-text' });
  });

  it('honors aborted operations before publishing any observation', async () => {
    const root = await fixture();
    const signal = AbortSignal.abort(new Error('cancelled Skill scan'));
    await expect(discoverSkillBundles({ root, signal })).rejects.toThrow('cancelled Skill scan');
    const handle = (await discoverSkillBundles({ root })).bundles[0]!.handle;
    await expect(pinSkillBundle({ root, handle, signal })).rejects.toThrow('cancelled Skill scan');
    const pinned = await pinSkillBundle({ root, handle });
    await expect(
      readPinnedSkillResource({ root, bundle: pinned, path: 'references/check.md', signal }),
    ).rejects.toThrow('cancelled Skill scan');
  });

  it('stops reading directory candidates even when invalid names precede healthy ones', async () => {
    const root = await fixture();
    await rm(path.join(root.directory, 'review'), { recursive: true });
    for (let index = 0; index < 129; index++)
      await mkdir(path.join(root.directory, `Bad-${index}`));
    expect(await discoverSkillBundles({ root })).toMatchObject({
      complete: false,
      truncated: true,
    });
  });

  it('does not hold more than four directory handles while traversing nested resources', async () => {
    const root = await fixture();
    await mkdir(path.join(root.directory, 'review', 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'), {
      recursive: true,
    });
    let active = 0;
    let highest = 0;
    const original = fs.opendir;
    vi.spyOn(fs, 'opendir').mockImplementation(async (file, options) => {
      const directory = await original(file, options);
      active++;
      highest = Math.max(highest, active);
      const close = directory.close.bind(directory);
      vi.spyOn(directory, 'close').mockImplementation(async () => {
        active--;
        await close();
      });
      return directory;
    });
    expect((await discoverSkillBundles({ root })).complete).toBe(true);
    expect(highest).toBeLessThanOrEqual(4);
    expect(active).toBe(0);
  });

  it('rejects growth during reading and awaits file cleanup before settling', async () => {
    const root = await fixture();
    const originalOpen = fs.open;
    let changed = false;
    let closed = false;
    vi.spyOn(fs, 'open').mockImplementation(async (file, flags, mode) => {
      const handle = await originalOpen(file, flags, mode);
      if (String(file).endsWith('/references/check.md')) {
        const read = handle.read.bind(handle);
        vi.spyOn(handle, 'read').mockImplementation(
          async (...args: Parameters<typeof handle.read>) => {
            if (!changed) {
              changed = true;
              await writeFile(String(file), 'x'.repeat(128));
            }
            return read(...args);
          },
        );
        const close = handle.close.bind(handle);
        vi.spyOn(handle, 'close').mockImplementation(async () => {
          await close();
          closed = true;
        });
      }
      return handle;
    });
    expect(await discoverSkillBundles({ root })).toMatchObject({ complete: false, bundles: [] });
    expect(closed).toBe(true);
  });

  it('preserves cancellation during read and closes the opened file', async () => {
    const root = await fixture();
    const controller = new AbortController();
    const reason = new Error('cancel inside read');
    const originalOpen = fs.open;
    let closed = false;
    vi.spyOn(fs, 'open').mockImplementation(async (file, flags, mode) => {
      const handle = await originalOpen(file, flags, mode);
      const read = handle.read.bind(handle);
      vi.spyOn(handle, 'read').mockImplementation(
        async (...args: Parameters<typeof handle.read>) => {
          const result = await read(...args);
          controller.abort(reason);
          return result;
        },
      );
      const close = handle.close.bind(handle);
      vi.spyOn(handle, 'close').mockImplementation(async () => {
        await close();
        closed = true;
      });
      return handle;
    });
    await expect(discoverSkillBundles({ root, signal: controller.signal })).rejects.toBe(reason);
    expect(closed).toBe(true);
  });

  // The three limits are checked in separate tests so each gets its own timeout budget on slow CI disks.
  it('bounds nesting depth', async () => {
    const root = await fixture();
    const deep = path.join(root.directory, 'review', ...Array.from({ length: 9 }, () => 'nested'));
    await mkdir(deep, { recursive: true });
    expect((await discoverSkillBundles({ root })).issues).toContainEqual({
      code: 'limit-exceeded',
      name: 'review',
    });
  });

  it('bounds total resource bytes', async () => {
    const root = await fixture();
    await writeFile(
      path.join(root.directory, 'review', 'big.bin'),
      Buffer.alloc(20 * 1024 * 1024 + 1),
    );
    expect((await discoverSkillBundles({ root })).issues).toContainEqual({
      code: 'limit-exceeded',
      name: 'review',
    });
    // Writing and hashing a 20MB resource is I/O heavy on CI; keep the real size to cover the limit.
  }, 30_000);

  it('bounds file counts', async () => {
    const root = await fixture();
    await Promise.all(
      Array.from({ length: 1000 }, (_, index) =>
        writeFile(path.join(root.directory, 'review', `r${index}`), ''),
      ),
    );
    expect((await discoverSkillBundles({ root })).issues).toContainEqual({
      code: 'limit-exceeded',
      name: 'review',
    });
    // The scan opens and hashes up to 1000 files one by one; on slow CI disks that exceeds 5s.
  }, 30_000);

  it('refuses FIFOs without blocking and rejects a linked resource parent after pinning', async () => {
    const root = await fixture();
    const pinned = await pinSkillBundle({
      root,
      handle: (await discoverSkillBundles({ root })).bundles[0]!.handle,
    });
    await rm(path.join(root.directory, 'review', 'references'), { recursive: true });
    await mkdir(path.join(root.directory, 'outside'));
    await writeFile(path.join(root.directory, 'outside', 'check.md'), 'Check code.\r\n');
    await symlink('../outside', path.join(root.directory, 'review', 'references'));
    await expect(
      readPinnedSkillResource({ root, bundle: pinned, path: 'references/check.md' }),
    ).rejects.toMatchObject({ code: 'skill-source-changed' });
    await rm(path.join(root.directory, 'review', 'references'));
    if (process.platform !== 'win32') {
      execFileSync('mkfifo', [path.join(root.directory, 'review', 'pipe')]);
      expect((await discoverSkillBundles({ root })).issues).toContainEqual({
        code: 'unsafe-entry',
        name: 'review',
      });
    }
  });

  it('reports permission errors as path-free incomplete observations', async () => {
    const root = await fixture();
    const original = fs.opendir;
    vi.spyOn(fs, 'opendir').mockImplementation(async (file, options) => {
      if (String(file) === (await fs.realpath(root.directory)))
        throw Object.assign(new Error(`denied ${root.directory}`), { code: 'EACCES' });
      return original(file, options);
    });
    const result = await discoverSkillBundles({ root });
    expect(result).toMatchObject({
      complete: false,
      bundles: [],
      issues: [{ code: 'unreadable' }],
    });
    expect(JSON.stringify(result)).not.toContain(root.directory);
  });

  it('rejects a symlink ancestor inside a configured nested Skill root', async () => {
    const root = await fixture();
    const parent = path.join(root.directory, 'project');
    await mkdir(parent);
    await symlink('..', path.join(parent, '.weave'));
    const nested = { ...root, directory: path.join(parent, '.weave', 'review', 'references') };
    expect(await discoverSkillBundles({ root: nested })).toMatchObject({
      complete: false,
      issues: [{ code: 'unsafe-entry' }],
    });
  });

  it('rejects a resource directory renamed during an open file read', async () => {
    const root = await fixture();
    const pinned = await pinSkillBundle({
      root,
      handle: (await discoverSkillBundles({ root })).bundles[0]!.handle,
    });
    const originalOpen = fs.open;
    let changed = false;
    vi.spyOn(fs, 'open').mockImplementation(async (file, flags, mode) => {
      const handle = await originalOpen(file, flags, mode);
      if (String(file).endsWith('/references/check.md')) {
        const read = handle.read.bind(handle);
        vi.spyOn(handle, 'read').mockImplementation(
          async (...args: Parameters<typeof handle.read>) => {
            const result = await read(...args);
            if (!changed) {
              changed = true;
              await fs.rename(
                path.join(root.directory, 'review', 'references'),
                path.join(root.directory, 'review', 'previous'),
              );
              await mkdir(path.join(root.directory, 'review', 'references'));
              await writeFile(String(file), 'Check code.\r\n');
            }
            return result;
          },
        );
      }
      return handle;
    });
    await expect(
      readPinnedSkillResource({ root, bundle: pinned, path: 'references/check.md' }),
    ).rejects.toMatchObject({ code: 'skill-source-changed' });
  });

  it.each(['add-parent-file', 'edit-instructions'])(
    'refuses incomplete snapshots when %s occurs during a child resource read',
    async (mutation) => {
      const root = await fixture();
      const originalOpen = fs.open;
      let changed = false;
      vi.spyOn(fs, 'open').mockImplementation(async (file, flags, mode) => {
        const handle = await originalOpen(file, flags, mode);
        if (String(file).endsWith('/references/check.md')) {
          const read = handle.read.bind(handle);
          vi.spyOn(handle, 'read').mockImplementation(
            async (...args: Parameters<typeof handle.read>) => {
              const result = await read(...args);
              if (!changed) {
                changed = true;
                if (mutation === 'add-parent-file')
                  await writeFile(path.join(root.directory, 'review', 'late.txt'), 'new resource');
                else
                  await writeFile(
                    path.join(root.directory, 'review', 'SKILL.md'),
                    document('review', 'Changed instructions.\n'),
                  );
              }
              return result;
            },
          );
        }
        return handle;
      });
      expect(await discoverSkillBundles({ root })).toMatchObject({
        complete: false,
        bundles: [],
        issues: [{ code: 'source-changed', name: 'review' }],
      });
    },
  );
});

it('includes Skill declarations in disk manifests and trust review diffs', () => {
  const manifest = {
    id: 'skills-example',
    name: 'Skills example',
    version: '1.0.0',
    apiVersion: '1.0.0',
    capabilities: ['skill'],
    contributes: { skills: ['review'] },
    permissions: [],
  };
  const parsed = parseDescriptor(
    JSON.stringify({ schemaVersion: 1, entry: 'index.mjs', manifest }),
  );
  expect(parsed.manifest.contributes?.skills).toEqual(['review']);
  const previous = { ...parsed.manifest, contributes: { skills: [] } };
  expect(diffManifests(previous, parsed.manifest).contributes.skills).toEqual({
    added: ['review'],
    removed: [],
  });
});
