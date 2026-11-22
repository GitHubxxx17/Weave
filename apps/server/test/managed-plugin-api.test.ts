import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  ExplicitLocalAuthorityError,
  GithubAcquisitionError,
  PluginArtifactError,
  PluginHostError,
} from '@weave/plugin-host';
import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import type { ManagedRuntimeObservation } from '../src/extension-coordinator.js';
import { ManagedCommitFailure } from '../src/managed-command-commit.js';
import { ManagedInstallerError } from '../src/managed-plugin-installer-errors.js';
import type { ManagedPluginInstaller } from '../src/managed-plugin-installer.js';
import { createSqlitePluginAuthorityDatabase } from '../src/plugin-authority-store.js';
import {
  PluginAuthorityError,
  type PluginAuthoritySnapshot,
} from '../src/plugin-authority-types.js';
import { PluginStoreOwnershipError } from '../src/plugin-store-ownership-types.js';
import { startServer } from '../src/main.js';
import { createRealManagedCompositionFixture } from './support/managed-plugin-composition-fixture.js';
import {
  activateInput,
  artifact,
  decisionInput,
  digestA,
  digestB,
  importInput,
} from './support/plugin-authority-fixtures.js';

const jsonHeaders = { Host: 'localhost', 'Content-Type': 'application/json' };
const managed = '/plugins/managed';
const studioOrigin = 'http://localhost:4317';
const runtime = { status: 'running' } as never;
const privatePath = '/private-do-not-disclose';
const stamp = '2026-11-22T10:00:00.000Z';
const identity = artifact();
const preview = { sourceDirectory: `${privatePath}/source` };
const importBody = { requestId: 'test-import', previewId: 'preview', expectedInstallSequence: 0 };
const selectionBody = {
  requestId: 'test-selection',
  selectedDigest: digestA,
  expectedInstallSequence: 4,
  expectedTrustSequence: 3,
};
const activate = {
  requestId: 'test-activate',
  digest: digestA,
  manifest: identity.manifest,
  previousSelection: null,
  expectedInstallSequence: 1,
  expectedTrustSequence: 0,
  intent: 'activate',
};
const observed: ManagedRuntimeObservation = {
  generation: { id: 7, acceptingRuns: true },
  members: [],
};
const emptyAuthority: PluginAuthoritySnapshot = {
  identity: { version: 1, databaseId: 'edb3423f-8837-4ee4-8588-fda4c46b5d20' },
  heads: { installSequence: 0, trustSequence: 0, operationSequence: 0 },
  trustEvents: [],
  installEvents: [],
  operationEvents: [],
  installations: [],
};

function fixture() {
  const candidate = {
    digest: digestA,
    manifest: { ...identity.manifest, description: 'Preserve this author text.' },
    files: 2,
    bytes: 128,
    sourceDirectory: `${privatePath}/source`,
    entry: `${privatePath}/index.mjs`,
  };
  const installer = {
    preview: vi.fn<ManagedPluginInstaller['preview']>().mockResolvedValue({
      previewId: 'preview',
      expiresAt: stamp,
      expectedInstallSequence: 0,
      candidate,
    }),
    previewGithub: vi.fn<ManagedPluginInstaller['previewGithub']>().mockResolvedValue({
      previewId: 'preview',
      expiresAt: stamp,
      expectedInstallSequence: 0,
      candidate,
      github: {
        repository: 'https://github.com/weave/notes',
        commit: 'a'.repeat(40),
        subdirectory: '',
      },
    }),
    import: vi.fn<ManagedPluginInstaller['import']>(),
    applySelection: vi.fn<ManagedPluginInstaller['applySelection']>(),
    snapshot: vi
      .fn<ManagedPluginInstaller['snapshot']>()
      .mockReturnValue({ authority: emptyAuthority, observed }),
    closeSync: () => {},
    drain: async () => {},
  } satisfies ManagedPluginInstaller;
  return {
    installer,
    app: createApp(runtime, { managedPluginInstaller: installer, studioOrigin }),
  };
}

function post(body: unknown, headers = jsonHeaders): RequestInit {
  return { method: 'POST', headers, body: JSON.stringify(body) };
}

async function expectError(response: Response, status: number, code: string, message?: string) {
  expect(response.status).toBe(status);
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(await response.json()).toEqual({
    error: { code, message: message ?? expect.any(String) },
  });
}

function expectNoDispatch(installer: ReturnType<typeof fixture>['installer']) {
  expect(installer.preview).not.toHaveBeenCalled();
  expect(installer.previewGithub).not.toHaveBeenCalled();
  expect(installer.import).not.toHaveBeenCalled();
  expect(installer.applySelection).not.toHaveBeenCalled();
  expect(installer.snapshot).not.toHaveBeenCalled();
}

