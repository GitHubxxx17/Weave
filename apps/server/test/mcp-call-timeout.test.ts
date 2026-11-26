import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { connectMcp, type McpConnection } from '@weave/mcp-client';
import { afterEach, describe, expect, it } from 'vitest';

const fixture = fileURLToPath(new URL('./fixtures/mcp-studio-server.mjs', import.meta.url));
const directories: string[] = [];
const connections: McpConnection[] = [];

afterEach(async () => {
  await Promise.all(connections.splice(0).map((connection) => connection.close()));
  await Promise.all(directories.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function connect(callTimeoutMs?: number): Promise<McpConnection> {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'weave-mcp-timeout-')));
  directories.push(directory);
  const connection = await connectMcp({
    command: process.execPath,
    args: [fixture, join(directory, 'log.jsonl')],
    cwd: directory,
    env: {},
    signal: new AbortController().signal,
    ...(callTimeoutMs === undefined ? {} : { callTimeoutMs }),
  });
  connections.push(connection);
  return connection;
}

describe('MCP call timeout', () => {
  it('stops a slow tool call after the configured timeout', async () => {
    const connection = await connect(1000);
    const started = Date.now();
    await expect(
      connection.callTool('wait', {}, { signal: new AbortController().signal }),
    ).rejects.toMatchObject({ code: 'mcp-timeout' });
    const elapsed = Date.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(900);
    expect(elapsed).toBeLessThan(10_000);
    // The connection stays usable after a timed-out call.
    await expect(
      connection.callTool('echo', {}, { signal: new AbortController().signal }),
    ).resolves.toMatchObject({ content: [{ type: 'text', text: 'fixture completed' }] });
  });

  it('rejects an out-of-range timeout when connecting', async () => {
    await expect(connect(999)).rejects.toMatchObject({ code: 'mcp-connect-failed' });
    await expect(connect(600_001)).rejects.toMatchObject({ code: 'mcp-connect-failed' });
  });
});
