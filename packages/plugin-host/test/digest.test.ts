import { createHash } from 'node:crypto';
import { chmod, link, symlink, utimes } from 'node:fs/promises';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { computeDirectoryDigest, defaultDigestLimits } from '../src/digest.js';
import { PluginHostError } from '../src/errors.js';
import { makeTempDirectory, removeTempDirectories, writeFileIn } from './support/fixtures.js';

afterEach(removeTempDirectories);

async function directoryWith(files: Record<string, string>): Promise<string> {
  const directory = await makeTempDirectory();
  for (const [relative, content] of Object.entries(files)) {
    await writeFileIn(directory, relative, content);
  }
  return directory;
}

async function digestOf(files: Record<string, string>): Promise<string> {
  return (await computeDirectoryDigest(await directoryWith(files))).digest;
}

async function rejection(action: Promise<unknown>): Promise<PluginHostError> {
  try {
    await action;
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(PluginHostError);
    return error as PluginHostError;
  }
  throw new Error('Expected the digest to be refused');
}

const sha256 = (value: Buffer | string): string => createHash('sha256').update(value).digest('hex');

describe('computeDirectoryDigest', () => {
  it('is 64 lowercase hexadecimal characters and counts files and bytes', async () => {
    const directory = await directoryWith({ 'a.js': 'abc', 'dist/b.js': 'de' });

    const result = await computeDirectoryDigest(directory);

    expect(result.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(result.files).toBe(2);
    expect(result.bytes).toBe(5);
  });

  it('follows the documented construction, so another implementation can reproduce it', async () => {
    const directory = await directoryWith({ 'b.js': 'two', 'a/z.js': 'one' });
    const expected = sha256(
      `a/z.js\u00003\u0000${sha256('one')}\n` + `b.js\u00003\u0000${sha256('two')}\n`,
    );

    expect((await computeDirectoryDigest(directory)).digest).toBe(expected);
  });

  it('is the same for the same content in another directory', async () => {
    const files = { 'index.js': 'export default 1;', 'weave-plugin.json': '{}' };

    expect(await digestOf(files)).toBe(await digestOf(files));
  });

  it('does not depend on the order files were written, or when', async () => {
    const first = await makeTempDirectory();
    const second = await makeTempDirectory();
    await writeFileIn(first, 'a.js', '1');
    await writeFileIn(first, 'b.js', '2');
    await writeFileIn(second, 'b.js', '2');
    await writeFileIn(second, 'a.js', '1');
    await utimes(path.join(second, 'a.js'), new Date(0), new Date(0));

    expect((await computeDirectoryDigest(first)).digest).toBe(
      (await computeDirectoryDigest(second)).digest,
    );
  });

  it('sorts paths by UTF-8 bytes, not by locale', async () => {
    // "Z" (0x5A) sorts before "a" (0x61) by bytes; a locale-aware sort would not.
    const directory = await directoryWith({ 'a.js': 'x', 'Z.js': 'y' });
    const expected = sha256(
      `Z.js\u00001\u0000${sha256('y')}\n` + `a.js\u00001\u0000${sha256('x')}\n`,
    );

    expect((await computeDirectoryDigest(directory)).digest).toBe(expected);
  });

  it('changes when a file changes by a single byte', async () => {
    expect(await digestOf({ 'index.js': 'a' })).not.toBe(await digestOf({ 'index.js': 'b' }));
  });

  it('changes when a file is renamed or moved', async () => {
    const original = await digestOf({ 'index.js': 'a' });

    expect(await digestOf({ 'main.js': 'a' })).not.toBe(original);
    expect(await digestOf({ 'dist/index.js': 'a' })).not.toBe(original);
  });

  it('changes when a file is added', async () => {
    expect(await digestOf({ 'index.js': 'a', 'extra.js': '' })).not.toBe(
      await digestOf({ 'index.js': 'a' }),
    );
  });

  it('cannot be confused by moving bytes between a name and a content', async () => {
    // Without the separators, "ab" + "c" and "a" + "bc" would hash alike.
    expect(await digestOf({ ab: 'c' })).not.toBe(await digestOf({ a: 'bc' }));
    expect(await digestOf({ a: '1' + '2' })).not.toBe(await digestOf({ a1: '2' }));
  });

  it('ignores .git, .DS_Store and Thumbs.db at any depth', async () => {
    const plain = await digestOf({ 'index.js': 'a', 'dist/b.js': 'b' });

    const noisy = await digestOf({
      'index.js': 'a',
      'dist/b.js': 'b',
      '.git/HEAD': 'ref: refs/heads/main',
      '.git/objects/ab/cdef': 'blob',
      '.DS_Store': 'finder',
      'dist/.DS_Store': 'finder',
      'dist/Thumbs.db': 'explorer',
      'vendor/.git': 'gitdir: ../../.git/modules/vendor',
    });

    // `vendor` holds only an ignored file, so it adds an empty directory and no entry.
    expect(noisy).toBe(plain);
  });

  it('counts other hidden files, which are part of the plugin', async () => {
    expect(await digestOf({ 'index.js': 'a', '.env': 'SECRET=1' })).not.toBe(
      await digestOf({ 'index.js': 'a' }),
    );
  });

  it('is not changed by file modes', async () => {
    const directory = await directoryWith({ 'index.js': 'a' });
    const before = (await computeDirectoryDigest(directory)).digest;

    await chmod(path.join(directory, 'index.js'), 0o755);

    expect((await computeDirectoryDigest(directory)).digest).toBe(before);
  });

  it('hashes an empty directory without error', async () => {
    const result = await computeDirectoryDigest(await makeTempDirectory());

    expect(result).toEqual({ digest: sha256(''), files: 0, bytes: 0 });
  });

  it('names the plugin in the errors it raises', async () => {
    const directory = await directoryWith({ 'a.js': 'a', 'b.js': 'b' });

    const error = await rejection(
      computeDirectoryDigest(directory, { limits: { maxFiles: 1 }, pluginId: 'hello-commands' }),
    );

    expect(error.pluginId).toBe('hello-commands');
  });

  describe('what it refuses', () => {
    it('refuses a symbolic link to a file, naming the link', async () => {
      const directory = await directoryWith({ 'index.js': 'a', 'real.txt': 'secret' });
      await symlink(path.join(directory, 'real.txt'), path.join(directory, 'alias.txt'));

      const error = await rejection(computeDirectoryDigest(directory));

      expect(error.code).toBe('plugin-unsupported-file');
      expect(error.message).toContain('symbolic link "alias.txt"');
    });

    it('refuses a symbolic link to a directory, inside a subdirectory too', async () => {
      const directory = await directoryWith({ 'dist/index.js': 'a' });
      const outside = await directoryWith({ 'other.js': 'b' });
      await symlink(outside, path.join(directory, 'dist', 'linked'));

      const error = await rejection(computeDirectoryDigest(directory));

      expect(error.code).toBe('plugin-unsupported-file');
      expect(error.message).toContain('"dist/linked"');
    });

    it('refuses a link that points nowhere', async () => {
      const directory = await directoryWith({ 'index.js': 'a' });
      await symlink('does-not-exist', path.join(directory, 'dangling'));

      expect((await rejection(computeDirectoryDigest(directory))).code).toBe(
        'plugin-unsupported-file',
      );
    });

    it('accepts a hard link, which is an ordinary file', async () => {
      const directory = await directoryWith({ 'index.js': 'a' });
      await link(path.join(directory, 'index.js'), path.join(directory, 'copy.js'));

      expect((await computeDirectoryDigest(directory)).files).toBe(2);
    });

    it('refuses more files than the limit and says to bundle', async () => {
      const directory = await directoryWith({ 'a.js': '', 'b.js': '', 'c.js': '' });

      const error = await rejection(computeDirectoryDigest(directory, { limits: { maxFiles: 2 } }));

      expect(error.code).toBe('plugin-too-large');
      expect(error.message).toContain('more than 2 files');
      expect(error.message).toContain('bundle the plugin into a single file');
    });

    it('accepts exactly as many files as the limit', async () => {
      const directory = await directoryWith({ 'a.js': '', 'b.js': '' });

      expect((await computeDirectoryDigest(directory, { limits: { maxFiles: 2 } })).files).toBe(2);
    });

    it('refuses more bytes than the limit', async () => {
      const directory = await directoryWith({ 'a.js': '12345', 'b.js': '12345' });

      const error = await rejection(computeDirectoryDigest(directory, { limits: { maxBytes: 9 } }));

      expect(error.code).toBe('plugin-too-large');
      expect(error.message).toContain('more than 9 bytes');
    });

    it('accepts exactly as many bytes as the limit', async () => {
      const directory = await directoryWith({ 'a.js': '12345', 'b.js': '12345' });

      expect((await computeDirectoryDigest(directory, { limits: { maxBytes: 10 } })).bytes).toBe(
        10,
      );
    });

    it('reports a directory that cannot be read as unreadable, keeping the cause', async () => {
      const missing = path.join(await makeTempDirectory(), 'nope');

      const error = await rejection(computeDirectoryDigest(missing));

      expect(error.code).toBe('plugin-unreadable');
      expect(error.message).toContain(missing);
      expect(error.cause).toBeInstanceOf(Error);
    });
  });

  it('defaults to 1000 files and 20 MB', () => {
    expect(defaultDigestLimits).toEqual({ maxFiles: 1000, maxBytes: 20 * 1024 * 1024 });
    expect(Object.isFrozen(defaultDigestLimits)).toBe(true);
  });
});