describe('managed plugin request validation', () => {
  it('returns canonical GitHub review data without paths and passes the raw signal', async () => {
    const { app, installer } = fixture();
    const source = { repository: 'https://github.com/WEAVE/Notes', commit: 'a'.repeat(40) };
    const request = new Request('http://localhost' + managed + '/github/preview', post(source));
    const response = await app.request(request);
    expect(response.status).toBe(200);
    expect(installer.previewGithub).toHaveBeenCalledExactlyOnceWith(
      { ...source, repository: 'https://github.com/weave/notes', subdirectory: '' },
      request.signal,
    );
    const body = await response.json();
    expect(body).toEqual({
      previewId: 'preview',
      expiresAt: stamp,
      expectedInstallSequence: 0,
      candidate: {
        digest: digestA,
        manifest: { ...identity.manifest, description: 'Preserve this author text.' },
        files: 2,
        bytes: 128,
      },
      github: {
        repository: 'https://github.com/weave/notes',
        commit: 'a'.repeat(40),
        subdirectory: '',
      },
    });
    expect(JSON.stringify(body)).not.toContain(privatePath);
  });

  it.each([
    { repository: 'https://github.com/weave/notes', commit: 'main' },
    { repository: 'https://github.com/weave/notes.git', commit: 'a'.repeat(40) },
    {
      repository: 'https://github.com/weave/notes',
      commit: 'a'.repeat(40),
      subdirectory: '../notes',
    },
    { repository: 'https://github.com/weave/notes', commit: 'a'.repeat(40), token: 'secret' },
  ])('rejects invalid GitHub sources before dispatch', async (source) => {
    const { app, installer } = fixture();
    await expectError(
      await app.request(managed + '/github/preview', post(source)),
      400,
      'plugin-invalid-request',
    );
    expectNoDispatch(installer);
  });

  it('guards GitHub preview before acquisition', async () => {
    const { app, installer } = fixture();
    await expectError(
      await app.request(
        managed + '/github/preview',
        post({}, { ...jsonHeaders, Origin: 'https://attacker.example' }),
      ),
      403,
      'forbidden-origin',
    );
    expectNoDispatch(installer);
  });
  it.each([
    ['preview', { sourceDirectory: 'relative' }],
    ['preview', { sourceDirectory: '/source\0' }],
    ['preview', { ...preview, extra: true }],
    ['import', { ...importBody, previewId: '' }],
    ['import', { ...importBody, requestId: 'x'.repeat(201) }],
    ['import', { ...importBody, expectedInstallSequence: Number.MAX_SAFE_INTEGER + 1 }],
    ['UPPER/activate', activate],
    ['%2Fnotes/activate', activate],
    ['notes--extra/activate', activate],
    ['notes/activate', { ...activate, manifest: { ...identity.manifest, id: 'other-id' } }],
    [
      'notes/activate',
      { ...activate, manifest: { ...identity.manifest, contributes: { directory: privatePath } } },
    ],
    [
      'notes/activate',
      {
        ...activate,
        manifest: { ...identity.manifest, engines: { weave: '^1.0.0', source: privatePath } },
      },
    ],
    ['notes/activate', { ...activate, manifest: { ...identity.manifest, permissions: undefined } }],
    ['notes/activate', { ...activate, intent: 'restore' }],
    ['notes/enable', { ...selectionBody, selectedDigest: null }],
    ['notes/enable', { ...selectionBody, immediate: false }],
    ['notes/disable', { ...selectionBody, expectedTrustSequence: -1 }],
    ['notes/revoke', { ...selectionBody, immediate: 'true' }],
    ['notes/uninstall', { ...selectionBody, selectedDigest: digestB.toUpperCase() }],
  ])('rejects invalid %s bodies before dispatch', async (path, body) => {
    const { app, installer } = fixture();
    const response = await app.request(`${managed}/${path}`, post(body));
    await expectError(response, 400, 'plugin-invalid-request', 'Invalid managed plugin request.');
    expectNoDispatch(installer);
  });

  it.each([
    ['preview?x', preview],
    ['import?=x', importBody],
    ['notes/activate?%69mmediate=true', activate],
    ['notes/enable?x=1&x=2', selectionBody],
    ['notes/disable?immediate=false', selectionBody],
    ['notes/revoke?unused=', selectionBody],
    ['notes/uninstall?unexpected', selectionBody],
  ])('rejects query parameters on %s before dispatch', async (path, body) => {
    const { app, installer } = fixture();
    await expectError(
      await app.request(`${managed}/${path}`, post(body)),
      400,
      'plugin-invalid-request',
    );
    expectNoDispatch(installer);
  });

  it('validates before reporting a missing installer and preserves CORS on both outcomes', async () => {
    const app = createApp(runtime, { studioOrigin });
    const headers = { ...jsonHeaders, Origin: studioOrigin };
    const disabled = await app.request(managed + '/preview', post(preview, headers));
    expect(disabled.headers.get('access-control-allow-origin')).toBe(studioOrigin);
    await expectError(
      disabled,
      404,
      'plugin-installer-disabled',
      'Managed plugin installation is unavailable.',
    );
    const badId = await app.request(managed + '/other-id/activate', post(activate, headers));
    expect(badId.headers.get('access-control-allow-origin')).toBe(studioOrigin);
    await expectError(badId, 400, 'plugin-invalid-request');
    const malformed = await app.request(managed + '/preview', {
      method: 'POST',
      headers,
      body: '{',
    });
    await expectError(malformed, 400, 'plugin-invalid-request');
    await expectError(await app.request(managed), 404, 'plugin-installer-disabled');
  });

  it('passes the raw signal and returns a strict preview with only measured facts', async () => {
    const { app, installer } = fixture();
    const request = new Request(
      'http://localhost' + managed + '/preview',
      post(preview, { ...jsonHeaders, Origin: studioOrigin }),
    );
    const response = await app.request(request);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('access-control-allow-origin')).toBe(studioOrigin);
    expect(installer.preview).toHaveBeenCalledExactlyOnceWith(
      preview.sourceDirectory,
      request.signal,
    );
    expect(await response.json()).toEqual({
      previewId: 'preview',
      expiresAt: stamp,
      expectedInstallSequence: 0,
      candidate: {
        digest: digestA,
        manifest: { ...identity.manifest, description: 'Preserve this author text.' },
        files: 2,
        bytes: 128,
      },
    });
  });
});

