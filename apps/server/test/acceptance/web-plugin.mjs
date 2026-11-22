/* global fetch, AbortSignal, TextDecoder */
// Build CLI and Server first. This exercises the shipped ESM and its real loader;
// successful public HTTP/provider requests belong to the separate adapter tests.
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { execFile } from 'node:child_process';
import console from 'node:console';
import { createHash, randomUUID } from 'node:crypto';
import { channel } from 'node:diagnostics_channel';
import { cp, mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { fileURLToPath, URL } from 'node:url';
import { promisify } from 'node:util';
import { startServer } from '../../dist/main.js';
import { getServerSessionStore } from '../../dist/runtime.js';

const execute = promisify(execFile);
const repository = fileURLToPath(new URL('../../../../', import.meta.url));
const bin = join(repository, 'packages/plugin-cli/dist/cli.js');
const authorSource = join(repository, 'plugins/official/weave-web-source');
const committedPayload = join(repository, 'plugins/official/weave-web');
const expectedTools = ['web_fetch', 'web_search'];
const webEnvironment = ['WEAVE_WEB_SEARCH_PROVIDER', 'WEAVE_WEB_TAVILY_API_KEY'];
const headers = { 'Content-Type': 'application/json' };
const network = { nativeRequests: 0, externalFetches: 0 };
const nativeChannel = channel('http.client.request.start');
const fetchChannel = channel('undici:request:create');
const observeNative = () => network.nativeRequests++;
const observeFetch = ({ request }) => {
  const hostname = new URL(request.origin).hostname;
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(hostname)) network.externalFetches++;
};
let server;
let base;
let sessionId;
let expectedVisible = false;
let modelRequests = 0;
let modelToolResults = 0;
let sequence = 0;

async function files(directory, prefix = '') {
  const names = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const name = prefix + entry.name;
    if (entry.isDirectory()) names.push(...(await files(join(directory, entry.name), name + '/')));
    else {
      assert.ok(entry.isFile(), `Payload entry must be a regular file: ${name}`);
      names.push(name);
    }
  }
  return names.sort();
}

async function samePayload(actual, expected) {
  const names = await files(actual);
  assert.deepEqual(names, await files(expected), 'The committed payload file set is reproducible');
  for (const name of names) {
    const rebuilt = await readFile(join(actual, name));
    const committed = await readFile(join(expected, name));
    assert.ok(
      rebuilt.equals(committed),
      `The committed payload bytes differ from CLI build: ${name} (rebuilt sha256=${createHash('sha256').update(rebuilt).digest('hex')}, committed sha256=${createHash('sha256').update(committed).digest('hex')})`,
    );
  }
}

async function cli(...args) {
  const { stdout, stderr } = await execute(process.execPath, [bin, ...args, '--json'], {
    cwd: repository,
    timeout: 90_000,
    maxBuffer: 2 * 1024 * 1024,
  });
  if (stderr) assert.match(stderr, /ExperimentalWarning: SQLite/);
  return JSON.parse(stdout);
}

async function boundedText(response, maxBytes = 512 * 1024) {
  assert.ok(response.body, 'HTTP response has a body');
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      assert.ok(size <= maxBytes, 'Acceptance response exceeded its byte budget');
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
}

