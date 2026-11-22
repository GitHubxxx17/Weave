import fs from 'node:fs/promises';
import { request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect } from 'vitest';
import { startServer, type StartServerOptions } from '../../src/main.js';
import {
  importPreviewResponseSchema,
  type ImportPreviewResponse,
  type ManagedCatalog,
  type ManagedMutationResponse,
} from '../../src/managed-plugin-catalog.js';
import { createSqlitePluginAuthorityDatabase } from '../../src/plugin-authority-store.js';
import type { ManagedCommand, ManagedRequest } from '../../src/plugin-authority-types.js';
import { createServerAgentRunner } from '../../src/runtime.js';
import { runFixtureTools, writeFixturePlugin } from './managed-plugin-composition-fixture.js';

export const managed = '/plugins/managed';
export const importPath = `${managed}/import`;
const timeout = 4_000;
export type Running = Awaited<ReturnType<typeof startServer>>;
type WireResponse = { status: number; cacheControl: string | null; text: string };
type ImportCommand = Extract<ManagedCommand, { kind: 'import' }>;
type ImportBody = Omit<ImportCommand, 'kind'> & { requestId: string };

export function importBody(requestId: string, preview: ImportPreviewResponse): ImportBody {
  return {
    requestId,
    previewId: preview.previewId,
    expectedInstallSequence: preview.expectedInstallSequence,
  };
}

export function importRequest({ requestId, ...command }: ImportBody): ManagedRequest {
  return { requestId, command: { kind: 'import', ...command } };
}

export function selectionBody({ requestId, command }: ManagedRequest) {
  if (command.kind === 'import') throw new Error('Expected a selection command');
  const { kind, pluginId, ...review } = command;
  return { path: `${managed}/${pluginId}/${kind}`, body: { requestId, ...review } };
}

