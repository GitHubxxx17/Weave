import { describe, expect, it, vi } from 'vitest';
import {
  createPluginKernel,
  createPluginSdk,
  definePlugin,
  toolsExtensionPoint,
} from '@weave/plugin';
import {
  createApprovalBroker,
  createToolPipeline,
  createToolRegistry,
  type ToolPermissionMode,
} from '@weave/runtime';
import { createWebModule } from '../../../plugins/official/weave-web-source/src/tools.js';
import type {
  HttpRequestInput,
  SearchConfiguration,
  WebHttpClient,
} from '../../../plugins/official/weave-web-source/src/types.js';

const ready = {
  status: 'ready',
  value: { provider: 'tavily', apiKey: 'test-own-secret-key' },
} as const;
async function fixture(
  configuration: SearchConfiguration = ready,
  handler?: WebHttpClient['request'],
) {
  const http = {
    request: vi.fn(
      handler ??
        (async () => ({
          status: 200,
          headers: { 'content-type': 'text/plain; charset=utf-8' },
          bytes: Buffer.from('public body'),
        })),
    ),
  };
  const kernel = createPluginKernel();
  const sdk = createPluginSdk();
  const module = createWebModule(sdk, {
    configuration,
    http,
    now: () => new Date('2026-11-23T00:00:00Z'),
  });
  await kernel.register(
    definePlugin({
      manifest: {
        id: 'weave-web',
        name: 'Weave 联网',
        version: '0.1.0',
        apiVersion: '1.0.0',
        capabilities: ['tool'],
        contributes: { tools: ['web_search', 'web_fetch'] },
        permissions: ['network:request'],
      },
      setup: (env) => module.setup(env),
    }),
  );
  await kernel.seal();
  const registry = createToolRegistry();
  kernel.extensions.collect(toolsExtensionPoint, { addTool: (tool) => registry.register(tool) });
  const broker = createApprovalBroker();
  const pipeline = createToolPipeline({ registry, approvalBroker: broker });
  return { kernel, http, registry, broker, pipeline };
}
const fetchArgs = { url: 'https://example.com/docs', maxChars: 6000 };
function request(name = 'web_fetch', args: unknown = fetchArgs, mode: ToolPermissionMode = 'ask') {
  return {
    name,
    toolCallId: 'call-1',
    sessionId: 'session-1',
    turnId: 'turn-1',
    arguments: JSON.stringify(args),
    permissionMode: mode,
  };
}