async function request(path, body, status = 200) {
  const response = await fetch(base + path, {
    ...(body === undefined ? {} : { method: 'POST', headers, body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(20_000),
  });
  const text = await boundedText(response);
  assert.equal(response.status, status, `Unexpected HTTP status for ${path}: ${text}`);
  return JSON.parse(text);
}

function assertNoExternalRequests() {
  assert.deepEqual(network, { nativeRequests: 0, externalFetches: 0 });
}

async function launch(root, initial = false) {
  server = await startServer(0, {
    databaseFile: join(root, 'weave.sqlite'),
    pluginsDirectory: join(root, 'plugins'),
    skillsDirectory: false,
    pluginMarketplaceCatalogFile: false,
    environment: {},
    ...(initial ? { managedPluginStore: { initialBinding: 'allow-unbound' } } : {}),
  });
  base = `http://127.0.0.1:${server.port}`;
  const registry = server.runtime.serverHost.hostProviderRegistry;
  const mock = registry.get('mock');
  assert.ok(mock, 'The production composition registers its local MockProvider');
  registry.register({
    id: 'web-acceptance',
    label: 'Web acceptance MockProvider',
    type: 'mock',
    client: {
      async *stream(input, options) {
        modelRequests++;
        assert.deepEqual(
          (input.tools ?? [])
            .map((tool) => tool.name)
            .filter((name) => expectedTools.includes(name))
            .sort(),
          expectedVisible ? expectedTools : [],
          'The next Turn receives exactly the active web tool names',
        );
        const userIndex = input.messages.findLastIndex((message) => message.role === 'user');
        const results = input.messages
          .slice(userIndex + 1)
          .filter((message) => message.role === 'tool');
        if (results.length > 0) {
          assert.equal(
            results.length,
            2,
            'The next model request receives both durable tool results',
          );
          modelToolResults += results.length;
          const content = JSON.stringify(results);
          if (expectedVisible) {
            assert.match(content, /web-url-blocked/);
            assert.match(content, /web-search-not-configured/);
          } else assert.match(content, /tool-not-found/);
        }
        yield* mock.stream(input, options);
      },
    },
  });
}

async function close() {
  if (server !== undefined) {
    const current = server;
    server = undefined;
    await current.stop();
  }
}

async function activate(candidate) {
  const catalog = await request('/plugins/managed');
  const row = catalog.plugins.find((plugin) => plugin.pluginId === 'weave-web');
  assert.ok(row);
  const result = await request('/plugins/managed/weave-web/activate', {
    requestId: `activate-${++sequence}`,
    digest: candidate.digest,
    manifest: candidate.manifest,
    previousSelection: row.selection?.digest ?? null,
    intent: 'activate',
    expectedInstallSequence: catalog.heads.installSequence,
    expectedTrustSequence: catalog.heads.trustSequence,
  });
  assert.equal(result.application.status, 'applied');
  assert.equal(result.application.active.digest, candidate.digest);
  expectedVisible = true;
}

async function select(kind) {
  const catalog = await request('/plugins/managed');
  const row = catalog.plugins.find((plugin) => plugin.pluginId === 'weave-web');
  assert.ok(row?.selection);
  const result = await request(`/plugins/managed/weave-web/${kind}`, {
    requestId: `${kind}-${++sequence}`,
    selectedDigest: row.selection.digest,
    expectedInstallSequence: catalog.heads.installSequence,
    expectedTrustSequence: catalog.heads.trustSequence,
    immediate: false,
  });
  assert.equal(result.application.status, 'applied');
  assert.equal(result.application.active, null);
  if (kind === 'disable') assert.equal(result.decision.trust.enabled, false);
  else assert.equal(result.decision.trust, null);
  expectedVisible = false;
}

async function run() {
  const path = `/sessions/${sessionId}/executions`;
  const accepted = await request(
    path,
    {
      requestId: randomUUID(),
      input: {
        provider: 'web-acceptance',
        model: 'fixture',
        permissionMode: 'ask',
        userMessage: {
          role: 'user',
          content: [
            {
              type: 'text',
              text: '/tool web_fetch {"url":"https://127.0.0.1/private"}\n/tool web_search {"query":"deterministic installed web acceptance"}',
            },
          ],
        },
      },
    },
    202,
  );
  assert.equal(typeof accepted.executionId, 'string');
  const response = await fetch(
    `${base}${path}/${accepted.executionId}/events?after=${encodeURIComponent(accepted.cursor)}`,
    { signal: AbortSignal.timeout(20_000) },
  );
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /text\/event-stream/);
  const frames = (await boundedText(response))
    .split(/\r?\n\r?\n/)
    .filter((frame) => frame.split(/\r?\n/).some((line) => line.startsWith('data: ')))
    .map((frame) =>
      JSON.parse(
        frame
          .split(/\r?\n/)
          .find((line) => line.startsWith('data: '))
          .slice(6),
      ),
    );
  assert.ok(
    frames.some((frame) => frame.type === 'snapshot'),
    'The detachable SSE begins with a snapshot',
  );
  const terminal = await request(`${path}/${accepted.executionId}`);
  assert.equal(terminal.status, 'completed', JSON.stringify(terminal.error));
  const durable = await getServerSessionStore(server.runtime).read(sessionId);
  const results = durable
    .filter(
      (event) => event.type === 'tool-result.created' && event.payload.turnId === accepted.turnId,
    )
    .map((event) => event.payload);
  assert.deepEqual(results.map((result) => result.name).sort(), expectedTools);
  for (const result of results) {
    assert.equal(
      result.status,
      'failed',
      'The safe local failure is a recoverable Pipeline tool result',
    );
    assert.equal(result.truncated, false);
    if (expectedVisible) {
      assert.equal(result.errorCode, 'tool-execution-failed');
      assert.match(
        result.content,
        new RegExp(result.name === 'web_fetch' ? 'web-url-blocked' : 'web-search-not-configured'),
      );
    } else {
      assert.equal(result.errorCode, 'tool-not-found');
      assert.match(result.content, /tool-not-found/);
    }
  }
  assertNoExternalRequests();
  return durable;
}

// A missing release is a real failure, never silently generated by verification.
try {
  assert.ok(
    (await files(committedPayload)).includes('index.mjs'),
    'The committed web payload contains index.mjs',
  );
} catch (cause) {
  throw new Error(
    'Committed weave-web payload is missing; build and commit the actual CLI payload first.',
    { cause },
  );
}
const root = await mkdtemp(join(tmpdir(), 'weave-web-delivery-'));
const savedEnvironment = webEnvironment.map((name) => [name, process.env[name]]);
try {
  for (const name of webEnvironment) delete process.env[name];
  nativeChannel.subscribe(observeNative);
  fetchChannel.subscribe(observeFetch);
  await mkdir(join(root, 'plugins'));
  await cli('validate', '--source', authorSource);
  const built = await cli('build', '--source', authorSource, '--out', join(root, 'build'));
  await cli('validate', '--artifact', built.payloadDirectory);
  await samePayload(built.payloadDirectory, committedPayload);
  const packed = await cli(
    'pack',
    '--artifact',
    built.payloadDirectory,
    '--out',
    join(root, 'release'),
  );
  await samePayload(packed.payloadDirectory, committedPayload);
  const importedSource = join(root, 'copied-local-import-source');
  await cp(packed.payloadDirectory, importedSource, { recursive: true });
  await launch(root, true);
  const preview = await request('/plugins/managed/preview', { sourceDirectory: importedSource });
  assert.equal(preview.candidate.digest, packed.receipt.digest);
  assert.deepEqual([...preview.candidate.manifest.contributes.tools].sort(), expectedTools);
  const importBody = {
    requestId: 'import-web',
    previewId: preview.previewId,
    expectedInstallSequence: preview.expectedInstallSequence,
  };
  const imported = await request('/plugins/managed/import', importBody);
  assert.equal(imported.application.status, 'not-required');
  const inert = (await request('/plugins/managed')).plugins.find(
    (plugin) => plugin.pluginId === 'weave-web',
  );
  assert.ok(inert);
  assert.equal(inert.selection, null);
  assert.equal(inert.trust, null);
  assert.equal(inert.active, null);
  assertNoExternalRequests();
  const project = await request(
    '/projects',
    { name: 'Installed web acceptance', folderName: 'web-acceptance' },
    201,
  );
  const session = await request(
    `/projects/${project.id}/sessions`,
    { title: 'Web lifecycle' },
    201,
  );
  sessionId = session.id;
  assert.equal(typeof sessionId, 'string');
  await run();
  await activate(preview.candidate);
  const history = await run();
  const httpHistory = await request(`/sessions/${sessionId}`);
  assert.match(JSON.stringify(httpHistory), /web-url-blocked/);
  assert.match(JSON.stringify(httpHistory), /web-search-not-configured/);
  await close();
  // Only the disposable import source is deleted. The repository is never removed or edited.
  await rm(importedSource, { recursive: true });
  await assert.rejects(readFile(join(importedSource, 'index.mjs')), { code: 'ENOENT' });
  await launch(root);
  assert.deepEqual(await getServerSessionStore(server.runtime).read(sessionId), history);
  assert.deepEqual(await request(`/sessions/${sessionId}`), httpHistory);
  await run();
  const replay = await request('/plugins/managed/import', importBody);
  assert.equal(replay.kind, 'replayed', 'Offline import retry uses the durable receipt');
  await select('disable');
  await run();
  await activate(preview.candidate);
  await run();
  await select('revoke');
  await run();
  assertNoExternalRequests();
  assert.equal(modelRequests, 12);
  assert.equal(modelToolResults, 12);
  console.log(
    JSON.stringify({
      passed: true,
      cli: 'actual source validate/build/artifact validate/pack',
      payload: 'exact committed file names and bytes',
      transport: 'real loopback HTTP 202 acceptance and detachable SSE',
      persistence: 'SQLite restart after deleting only copied local import source',
      assertions: [
        'import remains inert until separate exact-digest activation',
        'model-visible web tool names follow the active Generation',
        'installed production tools fail locally through shared Pipeline',
        'private URL and unconfigured search errors reach next model request and Session',
        'durable offline import receipt replay',
        'disable and revoke remove both tools from the next Turn',
        'no native HTTP requests or external fetches',
      ],
      modelRequests,
      modelToolResults,
      liveProviderValidation: false,
    }),
  );
} finally {
  try {
    await close();
  } finally {
    nativeChannel.unsubscribe(observeNative);
    fetchChannel.unsubscribe(observeFetch);
    for (const [name, value] of savedEnvironment) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await rm(root, { recursive: true, force: true });
  }
}
