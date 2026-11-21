import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  canonicalizeManagedRequest,
  canonicalJson,
  detachAndFreeze,
} from '../src/plugin-authority-data.js';
import {
  managedPreparationSchema,
  managedRequestSchema,
  PluginAuthorityError,
  pluginAuthorityOptionsSchema,
  pluginDatabaseIdentitySchema,
  recordedManagedOperationSchema,
  recordedPluginInstallEventSchema,
  type PluginAuthoritySnapshot,
} from '../src/plugin-authority-types.js';
import {
  activateInput,
  artifact as fixtureArtifact,
  decisionInput,
  importInput,
} from './support/plugin-authority-fixtures.js';

const digest = 'a'.repeat(64);
const anotherDigest = 'b'.repeat(64);
const manifest = {
  id: 'notes',
  name: 'Notes',
  version: '1.0.0',
  apiVersion: '1.0.0',
  capabilities: ['command'],
  contributes: { commands: ['notes'] },
  permissions: ['workspace:read'],
};
const artifact = { pluginId: 'notes', digest, manifest, files: 2, bytes: 128 };
const provenance = { kind: 'local-directory', sourceDirectory: '/tmp/weave-notes' };
const request = {
  requestId: 'import-a',
  command: { kind: 'import', previewId: 'preview-a', expectedInstallSequence: 0 },
};
const activation = {
  kind: 'activate',
  pluginId: 'notes',
  digest,
  manifest,
  previousSelection: null,
  expectedInstallSequence: 1,
  expectedTrustSequence: 0,
  intent: 'activate',
};
const recorded = {
  sequence: 1,
  occurredAt: '2026-11-21T10:00:00.000Z',
  scope: 'user',
};
const imported = {
  ...artifact,
  ...recorded,
  kind: 'imported',
  provenance,
  operationSequence: 1,
};
const emptyState = { selection: null, trust: null };
const operation = {
  ...recorded,
  version: 1,
  requestId: request.requestId,
  command: request.command,
  fingerprint: digest,
  evidence: { kind: 'import', artifact, provenance },
  decision: {
    kind: 'import',
    pluginId: 'notes',
    changed: true,
    before: { installSequence: 0, trustSequence: 0 },
    after: { installSequence: 1, trustSequence: 0 },
    pluginBefore: emptyState,
    pluginAfter: emptyState,
    links: { installEventSequence: 1, trustEventSequence: null },
  },
};

