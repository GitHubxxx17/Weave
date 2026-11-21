import { appendFileSync } from 'node:fs';
import process from 'node:process';
import { createInterface } from 'node:readline';
import { setInterval, setTimeout } from 'node:timers';

const [mode = 'normal', logFile, ...literalArgs] = process.argv.slice(2);
const log = (entry) => {
  if (logFile) appendFileSync(logFile, `${JSON.stringify(entry)}\n`);
};
const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const reply = (id, result) => send({ jsonrpc: '2.0', id, result });
const echo = {
  name: 'echo',
  description: 'Echo an integer',
  inputSchema: {
    type: 'object',
    properties: { x: { type: 'integer' }, action: { type: 'string' } },
    required: ['x'],
    additionalProperties: false,
  },
  outputSchema: {
    type: 'object',
    properties: { x: { type: 'integer' } },
    required: ['x'],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true },
};
const inspect = { name: 'inspect', inputSchema: { type: 'object' } };
let listCount = 0;
let callCount = 0;
log({ event: 'start', pid: process.pid, args: literalArgs, cwd: process.cwd() });
process.stderr.write('fixture private stderr\n');

const lines = createInterface({ input: process.stdin });
lines.on('line', (line) => {
  const message = JSON.parse(line);
  log(message);
  if (message.method === 'initialize') {
    if (mode === 'hang-initialize') return;
    if (mode === 'exit-initialize') process.exit(1);
    reply(message.id, {
      protocolVersion: message.params.protocolVersion,
      capabilities: mode === 'no-tools' ? {} : { tools: { listChanged: true } },
      serverInfo: { name: 'weave-test', version: '1.0.0' },
    });
  } else if (message.method === 'tools/list') {
    listCount++;
    if (mode === 'hang-list') return;
    if (mode === 'invalid-list') return reply(message.id, { tools: 'secret invalid catalog' });
    if (mode === 'cursor-loop') return reply(message.id, { tools: [], nextCursor: '' });
    if (mode === 'too-many-pages') {
      return reply(message.id, { tools: [], nextCursor: String(listCount) });
    }
    if (mode === 'too-many-tools') {
      return reply(message.id, {
        tools: Array.from({ length: 65 }, (_, index) => ({ ...inspect, name: `tool-${index}` })),
      });
    }
    if (mode === 'long-name')
      return reply(message.id, { tools: [{ ...echo, name: '界'.repeat(86) }] });
    if (mode === 'long-description') {
      return reply(message.id, { tools: [{ ...echo, description: 'x'.repeat(4097) }] });
    }
    if (mode === 'large-schema') {
      return reply(message.id, {
        tools: [{ ...echo, inputSchema: { type: 'object', description: 'x'.repeat(65536) } }],
      });
    }
    if (mode === 'large-catalog') {
      return reply(message.id, {
        tools: Array.from({ length: 10 }, (_, index) => ({
          ...inspect,
          name: `tool-${index}`,
          inputSchema: { type: 'object', default: { text: 'x'.repeat(54000) } },
        })),
      });
    }
    if (mode === 'unsupported-schema') {
      return reply(message.id, {
        tools: [{ ...echo, inputSchema: { type: 'object', patternProperties: {} } }],
      });
    }
    if (mode === 'duplicate-name') return reply(message.id, { tools: [echo, echo] });
    if (mode === 'stdout-overflow') return process.stdout.write('x'.repeat(2097153));
    if (mode === 'stale-prepare') {
      send({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' });
    }
    if (message.params?.cursor === undefined) {
      reply(message.id, { tools: [echo], nextCursor: '' });
    } else {
      reply(message.id, { tools: [inspect] });
    }
  } else if (message.method === 'tools/call') {
    callCount++;
    const args = message.params.arguments ?? {};
    if (args.action === 'exit') return process.exit(0);
    if (args.action === 'hang') return;
    if (args.action === 'progress') {
      return setInterval(
        () =>
          send({
            jsonrpc: '2.0',
            method: 'notifications/progress',
            params: { progressToken: message.id, progress: 1 },
          }),
        10,
      );
    }
    if (args.action === 'host-requests') {
      for (const [index, method] of [
        'sampling/createMessage',
        'elicitation/create',
        'roots/list',
      ].entries()) {
        send({ jsonrpc: '2.0', id: `host-${index}`, method, params: {} });
      }
    }
    if (args.action === 'input-required') {
      return reply(message.id, {
        resultType: 'input_required',
        inputRequests: [{ id: 'sample', method: 'sampling/createMessage', params: {} }],
        requestState: 'private state',
      });
    }
    if (args.action === 'deep-output') {
      return process.stdout.write(
        `{"jsonrpc":"2.0","id":${JSON.stringify(message.id)},"result":{"content":[],"structuredContent":{"nested":${'['.repeat(6000)}0${']'.repeat(6000)}}}}\n`,
      );
    }
    if (args.action === 'null-output')
      return reply(message.id, { content: [], structuredContent: null });
    if (args.action === 'rpc-error') {
      return send({
        jsonrpc: '2.0',
        id: message.id,
        error: { code: -32603, message: 'private failure with credentials' },
      });
    }
    if (args.action === 'stale')
      send({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' });
    if (args.action === 'invalid-result')
      return reply(message.id, { content: [{ type: 'unknown', secret: 'value' }] });
    if (args.action === 'large-result')
      return reply(message.id, { content: [{ type: 'text', text: 'x'.repeat(1048576) }] });
    if (args.action === 'bad-output')
      return reply(message.id, { content: [], structuredContent: { x: 'wrong' } });
    if (args.action === 'missing-output') return reply(message.id, { content: [] });
    if (args.action === 'error-result')
      return reply(message.id, {
        content: [{ type: 'text', text: 'tool error' }],
        structuredContent: { error: true },
        isError: true,
      });
    const result =
      message.params.name === 'inspect'
        ? {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  args: literalArgs,
                  cwd: process.cwd(),
                  explicit: process.env.MCP_EXPLICIT,
                  unexpected: process.env.MCP_UNEXPECTED,
                  path: process.env.PATH,
                  specialEnvironment: Object.fromEntries(
                    ['__proto__', 'constructor', 'toString', '_123'].flatMap((name) =>
                      Object.hasOwn(process.env, name) ? [[name, process.env[name]]] : [],
                    ),
                  ),
                  listCount,
                  callCount,
                }),
              },
            ],
          }
        : { content: [{ type: 'text', text: String(args.x) }], structuredContent: { x: args.x } };
    if (args.action === 'late') return setTimeout(() => reply(message.id, result), 150);
    if (args.action === 'delay') return setTimeout(() => reply(message.id, result), 400);
    reply(message.id, result);
  }
});
lines.on('close', () => process.exit(0));
