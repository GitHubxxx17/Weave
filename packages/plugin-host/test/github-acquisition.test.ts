import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createGithubPluginAcquirer, githubPluginSourceSchema } from '../src/index.js';

const commit = 'a'.repeat(40);
const treeSha = 'b'.repeat(40);
const source = { repository: 'https://github.com/acme/plugins', commit, subdirectory: '' };
const roots: string[] = [];
const blobSha = (text: string) =>
  createHash('sha1')
    .update(`blob ${Buffer.byteLength(text)}\0`)
    .update(text)
    .digest('hex');
const file = (name: string, text = 'export default 1;', mode = '100644') => ({
  path: name,
  mode,
  type: 'blob',
  sha: blobSha(text),
  size: Buffer.byteLength(text),
});
const tree = (entries: unknown[], sha = treeSha) => ({ sha, tree: entries, truncated: false });
const json = (data: unknown) => new Response(JSON.stringify(data));
async function scratch() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'weave-github-test-'));
  roots.push(root);
  return path.join(root, 'scratch');
}
function transport(entries: unknown[] = [file('index.js')], contents: Record<string, string> = {}) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input);
    calls.push({ url, ...(init === undefined ? {} : { init }) });
    if (url.endsWith(`/git/commits/${commit}`))
      return json({ sha: commit, tree: { sha: treeSha } });
    if (url.endsWith(`/git/trees/${treeSha}?recursive=1`)) return json(tree(entries));
    const prefix = `https://raw.githubusercontent.com/acme/plugins/${commit}/`;
    if (url.startsWith(prefix))
      return new Response(contents[url.slice(prefix.length)] ?? 'export default 1;');
    throw new Error(`Unexpected fixture URL ${url}`);
  };
  return { fetcher, calls };
}
async function expectCode(promise: Promise<unknown>, code = 'plugin-github-invalid') {
  await expect(promise).rejects.toMatchObject({ code });
}
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

describe('GitHub plugin sources', () => {
  it('normalizes repository case and defaults the optional subdirectory', () => {
    expect(
      githubPluginSourceSchema.parse({ repository: 'https://github.com/Acme/Plugins', commit }),
    ).toEqual(source);
  });
  it.each([
    { repository: 'https://user:secret@github.com/acme/plugins' },
    { repository: 'https://github.com:443/acme/plugins' },
    { repository: 'https://github.com/acme/plugins.git' },
    { repository: 'https://github.com/acme/plugins/' },
    { repository: 'https://github.com/acme/plugins?x=1' },
    { repository: 'https://github.com/acme/plugins#readme' },
    { repository: 'https://example.com/acme/plugins' },
    { repository: 'http://github.com/acme/plugins' },
    { commit: 'main' },
    { commit: 'A'.repeat(40) },
    { subdirectory: '../plugin' },
    { subdirectory: 'a//b' },
    { subdirectory: '/a' },
    { subdirectory: 'a/' },
    { subdirectory: 'a\\b' },
    { subdirectory: 'a\u0000b' },
    { subdirectory: 'a/b/c/d/e/f/g/h/i' },
    { unknown: true },
  ])('rejects noncanonical or unsafe input %j', (change) => {
    expect(githubPluginSourceSchema.safeParse({ ...source, ...change }).success).toBe(false);
  });
});

