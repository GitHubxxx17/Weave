/* global fetch */
import process from 'node:process';
import console from 'node:console';
// Explicit acceptance runner: build CLI and Server before invoking. No live model or network dependency.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import { startServer } from '../../dist/main.js';
const execute = promisify(execFile);
const bin = fileURLToPath(new URL('../../../../packages/plugin-cli/dist/cli.js', import.meta.url));
const root = await mkdtemp(join(tmpdir(), 'weave-cli-code-http-'));
const plugins = join(root, 'plugins');
await mkdir(plugins);
const databaseFile = join(root, 'weave.sqlite');
let server,
  base,
  seq = 0,
  calls = 0;
async function cli(...args) {
  const { stdout, stderr } = await execute(process.execPath, [bin, ...args, '--json'], {
    cwd: root,
  });
  if (stderr) assert.match(stderr, /ExperimentalWarning: SQLite/);
  return JSON.parse(stdout);
}
const headers = { 'Content-Type': 'application/json' };
async function get(p) {
  const r = await fetch(base + p);
  assert.equal(r.status, 200, await r.clone().text());
  return r.json();
}
async function post(p, b) {
  const r = await fetch(base + p, { method: 'POST', headers, body: JSON.stringify(b) });
  assert.ok([200, 201].includes(r.status), await r.clone().text());
  return r.json();
}
async function launch(initial = false) {
  server = await startServer(0, {
    databaseFile,
    pluginsDirectory: plugins,
    skillsDirectory: false,
    environment: {},
    ...(initial ? { managedPluginStore: { initialBinding: 'allow-unbound' } } : {}),
  });
  base = 'http://127.0.0.1:' + server.port;
}
async function close() {
  if (server) {
    const current = server;
    server = undefined;
    await current.stop();
  }
}
async function activate(candidate) {
  const current = await get('/plugins/managed');
  const row = current.plugins.find((x) => x.pluginId === candidate.manifest.id);
  const result = await post('/plugins/managed/' + candidate.manifest.id + '/activate', {
    requestId: 'activate-' + ++seq,
    digest: candidate.digest,
    manifest: candidate.manifest,
    previousSelection: row.selection?.digest ?? null,
    intent: 'activate',
    expectedInstallSequence: current.heads.installSequence,
    expectedTrustSequence: current.heads.trustSequence,
  });
  assert.equal(result.application.status, 'applied');
}
async function prepare(template) {
  const id = 'cli-' + template;
  const source = join(root, id);
  await cli('create', '--template', template, '--id', id, '--directory', source);
  const sourceFile = join(source, 'src/index.ts');
  let code = await readFile(sourceFile, 'utf8');
  const marker = join(root, id + '-imported.txt');
  code =
    "import {writeFileSync} from 'node:fs';\nwriteFileSync(" +
    JSON.stringify(marker) +
    ",'imported');\n" +
    code;
  await writeFile(sourceFile, code);
  await cli('validate', '--source', source);
  const built = await cli('build', '--source', source, '--out', join(root, id + '-built'));
  const packed = await cli(
    'pack',
    '--artifact',
    built.payloadDirectory,
    '--out',
    join(root, id + '-release'),
  );
  await assert.rejects(readFile(marker), { code: 'ENOENT' });
  const preview = await post('/plugins/managed/preview', {
    sourceDirectory: packed.payloadDirectory,
  });
  assert.equal(preview.candidate.digest, packed.receipt.digest);
  const body = {
    requestId: 'import-' + ++seq,
    previewId: preview.previewId,
    expectedInstallSequence: preview.expectedInstallSequence,
  };
  const result = await post('/plugins/managed/import', body);
  assert.equal(result.application.status, 'not-required');
  await assert.rejects(readFile(marker), { code: 'ENOENT' });
  const inert = await get('/plugins/managed');
  assert.equal(inert.plugins.find((x) => x.pluginId === id).selection, null);
  await activate(preview.candidate);
  assert.equal(await readFile(marker, 'utf8'), 'imported');
  return { source, built, packed, body, candidate: preview.candidate };
}
async function prepareSkills() {
  const source = join(root, 'cli-skills');
  await cli('create', '--template', 'skills', '--id', 'cli-skills', '--directory', source);
  const built = await cli('build', '--source', source, '--out', join(root, 'cli-skills-built'));
  const packed = await cli(
    'pack',
    '--artifact',
    built.payloadDirectory,
    '--out',
    join(root, 'cli-skills-release'),
  );
  const preview = await post('/plugins/managed/preview', {
    sourceDirectory: packed.payloadDirectory,
  });
  assert.equal(preview.candidate.digest, packed.receipt.digest);
  const body = {
    requestId: 'import-' + ++seq,
    previewId: preview.previewId,
    expectedInstallSequence: preview.expectedInstallSequence,
  };
  await post('/plugins/managed/import', body);
  await activate(preview.candidate);
  return { source, built, packed, body, candidate: preview.candidate };
}
try {
  await launch(true);
  const tool = await prepare('tool');
  const command = await prepare('command');
  const data = await prepareSkills();
  const commands = await get('/commands');
  assert.ok(
    commands.commands.some((x) => x.name === 'cli-command' && x.prompt.includes('$ARGUMENTS')),
  );
  const folder = join(root, 'project');
  await mkdir(folder);
  const project = await post('/projects', {
    name: 'CLI acceptance',
    folderName: 'project',
    folderPath: folder,
  });
  const projectId = project.id ?? project.project?.id;
  const session = await post('/projects/' + projectId + '/sessions', { title: 'CLI code smoke' });
  const sessionId = session.id ?? session.session?.id;
  assert.ok(sessionId);
  function register() {
    server.runtime.serverHost.hostProviderRegistry.register({
      id: 'scripted',
      label: 'Scripted',
      type: 'mock',
      client: {
        async *stream(request) {
          calls++;
          if (
            !request.messages
              .slice(request.messages.findLastIndex((x) => x.role === 'user') + 1)
              .some((x) => x.role === 'tool')
          ) {
            yield { type: 'tool-call-start', id: 'echo', name: 'cli-tool' };
            yield {
              type: 'tool-call-delta',
              id: 'echo',
              argumentsDelta: JSON.stringify({ text: 'pipeline result' }),
            };
            yield { type: 'finish', reason: 'tool-call' };
          } else {
            assert.match(JSON.stringify(request), /pipeline result/);
            yield { type: 'text-delta', text: 'Built tool through Pipeline' };
            yield { type: 'finish', reason: 'stop' };
          }
        },
      },
    });
  }
  async function run() {
    const r = await fetch(base + '/agent/runs/stream', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        sessionId,
        provider: 'scripted',
        model: 'fixture',
        userMessage: { role: 'user', content: [{ type: 'text', text: 'Call installed CLI tool' }] },
        permissionMode: 'ask',
      }),
    });
    assert.equal(r.status, 200);
    const events = await r.text();
    assert.match(events, /event: completed/);
    assert.match(events, /Built tool through Pipeline/);
  }
  register();
  await run();
  const catalog = await get('/sessions/' + sessionId + '/skills');
  const skill = catalog.entries.find((x) => x.id === 'plugin:cli-skills/cli-skills');
  assert.ok(skill);
  const ref = {
    id: skill.id,
    instructionSha256: skill.instructionSha256,
    bundleSha256: skill.bundleSha256,
  };
  const expectedResource = await readFile(
    join(data.source, 'skills/cli-skills/references/checklist.md'),
    'utf8',
  );
  const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex');
  async function readSkills() {
    const dataResponse = await fetch(base + '/agent/runs/stream', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        sessionId,
        provider: 'mock',
        model: 'fixture',
        userMessage: {
          role: 'user',
          content: [
            {
              type: 'text',
              text:
                '/tool read_skill ' +
                JSON.stringify({ skill: ref }) +
                '\n/tool read_skill_resource ' +
                JSON.stringify({ skill: ref, path: 'references/checklist.md' }),
            },
          ],
        },
      }),
    });
    assert.equal(dataResponse.status, 200);
    const events = (await dataResponse.text())
      .split(/\r?\n\r?\n/)
      .filter((frame) => frame.startsWith('event: '))
      .map((frame) => {
        const line = frame.split(/\r?\n/).find((value) => value.startsWith('data: '));
        assert.ok(line, 'Every SSE event carries JSON data');
        return JSON.parse(line.slice(6));
      });
    assert.equal(events.filter((event) => event.type === 'completed').length, 1);
    assert.equal(events.filter((event) => event.type === 'failed').length, 0);
    const results = events.filter((event) => event.type === 'tool-result');
    assert.equal(results.length, 2, 'Both Skill tools actually execute through Pipeline');
    for (const [name, kind] of [
      ['read_skill', 'instructions'],
      ['read_skill_resource', 'resource'],
    ]) {
      const event = results.find((item) => item.result.name === name);
      assert.ok(event, `Missing successful ${name} result`);
      assert.notEqual(event.status, 'failed');
      assert.notEqual(event.result.isError, true);
      assert.equal(event.errorCode, undefined);
      assert.equal(event.result.truncated, false);
      const page = JSON.parse(event.result.content);
      assert.deepEqual(page.skill, ref);
      assert.equal(page.kind, kind);
      assert.equal(page.offset, 0);
      assert.equal(page.eof, true);
      assert.equal(page.nextCursor, undefined);
      assert.equal(page.contentSha256, sha256(page.text));
      if (kind === 'instructions') {
        assert.equal(page.path, undefined);
        assert.equal(page.contentSha256, ref.instructionSha256);
        assert.match(page.text, /references\/checklist\.md/);
      } else {
        assert.equal(page.path, 'references/checklist.md');
        assert.equal(page.text, expectedResource);
      }
    }
    const detail = await get('/sessions/' + sessionId);
    const turn = detail.turns.at(-1);
    assert.equal(turn.status, 'completed');
    assert.equal(turn.toolCalls, 2);
    assert.deepEqual(turn.skills.failures, []);
    assert.equal(turn.skills.applications.length, 1);
    const applied = turn.skills.applications[0].skill;
    assert.deepEqual(
      {
        id: applied.id,
        instructionSha256: applied.instructionSha256,
        bundleSha256: applied.bundleSha256,
      },
      ref,
    );
    assert.equal(turn.skills.applications[0].invocation, 'model');
    assert.equal(turn.skills.applications[0].delivery, 'delivered');
  }
  await readSkills();
  const history = await get('/sessions/' + sessionId);
  assert.match(JSON.stringify(history), /pipeline result/);
  // Stale preview is refused without changing authority or evaluating code.
  const source = tool.packed.payloadDirectory;
  const stale = await post('/plugins/managed/preview', { sourceDirectory: source });
  await writeFile(
    join(source, 'index.mjs'),
    (await readFile(join(source, 'index.mjs'), 'utf8')) + '\n// changed after review\n',
  );
  const rejected = await fetch(base + '/plugins/managed/import', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      requestId: 'stale',
      previewId: stale.previewId,
      expectedInstallSequence: stale.expectedInstallSequence,
    }),
  });
  assert.equal(rejected.status, 409);
  assert.match(await rejected.text(), /plugin-preview-stale/);
  await close();
  for (const item of [tool, command, data]) {
    await rm(item.source, { recursive: true });
    await rm(item.built.outputDirectory, { recursive: true });
    await rm(item.packed.outputDirectory, { recursive: true });
  }
  await launch();
  assert.deepEqual(await get('/sessions/' + sessionId), history);
  assert.ok((await get('/commands')).commands.some((x) => x.name === 'cli-command'));
  assert.ok(
    (await get('/sessions/' + sessionId + '/skills')).entries.some(
      (x) => x.id === ref.id && x.bundleSha256 === ref.bundleSha256,
    ),
  );
  register();
  await run();
  await readSkills();
  const replay = await post('/plugins/managed/import', tool.body);
  assert.equal(replay.kind, 'replayed');
  console.log(
    JSON.stringify({
      passed: true,
      cli: 'actual Tool/Command/Skills bin',
      transport: 'real HTTP/SSE',
      persistence: 'SQLite restart after deleting author/build/release',
      assertions: [
        'top-level author marker absent before activation',
        'exact receipt/installer digest',
        'separate trust activation',
        'Tool through shared Pipeline',
        'prompt command catalog',
        'installed Skill/resource through Pipeline',
        'stale preview rejected',
        'offline durable import replay',
      ],
      providerRequests: calls,
    }),
  );
} finally {
  await close();
  await rm(root, { recursive: true, force: true });
}
