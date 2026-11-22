import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { captureSnapshot, verifySnapshot } from '../src/snapshot.js';
import { publishOutput, writeProject } from '../src/output.js';

const temporary: string[] = [];
async function root() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'weave-cli-fs-'));
  const canonical = await fs.realpath(directory);
  temporary.push(canonical);
  return canonical;
}
async function put(directory: string, relative: string, value = 'text') {
  await fs.mkdir(path.dirname(path.join(directory, relative)), { recursive: true });
  await fs.writeFile(path.join(directory, relative), value);
}
const files = () =>
  new Map([
    ['weave-plugin.json', new TextEncoder().encode('{}')],
    ['src/a.ts', new TextEncoder().encode('export {};')],
  ]);
afterEach(async () => {
  vi.restoreAllMocks();
  for (const directory of temporary.splice(0))
    await fs.rm(directory, { recursive: true, force: true });
});

describe('bounded CLI filesystem snapshots', () => {
  it('captures raw bytes and directories, normalizes ancestor aliases and ignores Host droppings', async () => {
    const directory = await root();
    await put(directory, 'src/index.ts', '\ufeffexport const x = 1;\r\n');
    await put(directory, '.git/config', 'ignored');
    await put(directory, 'src/.DS_Store', 'ignored');
    const alias = path.join(await root(), 'alias');
    await fs.symlink(directory, alias);
    const snapshot = await captureSnapshot(path.join(alias, 'src'));
    expect(snapshot.directory).toBe(path.join(directory, 'src'));
    expect(snapshot.directories).toEqual(['']);
    expect(Buffer.from(snapshot.files.get('index.ts')!).toString()).toBe(
      '\ufeffexport const x = 1;\r\n',
    );
    await verifySnapshot(snapshot);
    expect([...(await captureSnapshot(directory)).files.keys()]).toEqual(['src/index.ts']);
  });
  it('rejects a linked root and linked child', async () => {
    const directory = await root();
    await put(directory, 'a.ts');
    const alias = path.join(await root(), 'alias');
    await fs.symlink(directory, alias);
    await expect(captureSnapshot(alias)).rejects.toMatchObject({
      code: 'plugin-cli-invalid-project',
    });
    await fs.symlink(path.join(directory, 'a.ts'), path.join(directory, 'b.ts'));
    await expect(captureSnapshot(directory)).rejects.toMatchObject({
      code: 'plugin-cli-invalid-project',
    });
  });
  it.each([
    ['maxFiles', 0],
    ['maxBytes', 3],
    ['maxFileBytes', 3],
    ['maxDepth', 0],
    ['maxEntries', 1],
  ] as const)('enforces the %s limit with real files', async (bound, value) => {
    const directory = await root();
    await put(directory, 'src/index.ts', '1234');
    await expect(captureSnapshot(directory, { [bound]: value })).rejects.toMatchObject({
      code: 'plugin-cli-invalid-project',
    });
  });
  it.each(['CON.txt', 'bad?.txt', 'bad\u007f.txt', 'trailing.'])(
    'rejects nonportable payload path %s',
    async (relative) => {
      const directory = await root();
      await put(directory, relative);
      await expect(captureSnapshot(directory)).rejects.toMatchObject({
        code: 'plugin-cli-invalid-project',
      });
    },
  );
  it('detects additions, changed bytes, replaced identities and changed input aliases', async () => {
    const directory = await root();
    await put(directory, 'a.ts');
    const snapshot = await captureSnapshot(directory);
    await put(directory, 'extra.ts');
    await expect(verifySnapshot(snapshot)).rejects.toMatchObject({
      code: 'plugin-cli-source-changed',
    });
    await fs.rm(path.join(directory, 'extra.ts'));
    const second = await captureSnapshot(directory);
    await fs.rename(path.join(directory, 'a.ts'), path.join(directory, 'old'));
    await put(directory, 'a.ts');
    await fs.rm(path.join(directory, 'old'));
    await expect(verifySnapshot(second)).rejects.toMatchObject({
      code: 'plugin-cli-source-changed',
    });
  });
  it('rejects a source file changed during its actual bounded read', async () => {
    const directory = await root();
    await put(directory, 'a.ts', 'original');
    const open = fs.open.bind(fs);
    vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
      const handle = await open(...args);
      const read = handle.read.bind(handle);
      let changed = false;
      vi.spyOn(handle, 'read').mockImplementation(async (...readArgs) => {
        const result = await Reflect.apply(read, handle, readArgs);
        if (!changed) {
          changed = true;
          await fs.writeFile(path.join(directory, 'a.ts'), 'mutated!');
        }
        return result;
      });
      return handle;
    });
    await expect(captureSnapshot(directory)).rejects.toMatchObject({
      code: 'plugin-cli-invalid-project',
    });
  });
  it('detects a changed alias ancestor when verifying the snapshot', async () => {
    const parent = await root();
    const original = path.join(parent, 'original');
    const replacement = path.join(parent, 'replacement');
    await put(original, 'src/a.ts');
    await put(replacement, 'src/a.ts');
    const alias = path.join(parent, 'alias');
    await fs.symlink(original, alias);
    const snapshot = await captureSnapshot(path.join(alias, 'src'));
    await fs.unlink(alias);
    await fs.symlink(replacement, alias);
    await expect(verifySnapshot(snapshot)).rejects.toMatchObject({
      code: 'plugin-cli-source-changed',
    });
  });
  it('preserves abort reasons during real reads and closes file handles', async () => {
    const directory = await root();
    await put(directory, 'a.ts');
    const abort = new AbortController();
    const reason = new Error('stop snapshot');
    const open = fs.open.bind(fs);
    let closed = false;
    vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
      const handle = await open(...args);
      const read = handle.read.bind(handle);
      vi.spyOn(handle, 'read').mockImplementation(async (...readArgs) => {
        const result = await Reflect.apply(read, handle, readArgs);
        abort.abort(reason);
        return result;
      });
      const close = handle.close.bind(handle);
      vi.spyOn(handle, 'close').mockImplementation(async () => {
        await close();
        closed = true;
      });
      return handle;
    });
    await expect(captureSnapshot(directory, { signal: abort.signal })).rejects.toBe(reason);
    expect(closed).toBe(true);
  });
});

