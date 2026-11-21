import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { connectMcp } from '../src/stdio-connection.js';
import { McpClientError } from '../src/errors.js';
import type { ConnectMcpOptions, McpConnection } from '../src/types.js';

const fixture = fileURLToPath(new URL('./fixtures/server.mjs', import.meta.url));
const signal = () => new AbortController().signal;
let directory: string;
let logFile: string;
const connections: McpConnection[] = [];

beforeEach(async () => {
  directory = await realpath(await mkdtemp(join(tmpdir(), 'weave-mcp-')));
  logFile = join(directory, 'messages.jsonl');
});

afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  await Promise.all(connections.splice(0).map((connection) => connection.close()));
  await rm(directory, { recursive: true, force: true });
});

async function connect(mode = 'normal', overrides: Partial<ConnectMcpOptions> = {}) {
  const connection = await connectMcp({
    command: process.execPath,
    args: [fixture, mode, logFile],
    cwd: directory,
    env: {},
    signal: signal(),
    ...overrides,
  });
  connections.push(connection);
  return connection;
}

async function records(): Promise<Record<string, unknown>[]> {
  const text = await readFile(logFile, 'utf8');
  return text
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe('MCP stdio connection', () => {
  it('initializes once, pages an empty-string cursor and freezes a copied catalog', async () => {
    const connection = await connect();
    expect(connection.tools.map((tool) => tool.name)).toEqual(['echo', 'inspect']);
    expect(connection.tools[1]?.description).toBe('');
    expect(Object.isFrozen(connection.tools)).toBe(true);
    expect(Object.isFrozen(connection.tools[0]?.inputSchema)).toBe(true);
    expect(Object.isFrozen(connection.tools[0]?.inputSchema.properties)).toBe(true);
    expect(Object.isFrozen(connection.tools[0]?.annotations)).toBe(true);
    const messages = await records();
    expect(messages.filter((item) => item.event === 'start')).toHaveLength(1);
    expect(messages.filter((item) => item.method === 'tools/list')).toHaveLength(2);
    const initialize = messages.find((item) => item.method === 'initialize');
    expect(initialize?.params).toMatchObject({ capabilities: {} });
    expect(messages.some((item) => item.method === 'server/discover')).toBe(false);
    expect(await connection.callTool('echo', { x: 3 }, { signal: signal() })).toEqual({
      content: [{ type: 'text', text: '3' }],
      structuredContent: { x: 3 },
    });
  });

  it('validates all arguments without mutation and never sends invalid calls', async () => {
    const connection = await connect();
    const input = { x: '3', extra: true };
    expect(connection.validateInput('echo', input).valid).toBe(false);
    expect(connection.validateInput('missing', {}).valid).toBe(false);
    await expect(connection.callTool('echo', input, { signal: signal() })).rejects.toMatchObject({
      code: 'mcp-invalid-input',
    });
    await expect(connection.callTool('missing', {}, { signal: signal() })).rejects.toMatchObject({
      code: 'mcp-invalid-input',
    });
    expect(input).toEqual({ x: '3', extra: true });
    expect((await records()).filter((item) => item.method === 'tools/call')).toHaveLength(0);
  });

  it('rejects Proxy inputs before serialization can change the validated values', async () => {
    const connection = await connect();
    const input = new Proxy(
      { x: 1 },
      {
        get(target, property, receiver) {
          return property === 'x'
            ? 'invalid after validation'
            : Reflect.get(target, property, receiver);
        },
      },
    );
    await expect(connection.callTool('echo', input, { signal: signal() })).rejects.toMatchObject({
      code: 'mcp-invalid-input',
    });
    expect((await records()).filter((item) => item.method === 'tools/call')).toHaveLength(0);
  });

  it('rejects nested Proxy inputs before sending any tool call', async () => {
    const connection = await connect();
    const nested = new Proxy(
      { x: 1 },
      {
        get(target, property, receiver) {
          return property === 'x'
            ? 'changed nested value'
            : Reflect.get(target, property, receiver);
        },
      },
    );
    await expect(
      connection.callTool('inspect', { nested }, { signal: signal() }),
    ).rejects.toMatchObject({ code: 'mcp-invalid-input' });
    expect((await records()).filter((item) => item.method === 'tools/call')).toHaveLength(0);
  });

  it('passes literal argv and only explicit plus SDK-whitelisted environment', async () => {
    vi.stubEnv('MCP_UNEXPECTED', 'private host variable');
    const literals = ['$(touch surprise)', '*', '; echo unsafe', 'with spaces'];
    const connection = await connect('normal', {
      args: [fixture, 'normal', logFile, ...literals],
      env: { MCP_EXPLICIT: 'provided', PATH: '/explicit-path' },
    });
    const result = await connection.callTool('inspect', {}, { signal: signal() });
    const details = JSON.parse(result.content[0]?.text as string) as Record<string, unknown>;
    expect(details).toMatchObject({
      args: literals,
      cwd: directory,
      explicit: 'provided',
      path: '/explicit-path',
      listCount: 2,
    });
    expect(details.unexpected).toBeUndefined();
    expect(connection.stderrBytes).toBeGreaterThanOrEqual(
      Buffer.byteLength('fixture private stderr\n'),
    );
  });

  it('marks preparation and later changes stale without refreshing the frozen catalog', async () => {
    const onStale = vi.fn();
    const connection = await connect('stale-prepare', { onStale });
    expect(onStale).toHaveBeenCalled();
    const tools = connection.tools;
    await connection.callTool('echo', { x: 1, action: 'stale' }, { signal: signal() });
    expect(onStale).toHaveBeenCalledTimes(3);
    expect(connection.tools).toBe(tools);
    expect((await records()).filter((item) => item.method === 'tools/list')).toHaveLength(2);
  });

  it('rejects a fifth in-flight call immediately without queuing it', async () => {
    const connection = await connect();
    const pending = Array.from({ length: 4 }, () =>
      connection.callTool('echo', { x: 1, action: 'delay' }, { signal: signal() }),
    );
    await expect(connection.callTool('echo', { x: 2 }, { signal: signal() })).rejects.toMatchObject(
      { code: 'mcp-busy' },
    );
    await Promise.all(pending);
    expect((await records()).filter((item) => item.method === 'tools/call')).toHaveLength(4);
  });

  it('cancels promptly, sends cancellation and ignores a late reply without closing or replaying', async () => {
    const onClosed = vi.fn();
    const connection = await connect('normal', { onClosed });
    const controller = new AbortController();
    const pending = connection.callTool(
      'echo',
      { x: 1, action: 'late' },
      { signal: controller.signal },
    );
    await vi.waitFor(async () =>
      expect((await records()).some((item) => item.method === 'tools/call')).toBe(true),
    );
    controller.abort('private cancel reason');
    await expect(pending).rejects.toMatchObject({ code: 'mcp-cancelled' });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(onClosed).not.toHaveBeenCalled();
    expect(await connection.callTool('echo', { x: 2 }, { signal: signal() })).toMatchObject({
      structuredContent: { x: 2 },
    });
    const messages = await records();
    expect(messages.filter((item) => item.method === 'tools/call')).toHaveLength(2);
    expect(messages.filter((item) => item.method === 'notifications/cancelled')).toHaveLength(1);
  });

  it('does not send a call with an already-aborted signal', async () => {
    const connection = await connect();
    const controller = new AbortController();
    controller.abort();
    await expect(
      connection.callTool('echo', { x: 1 }, { signal: controller.signal }),
    ).rejects.toMatchObject({ code: 'mcp-cancelled' });
    expect((await records()).filter((item) => item.method === 'tools/call')).toHaveLength(0);
  });

  it('uses a fixed cancellation reason even when the caller supplies an MCP error', async () => {
    const connection = await connect();
    const controller = new AbortController();
    const pending = connection.callTool(
      'echo',
      { x: 1, action: 'hang' },
      { signal: controller.signal },
    );
    const rejected = expect(pending).rejects.toMatchObject({
      code: 'mcp-cancelled',
      message: 'The MCP operation was cancelled.',
    });
    await vi.waitFor(async () =>
      expect((await records()).some((item) => item.method === 'tools/call')).toBe(true),
    );
    const unsafeReason = new McpClientError('mcp-closed');
    unsafeReason.message = 'private caller reason';
    controller.abort(unsafeReason);
    await rejected;
    await vi.waitFor(async () =>
      expect((await records()).some((item) => item.method === 'notifications/cancelled')).toBe(
        true,
      ),
    );
    expect(JSON.stringify(await records())).not.toContain('private caller reason');
  });

  it('fails pending calls on EOF and does not restart or replay', async () => {
    const onClosed = vi.fn();
    const connection = await connect('normal', { onClosed });
    const pending = connection.callTool('echo', { x: 1, action: 'hang' }, { signal: signal() });
    const exited = connection.callTool('echo', { x: 1, action: 'exit' }, { signal: signal() });
    await expect(exited).rejects.toMatchObject({ code: 'mcp-closed' });
    await expect(pending).rejects.toMatchObject({ code: 'mcp-closed' });
    expect(onClosed).toHaveBeenCalledTimes(1);
    await expect(connection.callTool('echo', { x: 2 }, { signal: signal() })).rejects.toMatchObject(
      { code: 'mcp-closed' },
    );
    expect((await records()).filter((item) => item.event === 'start')).toHaveLength(1);
  });

  it('closes once, fails pending calls and refuses new calls', async () => {
    const onClosed = vi.fn();
    const connection = await connect('normal', { onClosed });
    const pending = connection.callTool('echo', { x: 1, action: 'hang' }, { signal: signal() });
    const rejected = expect(pending).rejects.toMatchObject({ code: 'mcp-closed' });
    await Promise.all([connection.close(), connection.close()]);
    await rejected;
    expect(onClosed).toHaveBeenCalledTimes(1);
    await expect(connection.callTool('echo', { x: 1 }, { signal: signal() })).rejects.toMatchObject(
      { code: 'mcp-closed' },
    );
  });

  it('closes the service once even when the closed observer throws', async () => {
    const onClosed = vi.fn(() => {
      throw new Error('private observer failure');
    });
    const connection = await connect('normal', { onClosed });
    const messages = await records();
    const pid = messages.find((item) => item.event === 'start')?.pid as number;
    const pending = connection.callTool('echo', { x: 1, action: 'hang' }, { signal: signal() });
    const rejected = expect(pending).rejects.toMatchObject({ code: 'mcp-closed' });
    await Promise.all([connection.close(), connection.close()]);
    await rejected;
    expect(onClosed).toHaveBeenCalledTimes(1);
    expect(() => process.kill(pid, 0)).toThrow();
  });

  it('keeps calls usable when a stale observer throws', async () => {
    const onStale = vi.fn(() => {
      throw new Error('private stale observer failure');
    });
    const connection = await connect('normal', { onStale });
    expect(
      await connection.callTool('echo', { x: 1, action: 'stale' }, { signal: signal() }),
    ).toMatchObject({ structuredContent: { x: 1 } });
    expect(onStale).toHaveBeenCalledTimes(1);
    expect(await connection.callTool('echo', { x: 2 }, { signal: signal() })).toMatchObject({
      structuredContent: { x: 2 },
    });
  });

  it.each(['bad-output', 'missing-output', 'invalid-result', 'large-result'])(
    'rejects %s with a safe result error',
    async (action) => {
      const connection = await connect();
      await expect(
        connection.callTool('echo', { x: 1, action }, { signal: signal() }),
      ).rejects.toMatchObject({ code: 'mcp-invalid-result' });
    },
  );

  it('preserves an isError result without applying the success output schema', async () => {
    const connection = await connect();
    expect(
      await connection.callTool('echo', { x: 1, action: 'error-result' }, { signal: signal() }),
    ).toMatchObject({ isError: true, structuredContent: { error: true } });
  });

  it('does not expose raw protocol errors', async () => {
    const connection = await connect();
    const error: unknown = await connection
      .callTool('echo', { x: 1, action: 'rpc-error' }, { signal: signal() })
      .catch((failure: unknown) => failure);
    expect(error).toMatchObject({ code: 'mcp-call-failed', message: 'The MCP tool call failed.' });
    expect((error as Error & { cause?: unknown }).cause).toBeUndefined();
  });

  it('rejects a scalar structured result incompatible with the negotiated legacy protocol', async () => {
    const connection = await connect();
    await expect(
      connection.callTool('inspect', { action: 'null-output' }, { signal: signal() }),
    ).rejects.toMatchObject({ code: 'mcp-invalid-result' });
  });

  it('preserves deep finite JSON results within the result byte budget', async () => {
    const connection = await connect();
    const result = await connection.callTool(
      'inspect',
      { action: 'deep-output' },
      { signal: signal() },
    );
    let value: unknown = (result.structuredContent as Record<string, unknown>).nested;
    for (let depth = 0; depth < 6000; depth++) {
      expect(Object.isFrozen(value)).toBe(true);
      value = (value as unknown[])[0];
    }
    expect(value).toBe(0);
  });

  it('does not fulfill host capability requests or replay input-required results', async () => {
    const connection = await connect();
    await connection.callTool('echo', { x: 1, action: 'host-requests' }, { signal: signal() });
    await vi.waitFor(async () =>
      expect(
        (await records()).filter(
          (item) => typeof item.id === 'string' && item.id.startsWith('host-'),
        ),
      ).toHaveLength(3),
    );
    for (const response of (await records()).filter(
      (item) => typeof item.id === 'string' && item.id.startsWith('host-'),
    )) {
      expect(response.error).toMatchObject({ code: -32601 });
    }
    await expect(
      connection.callTool('echo', { x: 1, action: 'input-required' }, { signal: signal() }),
    ).rejects.toMatchObject({ code: 'mcp-invalid-result' });
    expect((await records()).filter((item) => item.method === 'tools/call')).toHaveLength(2);
  });

  it('uses a total 120-second call deadline despite progress notifications', async () => {
    const connection = await connect();
    vi.useFakeTimers();
    let settled = false;
    const pending = connection.callTool('echo', { x: 1, action: 'progress' }, { signal: signal() });
    const rejected = expect(pending).rejects.toMatchObject({ code: 'mcp-timeout' });
    void pending.catch(() => {
      settled = true;
    });
    await delay(40);
    await vi.advanceTimersByTimeAsync(119999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await rejected;
    vi.useRealTimers();
    expect(await connection.callTool('echo', { x: 2 }, { signal: signal() })).toMatchObject({
      structuredContent: { x: 2 },
    });
    expect((await records()).filter((item) => item.method === 'tools/call')).toHaveLength(2);
  });

  it.each(['hang-initialize', 'hang-list'])(
    'uses the total preparation deadline for %s',
    async (mode) => {
      vi.useFakeTimers();
      const pending = connect(mode);
      const rejected = expect(pending).rejects.toMatchObject({ code: 'mcp-timeout' });
      await delay(80);
      await vi.advanceTimersByTimeAsync(15000);
      vi.useRealTimers();
      await rejected;
    },
  );

  it.each([undefined, {}, { signal: {} }])(
    'rejects invalid runtime call options safely',
    async (options) => {
      const connection = await connect();
      await expect(
        connection.callTool('echo', { x: 1 }, options as unknown as { signal: AbortSignal }),
      ).rejects.toMatchObject({ code: 'mcp-invalid-input' });
      expect((await records()).filter((item) => item.method === 'tools/call')).toHaveLength(0);
    },
  );

  it('maps a throwing call-option getter to a safe input error before sending', async () => {
    const connection = await connect();
    const options = Object.defineProperty({}, 'signal', {
      get() {
        throw new Error('private signal getter');
      },
    });
    const error: unknown = await connection
      .callTool('echo', { x: 1 }, options as { signal: AbortSignal })
      .catch((failure: unknown) => failure);
    expect(error).toMatchObject({
      code: 'mcp-invalid-input',
      message: 'MCP tool arguments do not match the declared schema.',
    });
    expect((error as Error & { cause?: unknown }).cause).toBeUndefined();
    expect((await records()).filter((item) => item.method === 'tools/call')).toHaveLength(0);
  });

  it.each([
    ['no-tools', 'mcp-connect-failed'],
    ['invalid-list', 'mcp-invalid-catalog'],
    ['duplicate-name', 'mcp-invalid-catalog'],
    ['cursor-loop', 'mcp-invalid-catalog'],
    ['too-many-pages', 'mcp-catalog-limit'],
    ['too-many-tools', 'mcp-catalog-limit'],
    ['long-name', 'mcp-catalog-limit'],
    ['long-description', 'mcp-catalog-limit'],
    ['large-schema', 'mcp-catalog-limit'],
    ['large-catalog', 'mcp-catalog-limit'],
    ['unsupported-schema', 'mcp-unsupported-schema'],
    ['stdout-overflow', 'mcp-connect-failed'],
    ['exit-initialize', 'mcp-connect-failed'],
  ])('rejects %s during preparation', async (mode, code) => {
    await expect(connect(mode)).rejects.toMatchObject({ code });
  });

  it.each(['hang-initialize', 'hang-list'])(
    'cancels %s without waiting for the total deadline',
    async (mode) => {
      const controller = new AbortController();
      const pending = connect(mode, { signal: controller.signal });
      const rejected = expect(pending).rejects.toMatchObject({ code: 'mcp-cancelled' });
      await vi.waitFor(async () =>
        expect(
          (await records()).some(
            (item) => item.method === (mode === 'hang-list' ? 'tools/list' : 'initialize'),
          ),
        ).toBe(true),
      );
      controller.abort();
      await rejected;
    },
  );

  it('does not start with an already-aborted preparation signal', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(connect('normal', { signal: controller.signal })).rejects.toMatchObject({
      code: 'mcp-cancelled',
    });
    await expect(readFile(logFile)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each([
    { args: 'private argument' },
    { env: { SECRET: 123 } },
    { signal: {} },
    { onStale: 'invalid callback' },
    { command: '' },
    { cwd: 123 },
  ])('rejects invalid resolved launch options before spawning', async (invalid) => {
    await expect(
      connect('normal', invalid as unknown as Partial<ConnectMcpOptions>),
    ).rejects.toMatchObject({ code: 'mcp-connect-failed' });
    await expect(readFile(logFile)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('maps a throwing launch-option getter to a safe connection error before spawning', async () => {
    const options: ConnectMcpOptions = {
      command: process.execPath,
      args: [fixture, 'normal', logFile],
      cwd: directory,
      env: {},
      signal: signal(),
    };
    Object.defineProperty(options, 'command', {
      get() {
        throw new Error('private launch getter');
      },
    });
    const error: unknown = await connectMcp(options).catch((failure: unknown) => failure);
    expect(error).toMatchObject({
      code: 'mcp-connect-failed',
      message: 'The MCP service could not be initialized.',
    });
    expect((error as Error & { cause?: unknown }).cause).toBeUndefined();
    await expect(readFile(logFile)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