describe('official web tools through governed SDK and shared Pipeline', () => {
  it.each(['ask', 'trust'] as const)(
    'requires %s approval before any HTTP for read-only fetch',
    async (mode) => {
      const f = await fixture();
      try {
        expect(f.http.request).not.toHaveBeenCalled();
        const pending = f.pipeline.execute(request('web_fetch', fetchArgs, mode));
        await vi.waitFor(() => expect(f.broker.list()).toHaveLength(1));
        expect(f.http.request).not.toHaveBeenCalled();
        expect(f.broker.list()[0]).toMatchObject({
          toolName: 'web_fetch',
          operation: 'web.fetch',
          risk: 'high',
          inputSummary: { url: fetchArgs.url, host: 'example.com', maxChars: 6000 },
        });
        expect(f.registry.get('web_fetch')?.readOnly).toBe(true);
        f.broker.approve(f.broker.list()[0]!.approvalId);
        const result = await pending;
        expect(result.truncated).toBe(false);
        expect(JSON.parse(result.content)).toMatchObject({
          kind: 'web-fetch',
          text: 'public body',
          source: { url: fetchArgs.url },
          retrievedAt: '2026-11-23T00:00:00.000Z',
        });
        expect(f.http.request).toHaveBeenCalledTimes(1);
        expect(f.http.request.mock.calls[0]![0]).toMatchObject({
          method: 'GET',
          headers: { 'Accept-Encoding': 'identity' },
        });
        expect(JSON.stringify(f.http.request.mock.calls[0]![0].headers)).not.toContain(
          ready.value.apiKey,
        );
      } finally {
        await f.kernel.dispose();
      }
    },
  );

  it.each(['reject', 'cancel', 'expire'] as const)(
    'never sends HTTP after approval %s',
    async (action) => {
      const f = await fixture();
      try {
        const pending = f.pipeline.execute(request()).catch((error: unknown) => error);
        await vi.waitFor(() => expect(f.broker.list()).toHaveLength(1));
        f.broker[action](f.broker.list()[0]!.approvalId);
        expect(await pending).toMatchObject({
          code:
            action === 'reject'
              ? 'tool-approval-rejected'
              : action === 'expire'
                ? 'tool-approval-expired'
                : 'tool-approval-cancelled',
        });
        expect(f.http.request).not.toHaveBeenCalled();
      } finally {
        await f.kernel.dispose();
      }
    },
  );

  it('fails closed without a broker, honors policy tightening in yolo, and permits ordinary yolo', async () => {
    const f = await fixture();
    try {
      await expect(
        createToolPipeline({ registry: f.registry }).execute(request()),
      ).rejects.toMatchObject({ code: 'tool-approval-required' });
      await expect(
        createToolPipeline({ registry: f.registry, policy: () => 'deny' }).execute(
          request('web_fetch', fetchArgs, 'yolo'),
        ),
      ).rejects.toMatchObject({ code: 'tool-denied' });
      expect(f.http.request).not.toHaveBeenCalled();
      const pending = createToolPipeline({
        registry: f.registry,
        approvalBroker: f.broker,
        policy: () => 'ask',
      }).execute(request('web_fetch', fetchArgs, 'yolo'));
      await vi.waitFor(() => expect(f.broker.list()).toHaveLength(1));
      expect(f.http.request).not.toHaveBeenCalled();
      f.broker.approve(f.broker.list()[0]!.approvalId);
      await pending;
      await f.pipeline.execute(request('web_fetch', fetchArgs, 'yolo'));
      expect(f.http.request).toHaveBeenCalledTimes(2);
    } finally {
      await f.kernel.dispose();
    }
  });

  it.each(['ask', 'yolo'] as const)(
    'rejects semantic URL/config safely before HTTP in %s',
    async (mode) => {
      const f = await fixture({ status: 'unconfigured' });
      try {
        await expect(
          f.pipeline.execute(request('web_fetch', { url: 'https://127.0.0.1/' }, mode)),
        ).rejects.toMatchObject({
          code: 'tool-execution-failed',
          cause: { code: 'web-url-blocked' },
        });
        await expect(
          f.pipeline.execute(request('web_search', { query: 'public query' }, mode)),
        ).rejects.toMatchObject({
          code: 'tool-execution-failed',
          cause: { code: 'web-search-not-configured' },
        });
        expect(f.http.request).not.toHaveBeenCalled();
        expect(f.broker.list()).toHaveLength(0);
        await f.pipeline.execute(request('web_fetch', fetchArgs, 'yolo'));
        expect(f.http.request).toHaveBeenCalledTimes(1);
      } finally {
        await f.kernel.dispose();
      }
    },
  );

  it('shows exact search query and sends only after approval', async () => {
    const f = await fixture(ready, async () => ({
      status: 200,
      headers: { 'content-type': 'application/json' },
      bytes: Buffer.from(
        JSON.stringify({
          results: [{ title: 'Official', url: 'https://example.com/source', content: 'evidence' }],
        }),
      ),
    }));
    try {
      const pending = f.pipeline.execute(
        request('web_search', { query: 'exact public query', maxResults: 1 }),
      );
      await vi.waitFor(() => expect(f.broker.list()).toHaveLength(1));
      expect(f.http.request).not.toHaveBeenCalled();
      expect(f.broker.list()[0]).toMatchObject({
        operation: 'web.search',
        inputSummary: {
          query: 'exact public query',
          provider: 'tavily',
          destination: 'https://api.tavily.com/search',
          maxResults: 1,
        },
      });
      f.broker.approve(f.broker.list()[0]!.approvalId);
      const result = await pending;
      expect(result.truncated).toBe(false);
      expect(JSON.parse(result.content)).toMatchObject({
        kind: 'web-search',
        sources: [{ url: 'https://example.com/source' }],
      });
    } finally {
      await f.kernel.dispose();
    }
  });

  it('follows only validated same-origin redirects, preserves sources and bounds hops', async () => {
    const f = await fixture(ready, async (input) =>
      input.url.pathname === '/docs'
        ? { status: 302, headers: { location: '/final' }, bytes: new Uint8Array() }
        : {
            status: 200,
            headers: { 'content-type': 'text/html' },
            bytes: Buffer.from('<title>Title</title><script>bad()</script><p>Body</p>'),
          },
    );
    try {
      const result = await f.pipeline.execute(request('web_fetch', fetchArgs, 'yolo'));
      expect(JSON.parse(result.content)).toMatchObject({
        source: { url: 'https://example.com/final', requestedUrl: fetchArgs.url, title: 'Title' },
        text: 'Body',
      });
      expect(f.http.request).toHaveBeenCalledTimes(2);
      f.http.request.mockImplementation(async () => ({
        status: 302,
        headers: { location: 'https://another.example/target' },
        bytes: new Uint8Array(),
      }));
      await expect(
        f.pipeline.execute(request('web_fetch', fetchArgs, 'yolo')),
      ).rejects.toMatchObject({ cause: { code: 'web-redirect-blocked' } });
      expect(f.http.request).toHaveBeenCalledTimes(3);
      let count = 0;
      f.http.request.mockImplementation(async () => ({
        status: 302,
        headers: { location: `/next-${++count}` },
        bytes: new Uint8Array(),
      }));
      await expect(
        f.pipeline.execute(request('web_fetch', fetchArgs, 'yolo')),
      ).rejects.toMatchObject({ cause: { code: 'web-redirect-blocked' } });
      expect(count).toBe(4);
    } finally {
      await f.kernel.dispose();
    }
  });

  it.each([
    'https://@example.com/next',
    '/some\\thing',
    ' /next',
    'https://example.com/next\n',
    'https:@example.com/next',
  ])('refuses raw redirect spelling before URL normalization: %j', async (location) => {
    const f = await fixture(ready, async () => ({
      status: 302,
      headers: { location },
      bytes: new Uint8Array(),
    }));
    try {
      await expect(
        f.pipeline.execute(request('web_fetch', fetchArgs, 'yolo')),
      ).rejects.toMatchObject({ cause: { code: 'web-redirect-blocked' } });
      expect(f.http.request).toHaveBeenCalledTimes(1);
    } finally {
      await f.kernel.dispose();
    }
  });

  it.each([
    { 'content-type': 'application/pdf' },
    { 'content-type': 'text/plain; charset=latin1' },
    { 'content-type': 'text/plain; charset="utf-8"garbage' },
    { 'content-type': 'text/plain; charset=utf-8; charset' },
    { 'content-type': 'text/plain', 'content-disposition': 'attachment; filename=page.txt' },
    { 'content-type': 'text/plain', 'content-disposition': 'attachment ; filename=page.txt' },
    { 'content-type': 'text/plain', 'content-disposition': 'attachment\t;filename=page.txt' },
    {},
  ])('refuses unsupported page interpretation %j', async (headers) => {
    const f = await fixture(ready, async () => ({
      status: 200,
      headers,
      bytes: Buffer.from('not parsed'),
    }));
    try {
      await expect(
        f.pipeline.execute(request('web_fetch', fetchArgs, 'yolo')),
      ).rejects.toMatchObject({ cause: { code: 'web-content-unsupported' } });
    } finally {
      await f.kernel.dispose();
    }
  });

  it('rejects invalid UTF-8 and secret-bearing URLs without rewriting citations', async () => {
    const f = await fixture(ready, async () => ({
      status: 200,
      headers: { 'content-type': 'text/plain' },
      bytes: Uint8Array.of(0xff),
    }));
    try {
      await expect(
        f.pipeline.execute(request('web_fetch', fetchArgs, 'yolo')),
      ).rejects.toMatchObject({ cause: { code: 'web-content-unsupported' } });
      await expect(
        f.pipeline.execute(
          request('web_fetch', { url: `https://example.com/${ready.value.apiKey}` }, 'yolo'),
        ),
      ).rejects.toMatchObject({ cause: { code: 'web-url-blocked' } });
      expect(f.http.request).toHaveBeenCalledTimes(1);
    } finally {
      await f.kernel.dispose();
    }
  });

  it.each(['https://SECRET12.example.com/', 'https://%53%45%43%52%45%54%31%32.example.com/'])(
    'rejects a raw secret before URL hostname normalization: %s',
    async (url) => {
      const f = await fixture({
        status: 'ready',
        value: { provider: 'tavily', apiKey: 'SECRET12' },
      });
      try {
        for (const mode of ['yolo', 'ask'] as const) {
          await expect(
            f.pipeline.execute(request('web_fetch', { url }, mode)),
          ).rejects.toMatchObject({
            code: 'tool-execution-failed',
            cause: { code: 'web-url-blocked' },
          });
        }
        expect(f.http.request).not.toHaveBeenCalled();
        expect(f.broker.list()).toHaveLength(0);
      } finally {
        await f.kernel.dispose();
      }
    },
  );

  it('cancels active HTTP, maps internal deadline and hides native errors', async () => {
    const seen: AbortSignal[] = [];
    const f = await fixture(ready, async (input: HttpRequestInput) => {
      seen.push(input.signal);
      return new Promise((_resolve, reject) =>
        input.signal.addEventListener('abort', () => reject(new Error('native private secret')), {
          once: true,
        }),
      );
    });
    try {
      const controller = new AbortController();
      const pending = f.pipeline
        .execute({ ...request('web_fetch', fetchArgs, 'yolo'), signal: controller.signal })
        .catch((error: unknown) => error);
      await vi.waitFor(() => expect(seen).toHaveLength(1));
      controller.abort(new Error('user cause should not escape'));
      expect(await pending).toMatchObject({ code: 'tool-cancelled' });
      expect(seen[0]!.aborted).toBe(true);
      vi.useFakeTimers();
      const timed = f.pipeline
        .execute(request('web_fetch', fetchArgs, 'yolo'))
        .catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(20_000);
      expect(await timed).toMatchObject({
        code: 'tool-execution-failed',
        cause: { code: 'web-timeout' },
      });
    } finally {
      vi.useRealTimers();
      await f.kernel.dispose();
    }
    const native = await fixture(ready, async () => {
      throw new Error('native private secret');
    });
    try {
      const failure: unknown = await native.pipeline
        .execute(request('web_fetch', fetchArgs, 'yolo'))
        .catch((error: unknown) => error);
      expect(failure).toMatchObject({ cause: { code: 'web-network-failed' } });
      expect(JSON.stringify(failure)).not.toContain('native private secret');
    } finally {
      await native.kernel.dispose();
    }
  });
});
