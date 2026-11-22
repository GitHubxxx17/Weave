// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  fetchManagedCatalog,
  prepareManagedRequest,
  previewManagedPlugin,
  sendManagedRequest,
} from '../src/features/plugins/managed-plugin-api.js';
import { managedManifestSchema } from '../src/features/plugins/managed-plugin-types.js';
import type {
  ManagedMutationResponse,
  ManagedReview,
} from '../src/features/plugins/managed-plugin-types.js';
import { PluginApiError } from '../src/features/plugins/plugin-api.js';
import {
  firstActive,
  firstCandidate,
  firstDigest,
  firstSelection,
  managedCatalog,
  managedDecision,
  managedGeneration,
  managedManifest,
  managedPlugin,
  managedPluginId,
  managedPreview,
  secondCandidate,
  secondDigest,
} from './support/managed-plugin-fixtures.js';

const managedPath = '/plugins/managed';
const requestId = 'review-1';
const expectations = { expectedInstallSequence: 3, expectedTrustSequence: 4 };
const selectionReview = { pluginId: managedPluginId, ...expectations };
const importReview = { kind: 'import', preview: managedPreview } satisfies ManagedReview;
const importTarget = { kind: 'import', digest: secondDigest } as const;
const activateReview = {
  ...selectionReview,
  kind: 'activate',
  digest: secondDigest,
  manifest: managedPreview.candidate.manifest,
  previousSelection: null,
  intent: 'activate',
} satisfies ManagedReview;
const rollbackReview = {
  ...activateReview,
  digest: firstDigest,
  manifest: managedManifest,
  previousSelection: secondDigest,
  intent: 'rollback',
} satisfies ManagedReview;

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function respond(response: Response) {
  const fetchMock = vi.fn<typeof fetch>(async () => response);
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function committed(target: ManagedMutationResponse['decision']['target'] = importTarget) {
  return {
    kind: 'committed',
    decision: managedDecision(target),
    application: { status: 'applied', generation: managedGeneration, active: firstActive },
    current: managedCatalog,
  } satisfies ManagedMutationResponse;
}

const duplicatePluginCatalog = {
  ...managedCatalog,
  plugins: [managedPlugin, { ...managedPlugin, active: null }],
};
const generationBlock = {
  code: 'plugin-generation-blocked',
  message: 'New runs are blocked pending a compliant Generation.',
};
const adoptionIssue = {
  code: 'plugin-managed-adoption-failed',
  message: 'Managed plugin authority could not be applied.',
};
const preparationIssue = {
  code: 'plugin-load-failed',
  message: 'Managed plugin preparation failed',
};

afterEach(() => {
  vi.unstubAllGlobals();
  Reflect.deleteProperty(window, 'weaveDesktop');
});

describe('managed plugin requests', () => {
  const commands = [
    {
      name: 'import',
      review: importReview,
      route: '/import',
      body: { previewId: 'preview-1', expectedInstallSequence: 3 },
      target: importTarget,
    },
    {
      name: 'initial activate',
      review: activateReview,
      route: `/${managedPluginId}/activate`,
      body: {
        digest: secondDigest,
        manifest: managedPreview.candidate.manifest,
        previousSelection: null,
        ...expectations,
        intent: 'activate',
      },
      target: { kind: 'activate', digest: secondDigest, intent: 'activate' },
    },
    {
      name: 'rollback',
      review: rollbackReview,
      route: `/${managedPluginId}/activate`,
      body: {
        digest: firstDigest,
        manifest: managedManifest,
        previousSelection: secondDigest,
        ...expectations,
        intent: 'rollback',
      },
      target: { kind: 'activate', digest: firstDigest, intent: 'rollback' },
    },
    {
      name: 'enable',
      review: { ...selectionReview, kind: 'enable', selectedDigest: secondDigest },
      route: `/${managedPluginId}/enable`,
      body: { ...expectations, selectedDigest: secondDigest },
      target: { kind: 'enable', digest: secondDigest },
    },
    {
      name: 'disable',
      review: {
        ...selectionReview,
        kind: 'disable',
        selectedDigest: secondDigest,
        immediate: true,
      },
      route: `/${managedPluginId}/disable`,
      body: { ...expectations, selectedDigest: secondDigest, immediate: true },
      target: { kind: 'disable', digest: secondDigest, immediate: true },
    },
    {
      name: 'revoke',
      review: {
        ...selectionReview,
        kind: 'revoke',
        selectedDigest: secondDigest,
        immediate: false,
      },
      route: `/${managedPluginId}/revoke`,
      body: { ...expectations, selectedDigest: secondDigest, immediate: false },
      target: { kind: 'revoke', digest: secondDigest, immediate: false },
    },
    {
      name: 'uninstall',
      review: { ...selectionReview, kind: 'uninstall', selectedDigest: null, immediate: false },
      route: `/${managedPluginId}/uninstall`,
      body: { ...expectations, selectedDigest: null, immediate: false },
      target: { kind: 'uninstall', digest: null, immediate: false },
    },
  ] satisfies Array<{
    name: string;
    review: ManagedReview;
    route: string;
    body: object;
    target: ManagedMutationResponse['decision']['target'];
  }>;

  it.each(commands)('sends the exact $name command', async ({ review, route, body, target }) => {
    const receipt = committed(target);
    const fetchMock = respond(json(receipt));
    const prepared = prepareManagedRequest(review, requestId);
    expect(prepared).toMatchObject({
      url: managedPath + route,
      requestId,
      pluginId: managedPluginId,
      target,
    });
    expect(JSON.parse(prepared.body)).toEqual({ requestId, ...body });
    await expect(sendManagedRequest(prepared)).resolves.toEqual(receipt);
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith(managedPath + route, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: prepared.body,
    });
  });

  it('sends the original preview path with spaces and the caller signal', async () => {
    const fetchMock = respond(json(managedPreview));
    const signal = new AbortController().signal;
    const sourceDirectory = '/Local Plugins/Notes Tool ';
    await expect(previewManagedPlugin(sourceDirectory, signal)).resolves.toEqual(managedPreview);
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith(`${managedPath}/preview`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sourceDirectory }),
      signal,
    });
  });

  it.each([
    { ...importReview, preview: { ...managedPreview, expectedInstallSequence: -1 } },
    { ...rollbackReview, expectedInstallSequence: 0.5 },
    { ...rollbackReview, expectedTrustSequence: Number.MAX_SAFE_INTEGER + 1 },
  ] satisfies ManagedReview[])(
    'rejects an invalid expected sequence before preparing $kind',
    (review) => {
      expect(() => prepareManagedRequest(review, requestId)).toThrow(PluginApiError);
    },
  );

  it('keeps the frozen Desktop URL, serialized manifest, and target through exact retry', async () => {
    const bridge = { isDesktop: true, serverUrl: 'http://127.0.0.1:9999/' };
    Object.defineProperty(window, 'weaveDesktop', { configurable: true, value: bridge });
    const review = structuredClone(rollbackReview);
    const prepared = prepareManagedRequest(review, requestId);
    const body = prepared.body;
    expect(Object.isFrozen(prepared)).toBe(true);
    expect(Object.isFrozen(prepared.target)).toBe(true);
    bridge.serverUrl = 'http://127.0.0.1:8888';
    review.manifest.contributes.tools.reverse();
    const fetchMock = respond(
      json(committed({ kind: 'activate', digest: firstDigest, intent: 'rollback' })),
    );
    await sendManagedRequest(prepared);
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith(
      `http://127.0.0.1:9999${managedPath}/${managedPluginId}/activate`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body },
    );
    expect(JSON.parse(body).manifest.contributes.tools).toEqual(['write-note', 'read-note']);
  });
});