function makeStreamingRequest(bytes: Uint8Array, contentLength?: string) {
  const split = 131_072;
  let offset = 0;
  const pull = vi.fn((controller: ReadableStreamDefaultController<Uint8Array>) => {
    if (offset === bytes.byteLength) {
      controller.close();
      return;
    }
    // Leave separate trailing input if the second chunk overflows.
    const end = Math.min(offset + split + 1, bytes.byteLength);
    controller.enqueue(bytes.subarray(offset, end));
    offset = end;
  });
  const cancel = vi.fn(() => new Promise<void>(() => {}));
  const stream = new ReadableStream({ pull, cancel }, { highWaterMark: 0 });
  const init: RequestInit & { duplex: 'half' } = {
    method: 'POST',
    headers: {
      ...jsonHeaders,
      ...(contentLength === undefined ? {} : { 'Content-Length': contentLength }),
    },
    body: stream,
    duplex: 'half',
  };
  return {
    request: new Request('http://localhost' + managed + '/preview', init),
    pull,
    cancel,
    stream,
  };
}

describe('managed plugin byte limit', () => {
  it.each([undefined, '1', '500000'])(
    'accepts exactly 256 KiB with Content-Length %s',
    async (contentLength) => {
      const { app, installer } = fixture();
      const body = JSON.stringify(preview);
      const bytes = new TextEncoder().encode(body.padEnd(262_144));
      const { request, cancel, stream } = makeStreamingRequest(bytes, contentLength);
      expect((await app.request(request)).status).toBe(200);
      expect(installer.preview).toHaveBeenCalledTimes(1);
      expect(cancel).not.toHaveBeenCalled();
      expect(stream.locked).toBe(false);
    },
  );

  it('counts multibyte UTF-8 and rejects exactly one byte over for an absent installer', async () => {
    const body = JSON.stringify({ sourceDirectory: '/' + '\uFFFD'.repeat(87_374) });
    const bytes = new TextEncoder().encode(body);
    expect(body.length).toBeLessThan(262_144);
    expect(bytes.byteLength).toBe(262_145);
    const { request } = makeStreamingRequest(bytes, '1');
    await expectError(
      await createApp(runtime).request(request),
      413,
      'plugin-request-too-large',
      'The managed plugin request exceeds 256 KiB.',
    );
  });

  it('stops pulling at the overflow and returns 413 without waiting for cancel to settle', async () => {
    const { app, installer } = fixture();
    const bytes = new TextEncoder().encode(JSON.stringify(preview).padEnd(262_150));
    const { request, pull, cancel, stream } = makeStreamingRequest(bytes, '1');
    await expectError(await app.request(request), 413, 'plugin-request-too-large');
    expect(pull).toHaveBeenCalledTimes(2);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(stream.locked).toBe(false);
    expectNoDispatch(installer);
  });

  it('reports cancellation delivered while reading the stream', async () => {
    const { app, installer } = fixture();
    const abort = new AbortController();
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          abort.abort(new Error(privatePath));
          controller.error(abort.signal.reason);
        },
      },
      { highWaterMark: 0 },
    );
    const init: RequestInit & { duplex: 'half' } = {
      method: 'POST',
      headers: jsonHeaders,
      body,
      signal: abort.signal,
      duplex: 'half',
    };
    const response = await app.request(
      new Request('http://localhost' + managed + '/preview', init),
    );
    await expectError(
      response,
      503,
      'plugin-installer-unavailable',
      'The managed plugin store is currently unavailable.',
    );
    expectNoDispatch(installer);
  });
});

