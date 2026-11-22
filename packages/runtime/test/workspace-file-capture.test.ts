import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants, type BigIntStats } from 'node:fs';
import fs, { lstat, open, realpath, type FileHandle } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentExecutionError } from '../src/agent-execution-types.js';
import { captureWorkspaceFiles } from '../src/workspace-file-capture.js';
import { withWorkspaceMutation } from '../src/workspace-mutation.js';

vi.mock('node:fs', async (original) => {
  const actual = await original<typeof import('node:fs')>();
  return { ...actual, constants: { ...actual.constants } };
});
vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>();
  return {
    ...actual,
    open: vi.fn(actual.open),
    lstat: vi.fn(actual.lstat),
    realpath: vi.fn(actual.realpath),
  };
});

const roots: string[] = [];
const handles: FileHandle[] = [];
const originalFlags = { nofollow: constants.O_NOFOLLOW, nonblock: constants.O_NONBLOCK };
const freshSignal = () => new AbortController().signal;

afterEach(async () => {
  vi.mocked(open).mockImplementation(fs.open);
  vi.mocked(lstat).mockImplementation(fs.lstat);
  vi.mocked(realpath).mockImplementation(fs.realpath);
  Object.assign(constants, {
    O_NOFOLLOW: originalFlags.nofollow,
    O_NONBLOCK: originalFlags.nonblock,
  });
  vi.restoreAllMocks();
  await Promise.all(handles.splice(0).map((handle) => handle.close()));
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function fixture(files: Readonly<Record<string, string | Buffer>> = { 'a.txt': 'hello' }) {
  const root = await fs.mkdtemp(join(tmpdir(), 'weave-file-context-'));
  roots.push(root);
  for (const [name, content] of Object.entries(files)) {
    const target = join(root, name);
    await fs.mkdir(join(target, '..'), { recursive: true });
    await fs.writeFile(target, content);
  }
  return fs.realpath(root);
}

function gate() {
  let enter!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    entered,
    release,
    async hold() {
      enter();
      await released;
    },
  };
}

function capture(root: string, paths = ['a.txt'], signal = freshSignal()) {
  return captureWorkspaceFiles(
    root,
    paths.map((path) => ({ path })),
    { signal },
  );
}

function holdOpen(target: string, barrier: ReturnType<typeof gate>) {
  let armed = true;
  vi.mocked(open).mockImplementation(async (path, flags, mode) => {
    if (armed && path === target) {
      armed = false;
      await barrier.hold();
    }
    const handle = await fs.open(path, flags, mode);
    handles.push(handle);
    return handle;
  });
}

function transformHandle(target: string, transform: (handle: FileHandle) => void) {
  vi.mocked(open).mockImplementation(async (path, flags, mode) => {
    const handle = await fs.open(path, flags, mode);
    handles.push(handle);
    if (path === target) transform(handle);
    return handle;
  });
}

describe('workspace file capture', () => {
  it('preserves BOM, Unicode, CRLF, empty content and reference order as exact UTF-8 bytes', async () => {
    const root = await fixture({ '中文 file.txt': '\uFEFF中文\r\n', '.empty': '' });
    const result = await capture(root, ['.empty', '中文 file.txt']);
    expect(result.version).toBe(1);
    expect(result.rootIdentity).toMatch(/^[a-f0-9]{64}$/);
    expect(result.files.map((file) => file.path)).toEqual(['.empty', '中文 file.txt']);
    expect(result.files[0]).toMatchObject({
      path: '.empty',
      content: '',
      byteLength: 0,
      encoding: 'utf-8',
      sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    });
    const bytes = await fs.readFile(join(root, '中文 file.txt'));
    expect(Buffer.from(result.files[1]!.content, 'utf8')).toEqual(bytes);
    expect(result.files[1]!.content).toBe('\uFEFF中文\r\n');
    expect(result.files[1]!.byteLength).toBe(11);
    expect(result.files[1]!.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
    expect(result.files[1]!.fileIdentity).toMatch(/^[a-f0-9]{64}$/);
    expect(result.files[1]!.fileIdentity).not.toBe(result.files[0]!.fileIdentity);
    expect(result).not.toHaveProperty('projectId');
  });

  it('accepts exactly 65,536 bytes per file and 262,144 bytes per batch', async () => {
    const root = await fixture({
      a: Buffer.alloc(65_536, 0x61),
      b: Buffer.alloc(65_536, 0x62),
      c: Buffer.alloc(65_536, 0x63),
      d: Buffer.alloc(65_536, 0x64),
    });
    const result = await capture(root, ['a', 'b', 'c', 'd']);
    expect(result.files.map((file) => file.byteLength)).toEqual([65_536, 65_536, 65_536, 65_536]);
    expect(result.files.map((file) => file.content[0])).toEqual(['a', 'b', 'c', 'd']);
  });

  it('rejects a single file one byte above the limit', async () => {
    const root = await fixture({ 'a.txt': Buffer.alloc(65_537, 0x61) });
    await expect(capture(root)).rejects.toMatchObject({ code: 'execution-file-too-large' });
  });

  it('rejects a batch one byte above the aggregate limit', async () => {
    const root = await fixture({
      a: Buffer.alloc(65_536, 0x61),
      b: Buffer.alloc(65_536, 0x62),
      c: Buffer.alloc(65_536, 0x63),
      d: Buffer.alloc(65_536, 0x64),
      e: 'e',
    });
    await expect(capture(root, ['a', 'b', 'c', 'd', 'e'])).rejects.toMatchObject({
      code: 'execution-file-too-large',
    });
  });

  it('accepts eight distinct empty files', async () => {
    const names = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
    const root = await fixture(Object.fromEntries(names.map((name) => [name, ''])));
    expect((await capture(root, names)).files).toHaveLength(8);
  });

  it.each(
    [
      [],
      Array.from({ length: 9 }, (_, i) => `file-${i}`),
      ['a.txt', 'a.txt'],
      ['../a'],
      ['a/../b'],
      ['/absolute'],
      ['C:/file'],
      ['a\\file'],
      ['a//file'],
      ['./file'],
      ['a\0file'],
      ['file:x'],
      ['a\u200Bfile'],
    ].map((paths) => ({ paths })),
  )('rejects invalid references before accessing a root: $paths', async ({ paths }) => {
    await expect(capture('/nonexistent-private-root', paths)).rejects.toMatchObject({
      code: 'execution-invalid-input',
    });
  });

  it('rejects caller-supplied captured content instead of trusting it', async () => {
    const root = await fixture();
    await expect(
      captureWorkspaceFiles(root, [{ path: 'a.txt', content: 'forged' }], {
        signal: freshSignal(),
      }),
    ).rejects.toMatchObject({ code: 'execution-invalid-input' });
  });

  it.each([Buffer.from([0x61, 0xff]), Buffer.from([0xc0, 0xaf]), Buffer.from('a\0b')])(
    'rejects invalid UTF-8 or NUL text without replacement decoding',
    async (bytes) => {
      const root = await fixture({ 'a.txt': bytes });
      await expect(capture(root)).rejects.toMatchObject({ code: 'execution-file-invalid-utf8' });
    },
  );

  it('rejects missing paths, directories and a non-directory parent', async () => {
    const root = await fixture();
    await fs.mkdir(join(root, 'directory'));
    for (const name of ['missing', 'directory', 'a.txt/child']) {
      await expect(capture(root, [name])).rejects.toMatchObject({
        code: 'execution-file-unavailable',
      });
    }
  });

  it('rejects symlinks to files inside or outside the root and symlink parents', async () => {
    const root = await fixture({ 'a.txt': 'inside', 'dir/file': 'nested' });
    const outside = await fixture({ file: 'outside' });
    await fs.symlink(join(root, 'a.txt'), join(root, 'inside-link'));
    await fs.symlink(join(outside, 'file'), join(root, 'outside-link'));
    await fs.symlink(join(root, 'dir'), join(root, 'parent-link'));
    for (const name of ['inside-link', 'outside-link', 'parent-link/file']) {
      await expect(capture(root, [name])).rejects.toMatchObject({
        code: 'execution-file-unavailable',
      });
    }
  });

  it('rejects a hardlinked regular file', async () => {
    const root = await fixture();
    await fs.link(join(root, 'a.txt'), join(root, 'hardlink'));
    await expect(capture(root)).rejects.toMatchObject({ code: 'execution-file-unavailable' });
  });

  it('rejects distinct lexical refs resolving to one actual file identity', async () => {
    const root = await fixture();
    const original = join(root, 'a.txt');
    const alias = join(root, 'A.TXT');
    vi.mocked(lstat).mockImplementation((path, options) =>
      fs.lstat(path === alias ? original : path, options),
    );
    vi.mocked(open).mockImplementation((path, flags, mode) =>
      fs.open(path === alias ? original : path, flags, mode),
    );
    await expect(capture(root, ['a.txt', 'A.TXT'])).rejects.toMatchObject({
      code: 'execution-file-unavailable',
    });
  });

  it.skipIf(process.platform === 'win32')(
    'rejects a FIFO without waiting for a writer',
    async () => {
      const root = await fixture();
      await promisify(execFile)('mkfifo', [join(root, 'fifo')]);
      await expect(capture(root, ['fifo'])).rejects.toMatchObject({
        code: 'execution-file-unavailable',
      });
    },
  );

  it.each(['O_NOFOLLOW', 'O_NONBLOCK'] as const)(
    'fails closed when %s is not available',
    async (flag) => {
      const root = await fixture();
      Object.assign(constants, { [flag]: 0 });
      await expect(capture(root)).rejects.toMatchObject({ code: 'execution-file-unavailable' });
    },
  );

  it('opens a regular file using no-follow and nonblocking flags', async () => {
    const root = await fixture();
    vi.mocked(open).mockImplementation(async (path, flags, mode) => {
      if (path === join(root, 'a.txt')) {
        if (
          typeof flags !== 'number' ||
          (flags & constants.O_NOFOLLOW) === 0 ||
          (flags & constants.O_NONBLOCK) === 0
        )
          throw new Error('Capture did not enforce final-component open flags');
      }
      return fs.open(path, flags, mode);
    });
    expect((await capture(root)).files[0]!.content).toBe('hello');
  });

  it('maps unsupported flags reported by open to an unavailable capture', async () => {
    const root = await fixture();
    vi.mocked(open).mockRejectedValue(
      Object.assign(new Error('private unsupported flags'), { code: 'ENOTSUP' }),
    );
    await expect(capture(root)).rejects.toMatchObject({ code: 'execution-file-unavailable' });
  });

  it('requires positive incarnation evidence from the actual open handle', async () => {
    const root = await fixture();
    transformHandle(join(root, 'a.txt'), (handle) => {
      const stat = handle.stat.bind(handle);
      vi.spyOn(handle, 'stat').mockImplementation(async (options) => {
        const metadata = await stat(options);
        return Object.assign(metadata, { birthtimeNs: 0n });
      });
    });
    await expect(capture(root)).rejects.toMatchObject({ code: 'execution-file-unavailable' });
    await expect(handles[0]!.stat()).rejects.toMatchObject({ code: 'EBADF' });
  });

  it('detects a same-byte replacement between lstat and open', async () => {
    const root = await fixture();
    const barrier = gate();
    holdOpen(join(root, 'a.txt'), barrier);
    const result = capture(root);
    const rejected = expect(result).rejects.toMatchObject({ code: 'execution-file-changed' });
    await barrier.entered;
    await fs.rename(join(root, 'a.txt'), join(root, 'old'));
    await fs.writeFile(join(root, 'a.txt'), 'hello');
    barrier.release();
    await rejected;
  });

  it('detects a parent replacement between component checks and open', async () => {
    const root = await fixture({ 'dir/a.txt': 'original' });
    const barrier = gate();
    holdOpen(join(root, 'dir/a.txt'), barrier);
    const rejected = expect(capture(root, ['dir/a.txt'])).rejects.toMatchObject({
      code: 'execution-file-changed',
    });
    await barrier.entered;
    await fs.rename(join(root, 'dir'), join(root, 'old-dir'));
    await fs.mkdir(join(root, 'dir'));
    await fs.writeFile(join(root, 'dir/a.txt'), 'replacement');
    barrier.release();
    await rejected;
  });

  it('detects a parent rename even when the opened file retains the same identity', async () => {
    const root = await fixture({ 'dir/a.txt': 'original' });
    const barrier = gate();
    holdOpen(join(root, 'dir/a.txt'), barrier);
    const rejected = expect(capture(root, ['dir/a.txt'])).rejects.toMatchObject({
      code: 'execution-file-changed',
    });
    await barrier.entered;
    await fs.rename(join(root, 'dir'), join(root, 'old-dir'));
    await fs.mkdir(join(root, 'dir'));
    await fs.rename(join(root, 'old-dir/a.txt'), join(root, 'dir/a.txt'));
    barrier.release();
    await rejected;
  });

  it('detects a configured root rebound during the read', async () => {
    const container = await fixture({ 'root/a.txt': 'original' });
    const root = join(container, 'root');
    const barrier = gate();
    transformHandle(join(root, 'a.txt'), (handle) => {
      const stat = handle.stat.bind(handle);
      let first = true;
      vi.spyOn(handle, 'stat').mockImplementation(async (options) => {
        const result = await stat(options);
        if (first) {
          first = false;
          await barrier.hold();
        }
        return result;
      });
    });
    const rejected = expect(capture(root)).rejects.toMatchObject({
      code: 'execution-file-changed',
    });
    await barrier.entered;
    await fs.rename(root, join(container, 'old-root'));
    await fs.mkdir(root);
    await fs.writeFile(join(root, 'a.txt'), 'replacement');
    barrier.release();
    await rejected;
  });

  it('rejects growth at cap plus one instead of silently truncating', async () => {
    const root = await fixture({ 'a.txt': Buffer.alloc(65_536, 0x61) });
    transformHandle(join(root, 'a.txt'), (handle) => {
      const read = handle.read.bind(handle);
      let first = true;
      vi.spyOn(handle, 'read').mockImplementation(
        async (...args: Parameters<typeof handle.read>) => {
          const result = await read(...args);
          if (first) {
            first = false;
            await fs.appendFile(join(root, 'a.txt'), 'b');
          }
          return result;
        },
      );
    });
    await expect(capture(root)).rejects.toMatchObject({ code: 'execution-file-too-large' });
    await expect(handles[0]!.stat()).rejects.toMatchObject({ code: 'EBADF' });
  });

  it('rejects a file that grows beyond the limit before its handle metadata is read', async () => {
    const root = await fixture({ 'a.txt': Buffer.alloc(65_536, 0x61) });
    const barrier = gate();
    holdOpen(join(root, 'a.txt'), barrier);
    const rejected = expect(capture(root)).rejects.toMatchObject({
      code: 'execution-file-too-large',
    });
    await barrier.entered;
    await fs.appendFile(join(root, 'a.txt'), 'b');
    barrier.release();
    await rejected;
  });

  it('rejects an observed same-size write while reading', async () => {
    const root = await fixture();
    transformHandle(join(root, 'a.txt'), (handle) => {
      const read = handle.read.bind(handle);
      let first = true;
      vi.spyOn(handle, 'read').mockImplementation(
        async (...args: Parameters<typeof handle.read>) => {
          const result = await read(...args);
          if (first) {
            first = false;
            await fs.writeFile(join(root, 'a.txt'), 'other');
          }
          return result;
        },
      );
    });
    await expect(capture(root)).rejects.toMatchObject({ code: 'execution-file-changed' });
  });

  it('rechecks earlier path evidence after the rest of the batch is read', async () => {
    const root = await fixture({ 'one/a': 'first', 'two/b': 'second' });
    const barrier = gate();
    holdOpen(join(root, 'two/b'), barrier);
    const rejected = expect(capture(root, ['one/a', 'two/b'])).rejects.toMatchObject({
      code: 'execution-file-changed',
    });
    await barrier.entered;
    await fs.rename(join(root, 'one'), join(root, 'old-one'));
    await fs.mkdir(join(root, 'one'));
    await fs.writeFile(join(root, 'one/a'), 'first');
    barrier.release();
    await rejected;
  });

  it('serializes the whole capture batch with cooperative workspace mutation', async () => {
    const root = await fixture({ 'a.txt': 'before a', b: 'before b' });
    const barrier = gate();
    holdOpen(join(root, 'a.txt'), barrier);
    const result = capture(root, ['a.txt', 'b']);
    await barrier.entered;
    let mutated = false;
    const mutation = withWorkspaceMutation(root, async () => {
      mutated = true;
      await fs.writeFile(join(root, 'a.txt'), 'after a');
      await fs.writeFile(join(root, 'b'), 'after b');
    });
    expect(mutated).toBe(false);
    barrier.release();
    expect((await result).files.map((file) => file.content)).toEqual(['before a', 'before b']);
    await mutation;
    expect(await fs.readFile(join(root, 'a.txt'), 'utf8')).toBe('after a');
  });

  it('rechecks root incarnation after waiting in the cooperative queue', async () => {
    const container = await fixture({ 'root/a.txt': 'original' });
    const root = join(container, 'root');
    const barrier = gate();
    const queued = gate();
    const mutation = withWorkspaceMutation(root, () => barrier.hold());
    await barrier.entered;
    let canonicalReads = 0;
    vi.mocked(realpath).mockImplementation(async (path, options) => {
      const value = await fs.realpath(path, options);
      if (path === root && ++canonicalReads === 2) await queued.hold();
      return value;
    });
    const rejected = expect(capture(root)).rejects.toMatchObject({
      code: 'execution-file-changed',
    });
    await queued.entered;
    await fs.rename(root, join(container, 'old-root'));
    await fs.mkdir(root);
    await fs.writeFile(join(root, 'a.txt'), 'replacement');
    queued.release();
    barrier.release();
    await mutation;
    await rejected;
  });

  it('rejects a signal already aborted before I/O', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(capture('/private/missing', ['a'], controller.signal)).rejects.toMatchObject({
      code: 'execution-file-capture-timeout',
    });
  });

  it('honors abort while waiting for the workspace queue', async () => {
    const root = await fixture();
    const barrier = gate();
    const queued = gate();
    const mutation = withWorkspaceMutation(root, () => barrier.hold());
    await barrier.entered;
    let canonicalReads = 0;
    vi.mocked(realpath).mockImplementation(async (path, options) => {
      const value = await fs.realpath(path, options);
      if (path === root && ++canonicalReads === 2) await queued.hold();
      return value;
    });
    const controller = new AbortController();
    const rejected = expect(capture(root, ['a.txt'], controller.signal)).rejects.toMatchObject({
      code: 'execution-file-capture-timeout',
    });
    await queued.entered;
    controller.abort();
    queued.release();
    barrier.release();
    await mutation;
    await rejected;
  });

  it('waits for an aborted read to settle and closes its actual handle', async () => {
    const root = await fixture();
    const barrier = gate();
    const controller = new AbortController();
    transformHandle(join(root, 'a.txt'), (handle) => {
      const read = handle.read.bind(handle);
      vi.spyOn(handle, 'read').mockImplementation(
        async (...args: Parameters<typeof handle.read>) => {
          await barrier.hold();
          return read(...args);
        },
      );
    });
    const rejected = expect(capture(root, ['a.txt'], controller.signal)).rejects.toMatchObject({
      code: 'execution-file-capture-timeout',
    });
    await barrier.entered;
    controller.abort();
    barrier.release();
    await rejected;
    await expect(handles[0]!.stat()).rejects.toMatchObject({ code: 'EBADF' });
  });

  it('maps unexpected I/O failures without a cause, host path or raw system error', async () => {
    const root = await fixture();
    vi.mocked(open).mockRejectedValue(
      Object.assign(new Error(`private open failure at ${root}`), { code: 'EMFILE' }),
    );
    const error: unknown = await capture(root).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(AgentExecutionError);
    expect(error).toMatchObject({ code: 'execution-file-capture-failed' });
    expect(error).not.toHaveProperty('cause');
    expect((error as Error).message).not.toContain(root);
    expect((error as Error).message).not.toContain('EMFILE');
  });

  it('maps raw root lookup errors into a stable safe failure', async () => {
    const root = '/private/unavailable-weave-file-context';
    const error: unknown = await capture(root).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(AgentExecutionError);
    expect(error).toMatchObject({ code: 'execution-file-unavailable' });
    expect(error).not.toHaveProperty('cause');
    expect((error as Error).message).not.toContain(root);
  });

  it('rejects inconsistent post-read handle metadata', async () => {
    const root = await fixture();
    transformHandle(join(root, 'a.txt'), (handle) => {
      const stat = handle.stat.bind(handle);
      let calls = 0;
      vi.spyOn(handle, 'stat').mockImplementation(async (options) => {
        const metadata = await stat(options);
        if (++calls === 2) (metadata as BigIntStats).ctimeNs += 1n;
        return metadata;
      });
    });
    await expect(capture(root)).rejects.toMatchObject({ code: 'execution-file-changed' });
  });
});