describe('managed catalog observations', () => {
  const emptyCatalog = {
    ...managedCatalog,
    heads: { installSequence: 0, trustSequence: 0, operationSequence: 0 },
    plugins: [],
  };

  it('reads a valid empty catalog as enabled', async () => {
    const fetchMock = respond(json(emptyCatalog));
    const signal = new AbortController().signal;
    await expect(fetchManagedCatalog(signal)).resolves.toEqual({
      kind: 'enabled',
      catalog: emptyCatalog,
    });
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith(managedPath, { method: 'GET', signal });
  });

  it('preserves the manifest, optional fields and array order in a populated catalog', async () => {
    respond(json(managedCatalog));
    await expect(fetchManagedCatalog()).resolves.toEqual({
      kind: 'enabled',
      catalog: managedCatalog,
    });
  });

  it('accepts the public Generation block pair', async () => {
    const catalog = {
      ...managedCatalog,
      generation: { ...managedGeneration, acceptingRuns: false, blocked: generationBlock },
    };
    respond(json(catalog));
    await expect(fetchManagedCatalog()).resolves.toEqual({ kind: 'enabled', catalog });
  });

  it('recognizes the explicit disabled status and code', async () => {
    respond(json({ error: { code: 'plugin-installer-disabled', message: 'Unavailable' } }, 404));
    await expect(fetchManagedCatalog()).resolves.toEqual({ kind: 'disabled' });
  });

  it('classifies the fixed Hono GET fallback as legacy only on the managed catalog', async () => {
    respond(new Response('404 Not Found', { status: 404 }));
    await expect(fetchManagedCatalog()).resolves.toEqual({ kind: 'legacy' });
    respond(new Response('404 Not Found', { status: 404 }));
    await expect(previewManagedPlugin('/plugins')).rejects.toMatchObject({
      code: 'plugin-request-failed',
      status: 404,
    });
  });

  it.each([
    ['unknown JSON 404', () => json({ error: { code: 'unknown', message: 'Unknown' } }, 404), 404],
    ['extended fallback text', () => new Response('404 Not Found\n', { status: 404 }), 404],
    [
      'fallback text with HTML media type',
      () =>
        new Response('404 Not Found', { status: 404, headers: { 'Content-Type': 'text/html' } }),
      404,
    ],
    ['success payload with status 201', () => json(emptyCatalog, 201), 201],
  ])('reports %s as a recoverable catalog failure', async (_name, response, status) => {
    respond(response());
    await expect(fetchManagedCatalog()).rejects.toMatchObject({
      code: 'plugin-request-failed',
      status,
    });
  });

  it.each([
    ['missing generation', { heads: emptyCatalog.heads, plugins: [] }],
    ['duplicate plugin IDs with different active membership', duplicatePluginCatalog],
    [
      'unsafe head',
      {
        ...emptyCatalog,
        heads: { ...emptyCatalog.heads, installSequence: Number.MAX_SAFE_INTEGER + 1 },
      },
    ],
    ['fractional head', { ...emptyCatalog, heads: { ...emptyCatalog.heads, trustSequence: 0.5 } }],
    ['zero Generation ID', { ...emptyCatalog, generation: { ...managedGeneration, id: 0 } }],
    [
      'candidate from another plugin',
      {
        ...managedCatalog,
        plugins: [
          {
            ...managedPlugin,
            candidates: [
              {
                ...firstCandidate,
                manifest: { ...firstCandidate.manifest, id: 'other', contributes: {} },
              },
              secondCandidate,
            ],
          },
        ],
      },
    ],
    [
      'wrong sequence for the selected digest',
      {
        ...managedCatalog,
        plugins: [
          {
            ...managedPlugin,
            selection: {
              ...managedPlugin.selection,
              candidateImportSequence: firstCandidate.importSequence,
            },
          },
        ],
      },
    ],
    [
      'trust for a different digest',
      {
        ...managedCatalog,
        plugins: [{ ...managedPlugin, trust: { ...managedPlugin.trust, digest: firstDigest } }],
      },
    ],
    [
      'active from a different plugin',
      {
        ...managedCatalog,
        plugins: [{ ...managedPlugin, active: { ...firstActive, pluginId: 'other' } }],
      },
    ],
    [
      'active absent from candidate history',
      {
        ...managedCatalog,
        plugins: [{ ...managedPlugin, active: { ...firstActive, digest: 'c'.repeat(64) } }],
      },
    ],
    [
      'leaked candidate path',
      {
        ...managedCatalog,
        plugins: [
          {
            ...managedPlugin,
            candidates: [
              { ...firstCandidate, payloadPath: '/private/plugin' },
              ...managedPlugin.candidates.slice(1),
            ],
          },
        ],
      },
    ],
  ])('rejects a 200 catalog with %s', async (_name, payload) => {
    respond(json(payload));
    await expect(fetchManagedCatalog()).rejects.toMatchObject({
      code: 'plugin-invalid-response',
      status: 200,
    });
  });

  it.each([
    ['unknown code', { ...generationBlock, code: 'unexpected-issue' }],
    [
      'private message',
      { ...generationBlock, message: 'Synthetic diagnostic for /private/example' },
    ],
  ])('rejects a Generation block pair with an invalid %s', async (_name, blocked) => {
    respond(
      json({
        ...managedCatalog,
        generation: { ...managedGeneration, acceptingRuns: false, blocked },
      }),
    );
    await expect(fetchManagedCatalog()).rejects.toMatchObject({
      code: 'plugin-invalid-response',
      status: 200,
    });
  });
});