describe('managed plugin public errors', () => {
  it.each([
    ['plugin-github-invalid', 400],
    ['plugin-github-too-large', 400],
    ['plugin-github-unavailable', 502],
    ['plugin-github-rate-limited', 429],
    ['plugin-github-timeout', 504],
  ] as const)('redacts remote acquisition error %s', async (code, status) => {
    const { app, installer } = fixture();
    installer.previewGithub.mockRejectedValueOnce(
      new GithubAcquisitionError(code, privatePath, { cause: new Error('private response body') }),
    );
    const response = await app.request(
      managed + '/github/preview',
      post({ repository: 'https://github.com/weave/notes', commit: 'a'.repeat(40) }),
    );
    expect(response.status).toBe(status);
    const body = await response.text();
    expect(JSON.parse(body)).toEqual({ error: { code, message: expect.any(String) } });
    expect(body).not.toContain(privatePath);
    expect(body).not.toContain('private response body');
  });

  it.each([
    [
      new ManagedInstallerError('plugin-preview-stale', { cause: privatePath }),
      409,
      'plugin-preview-stale',
      'Review the current plugin directory before importing it.',
    ],
    [
      new ManagedInstallerError('plugin-preview-capacity'),
      429,
      'plugin-preview-capacity',
      'Preview capacity has been reached. Retry later.',
    ],
    [
      new ManagedInstallerError('plugin-managed-id-conflict'),
      409,
      'plugin-managed-id-conflict',
      'The plugin ID is unavailable for managed installation.',
    ],
    [
      new ManagedInstallerError('plugin-managed-namespace-unavailable'),
      409,
      'plugin-managed-namespace-unavailable',
      'The current plugin namespace could not be verified.',
    ],
    [
      new PluginArtifactError('plugin-artifact-invalid', privatePath),
      400,
      'plugin-artifact-invalid',
      'The directory does not contain a valid compatible bundled plugin.',
    ],
    [
      new PluginArtifactError('plugin-artifact-unsupported-file', privatePath),
      400,
      'plugin-artifact-unsupported-file',
      'Plugin payloads require regular files and real directories.',
    ],
    [
      new PluginArtifactError('plugin-artifact-too-large', privatePath),
      400,
      'plugin-artifact-too-large',
      'The plugin exceeds the artifact size or traversal limits.',
    ],
    [
      new PluginArtifactError('plugin-artifact-capacity', privatePath),
      409,
      'plugin-artifact-capacity',
      'The artifact store is full. Existing artifacts are retained and exact matches can be reused.',
    ],
    [
      new PluginArtifactError('plugin-artifact-source-changed', privatePath),
      409,
      'plugin-preview-stale',
      'Review the current plugin directory before importing it.',
    ],
    ...(
      ['plugin-artifact-conflict', 'plugin-artifact-not-found', 'plugin-artifact-corrupt'] as const
    ).map(
      (code) =>
        [
          new PluginArtifactError(code, privatePath),
          409,
          'plugin-artifact-unavailable',
          'The plugin artifact could not be verified.',
        ] as const,
    ),
    [
      new PluginAuthorityError('plugin-authority-not-found', privatePath),
      404,
      'plugin-authority-not-found',
      'The managed plugin or candidate was not found.',
    ],
    [
      new PluginAuthorityError('plugin-authority-conflict', privatePath),
      409,
      'plugin-authority-conflict',
      'Plugin authority changed. Review the current state.',
    ],
    [
      new PluginAuthorityError('plugin-authority-request-conflict', privatePath),
      409,
      'plugin-authority-request-conflict',
      'The request ID is already associated with a different decision.',
    ],
    [
      new PluginAuthorityError('plugin-authority-activation-required', privatePath),
      409,
      'plugin-authority-activation-required',
      'Activate the selected plugin before enabling it.',
    ],
    [
      new ManagedCommitFailure(new PluginAuthorityError('plugin-authority-busy', privatePath), [
        new Error(privatePath),
      ]),
      503,
      'plugin-authority-busy',
      'Plugin authority is temporarily busy.',
    ],
    ...[
      new PluginAuthorityError('plugin-authority-closed', privatePath),
      new PluginStoreOwnershipError('plugin-store-closed', privatePath),
      new ExplicitLocalAuthorityError(
        new PluginStoreOwnershipError('plugin-store-ownership-lost', privatePath),
      ),
      new PluginHostError('plugin-host-disposed', privatePath),
      new DOMException(privatePath, 'AbortError'),
    ].map(
      (error) =>
        [
          error,
          503,
          'plugin-installer-unavailable',
          'The managed plugin store is currently unavailable.',
        ] as const,
    ),
    ...[
      new PluginArtifactError('plugin-artifact-io', privatePath),
      new PluginAuthorityError('plugin-authority-invalid', privatePath),
      new PluginAuthorityError('plugin-authority-protocol', privatePath),
      new PluginAuthorityError('plugin-authority-storage', privatePath),
      new ExplicitLocalAuthorityError(new Error(privatePath)),
      new AggregateError([], privatePath, {
        cause: new PluginAuthorityError('plugin-authority-busy', privatePath),
      }),
      { code: 'plugin-preview-stale', message: privatePath },
      undefined,
    ].map(
      (error) =>
        [error, 500, 'plugin-management-failed', 'Managed plugin management failed.'] as const,
    ),
  ] as const)('projects typed error %# as %s', async (error, status, code, message) => {
    const { app, installer } = fixture();
    installer.preview.mockRejectedValueOnce(error);
    await expectError(
      await app.request(managed + '/preview', post(preview)),
      status,
      code,
      message,
    );
  });

  it('reports invalid prepared import evidence as a server failure after request validation', async () => {
    const { app, installer } = fixture();
    installer.import.mockRejectedValueOnce(
      new ManagedCommitFailure(new PluginAuthorityError('plugin-authority-invalid', privatePath), [
        new Error(privatePath),
      ]),
    );
    await expectError(
      await app.request(managed + '/import', post(importBody)),
      500,
      'plugin-management-failed',
      'Managed plugin management failed.',
    );
    expect(installer.import).toHaveBeenCalledTimes(1);
  });

  it('reports a malformed internal catalog with the generic fixed error', async () => {
    const { app, installer } = fixture();
    installer.snapshot.mockReturnValue({
      authority: emptyAuthority,
      observed: { ...observed, generation: { id: -1, acceptingRuns: true } },
    });
    await expectError(
      await app.request(managed),
      500,
      'plugin-management-failed',
      'Managed plugin management failed.',
    );
  });
});

