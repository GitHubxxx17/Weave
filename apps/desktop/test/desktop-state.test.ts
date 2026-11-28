import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  desktopStateFileName,
  getDesktopStatePath,
  readDesktopState,
  writeDesktopState,
} from '../src/desktop-state.js';

describe('desktop state file', () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'weave-desktop-state-'));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it('returns no record when the file is missing or the directory does not exist', async () => {
    await expect(readDesktopState(directory)).resolves.toEqual({ version: 1 });
    await expect(readDesktopState(join(directory, 'missing'))).resolves.toEqual({ version: 1 });
  });

  it('writes and reads the server port, creating the directory when needed', async () => {
    const nested = join(directory, 'a', 'b');
    await expect(writeDesktopState(nested, { serverPort: 43210 })).resolves.toEqual({
      version: 1,
      serverPort: 43210,
    });
    await expect(readDesktopState(nested)).resolves.toEqual({ version: 1, serverPort: 43210 });
    expect(await readdir(nested)).toEqual([desktopStateFileName]);
  });

  it('merges a patch into the stored state and ignores undefined fields', async () => {
    await writeDesktopState(directory, { serverPort: 43210 });
    await writeDesktopState(directory, { serverPort: undefined });
    await expect(readDesktopState(directory)).resolves.toEqual({ version: 1, serverPort: 43210 });
    await writeDesktopState(directory, { serverPort: 43211 });
    await expect(readDesktopState(directory)).resolves.toEqual({ version: 1, serverPort: 43211 });
  });

  it('ignores unknown fields on read', async () => {
    await writeFile(
      getDesktopStatePath(directory),
      JSON.stringify({ version: 1, serverPort: 43210, future: true }),
    );
    await expect(readDesktopState(directory)).resolves.toEqual({ version: 1, serverPort: 43210 });
  });

  it.each([
    ['empty file', ''],
    ['invalid JSON', '{not json'],
    ['non-object', '[1]'],
    ['wrong version', JSON.stringify({ version: 2, serverPort: 43210 })],
    ['missing version', JSON.stringify({ serverPort: 43210 })],
    ['privileged port', JSON.stringify({ version: 1, serverPort: 80 })],
    ['port above range', JSON.stringify({ version: 1, serverPort: 70000 })],
    ['fractional port', JSON.stringify({ version: 1, serverPort: 4000.5 })],
    ['string port', JSON.stringify({ version: 1, serverPort: '43210' })],
  ])('treats %s as no record and recovers on the next write', async (_name, content) => {
    await writeFile(getDesktopStatePath(directory), content);
    await expect(readDesktopState(directory)).resolves.toEqual({ version: 1 });
    await writeDesktopState(directory, { serverPort: 43210 });
    await expect(readDesktopState(directory)).resolves.toEqual({ version: 1, serverPort: 43210 });
  });

  it('treats an unreadable path as no record', async () => {
    await mkdir(getDesktopStatePath(directory));
    await expect(readDesktopState(directory)).resolves.toEqual({ version: 1 });
  });

  it('rejects an invalid port on write and leaves the old file and no temporary file', async () => {
    await writeDesktopState(directory, { serverPort: 43210 });
    await expect(writeDesktopState(directory, { serverPort: 80 })).rejects.toThrow();
    expect(JSON.parse(await readFile(getDesktopStatePath(directory), 'utf8'))).toEqual({
      version: 1,
      serverPort: 43210,
    });
    expect(await readdir(directory)).toEqual([desktopStateFileName]);
  });
});