describe('exclusive CLI output publication', () => {
  it('creates a project exclusively, preserves existing output and validates relative names first', async () => {
    const parent = await root();
    const directory = path.join(parent, 'project');
    await writeProject(directory, files());
    expect(await fs.readFile(path.join(directory, 'src/a.ts'), 'utf8')).toBe('export {};');
    await expect(writeProject(directory, files())).rejects.toMatchObject({
      code: 'plugin-cli-output-conflict',
    });
    const invalid = path.join(parent, 'invalid');
    await expect(
      writeProject(invalid, new Map([['../escape', new Uint8Array()]])),
    ).rejects.toMatchObject({ code: 'plugin-cli-invalid-project' });
    await expect(fs.stat(invalid)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('publishes checked staging, rechecks source then final payload and writes an external receipt', async () => {
    const parent = await root();
    const source = path.join(parent, 'source');
    await fs.mkdir(source);
    const snapshot = await captureSnapshot(source);
    const out = path.join(parent, 'out');
    const seen: string[] = [];
    const published = await publishOutput({
      sourceDirectory: source,
      outputDirectory: out,
      files: files(),
      verifyInput: async () => {
        seen.push('verify');
        await verifySnapshot(snapshot);
      },
      validatePayload: async (directory) => {
        seen.push(path.basename(directory));
        return await fs.readFile(path.join(directory, 'src/a.ts'), 'utf8');
      },
      receipt: (value, payloadDirectory) => ({ value, outputPath: payloadDirectory }),
    });
    expect(seen).toEqual(['.payload-building', 'verify', 'payload']);
    expect(published).toEqual({
      value: 'export {};',
      payloadDirectory: path.join(out, 'payload'),
      receiptPath: path.join(out, 'receipt.json'),
    });
    expect(JSON.parse(await fs.readFile(published.receiptPath!, 'utf8'))).toEqual({
      value: 'export {};',
      outputPath: published.payloadDirectory,
    });
    expect(await fs.readdir(out)).toEqual(['payload', 'receipt.json']);
  });
  it('refuses lexical and canonical overlap before changing source', async () => {
    const parent = await root();
    const source = path.join(parent, 'source');
    await fs.mkdir(source);
    const alias = path.join(parent, 'alias');
    await fs.symlink(source, alias);
    for (const out of [path.join(source, 'nested'), path.join(alias, 'nested')]) {
      await expect(
        publishOutput({
          sourceDirectory: source,
          outputDirectory: out,
          files: files(),
          verifyInput: async () => {},
          validatePayload: async () => true,
        }),
      ).rejects.toMatchObject({ code: 'plugin-cli-path-overlap' });
    }
    expect(await fs.readdir(source)).toEqual([]);
  });
  it('cleans its exclusive output when input verification fails', async () => {
    const parent = await root();
    const source = path.join(parent, 'source');
    await fs.mkdir(source);
    const out = path.join(parent, 'out');
    const reason = new Error('source changed');
    await expect(
      publishOutput({
        sourceDirectory: source,
        outputDirectory: out,
        files: files(),
        verifyInput: async () => {
          throw reason;
        },
        validatePayload: async () => true,
      }),
    ).rejects.toBe(reason);
    await expect(fs.stat(out)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('preserves replacement output and reports both primary and cleanup errors', async () => {
    const parent = await root();
    const source = path.join(parent, 'source');
    await fs.mkdir(source);
    const out = path.join(parent, 'out');
    const reason = new Error('validation failed');
    await expect(
      publishOutput({
        sourceDirectory: source,
        outputDirectory: out,
        files: files(),
        verifyInput: async () => {},
        validatePayload: async () => {
          await fs.rename(out, `${out}-original`);
          await fs.mkdir(out);
          await put(out, 'precious', 'preserve');
          throw reason;
        },
      }),
    ).rejects.toBeInstanceOf(AggregateError);
    expect(await fs.readFile(path.join(out, 'precious'), 'utf8')).toBe('preserve');
  });
  it('preserves an unowned child added before a failure', async () => {
    const parent = await root();
    const source = path.join(parent, 'source');
    await fs.mkdir(source);
    const out = path.join(parent, 'out');
    await expect(
      publishOutput({
        sourceDirectory: source,
        outputDirectory: out,
        files: files(),
        verifyInput: async () => {},
        validatePayload: async () => {
          await put(out, 'unexpected', 'preserve');
          throw new Error('failure');
        },
      }),
    ).rejects.toBeInstanceOf(AggregateError);
    expect(await fs.readFile(path.join(out, 'unexpected'), 'utf8')).toBe('preserve');
  });
  it('supports cooperative cancellation and drains cleanup before rejection', async () => {
    const parent = await root();
    const source = path.join(parent, 'source');
    await fs.mkdir(source);
    const abort = new AbortController();
    const reason = new Error('stop publication');
    const out = path.join(parent, 'out');
    await expect(
      publishOutput({
        sourceDirectory: source,
        outputDirectory: out,
        files: files(),
        signal: abort.signal,
        verifyInput: async () => {
          abort.abort(reason);
        },
        validatePayload: async () => true,
      }),
    ).rejects.toBe(reason);
    await expect(fs.stat(out)).rejects.toMatchObject({ code: 'ENOENT' });
    const already = path.join(parent, 'already');
    await expect(writeProject(already, files(), abort.signal)).rejects.toBe(reason);
    await expect(fs.stat(already)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('preserves the primary failure when cleanup itself fails', async () => {
    const parent = await root();
    const source = path.join(parent, 'source');
    await fs.mkdir(source);
    const out = path.join(parent, 'out');
    const reason = new Error('primary validation');
    const unlink = fs.unlink.bind(fs);
    vi.spyOn(fs, 'unlink').mockImplementation(async (...args) => {
      if (String(args[0]).includes('out')) throw new Error('cleanup denied');
      return unlink(...args);
    });
    let caught: unknown;
    try {
      await publishOutput({
        sourceDirectory: source,
        outputDirectory: out,
        files: files(),
        verifyInput: async () => {},
        validatePayload: async () => {
          throw reason;
        },
      });
    } catch (error: unknown) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(AggregateError);
    expect((caught as AggregateError).errors[0]).toBe(reason);
    expect((caught as AggregateError).errors[1]).toMatchObject({ message: 'cleanup denied' });
    expect(await fs.stat(out)).toBeDefined();
  });
  it('cleans a published payload when cancellation arrives before receipt completion', async () => {
    const parent = await root();
    const source = path.join(parent, 'source');
    await fs.mkdir(source);
    const out = path.join(parent, 'out');
    const abort = new AbortController();
    const reason = new Error('late abort');
    await expect(
      publishOutput({
        sourceDirectory: source,
        outputDirectory: out,
        files: files(),
        signal: abort.signal,
        verifyInput: async () => {},
        validatePayload: async () => true,
        receipt: () => {
          abort.abort(reason);
          return {};
        },
      }),
    ).rejects.toBe(reason);
    await expect(fs.stat(out)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('closes an opened output handle and cleans a partial file on actual write cancellation', async () => {
    const parent = await root();
    const out = path.join(parent, 'out');
    const abort = new AbortController();
    const reason = new Error('write cancelled');
    const open = fs.open.bind(fs);
    let closed = false;
    vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
      const handle = await open(...args);
      const write = handle.write.bind(handle);
      const close = handle.close.bind(handle);
      vi.spyOn(handle, 'write').mockImplementation(async (...writeArgs) => {
        const result = await Reflect.apply(write, handle, writeArgs);
        abort.abort(reason);
        return result;
      });
      vi.spyOn(handle, 'close').mockImplementation(async () => {
        await close();
        closed = true;
      });
      return handle;
    });
    await expect(writeProject(out, files(), abort.signal)).rejects.toBe(reason);
    expect(closed).toBe(true);
    await expect(fs.stat(out)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('reports and cleans an actual output write failure without losing the cause', async () => {
    const parent = await root();
    const out = path.join(parent, 'out');
    const reason = new Error('disk write failed');
    const open = fs.open.bind(fs);
    let closed = false;
    vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
      const handle = await open(...args);
      const close = handle.close.bind(handle);
      vi.spyOn(handle, 'write').mockRejectedValue(reason);
      vi.spyOn(handle, 'close').mockImplementation(async () => {
        await close();
        closed = true;
      });
      return handle;
    });
    await expect(writeProject(out, files())).rejects.toBe(reason);
    expect(closed).toBe(true);
    await expect(fs.stat(out)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('closes a newly opened file when its first identity observation fails', async () => {
    const parent = await root();
    const out = path.join(parent, 'out');
    const reason = new Error('file stat failed');
    const open = fs.open.bind(fs);
    let closed = false;
    vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
      const handle = await open(...args);
      const stat = handle.stat.bind(handle);
      const close = handle.close.bind(handle);
      let first = true;
      vi.spyOn(handle, 'stat').mockImplementation(async (...statArgs) => {
        if (first) {
          first = false;
          throw reason;
        }
        return Reflect.apply(stat, handle, statArgs);
      });
      vi.spyOn(handle, 'close').mockImplementation(async () => {
        await close();
        closed = true;
      });
      return handle;
    });
    await expect(writeProject(out, files())).rejects.toBe(reason);
    expect(closed).toBe(true);
    await expect(fs.stat(out)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('reports retained output when identity observation fails after exclusive directory creation', async () => {
    const parent = await root();
    const out = path.join(parent, 'out');
    const reason = new Error('first directory stat failed');
    const lstat = fs.lstat.bind(fs);
    let first = true;
    vi.spyOn(fs, 'lstat').mockImplementation(async (...args) => {
      if (String(args[0]) === out && first) {
        first = false;
        throw reason;
      }
      return Reflect.apply(lstat, fs, args);
    });
    let caught: unknown;
    try {
      await writeProject(out, files());
    } catch (error: unknown) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(AggregateError);
    expect((caught as AggregateError).errors[0]).toBe(reason);
    expect((caught as AggregateError).message).toContain(out);
    expect((caught as AggregateError).message).toContain('retained');
    expect(await fs.readdir(out)).toEqual([]);
  });
  it('allows exactly one of two concurrent creators to own an output', async () => {
    const parent = await root();
    const out = path.join(parent, 'out');
    const results = await Promise.allSettled([
      writeProject(out, files()),
      writeProject(out, files()),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toMatchObject([
      { reason: { code: 'plugin-cli-output-conflict' } },
    ]);
    expect(await fs.readFile(path.join(out, 'src/a.ts'), 'utf8')).toBe('export {};');
  });
});
