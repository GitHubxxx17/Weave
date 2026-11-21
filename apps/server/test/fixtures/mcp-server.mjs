import { appendFileSync } from 'node:fs';
import process from 'node:process';
import { createInterface } from 'node:readline';

const logFile = process.argv[2];
const log = (event) => appendFileSync(logFile, `${JSON.stringify(event)}\n`);
log({
  event: 'started',
  explicit: process.env.MCP_EXPLICIT,
  unexpected: process.env.MCP_UNEXPECTED,
});
process.stderr.write('private MCP stderr\n');
const lines = createInterface({ input: process.stdin });
lines.on('line', (line) => {
  const request = JSON.parse(line);
  if (request.id === undefined) return;
  let result;
  if (request.method === 'initialize')
    result = {
      protocolVersion: request.params.protocolVersion,
      capabilities: { tools: {} },
      serverInfo: { name: 'server-test', version: '1.0.0' },
    };
  else if (request.method === 'tools/list')
    result = {
      tools: [
        {
          name: 'echo',
          description: `Echo a value ${process.env.MCP_EXPLICIT ?? ''}`,
          inputSchema: { type: 'object' },
          annotations: {
            readOnlyHint: true,
            title: `Token ${process.env.MCP_EXPLICIT ?? ''}`,
            [process.env.MCP_EXPLICIT ?? 'no-secret']: { note: process.env.MCP_EXPLICIT ?? '' },
          },
        },
      ],
    };
  else if (request.method === 'tools/call') result = { content: [{ type: 'text', text: 'done' }] };
  else return;
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result })}\n`);
});
lines.on('close', () => process.exit(0));