export async function within<T>(promise: Promise<T>, description: string): Promise<T> {
  const signal = AbortSignal.timeout(timeout);
  const expired = Promise.withResolvers<never>();
  const onAbort = () => expired.reject(new Error(`Timed out waiting for ${description}`));
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    return await Promise.race([promise, expired.promise]);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

export function pending<T>(promise: Promise<T>): Promise<T> {
  void promise.catch(() => undefined);
  return promise;
}

async function readWire(response: Response): Promise<WireResponse> {
  return {
    status: response.status,
    cacheControl: response.headers.get('cache-control'),
    text: await response.text(),
  };
}

export async function createInstallerHttpFixture(
  cleanups: (() => Promise<void>)[],
  privateCauses: readonly string[],
) {
  const temporary = await fs.mkdtemp(join(tmpdir(), 'weave-installer-http-'));
  const root = await fs.realpath(temporary);
  const pluginsDirectory = join(root, 'manual-plugins');
  const databaseFile = join(root, 'private-authority.sqlite');
  const storeDirectory = join(pluginsDirectory, '.weave-store');
  const artifacts = join(storeDirectory, 'artifacts');
  const ownerFile = join(storeDirectory, 'ownership.sqlite');
  const launchLog = join(root, 'private-mcp-launch.jsonl');
  const options = { databaseFile, pluginsDirectory, environment: {} };
  let running: Running | undefined;
  let reader: ReturnType<typeof createSqlitePluginAuthorityDatabase> | undefined;
  let sourceIndex = 0;
  await fs.mkdir(pluginsDirectory);

  function server() {
    if (running === undefined) throw new Error('Expected a listening test Server');
    return running;
  }

  function authority() {
    if (reader === undefined) throw new Error('Expected an independent authority reader');
    return reader;
  }

  async function start(extra: StartServerOptions = {}) {
    running = await startServer(0, { ...options, ...extra });
    reader ??= createSqlitePluginAuthorityDatabase({ filename: databaseFile });
    return running;
  }

  async function stop() {
    await running?.stop();
    running = undefined;
  }

  cleanups.push(async () => {
    try {
      await stop();
    } finally {
      await reader?.close();
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  function parse(response: WireResponse, path: string, status: number): unknown {
    if (path === managed || path.startsWith(`${managed}/`)) {
      for (const privateData of [
        root,
        temporary,
        'ownership.sqlite',
        'private-authority.sqlite',
        ...privateCauses,
      ]) {
        expect(response.text).not.toContain(privateData);
      }
      expect(response.cacheControl).toBe('no-store');
    }
    expect(response.status, response.text).toBe(status);
    return JSON.parse(response.text) as unknown;
  }

  async function http(path: string, body?: unknown, status = 200) {
    const response = await fetch(`http://127.0.0.1:${server().port}${path}`, {
      signal: AbortSignal.timeout(timeout),
      ...(body === undefined
        ? {}
        : {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          }),
    });
    return parse(await readWire(response), path, status);
  }

  async function source(
    id = 'notes',
    text = 'fixture value',
    fixtureOptions?: Parameters<typeof writeFixturePlugin>[3],
  ) {
    const directory = join(root, `external-source-${++sourceIndex}-private`);
    await writeFixturePlugin(directory, id, text, fixtureOptions);
    return { directory };
  }

  return {
    root,
    pluginsDirectory,
    databaseFile,
    storeDirectory,
    ownerFile,
    artifacts,
    launchLog,
    start,
    stop,
    server,
    authority,
    http,
    parse,
    source,
    startUnbound(extra: StartServerOptions = {}) {
      return start({ ...extra, managedPluginStore: { initialBinding: 'allow-unbound' } });
    },
    snapshot() {
      return authority().snapshotSync();
    },
    async preview(sourceDirectory: string) {
      return importPreviewResponseSchema.parse(
        await http(`${managed}/preview`, { sourceDirectory }),
      );
    },
    async import(body: ImportBody) {
      return (await http(`${managed}/import`, body)) as ManagedMutationResponse;
    },
    async select(command: ManagedRequest) {
      const { path, body } = selectionBody(command);
      return (await http(path, body)) as ManagedMutationResponse;
    },
    async catalog() {
      return (await http(managed)) as ManagedCatalog;
    },
    async run(tool: string | readonly string[], sessionId: string) {
      const { runtime } = server();
      return runFixtureTools(runtime, await createServerAgentRunner(runtime), tool, sessionId);
    },
  };
}

export function openPost(running: Running, path: string, body: unknown) {
  const json = JSON.stringify(body);
  const accepted = Promise.withResolvers<void>();
  const closed = Promise.withResolvers<void>();
  const result = Promise.withResolvers<WireResponse | Error>();
  const observe = (request: IncomingMessage, response: ServerResponse) => {
    if (request.headers['x-installer-test-socket'] !== 'observed') return;
    running.server.off('request', observe);
    response.once('close', closed.resolve);
    accepted.resolve();
  };
  running.server.on('request', observe);
  const client = httpRequest({
    hostname: '127.0.0.1',
    port: running.port,
    path,
    method: 'POST',
    agent: false,
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(json),
      'x-installer-test-socket': 'observed',
    },
  });
  client.on('error', result.resolve);
  client.on('response', (response) => {
    response.setEncoding('utf8');
    let text = '';
    response.on('data', (chunk: string) => {
      text += chunk;
    });
    response.on('error', result.resolve);
    response.on('end', () =>
      result.resolve({
        status: response.statusCode!,
        cacheControl: response.headers['cache-control'] ?? null,
        text,
      }),
    );
  });
  return {
    accepted: accepted.promise,
    closed: closed.promise,
    result: result.promise,
    beginPartial() {
      client.write(json.slice(0, 1));
    },
    finishPartial() {
      client.end(json.slice(1));
    },
    send() {
      client.end(json);
    },
    disconnect() {
      client.socket!.destroy();
    },
    cleanup() {
      running.server.off('request', observe);
      client.destroy();
    },
  };
}