const digestC = 'c'.repeat(64);
const second = artifact(digestB, '2.0.0');
const other = {
  ...artifact(digestC),
  pluginId: 'alpha',
  manifest: { ...identity.manifest, id: 'alpha' },
};

async function history() {
  let milliseconds = Date.parse(stamp);
  const db = createSqlitePluginAuthorityDatabase({
    filename: ':memory:',
    now: () => new Date(milliseconds++),
  });
  try {
    await db.trust.append({
      kind: 'trusted',
      pluginId: 'notes',
      digest: digestA,
      manifest: { ...identity.manifest, name: 'Unrelated manual trust' },
    });
    const commit = (input: Parameters<typeof db.commitSync>[0]) => {
      const result = db.commitSync(input);
      if (result.kind !== 'committed') throw new Error('Expected a fresh fixture operation');
      return result;
    };
    const first = commit(importInput('import-a', 0, identity));
    const alpha = commit(importInput('import-alpha', 1, other));
    const firstActivation = commit(activateInput('activate-a', alpha.afterSnapshot));
    const next = commit(importInput('import-b', 3, second));
    const activated = commit(activateInput('activate-b', next.afterSnapshot, second, 'rollback'));
    const enabled = commit(decisionInput('enable', 'enable-b', activated.afterSnapshot));
    const disabled = commit(decisionInput('disable', 'disable-b', enabled.afterSnapshot, true));
    const revoked = commit(decisionInput('revoke', 'revoke-b', disabled.afterSnapshot));
    const uninstalled = commit(decisionInput('uninstall', 'uninstall-b', revoked.afterSnapshot));
    return {
      first,
      alpha,
      firstActivation,
      next,
      activated,
      enabled,
      disabled,
      revoked,
      uninstalled,
    };
  } finally {
    await db.close();
  }
}

const oldMember = {
  pluginId: 'notes',
  sourceId: 'local-esm',
  origin: 'managed',
  identity: `${privatePath}/payload/index.mjs`,
  instanceId: `${privatePath}/lease`,
  managedIdentity: { digest: digestA, activationSequence: 3 },
  manifest: identity.manifest,
} as const;
const mismatchedObservation: ManagedRuntimeObservation = {
  generation: {
    id: 8,
    acceptingRuns: false,
    blocked: { code: 'mcp-private-block', message: privatePath },
  },
  members: [
    { ...oldMember, sourceId: 'mcp', managedIdentity: { digest: digestC, activationSequence: 22 } },
    {
      ...oldMember,
      origin: 'manual',
      managedIdentity: { digest: digestB, activationSequence: 23 },
    },
    oldMember,
    { ...oldMember, pluginId: 'alpha', sourceId: 'mcp', manifest: other.manifest },
  ],
};
const publicGeneration = {
  id: 8,
  acceptingRuns: false,
  blocked: {
    code: 'plugin-generation-blocked',
    message: 'New runs are blocked pending a compliant Generation.',
  },
};
const activeA = { pluginId: 'notes', digest: digestA, version: '1.0.0', activationSequence: 3 };