describe('static managed request identity', () => {
  it('canonicalizes the complete static command and fingerprints its UTF-8 bytes', () => {
    const result = canonicalizeManagedRequest(request);
    const expected =
      '{"command":{"expectedInstallSequence":0,"kind":"import","previewId":"preview-a"},"version":1}';
    expect(result.request).toEqual(request);
    expect(result.canonicalCommand).toBe(expected);
    expect(result.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(result.fingerprint).toBe(createHash('sha256').update(expected, 'utf8').digest('hex'));
    expect(canonicalizeManagedRequest({ ...request, requestId: 'another-request' })).toMatchObject({
      canonicalCommand: expected,
      fingerprint: result.fingerprint,
    });
  });

  it.each([
    ['unknown request field', { ...request, extra: true }],
    ['unknown command field', { ...request, command: { ...request.command, extra: true } }],
    ['unknown command kind', { ...request, command: { ...request.command, kind: 'reload' } }],
    ['empty request ID', { ...request, requestId: '' }],
    ['long request ID', { ...request, requestId: 'a'.repeat(201) }],
    ['empty preview ID', { ...request, command: { ...request.command, previewId: '' } }],
    [
      'long preview ID',
      { ...request, command: { ...request.command, previewId: 'a'.repeat(201) } },
    ],
    ['negative head', { ...request, command: { ...request.command, expectedInstallSequence: -1 } }],
    [
      'fractional head',
      { ...request, command: { ...request.command, expectedInstallSequence: 0.5 } },
    ],
    [
      'unsafe head',
      { ...request, command: { ...request.command, expectedInstallSequence: 2 ** 53 } },
    ],
    [
      'numeric head string',
      { ...request, command: { ...request.command, expectedInstallSequence: '0' } },
    ],
    ['unknown intent', { requestId: 'activate', command: { ...activation, intent: 'import' } }],
    [
      'missing explicit intent',
      { requestId: 'activate', command: { ...activation, intent: undefined } },
    ],
    [
      'invalid managed ID',
      { requestId: 'activate', command: { ...activation, pluginId: 'Notes!' } },
    ],
    [
      'mismatched manifest ID',
      { requestId: 'activate', command: { ...activation, pluginId: 'other' } },
    ],
    [
      'uppercase digest',
      { requestId: 'activate', command: { ...activation, digest: 'A'.repeat(64) } },
    ],
    ['short digest', { requestId: 'activate', command: { ...activation, digest: 'abc' } }],
    [
      'invalid previous digest',
      { requestId: 'activate', command: { ...activation, previousSelection: '' } },
    ],
    [
      'invalid manifest',
      {
        requestId: 'activate',
        command: { ...activation, manifest: { ...manifest, version: 'v1' } },
      },
    ],
    [
      'unknown manifest field',
      { requestId: 'activate', command: { ...activation, manifest: { ...manifest, extra: true } } },
    ],
    [
      'unsafe trust head',
      { requestId: 'activate', command: { ...activation, expectedTrustSequence: 2 ** 53 } },
    ],
  ])('rejects %s before canonicalization', (_name, input) => {
    expect(managedRequestSchema.safeParse(input).success).toBe(false);
    expect(() => canonicalizeManagedRequest(input)).toThrow(
      expect.objectContaining({ code: 'plugin-authority-invalid' }),
    );
  });

  it('accepts 200-character opaque IDs and preserves exact whitespace and case', () => {
    const result = canonicalizeManagedRequest({
      requestId: 'R'.repeat(200),
      command: { ...request.command, previewId: ` ${'P'.repeat(198)} ` },
    });
    expect(result.request.requestId).toBe('R'.repeat(200));
    expect(result.request.command).toMatchObject({ previewId: ` ${'P'.repeat(198)} ` });
  });

  it.each(['disable', 'revoke', 'uninstall'])('normalizes omitted %s timing to false', (kind) => {
    const command = {
      kind,
      pluginId: 'notes',
      selectedDigest: null,
      expectedInstallSequence: 1,
      expectedTrustSequence: 2,
    };
    const omitted = canonicalizeManagedRequest({ requestId: 'decision', command });
    const explicit = canonicalizeManagedRequest({
      requestId: 'decision',
      command: { ...command, immediate: false },
    });
    expect(omitted).toEqual(explicit);
    expect(omitted.request.command).toMatchObject({ immediate: false });
    expect(
      canonicalizeManagedRequest({
        requestId: 'decision',
        command: { ...command, immediate: true },
      }).fingerprint,
    ).not.toBe(omitted.fingerprint);
  });

  it('keeps every review field in the static identity', () => {
    const original = canonicalizeManagedRequest({ requestId: 'activate', command: activation });
    const changed = [
      { ...activation, digest: anotherDigest },
      { ...activation, manifest: { ...manifest, description: 'Changed review' } },
      { ...activation, previousSelection: anotherDigest },
      { ...activation, expectedInstallSequence: 2 },
      { ...activation, expectedTrustSequence: 1 },
      { ...activation, intent: 'rollback' },
    ];
    for (const command of changed) {
      const next = canonicalizeManagedRequest({ requestId: 'activate', command });
      expect(next.canonicalCommand).not.toBe(original.canonicalCommand);
      expect(next.fingerprint).not.toBe(original.fingerprint);
    }
    const originalImport = canonicalizeManagedRequest(request);
    expect(
      canonicalizeManagedRequest({
        ...request,
        command: { ...request.command, previewId: 'preview-b' },
      }).fingerprint,
    ).not.toBe(originalImport.fingerprint);
  });

  it('accepts exact enable selection but rejects missing, null or malformed selection', () => {
    const command = {
      kind: 'enable',
      pluginId: 'notes',
      selectedDigest: digest,
      expectedInstallSequence: 1,
      expectedTrustSequence: 1,
    };
    expect(managedRequestSchema.safeParse({ requestId: 'enable', command }).success).toBe(true);
    for (const selectedDigest of [undefined, null, '']) {
      expect(
        managedRequestSchema.safeParse({
          requestId: 'enable',
          command: { ...command, selectedDigest },
        }).success,
      ).toBe(false);
    }
  });

  it('treats object-key reordering and optional undefined manifest properties as equal', () => {
    const original = canonicalizeManagedRequest({ requestId: 'activate', command: activation });
    const reordered = canonicalizeManagedRequest({
      command: {
        ...activation,
        manifest: { permissions: manifest.permissions, ...manifest, description: undefined },
      },
      requestId: 'activate',
    });
    expect(reordered.canonicalCommand).toBe(original.canonicalCommand);
    expect(reordered.fingerprint).toBe(original.fingerprint);
  });
});

describe('managed evidence and persisted static shapes', () => {
  it.each(['import', 'activate', 'enable', 'disable', 'revoke', 'uninstall'])(
    'accepts %s preparation',
    (kind) => {
      const input =
        kind === 'import'
          ? { kind, artifact, provenance }
          : kind === 'activate' || kind === 'enable'
            ? { kind, artifact }
            : { kind };
      expect(managedPreparationSchema.safeParse(input).success).toBe(true);
    },
  );

  it.each([
    ['unknown kind', { kind: 'rollback', artifact }],
    ['unknown preparation field', { kind: 'disable', artifact }],
    ['missing artifact', { kind: 'activate' }],
    [
      'artifact execution path',
      { kind: 'enable', artifact: { ...artifact, path: '/tmp/payload' } },
    ],
    ['invalid managed ID', { kind: 'activate', artifact: { ...artifact, pluginId: '../notes' } }],
    ['mismatched manifest ID', { kind: 'activate', artifact: { ...artifact, pluginId: 'other' } }],
    [
      'missing contributes',
      {
        kind: 'activate',
        artifact: { ...artifact, manifest: { ...manifest, contributes: undefined } },
      },
    ],
    [
      'missing permissions',
      {
        kind: 'activate',
        artifact: { ...artifact, manifest: { ...manifest, permissions: undefined } },
      },
    ],
    ['zero files', { kind: 'activate', artifact: { ...artifact, files: 0 } }],
    ['negative files', { kind: 'activate', artifact: { ...artifact, files: -1 } }],
    ['fractional files', { kind: 'activate', artifact: { ...artifact, files: 0.5 } }],
    ['unsafe files', { kind: 'activate', artifact: { ...artifact, files: 2 ** 53 } }],
    ['negative bytes', { kind: 'activate', artifact: { ...artifact, bytes: -1 } }],
    ['unsafe bytes', { kind: 'activate', artifact: { ...artifact, bytes: 2 ** 53 } }],
    [
      'relative provenance',
      { kind: 'import', artifact, provenance: { ...provenance, sourceDirectory: 'notes' } },
    ],
    [
      'NUL provenance',
      { kind: 'import', artifact, provenance: { ...provenance, sourceDirectory: '/tmp/notes\0' } },
    ],
    [
      'empty provenance',
      { kind: 'import', artifact, provenance: { ...provenance, sourceDirectory: '' } },
    ],
    [
      'unknown provenance field',
      { kind: 'import', artifact, provenance: { ...provenance, realpath: '/tmp/notes' } },
    ],
  ])('rejects %s', (_name, input) => {
    expect(managedPreparationSchema.safeParse(input).success).toBe(false);
  });

  it('accepts zero bytes and absolute syntax without acquiring or normalizing a path', () => {
    const input = {
      kind: 'import',
      artifact: { ...artifact, bytes: 0 },
      provenance: { ...provenance, sourceDirectory: '/missing/../does-not-exist/notes' },
    };
    expect(managedPreparationSchema.parse(input)).toEqual(input);
  });

  it('validates a strict UUID identity and injectable dependencies without invoking them', () => {
    expect(
      pluginDatabaseIdentitySchema.parse({
        version: 1,
        databaseId: '94f3221b-623d-49da-92f0-daa608247dc5',
      }),
    ).toEqual({ version: 1, databaseId: '94f3221b-623d-49da-92f0-daa608247dc5' });
    for (const input of [
      { version: 2, databaseId: '94f3221b-623d-49da-92f0-daa608247dc5' },
      { version: 1, databaseId: 'not-a-uuid' },
      { version: 1, databaseId: '94f3221b-623d-49da-92f0-daa608247dc5', extra: true },
    ])
      expect(pluginDatabaseIdentitySchema.safeParse(input).success).toBe(false);
    const unexpectedCall = (): never => {
      throw new Error('Schema must not call dependencies');
    };
    expect(
      pluginAuthorityOptionsSchema.parse({
        filename: ':memory:',
        now: unexpectedCall,
        newDatabaseId: unexpectedCall,
      }),
    ).toMatchObject({ filename: ':memory:' });
    for (const input of [
      { filename: '' },
      { filename: ':memory:', now: new Date() },
      { filename: ':memory:', newDatabaseId: 'uuid' },
      { filename: ':memory:', extra: true },
    ])
      expect(pluginAuthorityOptionsSchema.safeParse(input).success).toBe(false);
  });

  it('accepts every installation fact with positive recorded and linked sequences', () => {
    const activated = {
      ...recorded,
      operationSequence: 2,
      kind: 'activated',
      pluginId: 'notes',
      digest,
      candidateImportSequence: 1,
      previousSelection: null,
      trustEventSequence: 1,
      intent: 'activate',
    };
    const uninstalled = {
      ...recorded,
      operationSequence: 3,
      kind: 'uninstalled',
      pluginId: 'notes',
      previousSelection: digest,
      trustEventSequence: 2,
    };
    for (const input of [imported, activated, uninstalled]) {
      expect(recordedPluginInstallEventSchema.parse(input)).toEqual(input);
    }
    for (const field of [
      'sequence',
      'operationSequence',
      'candidateImportSequence',
      'trustEventSequence',
    ]) {
      for (const value of [0, -1, 0.5, 2 ** 53]) {
        expect(
          recordedPluginInstallEventSchema.safeParse({ ...activated, [field]: value }).success,
        ).toBe(false);
      }
    }
    for (const occurredAt of ['', 'yesterday', '2026-11-21T10:00:00.000+00:00']) {
      expect(recordedPluginInstallEventSchema.safeParse({ ...imported, occurredAt }).success).toBe(
        false,
      );
    }
    expect(
      recordedPluginInstallEventSchema.safeParse({ ...imported, scope: 'project' }).success,
    ).toBe(false);
    expect(recordedPluginInstallEventSchema.safeParse({ ...imported, extra: true }).success).toBe(
      false,
    );
    expect(
      recordedPluginInstallEventSchema.safeParse({ ...imported, pluginId: 'other' }).success,
    ).toBe(false);
  });

  it('validates the operation envelope and nested decision without normalizing corrupt fields', () => {
    expect(recordedManagedOperationSchema.parse(operation)).toEqual(operation);
    for (const input of [
      { ...operation, version: 2 },
      { ...operation, sequence: 0 },
      { ...operation, requestId: '' },
      { ...operation, fingerprint: 'bad' },
      { ...operation, scope: 'project' },
      { ...operation, occurredAt: 'not-a-time' },
      { ...operation, extra: true },
      { ...operation, evidence: { kind: 'disable' } },
      { ...operation, decision: { ...operation.decision, kind: 'disable' } },
      { ...operation, decision: { ...operation.decision, changed: 'true' } },
      {
        ...operation,
        decision: { ...operation.decision, before: { installSequence: -1, trustSequence: 0 } },
      },
      {
        ...operation,
        decision: {
          ...operation.decision,
          links: { installEventSequence: 0, trustEventSequence: null },
        },
      },
      {
        ...operation,
        decision: {
          ...operation.decision,
          pluginBefore: {
            selection: { digest, candidateImportSequence: 0, activationSequence: 1 },
            trust: null,
          },
        },
      },
      {
        ...operation,
        decision: {
          ...operation.decision,
          pluginAfter: {
            selection: null,
            trust: { digest, manifest: { ...manifest, id: 'other' }, enabled: true },
          },
        },
      },
    ])
      expect(recordedManagedOperationSchema.safeParse(input).success).toBe(false);
  });

  it('requires persisted removal commands to contain the already normalized immediate field', () => {
    const command = {
      kind: 'disable',
      pluginId: 'notes',
      selectedDigest: null,
      expectedInstallSequence: 1,
      expectedTrustSequence: 0,
    };
    const input = {
      ...operation,
      command,
      evidence: { kind: 'disable' },
      decision: { ...operation.decision, kind: 'disable' },
    };
    expect(recordedManagedOperationSchema.safeParse(input).success).toBe(false);
    expect(
      recordedManagedOperationSchema.safeParse({
        ...input,
        command: { ...command, immediate: false },
      }).success,
    ).toBe(true);
  });

  it('preserves authority error code, message and internal cause', () => {
    const cause = new Error('private detail');
    const error = new PluginAuthorityError('plugin-authority-invalid', 'Invalid input', { cause });
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('PluginAuthorityError');
    expect(error.code).toBe('plugin-authority-invalid');
    expect(error.message).toBe('Invalid input');
    expect(error.cause).toBe(cause);
  });
});

describe('plain JSON data helpers', () => {
  it('sorts keys lexically at every depth while preserving array order and exact strings', () => {
    expect(
      canonicalJson({ z: ' Exact ', a: [{ z: 2, a: 1 }, 'b', 'a'], 2: 'two', 10: 'ten' }),
    ).toBe('{"10":"ten","2":"two","a":[{"a":1,"z":2},"b","a"],"z":" Exact "}');
    expect(canonicalJson({ omitted: undefined, kept: null })).toBe('{"kept":null}');
    expect(canonicalJson({ values: ['a', 'b'] })).not.toBe(canonicalJson({ values: ['b', 'a'] }));
  });

  it('treats array order in a reviewed manifest as meaningful', () => {
    const command = {
      ...activation,
      manifest: { ...manifest, permissions: ['workspace:read', 'workspace:write'] },
    };
    const original = canonicalizeManagedRequest({ requestId: 'activate', command });
    const reordered = canonicalizeManagedRequest({
      requestId: 'activate',
      command: {
        ...command,
        manifest: { ...command.manifest, permissions: ['workspace:write', 'workspace:read'] },
      },
    });
    expect(reordered.fingerprint).not.toBe(original.fingerprint);
  });

  it.each([
    ['undefined root', undefined],
    ['undefined array entry', [undefined]],
    ['sparse array', Array(1)],
    ['NaN', NaN],
    ['infinity', Infinity],
    ['negative infinity', -Infinity],
    ['bigint', 1n],
    ['function', () => undefined],
    ['symbol', Symbol('value')],
    ['Date', new Date()],
    ['Map', new Map()],
    ['Set', new Set()],
    ['typed array', new Uint8Array([1])],
    ['custom prototype', Object.create({ inherited: true })],
    ['nested invalid value', { a: { b: Infinity } }],
    ['custom JSON conversion', { toJSON: () => ({ value: 1 }) }],
  ])('rejects %s rather than silently changing its JSON meaning', (_name, input) => {
    expect(() => canonicalJson(input)).toThrow(
      expect.objectContaining({ code: 'plugin-authority-invalid' }),
    );
    expect(() => detachAndFreeze(input)).toThrow(
      expect.objectContaining({ code: 'plugin-authority-invalid' }),
    );
  });

  it('rejects cycles but accepts shared acyclic data as detached plain copies', () => {
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    expect(() => canonicalJson(cyclic)).toThrow(
      expect.objectContaining({ code: 'plugin-authority-invalid' }),
    );
    expect(() => detachAndFreeze(cyclic)).toThrow(
      expect.objectContaining({ code: 'plugin-authority-invalid' }),
    );
    const child = { value: 1 };
    expect(canonicalJson({ left: child, right: child })).toBe(
      '{"left":{"value":1},"right":{"value":1}}',
    );
  });

  it('rejects custom array prototypes instead of cloning an object with custom behavior', () => {
    class CustomArray extends Array<string> {}
    const input = new CustomArray('value');
    expect(() => canonicalJson(input)).toThrow(
      expect.objectContaining({ code: 'plugin-authority-invalid' }),
    );
    expect(() => detachAndFreeze(input)).toThrow(
      expect.objectContaining({ code: 'plugin-authority-invalid' }),
    );
  });

  it('clones plain data before recursively freezing all objects and arrays', () => {
    const source = { values: [{ label: 'original' }], omitted: undefined };
    const result = detachAndFreeze(source);
    source.values[0]!.label = 'changed';
    expect(result.values[0]!.label).toBe('original');
    expect(result).not.toBe(source);
    expect(result.values).not.toBe(source.values);
    expect(result.values[0]).not.toBe(source.values[0]);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.values)).toBe(true);
    expect(Object.isFrozen(result.values[0])).toBe(true);
    expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
    expect(Object.hasOwn(result, 'omitted')).toBe(false);
    expect(() => {
      result.values[0]!.label = 'mutated';
    }).toThrow(TypeError);
    expect(source.values[0]!.label).toBe('changed');
  });

  it('preserves special JSON object keys as ordinary detached data', () => {
    const source: unknown = JSON.parse('{"__proto__":{"polluted":true},"constructor":"data"}');
    expect(canonicalJson(source)).toBe('{"__proto__":{"polluted":true},"constructor":"data"}');
    const result = detachAndFreeze(source);
    expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
    expect(Object.hasOwn(result as object, '__proto__')).toBe(true);
    expect(result).toEqual(source);
  });

  it('returns detached normalized commands immune to later caller mutation', () => {
    const mutable = {
      requestId: 'activate',
      command: { ...activation, manifest: structuredClone(manifest) },
    };
    const result = canonicalizeManagedRequest(mutable);
    mutable.command.manifest.name = 'Changed';
    expect(result.request.command).toMatchObject({ manifest: { name: 'Notes' } });
    expect(Object.isFrozen(result.request)).toBe(true);
  });

  it('rejects non-JSON request objects before schema parsing can normalize or read them', () => {
    class RequestObject {
      requestId = request.requestId;
      command = request.command;
    }
    expect(() => canonicalizeManagedRequest(new RequestObject())).toThrow(
      expect.objectContaining({ code: 'plugin-authority-invalid' }),
    );
    let reads = 0;
    const input = {
      requestId: request.requestId,
      get command() {
        reads += 1;
        return request.command;
      },
    };
    expect(() => canonicalizeManagedRequest(input)).toThrow(
      expect.objectContaining({ code: 'plugin-authority-invalid' }),
    );
    expect(reads).toBe(0);
  });
});