describe('GitHub acquisition transport and payload', () => {
  it('binds a private callback directory to the full commit and removes it before resolving', async () => {
    const directory = await scratch();
    const { fetcher, calls } = transport([file('index.js', 'export default 1;', '100755')]);
    let payload = '';
    const result = await createGithubPluginAcquirer({ directory, fetch: fetcher }).withSource(
      source,
      async (downloaded) => {
        payload = downloaded;
        expect(await fs.readFile(path.join(downloaded, 'index.js'), 'utf8')).toBe(
          'export default 1;',
        );
        expect((await fs.stat(downloaded)).mode & 0o777).toBe(0o700);
        expect((await fs.stat(path.join(downloaded, 'index.js'))).mode & 0o111).toBe(0);
        return 'reviewed';
      },
    );
    expect(result).toBe('reviewed');
    await expect(fs.stat(payload)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await fs.readdir(directory)).toEqual([]);
    expect(calls.map((call) => call.url)).toEqual([
      `https://api.github.com/repos/acme/plugins/git/commits/${commit}`,
      `https://api.github.com/repos/acme/plugins/git/trees/${treeSha}?recursive=1`,
      `https://raw.githubusercontent.com/acme/plugins/${commit}/index.js`,
    ]);
    for (const { init } of calls) {
      expect(init).toMatchObject({ redirect: 'error', credentials: 'omit' });
      expect(new Headers(init?.headers).has('authorization')).toBe(false);
    }
  });
  it('traverses subdirectories through nonrecursive trees and encodes raw path segments', async () => {
    const directory = await scratch();
    const nested = 'c'.repeat(40);
    const calls: string[] = [];
    const fetcher: typeof fetch = async (input) => {
      const url = String(input);
      calls.push(url);
      if (url.endsWith(`/git/commits/${commit}`))
        return json({ sha: commit, tree: { sha: treeSha } });
      if (url.endsWith(`/git/trees/${treeSha}`))
        return json(tree([{ path: 'bundles', mode: '040000', type: 'tree', sha: nested }]));
      if (url.endsWith(`/git/trees/${nested}?recursive=1`))
        return json(tree([file('a #%.js')], nested));
      return new Response('export default 1;');
    };
    await createGithubPluginAcquirer({ directory, fetch: fetcher }).withSource(
      { ...source, subdirectory: 'bundles' },
      async (payload) => {
        expect(await fs.readFile(path.join(payload, 'a #%.js'), 'utf8')).toBe('export default 1;');
      },
    );
    expect(calls).toEqual([
      `https://api.github.com/repos/acme/plugins/git/commits/${commit}`,
      `https://api.github.com/repos/acme/plugins/git/trees/${treeSha}`,
      `https://api.github.com/repos/acme/plugins/git/trees/${nested}?recursive=1`,
      `https://raw.githubusercontent.com/acme/plugins/${commit}/bundles/a%20%23%25.js`,
    ]);
  });
  it.each([
    [403, 'plugin-github-rate-limited'],
    [429, 'plugin-github-rate-limited'],
    [404, 'plugin-github-unavailable'],
    [500, 'plugin-github-unavailable'],
    [302, 'plugin-github-invalid'],
  ] as const)('classifies HTTP %i without exposing its body', async (status, code) => {
    const directory = await scratch();
    const fetcher: typeof fetch = async () => new Response('private response body', { status });
    const result = createGithubPluginAcquirer({ directory, fetch: fetcher }).withSource(
      source,
      async () => undefined,
    );
    await expectCode(result, code);
    await expect(result).rejects.not.toHaveProperty('message', expect.stringContaining('private'));
    expect(await fs.readdir(directory)).toEqual([]);
  });
  it.each([
    { sha: 'c'.repeat(40), tree: { sha: treeSha } },
    { sha: commit },
    { sha: commit, tree: { sha: 'main' } },
    { tree: [] },
  ])('requires an actual consistent commit object: %j', async (metadata) => {
    const directory = await scratch();
    const fetcher: typeof fetch = async () => json(metadata);
    await expectCode(
      createGithubPluginAcquirer({ directory, fetch: fetcher }).withSource(
        source,
        async () => undefined,
      ),
    );
  });
  it.each([
    [file('../escape')],
    [file('/absolute')],
    [file('a\\b')],
    [file('a//b')],
    [file('a/./b')],
    [file('a\u0000b')],
    [file('CON.txt')],
    [file('x:ads')],
    [file('trailing.')],
    [file('trailing ')],
    [file('a\ud800b')],
    [file('link', '', '120000')],
    [file('module', '', '160000')],
    [file('a'), file('a')],
    [file('A'), file('a')],
    [file('caf\u00e9'), file('cafe\u0301')],
    [file('a'), file('a/b')],
    [{ path: 'a', mode: '040000', type: 'blob', sha: treeSha }],
  ])(
    'rejects unsafe paths, modes and portable collisions before raw requests: %j',
    async (...entries) => {
      const directory = await scratch();
      const { fetcher, calls } = transport(entries);
      await expectCode(
        createGithubPluginAcquirer({ directory, fetch: fetcher }).withSource(
          source,
          async () => undefined,
        ),
      );
      expect(calls.every(({ url }) => url.startsWith('https://api.github.com/'))).toBe(true);
    },
  );
  it.each([
    { sha: treeSha, tree: [], truncated: true },
    { sha: 'c'.repeat(40), tree: [], truncated: false },
    { sha: treeSha, tree: [{ ...file('x'), size: -1 }], truncated: false },
  ])('rejects truncated or inconsistent tree data %j', async (metadata) => {
    const directory = await scratch();
    let request = 0;
    const fetcher: typeof fetch = async () =>
      ++request === 1 ? json({ sha: commit, tree: { sha: treeSha } }) : json(metadata);
    await expectCode(
      createGithubPluginAcquirer({ directory, fetch: fetcher }).withSource(
        source,
        async () => undefined,
      ),
    );
  });
  it('rejects recursive files whose ancestor trees are missing before writes', async () => {
    const directory = await scratch();
    const { fetcher, calls } = transport([file('missing/child.js')]);
    await expectCode(
      createGithubPluginAcquirer({ directory, fetch: fetcher }).withSource(
        source,
        async () => undefined,
      ),
    );
    expect(calls).toHaveLength(2);
    expect(await fs.readdir(directory)).toEqual([]);
  });
  it('accepts declared nested trees independent of their response ordering', async () => {
    const directory = await scratch();
    const { fetcher } = transport([
      file('nested/index.js'),
      {
        path: 'nested',
        mode: '040000',
        type: 'tree',
        sha: 'c'.repeat(40),
        url: 'https://untrusted.invalid/ignored',
      },
    ]);
    await createGithubPluginAcquirer({ directory, fetch: fetcher }).withSource(
      source,
      async (payload) => {
        expect(await fs.readFile(path.join(payload, 'nested/index.js'), 'utf8')).toBe(
          'export default 1;',
        );
      },
    );
  });
  it.each([
    [[file('x', 'expected')], { x: 'wrong!!!' }],
    [[file('x', 'expected')], { x: 'short' }],
    [[file('x', '')], { x: 'longer' }],
  ] as const)('verifies actual raw size and Git blob SHA-1', async (entries, contents) => {
    const directory = await scratch();
    const { fetcher } = transport([...entries], contents);
    await expectCode(
      createGithubPluginAcquirer({ directory, fetch: fetcher }).withSource(
        source,
        async () => undefined,
      ),
    );
    expect(await fs.readdir(directory)).toEqual([]);
  });
  it.each(['', 'export default 1;', 'export default 1;'.repeat(4096)])(
    'accepts gzip responses whose wire length differs from their decoded Git blob size',
    async (text) => {
      const directory = await scratch();
      const compressed = gzipSync(text);
      const server = createServer((_request, response) => {
        response.writeHead(200, {
          'content-encoding': 'gzip',
          'content-length': compressed.length,
        });
        response.end(compressed);
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      try {
        const address = server.address();
        if (address === null || typeof address === 'string') throw new Error('Missing test port');
        const base = transport([file('index.js', text)]);
        const fetcher: typeof fetch = (input, init) =>
          String(input).startsWith('https://api.github.com/')
            ? base.fetcher(input, init)
            : fetch(`http://127.0.0.1:${address.port}/index.js`, init);
        await createGithubPluginAcquirer({ directory, fetch: fetcher }).withSource(
          source,
          async (payload) => {
            expect(await fs.readFile(path.join(payload, 'index.js'), 'utf8')).toBe(text);
          },
        );
        expect(await fs.readdir(directory)).toEqual([]);
      } finally {
        await new Promise<void>((resolve, reject) => {
          server.close((error) => (error === undefined ? resolve() : reject(error)));
          server.closeAllConnections();
        });
      }
    },
  );
  it.each([undefined, 'identity'])(
    'rejects an incorrect uncompressed content-length with encoding %s',
    async (encoding) => {
      const directory = await scratch();
      const base = transport();
      const fetcher: typeof fetch = (input, init) => {
        if (String(input).startsWith('https://api.github.com/')) return base.fetcher(input, init);
        return Promise.resolve(
          new Response('export default 1;', {
            headers: {
              'content-length': '1',
              ...(encoding === undefined ? {} : { 'content-encoding': encoding }),
            },
          }),
        );
      };
      await expectCode(
        createGithubPluginAcquirer({ directory, fetch: fetcher }).withSource(
          source,
          async () => undefined,
        ),
      );
      expect(await fs.readdir(directory)).toEqual([]);
    },
  );
  it.each([
    Array.from({ length: 129 }, (_, i) => file(`file-${i}`)),
    [{ ...file('huge'), size: 20 * 1024 * 1024 + 1 }],
    [file(Array.from({ length: 65 }, () => 'a').join('/'))],
    Array.from({ length: 2001 }, (_, i) => ({
      path: `dir-${i}`,
      mode: '040000',
      type: 'tree',
      sha: treeSha,
    })),
  ])('enforces declared acquisition limits before downloads', async (...entries) => {
    const directory = await scratch();
    const { fetcher } = transport(entries);
    await expectCode(
      createGithubPluginAcquirer({ directory, fetch: fetcher }).withSource(
        source,
        async () => undefined,
      ),
      'plugin-github-too-large',
    );
  });
  it('bounds actual streamed metadata independently of content-length', async () => {
    const directory = await scratch();
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(1024 * 1024));
      },
      cancel() {
        cancelled = true;
      },
    });
    const fetcher: typeof fetch = async () =>
      new Response(body, { headers: { 'content-length': '1' } });
    await expectCode(
      createGithubPluginAcquirer({ directory, fetch: fetcher }).withSource(
        source,
        async () => undefined,
      ),
      'plugin-github-too-large',
    );
    expect(cancelled).toBe(true);
  });
  it.each([403, 302, 200])(
    'cancels unused HTTP %i response bodies on rejection',
    async (status) => {
      const directory = await scratch();
      let cancelled = false;
      const body = new ReadableStream<Uint8Array>({
        cancel() {
          cancelled = true;
        },
      });
      const fetcher: typeof fetch = async () =>
        new Response(body, { status, headers: { 'content-length': String(3 * 1024 * 1024) } });
      await expect(
        createGithubPluginAcquirer({ directory, fetch: fetcher }).withSource(
          source,
          async () => undefined,
        ),
      ).rejects.toThrow();
      expect(cancelled).toBe(true);
    },
  );
  it('limits selected payload files rather than unrelated parent-tree files', async () => {
    const directory = await scratch();
    const nested = 'c'.repeat(40);
    const fetcher: typeof fetch = async (input) => {
      const url = String(input);
      if (url.endsWith(`/git/commits/${commit}`))
        return json({ sha: commit, tree: { sha: treeSha } });
      if (url.endsWith(`/git/trees/${treeSha}`))
        return json(
          tree([
            ...Array.from({ length: 129 }, (_, i) => file(`unrelated-${i}`)),
            { path: 'selected', mode: '040000', type: 'tree', sha: nested },
          ]),
        );
      if (url.endsWith(`/git/trees/${nested}?recursive=1`))
        return json(tree([file('index.js')], nested));
      return new Response('export default 1;');
    };
    await createGithubPluginAcquirer({ directory, fetch: fetcher }).withSource(
      { ...source, subdirectory: 'selected' },
      async (payload) => {
        expect(await fs.readdir(payload)).toEqual(['index.js']);
      },
    );
  });
});