function privateFree(value: unknown, fingerprint?: string) {
  const response = JSON.stringify(value);
  for (const sentinel of [
    privatePath,
    'weave-authority-fixtures',
    'databaseId',
    emptyAuthority.identity.databaseId,
    'registration',
    'entryPath',
    'storeDirectory',
    'fingerprint',
    'sourceDirectory',
    'pluginBefore',
    'evidence',
    'lease',
    fingerprint,
  ]) {
    if (sentinel !== undefined) expect(response).not.toContain(sentinel);
  }
}

describe('managed plugin readback', () => {
  it('orders candidate history and joins exact recorded import times, trust, and members', async () => {
    const { activated, next } = await history();
    const { app, installer } = fixture();
    const authority = {
      ...activated.afterSnapshot,
      registration: { ownerDatabaseFile: privatePath },
      installations: [...activated.afterSnapshot.installations].reverse().map((record) => ({
        ...record,
        candidates: [...record.candidates].reverse(),
      })),
    };
    const snapshot = {
      authority,
      observed: mismatchedObservation,
    };
    installer.snapshot.mockReturnValue(snapshot);
    const response = await app.request(managed);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(installer.snapshot).toHaveBeenCalledTimes(1);
    const catalog: unknown = await response.json();
    privateFree(catalog, next.operation.fingerprint);
    expect(catalog).toEqual({
      heads: { installSequence: 5, trustSequence: 3, operationSequence: 5 },
      plugins: [
        {
          pluginId: 'notes',
          candidates: [
            {
              manifest: identity.manifest,
              digest: digestA,
              files: 2,
              bytes: 128,
              importSequence: 1,
              importedAt: '2026-11-22T10:00:00.001Z',
              provenance: 'local-directory',
            },
            {
              manifest: second.manifest,
              digest: digestB,
              files: 2,
              bytes: 128,
              importSequence: 4,
              importedAt: '2026-11-22T10:00:00.004Z',
              provenance: 'local-directory',
            },
          ],
          selection: { digest: digestB, candidateImportSequence: 4, activationSequence: 5 },
          trust: { digest: digestB, enabled: true },
          active: activeA,
        },
        {
          pluginId: 'alpha',
          candidates: [
            {
              manifest: other.manifest,
              digest: digestC,
              files: 2,
              bytes: 128,
              importSequence: 2,
              importedAt: '2026-11-22T10:00:00.002Z',
              provenance: 'local-directory',
            },
          ],
          selection: null,
          trust: null,
          active: null,
        },
      ],
      generation: publicGeneration,
    });
  });

  it('requires exact candidate and manifest matches for current and historical trust', async () => {
    const { first, firstActivation } = await history();
    const { app, installer } = fixture();
    const { operation, afterSnapshot } = firstActivation;
    const unrelatedTrust = first.afterSnapshot.trustEvents[0]!;
    if (unrelatedTrust.kind !== 'trusted') throw new Error('Expected historical manual trust');
    const authority = { ...afterSnapshot, trustEvents: [unrelatedTrust] };
    installer.applySelection.mockResolvedValueOnce({
      kind: 'replayed',
      operation: {
        ...operation,
        decision: {
          ...operation.decision,
          pluginAfter: {
            ...operation.decision.pluginAfter,
            trust: { ...unrelatedTrust, enabled: true },
          },
        },
      },
      currentAuthority: authority,
      observed,
    });
    const response = await app.request(managed + '/notes/activate', post(activate));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      decision: { selection: { digest: digestA }, trust: null },
      current: {
        plugins: [{ selection: { digest: digestA }, trust: null }, { pluginId: 'alpha' }],
      },
    });
  });

  it.each(['not-required', 'failed'] as const)(
    'returns a committed import with application %s',
    async (status) => {
      const { first } = await history();
      const { app, installer } = fixture();
      installer.import.mockResolvedValue({
        kind: 'committed',
        operation: first.operation,
        savedAuthority: first.afterSnapshot,
        observed,
        application:
          status === 'failed'
            ? { status, failureKind: 'adoption', cause: new Error(privatePath) }
            : { status },
      });
      const request = new Request('http://localhost' + managed + '/import', post(importBody));
      const response = await app.request(request);
      expect(response.status).toBe(200);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(installer.import).toHaveBeenCalledExactlyOnceWith(
        {
          requestId: 'test-import',
          command: { kind: 'import', previewId: 'preview', expectedInstallSequence: 0 },
        },
        request.signal,
      );
      expect(installer.snapshot).not.toHaveBeenCalled();
      const value: unknown = await response.json();
      privateFree(value, first.operation.fingerprint);
      expect(value).toMatchObject({
        kind: 'committed',
        decision: {
          requestId: 'import-a',
          operationSequence: 1,
          occurredAt: '2026-11-22T10:00:00.001Z',
          pluginId: 'notes',
          changed: true,
          target: { kind: 'import', digest: digestA },
          selection: null,
          trust: null,
          installSequence: 1,
          trustSequence: 1,
          installEventSequence: 1,
          trustEventSequence: null,
        },
        application: {
          status,
          active: null,
          generation: { id: 7, acceptingRuns: true },
          ...(status === 'failed'
            ? {
                issue: {
                  code: 'plugin-managed-adoption-failed',
                  message: 'Managed plugin authority could not be applied.',
                },
              }
            : {}),
        },
        current: { plugins: [{ trust: null }] },
      });
    },
  );

  it.each([
    ['activate', activate, 'activated', { kind: 'activate', intent: 'rollback', digest: digestB }],
    ['enable', selectionBody, 'enabled', { kind: 'enable', digest: digestB }],
    [
      'disable',
      { ...selectionBody, immediate: true },
      'disabled',
      { kind: 'disable', digest: digestB, immediate: true },
    ],
    ['revoke', selectionBody, 'revoked', { kind: 'revoke', digest: digestB, immediate: false }],
    [
      'uninstall',
      { ...selectionBody, selectedDigest: null },
      'uninstalled',
      { kind: 'uninstall', digest: digestB, immediate: false },
    ],
  ] as const)(
    'normalizes %s for one service call and projects its recorded target',
    async (kind, body, resultName, target) => {
      const saved = (await history())[resultName];
      const { app, installer } = fixture();
      installer.applySelection.mockResolvedValue({
        kind: 'committed',
        operation: saved.operation,
        savedAuthority: saved.afterSnapshot,
        observed: mismatchedObservation,
        application: { status: 'applied' },
      });
      const request = new Request('http://localhost' + managed + '/notes/' + kind, post(body));
      const response = await app.request(request);
      expect(response.status).toBe(200);
      const { requestId, ...command } = body;
      expect(installer.applySelection).toHaveBeenCalledExactlyOnceWith(
        {
          requestId,
          command: {
            kind,
            pluginId: 'notes',
            ...command,
            ...(['revoke', 'uninstall'].includes(kind) ? { immediate: false } : {}),
          },
        },
        request.signal,
      );
      expect(installer.snapshot).not.toHaveBeenCalled();
      const value: unknown = await response.json();
      privateFree(value, saved.operation.fingerprint);
      expect(value).toMatchObject({
        kind: 'committed',
        decision: { target },
        application: { status: 'applied', active: activeA, generation: publicGeneration },
      });
    },
  );

  it.each([
    [
      { failureKind: 'adoption', cause: new Error(privatePath) },
      'plugin-managed-adoption-failed',
      'Managed plugin authority could not be applied.',
    ],
    [{ failureKind: 'preparation' }, 'plugin-load-failed', 'Managed plugin preparation failed'],
    [
      { failureKind: 'publication', cause: undefined },
      'plugin-reload-failed',
      'Managed plugin Generation publication failed.',
    ],
  ] as const)(
    'keeps a durable activation with application failure %# at 200',
    async (failure, code, message) => {
      const { activated } = await history();
      const { app, installer } = fixture();
      installer.applySelection.mockResolvedValue({
        kind: 'committed',
        operation: activated.operation,
        savedAuthority: activated.afterSnapshot,
        observed: mismatchedObservation,
        application: { status: 'failed', ...failure },
      });
      const response = await app.request(managed + '/notes/activate', post(activate));
      expect(response.status).toBe(200);
      const value: unknown = await response.json();
      privateFree(value, activated.operation.fingerprint);
      expect(value).toMatchObject({
        decision: { selection: { digest: digestB }, trust: { digest: digestB, enabled: true } },
        application: {
          status: 'failed',
          issue: { code, message },
          active: activeA,
          generation: publicGeneration,
        },
      });
    },
  );

  it.each(['import', 'activate'] as const)(
    'uses the historical %s decision and in-ticket current authority for replay',
    async (kind) => {
      const { first, firstActivation, activated } = await history();
      const { app, installer } = fixture();
      const saved = kind === 'import' ? first : firstActivation;
      const result = {
        kind: 'replayed',
        operation: saved.operation,
        currentAuthority: activated.afterSnapshot,
        observed: mismatchedObservation,
      } as const;
      const response =
        kind === 'import'
          ? (installer.import.mockResolvedValueOnce(result),
            await app.request(managed + '/import', post(importBody)))
          : (installer.applySelection.mockResolvedValueOnce(result),
            await app.request(managed + '/notes/activate', post(activate)));
      expect(response.status).toBe(200);
      expect(installer.snapshot).not.toHaveBeenCalled();
      const value = (await response.json()) as { application: unknown };
      privateFree(value, saved.operation.fingerprint);
      expect(value.application).toEqual({ status: 'unknown' });
      expect(value).toMatchObject({
        kind: 'replayed',
        decision: {
          target: { kind, digest: digestA },
          selection:
            kind === 'import'
              ? null
              : { digest: digestA, candidateImportSequence: 1, activationSequence: 3 },
          trust: kind === 'import' ? null : { digest: digestA, enabled: true },
          installSequence: kind === 'import' ? 1 : 3,
        },
        current: {
          heads: { installSequence: 5, trustSequence: 3, operationSequence: 5 },
          plugins: [
            {
              selection: { digest: digestB },
              trust: { digest: digestB, enabled: true },
              active: activeA,
            },
            { pluginId: 'alpha' },
          ],
          generation: publicGeneration,
        },
      });
    },
  );
});

