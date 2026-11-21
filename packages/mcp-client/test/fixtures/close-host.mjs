import { createRequire } from 'node:module';
import { performance } from 'node:perf_hooks';
import process from 'node:process';
import { setImmediate } from 'node:timers/promises';
import { fileURLToPath, URL } from 'node:url';

const [distribution, scenario, pidFile] = process.argv.slice(2);
const require = createRequire(import.meta.url);
const { Client } =
  distribution === 'cjs'
    ? require('@modelcontextprotocol/client')
    : await import('@modelcontextprotocol/client');
const { StdioClientTransport } =
  distribution === 'cjs'
    ? require('@modelcontextprotocol/client/stdio')
    : await import('@modelcontextprotocol/client/stdio');
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [fileURLToPath(new URL('./close-server.mjs', import.meta.url)), scenario, pidFile],
  stderr: 'pipe',
});
transport.stderr.resume();
const client = new Client(
  { name: 'weave-close-host', version: '1.0.0' },
  { capabilities: {}, versionNegotiation: { mode: 'legacy' } },
);
let closeCount = 0;
let pendingSettled = scenario !== 'pending';
let initializeFailed = false;
client.onclose = () => {
  closeCount += 1;
};
try {
  await client.connect(transport);
} catch {
  initializeFailed = true;
}
if (scenario === 'pending') {
  void client.request({ method: 'tools/list' }).then(
    () => {
      pendingSettled = true;
    },
    () => {
      pendingSettled = true;
    },
  );
}
const started = performance.now();
await client.close();
await transport.close();
await transport.close();
await setImmediate();
process.stdout.write(
  `${JSON.stringify({
    closeCount,
    pendingSettled,
    initializeFailed,
    stderrDestroyed: transport.stderr.destroyed,
    closeMs: performance.now() - started,
  })}\n`,
);