describe('reusable review fixtures', () => {
  const identity = fixtureArtifact(anotherDigest, '2.0.0');
  const snapshot: PluginAuthoritySnapshot = {
    identity: { version: 1, databaseId: '94f3221b-623d-49da-92f0-daa608247dc5' },
    heads: { installSequence: 7, trustSequence: 9, operationSequence: 12 },
    trustEvents: [],
    installEvents: [],
    operationEvents: [],
    installations: [
      {
        pluginId: 'notes',
        firstImportSequence: 1,
        candidates: [
          {
            ...identity,
            firstImportSequence: 3,
            provenance: { kind: 'local-directory', sourceDirectory: '/tmp/notes' },
          },
        ],
        selection: { digest: anotherDigest, candidateImportSequence: 3, activationSequence: 7 },
      },
    ],
  };

  it('builds import and activation reviews from explicit inputs and current authority heads', () => {
    const importedInput = importInput('candidate', 5, identity);
    expect(importedInput.request).toEqual({
      requestId: 'candidate',
      command: {
        kind: 'import',
        previewId: 'candidate',
        expectedInstallSequence: 5,
      },
    });
    expect(importedInput.prepared).toMatchObject({
      kind: 'import',
      artifact: identity,
      provenance: { kind: 'local-directory' },
    });
    expect(managedPreparationSchema.safeParse(importedInput.prepared).success).toBe(true);
    expect(activateInput('rollback', snapshot, fixtureArtifact(), 'rollback').request).toEqual({
      requestId: 'rollback',
      command: {
        kind: 'activate',
        pluginId: 'notes',
        digest,
        manifest: fixtureArtifact().manifest,
        previousSelection: anotherDigest,
        expectedInstallSequence: 7,
        expectedTrustSequence: 9,
        intent: 'rollback',
      },
    });
  });

  it('binds decisions and enable artifact evidence to the selected candidate', () => {
    expect(decisionInput('enable', 'enable', snapshot)).toEqual({
      request: {
        requestId: 'enable',
        command: {
          kind: 'enable',
          pluginId: 'notes',
          selectedDigest: anotherDigest,
          expectedInstallSequence: 7,
          expectedTrustSequence: 9,
        },
      },
      prepared: { kind: 'enable', artifact: identity },
    });
    for (const kind of ['disable', 'revoke', 'uninstall'] as const) {
      expect(decisionInput(kind, 'remove', snapshot, true)).toEqual({
        request: {
          requestId: 'remove',
          command: {
            kind,
            pluginId: 'notes',
            selectedDigest: anotherDigest,
            expectedInstallSequence: 7,
            expectedTrustSequence: 9,
            immediate: true,
          },
        },
        prepared: { kind },
      });
    }
    expect(() => decisionInput('enable', 'enable', { ...snapshot, installations: [] })).toThrow(
      'Authority fixture enable requires a selection',
    );
  });
});
