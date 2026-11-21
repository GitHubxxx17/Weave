import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import process from 'node:process';
import { createInterface } from 'node:readline';
import { fileURLToPath, URL } from 'node:url';

const [scenario, pidFile] = process.argv.slice(2);
let descendant;
if (scenario === 'inherited' || scenario === 'pending') {
  descendant = spawn(
    process.execPath,
    [fileURLToPath(new URL('./close-descendant.mjs', import.meta.url))],
    { stdio: 'inherit' },
  );
  descendant.unref();
}
writeFileSync(pidFile, JSON.stringify({ servicePid: process.pid, descendantPid: descendant?.pid }));

const lines = createInterface({ input: process.stdin });
lines.on('line', (line) => {
  const message = JSON.parse(line);
  if (message.method === 'initialize') {
    process.stdout.write(
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: message.id,
        result: {
          protocolVersion:
            scenario === 'invalid-initialize'
              ? 'unsupported-version'
              : message.params.protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: 'weave-close-fixture', version: '1.0.0' },
        },
      })}\n`,
    );
  }
});
process.stdin.on('end', () => process.exit(0));