describe('managed receipt decoding', () => {
  it.each([
    { ...committed(), current: duplicatePluginCatalog },
    {
      kind: 'replayed',
      decision: managedDecision(importTarget),
      application: { status: 'unknown' },
      current: duplicatePluginCatalog,
    },
  ])('rejects a $kind receipt with duplicate IDs in its current catalog', async (receipt) => {
    respond(json(receipt));
    await expect(
      sendManagedRequest(prepareManagedRequest(importReview, requestId)),
    ).rejects.toMatchObject({
      code: 'plugin-invalid-response',
      status: 200,
    });
  });

  it.each([adoptionIssue, preparationIssue])(
    'accepts the public application issue $code',
    async (issue) => {
      const receipt = committed();
      const response = {
        ...receipt,
        application: { ...receipt.application, status: 'failed', issue },
      };
      respond(json(response));
      await expect(
        sendManagedRequest(prepareManagedRequest(importReview, requestId)),
      ).resolves.toEqual(response);
    },
  );

  it.each([
    ['unknown code', { ...adoptionIssue, code: 'unexpected-issue' }],
    ['private message', { ...adoptionIssue, message: 'Synthetic diagnostic for /private/example' }],
    ['message for a different code', { ...adoptionIssue, message: preparationIssue.message }],
  ])('rejects an application failure pair with an invalid %s', async (_name, issue) => {
    const receipt = committed();
    respond(json({ ...receipt, application: { ...receipt.application, status: 'failed', issue } }));
    await expect(
      sendManagedRequest(prepareManagedRequest(importReview, requestId)),
    ).rejects.toMatchObject({
      code: 'plugin-invalid-response',
      status: 200,
    });
  });

  it('retains the actual older active version after a committed uninstall', async () => {
    const receipt = committed({ kind: 'uninstall', digest: secondDigest, immediate: true });
    const uninstalled = { ...managedPlugin, selection: null, trust: null };
    const response = {
      ...receipt,
      decision: { ...receipt.decision, selection: null, trust: null },
      application: {
        ...receipt.application,
        status: 'failed',
        issue: {
          code: 'plugin-reload-failed',
          message: 'Managed plugin Generation publication failed.',
        },
      },
      current: { ...receipt.current, plugins: [uninstalled] },
    };
    respond(json(response));
    const review = {
      ...selectionReview,
      kind: 'uninstall',
      selectedDigest: secondDigest,
      immediate: true,
    } satisfies ManagedReview;
    await expect(sendManagedRequest(prepareManagedRequest(review, requestId))).resolves.toEqual(
      response,
    );
  });

  it('retains a replay decision alongside newer, different current authority', async () => {
    const currentPlugin = {
      ...managedPlugin,
      selection: firstSelection,
      trust: { digest: firstDigest, enabled: false },
    };
    const response = {
      kind: 'replayed',
      decision: managedDecision(importTarget),
      application: { status: 'unknown' },
      current: {
        ...managedCatalog,
        heads: { installSequence: 7, trustSequence: 8, operationSequence: 9 },
        plugins: [currentPlugin],
      },
    } satisfies ManagedMutationResponse;
    respond(json(response));
    await expect(
      sendManagedRequest(prepareManagedRequest(importReview, requestId)),
    ).resolves.toEqual(response);
  });

  it.each([
    ['request ID', { requestId: 'other-review' }],
    ['plugin ID', { pluginId: 'other-plugin' }],
    ['command', { target: { kind: 'enable', digest: secondDigest } }],
    ['import digest', { target: { kind: 'import', digest: firstDigest } }],
    ['unsafe operation sequence', { operationSequence: Number.MAX_SAFE_INTEGER + 1 }],
    ['fractional install event sequence', { installEventSequence: 2.5 }],
    ['zero trust event sequence', { trustEventSequence: 0 }],
  ])('rejects a 200 receipt with an invalid %s', async (_name, fields) => {
    const receipt = committed();
    respond(json({ ...receipt, decision: { ...receipt.decision, ...fields } }));
    await expect(
      sendManagedRequest(prepareManagedRequest(importReview, requestId)),
    ).rejects.toMatchObject({ code: 'plugin-invalid-response', status: 200 });
  });

  it.each([
    {
      name: 'activation intent',
      review: rollbackReview,
      target: { kind: 'activate', digest: firstDigest, intent: 'activate' },
    },
    {
      name: 'immediate flag',
      review: { ...selectionReview, kind: 'uninstall', selectedDigest: null, immediate: true },
      target: { kind: 'uninstall', digest: null, immediate: false },
    },
  ] satisfies Array<{
    name: string;
    review: ManagedReview;
    target: ManagedMutationResponse['decision']['target'];
  }>)('rejects the wrong $name', async ({ review, target }) => {
    respond(json(committed(target)));
    await expect(
      sendManagedRequest(prepareManagedRequest(review, requestId)),
    ).rejects.toMatchObject({ code: 'plugin-invalid-response', status: 200 });
  });

  it.each([
    [
      'application generation',
      { ...committed().application, generation: { ...managedGeneration, acceptingRuns: false } },
    ],
    [
      'application active',
      { ...committed().application, active: { ...firstActive, activationSequence: 3 } },
    ],
  ])('rejects mismatched %s in the fresh receipt', async (_name, application) => {
    respond(json({ ...committed(), application }));
    await expect(
      sendManagedRequest(prepareManagedRequest(importReview, requestId)),
    ).rejects.toMatchObject({ code: 'plugin-invalid-response', status: 200 });
  });
});

