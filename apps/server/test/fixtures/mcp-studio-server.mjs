import { appendFileSync } from 'node:fs';
import { clearTimeout, setTimeout } from 'node:timers';
import process from 'node:process';
import { createInterface } from 'node:readline';

// Safe, deterministic stdio peer for real Studio/Desktop acceptance. It only
// appends lifecycle evidence to the explicitly supplied temporary log file.
const logFile = process.argv[2];
const log = (event) =>
  appendFileSync(logFile, `${JSON.stringify({ pid: process.pid, ...event })}\n`);
const send = (message) =>
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
const tools = ['echo', 'fail', 'mark_stale', 'wait'].map((name) => ({
  name,
  description: `Safe acceptance fixture: ${name}`,
  inputSchema: {
    type: 'object',
    properties: { value: { type: 'string' } },
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true },
}));
const pending = new Map();
log({ event: 'started' });
const lines = createInterface({ input: process.stdin });
lines.on('line', (line) => {
  const request = JSON.parse(line);
  if (request.method === 'notifications/cancelled') {
    const timer = pending.get(request.params.requestId);
    if (timer !== undefined) {
      clearTimeout(timer);
      pending.delete(request.params.requestId);
      log({ event: 'cancelled' });
    }
    return;
  }
  if (request.id === undefined) return;
  const reply = (result) => send({ id: request.id, result });
  if (request.method === 'initialize') {
    reply({
      protocolVersion: request.params.protocolVersion,
      capabilities: { tools: { listChanged: true } },
      serverInfo: { name: 'studio-acceptance', version: '1.0.0' },
    });
  } else if (request.method === 'tools/list') {
    reply({ tools });
  } else if (request.method === 'tools/call') {
    const name = request.params.name;
    log({ event: 'call', name, arguments: request.params.arguments });
    if (name === 'wait') {
      pending.set(
        request.id,
        setTimeout(() => {
          pending.delete(request.id);
          reply({ content: [{ type: 'text', text: 'wait completed' }] });
        }, 60_000),
      );
    } else {
      reply({
        content: [
          { type: 'text', text: name === 'fail' ? 'fixture failure' : 'fixture completed' },
        ],
        ...(name === 'fail' ? { isError: true } : {}),
      });
      if (name === 'mark_stale') send({ method: 'notifications/tools/list_changed' });
    }
  }
});
function stop() {
  for (const timer of pending.values()) clearTimeout(timer);
  log({ event: 'stopped' });
  process.exit(0);
}
lines.on('close', stop);
process.once('SIGTERM', stop);
process.once('SIGINT', stop);