describe('managed plugin startup wiring', () => {
  it('round-trips a near-64 KiB descriptor using replacement decoding on a registered restart', async () => {
    const f = await createRealManagedCompositionFixture();
    let server: Awaited<ReturnType<typeof startServer>> | undefined;
    try {
      const source = await f.writeSource('notes');
      const descriptor = {
        schemaVersion: 1,
        entry: 'index.mjs',
        manifest: { ...source.manifest, description: 'X' },
      };
      const [prefix, suffix] = JSON.stringify(descriptor).split('"X"') as [string, string];
      const raw = Buffer.concat([
        Buffer.from(prefix + '"'),
        Buffer.alloc(64 * 1024 - 512, 0xff),
        Buffer.from('"' + suffix),
      ]);
      expect(raw.byteLength).toBeLessThan(64 * 1024);
      await writeFile(join(source.directory, 'weave-plugin.json'), raw);
      await f.closeResources();
      server = await startServer(0, {
        databaseFile: f.databaseFile,
        pluginsDirectory: f.pluginsDirectory,
        environment: {},
      });
      const url = `http://127.0.0.1:${server.port}${managed}`;
      const review = await fetch(url + '/preview', post({ sourceDirectory: source.directory }));
      expect(review.status).toBe(200);
      const { previewId, expectedInstallSequence, candidate } = (await review.json()) as {
        previewId: string;
        expectedInstallSequence: number;
        candidate: { manifest: typeof source.manifest; digest: string };
      };
      expect(candidate.manifest.description).toBe('\uFFFD'.repeat(64 * 1024 - 512));
      const imported = await fetch(
        url + '/import',
        post({ requestId: 'large-import', previewId, expectedInstallSequence }),
      );
      expect(imported.status).toBe(200);
      const activated = await fetch(
        url + '/notes/activate',
        post({ ...activate, digest: candidate.digest, manifest: candidate.manifest }),
      );
      expect(activated.status).toBe(200);
      expect(await activated.json()).toMatchObject({ application: { status: 'applied' } });
    } finally {
      await server?.stop();
      await f.close();
    }
  });

  it('refuses sticky legacy writes with local ESM disabled and preserves ordinary disabled routes', async () => {
    const f = await createRealManagedCompositionFixture();
    let server: Awaited<ReturnType<typeof startServer>> | undefined;
    try {
      await f.seedManaged('notes', 'managed');
      f.authority.commitSync(decisionInput('uninstall', 'removed', f.authority.snapshotSync()));
      await f.closeResources();
      server = await startServer(0, {
        databaseFile: f.databaseFile,
        pluginsDirectory: false,
        environment: {},
      });
      const base = `http://127.0.0.1:${server.port}/plugins`;
      for (const [path, init] of [
        ['/notes/trust', post({ digest: digestA })],
        ['/notes/trust?immediate=true', { ...post({}), method: 'DELETE' }],
        ['/notes/enable', post({})],
        ['/notes/disable?immediate=false', post({})],
      ] as const) {
        const response = await fetch(base + path, init);
        expect(response.status).toBe(409);
        expect(await response.json()).toEqual({
          error: {
            code: 'plugin-managed-review-required',
            message: 'Use the managed plugin review to change this plugin.',
          },
        });
      }
      for (const path of ['/other-id/enable', '/reload']) {
        const response = await fetch(base + path, post({}));
        expect(response.status).toBe(404);
        expect(await response.json()).toMatchObject({
          error: { code: 'plugin-management-disabled' },
        });
      }
      await expectError(await fetch(base + '/managed'), 404, 'plugin-installer-disabled');
    } finally {
      await server?.stop();
      await f.close();
    }
  });
});