describe('GitHub scratch lifetime', () => {
  it('serializes callbacks, recovers UUID directories and cleans callback failure', async () => {
    const directory = await scratch();
    const abandoned = path.join(directory, randomUUID());
    await fs.mkdir(path.join(abandoned, 'nested'), { recursive: true });
    await fs.writeFile(path.join(abandoned, 'nested', 'old'), 'abandoned');
    const { fetcher } = transport();
    const acquirer = createGithubPluginAcquirer({ directory, fetch: fetcher });
    const events: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = acquirer.withSource(source, async () => {
      events.push('first');
      await expect(fs.stat(abandoned)).rejects.toMatchObject({ code: 'ENOENT' });
      await gate;
      throw new Error('callback failed');
    });
    const rejected = expect(first).rejects.toThrow('callback failed');
    const second = acquirer.withSource(source, async () => {
      events.push('second');
    });
    await vi.waitFor(() => expect(events).toEqual(['first']));
    release();
    await rejected;
    await second;
    expect(events).toEqual(['first', 'second']);
    expect(await fs.readdir(directory)).toEqual([]);
  });
  it.each([
    'unexpected-file',
    'unexpected-directory',
    'symlink-root',
    'symlink-operation',
    'symlink-child',
  ])('fails closed for %s during scratch recovery', async (kind) => {
    const directory = await scratch();
    const outside = path.join(path.dirname(directory), 'outside');
    await fs.mkdir(outside);
    await fs.writeFile(path.join(outside, 'keep'), 'safe');
    if (kind === 'symlink-root') await fs.symlink(outside, directory);
    else {
      await fs.mkdir(directory);
      if (kind === 'unexpected-file')
        await fs.writeFile(path.join(directory, 'unexpected'), 'keep');
      if (kind === 'unexpected-directory') await fs.mkdir(path.join(directory, 'unexpected'));
      if (kind === 'symlink-operation')
        await fs.symlink(outside, path.join(directory, randomUUID()));
      if (kind === 'symlink-child') {
        const operation = path.join(directory, randomUUID());
        await fs.mkdir(operation);
        await fs.symlink(outside, path.join(operation, 'link'));
      }
    }
    const { fetcher, calls } = transport();
    await expect(
      createGithubPluginAcquirer({ directory, fetch: fetcher }).withSource(
        source,
        async () => undefined,
      ),
    ).rejects.toThrow();
    expect(calls).toEqual([]);
    expect(await fs.readFile(path.join(outside, 'keep'), 'utf8')).toBe('safe');
  });
  it('retains cleanup failure alongside a primary callback error', async () => {
    const directory = await scratch();
    const { fetcher } = transport();
    const primary = new Error('primary callback error');
    const result = createGithubPluginAcquirer({ directory, fetch: fetcher }).withSource(
      source,
      async (payload) => {
        await fs.symlink(path.dirname(directory), path.join(payload, 'unexpected-link'));
        throw primary;
      },
    );
    await expect(result).rejects.toBeInstanceOf(AggregateError);
    await expect(result).rejects.toMatchObject({ errors: [primary, expect.any(Error)] });
  });
  it('cancels active requests and drains their four workers before cleanup', async () => {
    const directory = await scratch();
    const base = transport(Array.from({ length: 8 }, (_, i) => file(`file-${i}`)));
    const caller = new AbortController();
    let active = 0;
    let maxActive = 0;
    let started = 0;
    const fetcher: typeof fetch = async (input, init) => {
      if (String(input).startsWith('https://api.github.com/')) return base.fetcher(input, init);
      active += 1;
      started += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise<void>((resolve) =>
        init?.signal?.addEventListener(
          'abort',
          () => {
            setTimeout(resolve, 10);
          },
          { once: true },
        ),
      );
      expect((await fs.readdir(directory)).length).toBe(1);
      active -= 1;
      throw init?.signal?.reason;
    };
    const result = createGithubPluginAcquirer({ directory, fetch: fetcher }).withSource(
      source,
      async () => undefined,
      caller.signal,
    );
    const reason = new Error('caller closed');
    const failed = expect(result).rejects.toBe(reason);
    await vi.waitFor(() => expect(started).toBe(4));
    caller.abort(reason);
    await failed;
    expect(active).toBe(0);
    expect(maxActive).toBe(4);
    expect(started).toBe(4);
    expect(await fs.readdir(directory)).toEqual([]);
  });
  it('aborts sibling file workers on a blob failure and awaits their drain before cleanup', async () => {
    const directory = await scratch();
    const base = transport(Array.from({ length: 8 }, (_, i) => file(`file-${i}`)));
    let started = 0;
    let drained = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fetcher: typeof fetch = async (input, init) => {
      if (String(input).startsWith('https://api.github.com/')) return base.fetcher(input, init);
      started += 1;
      if (String(input).endsWith('/file-0')) {
        await gate;
        return new Response('wrong blob bytes!');
      }
      await new Promise<void>((resolve) =>
        init?.signal?.addEventListener(
          'abort',
          () => {
            setTimeout(resolve, 10);
          },
          { once: true },
        ),
      );
      expect((await fs.readdir(directory)).length).toBe(1);
      drained += 1;
      throw init?.signal?.reason;
    };
    const result = createGithubPluginAcquirer({ directory, fetch: fetcher }).withSource(
      source,
      async () => undefined,
    );
    const failed = expectCode(result);
    await vi.waitFor(() => expect(started).toBe(4));
    release();
    await failed;
    expect(started).toBe(4);
    expect(drained).toBe(3);
    expect(await fs.readdir(directory)).toEqual([]);
  });
  it('does not admit already cancelled queued acquisitions', async () => {
    const directory = await scratch();
    const base = transport();
    const acquirer = createGithubPluginAcquirer({ directory, fetch: base.fetcher });
    let finish!: () => void;
    let inCallback = false;
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const first = acquirer.withSource(source, async () => {
      inCallback = true;
      await gate;
    });
    await vi.waitFor(() => expect(inCallback).toBe(true));
    const caller = new AbortController();
    const reason = new Error('queued cancelled');
    caller.abort(reason);
    const second = acquirer.withSource(
      source,
      async () => {
        throw new Error('must not run');
      },
      caller.signal,
    );
    const failed = expect(second).rejects.toBe(reason);
    finish();
    await first;
    await failed;
    expect(base.calls).toHaveLength(3);
    expect(await fs.readdir(directory)).toEqual([]);
  });
  it('times out and cancels a stalled metadata body independently of fetch headers', async () => {
    vi.useFakeTimers();
    const directory = await scratch();
    let cancelled = false;
    let requested = false;
    const fetcher: typeof fetch = async () => {
      requested = true;
      return new Response(
        new ReadableStream<Uint8Array>({
          cancel() {
            cancelled = true;
          },
        }),
      );
    };
    const result = createGithubPluginAcquirer({ directory, fetch: fetcher }).withSource(
      source,
      async () => undefined,
    );
    const failed = expectCode(result, 'plugin-github-timeout');
    await vi.waitFor(() => expect(requested).toBe(true));
    await vi.advanceTimersByTimeAsync(15_000);
    await failed;
    expect(cancelled).toBe(true);
    expect(await fs.readdir(directory)).toEqual([]);
  });
  it('times out a stalled request after 15 seconds and aborts its signal', async () => {
    vi.useFakeTimers();
    const directory = await scratch();
    let requestSignal: AbortSignal | undefined;
    const fetcher: typeof fetch = async (_input, init) => {
      requestSignal = init?.signal ?? undefined;
      return new Promise((_resolve, reject) =>
        requestSignal?.addEventListener('abort', () => reject(requestSignal?.reason), {
          once: true,
        }),
      );
    };
    const result = createGithubPluginAcquirer({ directory, fetch: fetcher }).withSource(
      source,
      async () => undefined,
    );
    const failed = expectCode(result, 'plugin-github-timeout');
    await vi.waitFor(() => expect(requestSignal).toBeDefined());
    await vi.advanceTimersByTimeAsync(15_000);
    await failed;
    expect(requestSignal?.aborted).toBe(true);
    expect(await fs.readdir(directory)).toEqual([]);
  });
  it('aborts the callback at the total deadline and waits for settlement before cleanup', async () => {
    vi.useFakeTimers();
    const directory = await scratch();
    const { fetcher } = transport();
    let callbackSignal: AbortSignal | undefined;
    let payload = '';
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const result = createGithubPluginAcquirer({ directory, fetch: fetcher }).withSource(
      source,
      async (downloaded, signal) => {
        payload = downloaded;
        callbackSignal = signal;
        await gate;
        expect(await fs.readFile(path.join(downloaded, 'index.js'), 'utf8')).toBe(
          'export default 1;',
        );
      },
    );
    const failed = expectCode(result, 'plugin-github-timeout');
    await vi.waitFor(() => expect(callbackSignal).toBeDefined());
    await vi.advanceTimersByTimeAsync(60_000);
    expect(callbackSignal?.aborted).toBe(true);
    expect((await fs.stat(payload)).isDirectory()).toBe(true);
    finish();
    await failed;
    expect(await fs.readdir(directory)).toEqual([]);
  });
  it('does not return successful review data if its deadline expires during cleanup', async () => {
    vi.useFakeTimers();
    const directory = await scratch();
    const { fetcher } = transport();
    const remove = fs.rmdir.bind(fs);
    let cleanupStarted = false;
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    vi.spyOn(fs, 'rmdir').mockImplementation(async (target) => {
      cleanupStarted = true;
      await gate;
      return remove(target);
    });
    const result = createGithubPluginAcquirer({ directory, fetch: fetcher }).withSource(
      source,
      async () => 'reviewed',
    );
    const failed = expectCode(result, 'plugin-github-timeout');
    await vi.waitFor(() => expect(cleanupStarted).toBe(true));
    await vi.advanceTimersByTimeAsync(60_000);
    finish();
    await failed;
    expect(await fs.readdir(directory)).toEqual([]);
  });
});