describe('managed request failures', () => {
  it.each([
    ['403 guard', 403, 'forbidden-origin', 'forbidden-origin'],
    ['415 guard', 415, 'unsupported-media-type', 'unsupported-media-type'],
    ['authority conflict', 409, 'plugin-authority-conflict', 'plugin-authority-conflict'],
    ['authority busy', 503, 'plugin-authority-busy', 'plugin-authority-busy'],
    ['disabled on the wrong status', 409, 'plugin-installer-disabled', 'plugin-request-failed'],
    ['unknown status/code pair', 422, 'plugin-authority-conflict', 'plugin-request-failed'],
    ['known error code on HTTP 200', 200, 'plugin-authority-conflict', 'plugin-invalid-response'],
  ])(
    'classifies %s using both HTTP status and code',
    async (_name, status, sentCode, expectedCode) => {
      respond(json({ error: { code: sentCode, message: 'Server message' } }, status));
      await expect(
        sendManagedRequest(prepareManagedRequest(importReview, requestId)),
      ).rejects.toMatchObject({ code: expectedCode, status });
    },
  );

  it.each([
    [
      'non-JSON 200',
      () => new Response('unparseable', { status: 200 }),
      'plugin-invalid-response',
      200,
    ],
    ['empty 204', () => new Response(null, { status: 204 }), 'plugin-request-failed', 204],
    ['receipt with status 202', () => json(committed(), 202), 'plugin-request-failed', 202],
  ])('rejects a durable command response containing %s', async (_name, response, code, status) => {
    respond(response());
    await expect(
      sendManagedRequest(prepareManagedRequest(importReview, requestId)),
    ).rejects.toMatchObject({ code, status });
  });

  it.each([
    ['source path', { ...managedPreview, sourceDirectory: '/private/plugin' }],
    ['fractional expected head', { ...managedPreview, expectedInstallSequence: 2.5 }],
    [
      'nonpositive file count',
      { ...managedPreview, candidate: { ...managedPreview.candidate, files: 0 } },
    ],
    [
      'negative byte count',
      { ...managedPreview, candidate: { ...managedPreview.candidate, bytes: -1 } },
    ],
    [
      'extra declaration field',
      {
        ...managedPreview,
        candidate: {
          ...managedPreview.candidate,
          manifest: {
            ...managedManifest,
            contributes: { ...managedManifest.contributes, entry: 'private/entry.mjs' },
          },
        },
      },
    ],
  ])('rejects a preview containing an invalid %s', async (_name, preview) => {
    respond(json(preview));
    await expect(previewManagedPlugin('/plugins')).rejects.toMatchObject({
      code: 'plugin-invalid-response',
      status: 200,
    });
  });

  it('wraps a durable Fetch exception as a recoverable network error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('/private/internal/socket')));
    const error = await sendManagedRequest(prepareManagedRequest(importReview, requestId)).catch(
      (failure: unknown) => failure,
    );
    expect(error).toBeInstanceOf(PluginApiError);
    expect(error).toMatchObject({ code: 'plugin-network', status: 0 });
    expect((error as Error).message).not.toContain('/private');
  });

  it('propagates preview aborts', async () => {
    const controller = new AbortController();
    controller.abort();
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(controller.signal.reason));
    await expect(previewManagedPlugin('/plugins', controller.signal)).rejects.toBe(
      controller.signal.reason,
    );
  });
});

it('retains governed Skill declarations when reviewing managed candidates', () => {
  const result = managedManifestSchema.parse({
    ...managedManifest,
    capabilities: ['skill'],
    contributes: { skills: ['team-review'] },
  });
  expect(result.contributes.skills).toEqual(['team-review']);
});
