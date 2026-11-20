import type { PluginManifest } from '@weave/plugin';
import { describe, expect, it } from 'vitest';

import type { LocalPluginCandidate, ReadyLocalPlugin } from '../src/discovery.js';
import {
  createMemoryTrustStore,
  diffManifests,
  foldTrust,
  pluginTrustEventSchema,
  recordedPluginTrustEventSchema,
  resolveLocalPlugins,
  type PluginTrustEvent,
  type RecordedPluginTrustEvent,
} from '../src/trust.js';

const digestA = 'a'.repeat(64);
const digestB = 'b'.repeat(64);

function manifest(over: Partial<PluginManifest> = {}): PluginManifest {
  return {
    id: 'notes',
    name: 'Notes',
    version: '1.0.0',
    apiVersion: '1.0.0',
    capabilities: ['tool', 'command'],
    contributes: { tools: ['note'], commands: ['recap'], hooks: ['weave.tools.policy'] },
    permissions: ['workspace:read'],
    ...over,
  };
}

let sequence = 0;
function recorded(
  event: PluginTrustEvent,
  at = '2026-11-21T00:00:00.000Z',
): RecordedPluginTrustEvent {
  sequence += 1;
  return { ...event, sequence, occurredAt: at, scope: 'user' };
}
const trusted = (pluginId: string, digest = digestA, over: Partial<PluginManifest> = {}) =>
  ({ kind: 'trusted', pluginId, digest, manifest: manifest({ id: pluginId, ...over }) }) as const;

function ready(id: string, digest = digestA): ReadyLocalPlugin {
  return {
    status: 'ready',
    id,
    directory: `/plugins/${id}`,
    manifest: manifest({ id }),
    entry: `/plugins/${id}/index.js`,
    digest,
  };
}

describe('pluginTrustEventSchema', () => {
  it.each<[string, unknown]>([
    ['trusted', trusted('notes')],
    ['revoked', { kind: 'revoked', pluginId: 'notes' }],
    ['enabled', { kind: 'enabled', pluginId: 'notes' }],
    ['disabled', { kind: 'disabled', pluginId: 'notes' }],
  ])('accepts a %s event', (_kind, event) => {
    expect(pluginTrustEventSchema.parse(event)).toEqual(event);
  });

  it.each<[string, unknown]>([
    ['an unknown kind', { kind: 'blessed', pluginId: 'notes' }],
    ['no plugin id', { kind: 'revoked' }],
    ['an empty plugin id', { kind: 'revoked', pluginId: '' }],
    ['a trusted event without a digest', { ...trusted('notes'), digest: undefined }],
    ['a digest that is not lowercase hex', { ...trusted('notes'), digest: 'ABC' }],
    ['a short digest', { ...trusted('notes'), digest: 'a'.repeat(63) }],
    ['a trusted event without a manifest', { kind: 'trusted', pluginId: 'notes', digest: digestA }],
    ['an invalid manifest', { ...trusted('notes'), manifest: { id: 'x' } }],
    ['an unknown field', { kind: 'enabled', pluginId: 'notes', reason: 'because' }],
  ])('rejects %s', (_label, event) => {
    expect(pluginTrustEventSchema.safeParse(event).success).toBe(false);
  });
});

describe('recordedPluginTrustEventSchema', () => {
  it('accepts a stored event and rejects one the store did not number', () => {
    const stored = recorded({ kind: 'revoked', pluginId: 'notes' });

    expect(recordedPluginTrustEventSchema.parse(stored)).toEqual(stored);
    expect(
      recordedPluginTrustEventSchema.safeParse({ kind: 'revoked', pluginId: 'notes' }).success,
    ).toBe(false);
    expect(recordedPluginTrustEventSchema.safeParse({ ...stored, sequence: 0 }).success).toBe(
      false,
    );
    expect(recordedPluginTrustEventSchema.safeParse({ ...stored, scope: 'project' }).success).toBe(
      false,
    );
  });
});

describe('createMemoryTrustStore', () => {
  it('numbers events from 1 and stamps them with the clock', async () => {
    const store = createMemoryTrustStore({ now: () => new Date('2026-11-21T08:00:00.000Z') });

    const first = await store.append(trusted('notes'));
    const second = await store.append({ kind: 'disabled', pluginId: 'notes' });

    expect(first).toMatchObject({
      sequence: 1,
      occurredAt: '2026-11-21T08:00:00.000Z',
      scope: 'user',
      kind: 'trusted',
    });
    expect(second.sequence).toBe(2);
    expect(await store.events()).toEqual([first, second]);
  });

  it('hands back events that cannot be changed, and a copy of the log', async () => {
    const store = createMemoryTrustStore();
    const event = await store.append({ kind: 'enabled', pluginId: 'notes' });

    expect(Object.isFrozen(event)).toBe(true);
    const events = await store.events();
    expect(Object.isFrozen(events)).toBe(true);
    await store.append({ kind: 'disabled', pluginId: 'notes' });
    expect(events).toHaveLength(1);
  });

  it('refuses an event that is not valid and keeps nothing', async () => {
    const store = createMemoryTrustStore();

    await expect(
      store.append({ kind: 'blessed', pluginId: 'notes' } as never),
    ).rejects.toThrowError(TypeError);
    expect(await store.events()).toEqual([]);
  });

  it('keeps only what the schema allows: a caller cannot choose the sequence', async () => {
    const store = createMemoryTrustStore();

    await expect(
      store.append({ kind: 'enabled', pluginId: 'notes', sequence: 99 } as never),
    ).rejects.toThrowError(TypeError);
    expect(await store.events()).toEqual([]);
  });
});

describe('foldTrust', () => {
  const fold = (...events: PluginTrustEvent[]) => foldTrust(events.map((event) => recorded(event)));

  it('knows nothing without events', () => {
    expect(foldTrust([]).size).toBe(0);
  });

  it('trusts a plugin enabled, with the digest and the declarations that were reviewed', () => {
    const records = foldTrust([recorded(trusted('notes'), '2026-11-21T01:00:00.000Z')]);

    expect(records.get('notes')).toEqual({
      pluginId: 'notes',
      digest: digestA,
      manifest: manifest(),
      trustedAt: '2026-11-21T01:00:00.000Z',
      enabled: true,
    });
  });

  it('keeps plugins apart', () => {
    const records = fold(trusted('a'), trusted('b', digestB), { kind: 'disabled', pluginId: 'a' });

    expect(records.get('a')?.enabled).toBe(false);
    expect(records.get('b')).toMatchObject({ digest: digestB, enabled: true });
  });

  it.each<[string, PluginTrustEvent[], boolean | 'untrusted']>([
    ['a trust', [trusted('notes')], true],
    ['a trust then disabled', [trusted('notes'), { kind: 'disabled', pluginId: 'notes' }], false],
    [
      'disabled then enabled again',
      [
        trusted('notes'),
        { kind: 'disabled', pluginId: 'notes' },
        { kind: 'enabled', pluginId: 'notes' },
      ],
      true,
    ],
    [
      'a repeated disable',
      [
        trusted('notes'),
        { kind: 'disabled', pluginId: 'notes' },
        { kind: 'disabled', pluginId: 'notes' },
      ],
      false,
    ],
    [
      'a trust then revoked',
      [trusted('notes'), { kind: 'revoked', pluginId: 'notes' }],
      'untrusted',
    ],
    [
      'revoked then trusted again',
      [trusted('notes'), { kind: 'revoked', pluginId: 'notes' }, trusted('notes')],
      true,
    ],
    [
      'a switch before any trust',
      [
        { kind: 'disabled', pluginId: 'notes' },
        { kind: 'enabled', pluginId: 'notes' },
      ],
      'untrusted',
    ],
    ['a revoke of what was never trusted', [{ kind: 'revoked', pluginId: 'notes' }], 'untrusted'],
    [
      'a switch before the trust it precedes',
      [{ kind: 'disabled', pluginId: 'notes' }, trusted('notes')],
      true,
    ],
    [
      'a re-trust after a disable, which switches it on',
      [trusted('notes'), { kind: 'disabled', pluginId: 'notes' }, trusted('notes', digestB)],
      true,
    ],
    [
      'a switch after revoke, which means nothing',
      [
        trusted('notes'),
        { kind: 'revoked', pluginId: 'notes' },
        { kind: 'enabled', pluginId: 'notes' },
      ],
      'untrusted',
    ],
  ])('%s', (_label, events, expected) => {
    const record = fold(...events).get('notes');

    expect(record === undefined ? 'untrusted' : record.enabled).toBe(expected);
  });

  it('keeps the latest trust: its digest and declarations replace the earlier ones', () => {
    const records = fold(
      trusted('notes', digestA, { version: '1.0.0' }),
      trusted('notes', digestB, { version: '2.0.0' }),
    );

    expect(records.get('notes')).toMatchObject({
      digest: digestB,
      manifest: { version: '2.0.0' },
    });
  });

  it('applies events in sequence order whatever order they arrive in', () => {
    const events = [
      recorded(trusted('notes')),
      recorded({ kind: 'disabled', pluginId: 'notes' }),
      recorded({ kind: 'revoked', pluginId: 'notes' }),
    ];

    expect(foldTrust([...events].reverse()).has('notes')).toBe(false);
    expect(foldTrust(events).has('notes')).toBe(false);
  });
});

describe('resolveLocalPlugins', () => {
  const records = (...events: PluginTrustEvent[]) =>
    foldTrust(events.map((event) => recorded(event)));

  it('leaves a plugin nobody trusted waiting for trust', () => {
    const [resolved] = resolveLocalPlugins([ready('notes')], records());

    expect(resolved).toMatchObject({ id: 'notes', state: 'pending-trust', trusted: undefined });
  });

  it('lets a plugin load when it is trusted, switched on and unchanged', () => {
    const trust = records(trusted('notes'));

    const [resolved] = resolveLocalPlugins([ready('notes')], trust);

    expect(resolved).toMatchObject({ state: 'eligible', trusted: trust.get('notes') });
  });

  it('calls a plugin changed when its content is not what was trusted', () => {
    const [resolved] = resolveLocalPlugins([ready('notes', digestB)], records(trusted('notes')));

    expect(resolved?.state).toBe('changed');
    expect(resolved?.trusted?.digest).toBe(digestA);
  });

  it('calls a switched-off plugin disabled', () => {
    const [resolved] = resolveLocalPlugins(
      [ready('notes')],
      records(trusted('notes'), { kind: 'disabled', pluginId: 'notes' }),
    );

    expect(resolved?.state).toBe('disabled');
  });

  it('asks for a new review of a switched-off plugin whose content changed', () => {
    const [resolved] = resolveLocalPlugins(
      [ready('notes', digestB)],
      records(trusted('notes'), { kind: 'disabled', pluginId: 'notes' }),
    );

    expect(resolved?.state).toBe('changed');
  });

  it('puts a revoked plugin back to waiting for trust', () => {
    const [resolved] = resolveLocalPlugins(
      [ready('notes')],
      records(trusted('notes'), { kind: 'revoked', pluginId: 'notes' }),
    );

    expect(resolved).toMatchObject({ state: 'pending-trust', trusted: undefined });
  });

  it('keeps invalid and incompatible plugins as they are, whatever was trusted', () => {
    const candidates: LocalPluginCandidate[] = [
      {
        status: 'invalid',
        id: 'notes',
        directory: '/plugins/a',
        issue: { code: 'x', message: 'm' },
      },
      {
        status: 'incompatible',
        id: 'other',
        directory: '/plugins/b',
        manifest: manifest({ id: 'other' }),
        issue: { code: 'y', message: 'm' },
      },
    ];

    const resolved = resolveLocalPlugins(candidates, records(trusted('notes'), trusted('other')));

    expect(resolved.map((item) => [item.id, item.state])).toEqual([
      ['notes', 'invalid'],
      ['other', 'incompatible'],
    ]);
  });

  it('keeps the order of the candidates and returns each candidate itself', () => {
    const candidates = [ready('b'), ready('a')];

    const resolved = resolveLocalPlugins(candidates, records());

    expect(resolved.map((item) => item.id)).toEqual(['b', 'a']);
    expect(resolved[0]?.candidate).toBe(candidates[0]);
  });
});

describe('diffManifests', () => {
  it('finds no change between equal manifests', () => {
    const diff = diffManifests(manifest(), manifest());

    expect(diff.changed).toBe(false);
    expect(diff.version).toBeUndefined();
    expect(diff.permissions).toEqual({ added: [], removed: [] });
    expect(diff.capabilities).toEqual({ added: [], removed: [] });
    expect(
      Object.values(diff.contributes).every((d) => d.added.length + d.removed.length === 0),
    ).toBe(true);
  });

  it('reports a version change', () => {
    const diff = diffManifests(manifest(), manifest({ version: '1.1.0' }));

    expect(diff.version).toEqual({ from: '1.0.0', to: '1.1.0' });
    expect(diff.changed).toBe(true);
  });

  it('reports what was added and what was removed in each list', () => {
    const before = manifest();
    const after = manifest({
      capabilities: ['tool', 'prompt'],
      contributes: {
        tools: ['note', 'search'],
        commands: [],
        promptSections: ['style'],
        hooks: ['weave.tools.policy', 'weave.llm.request'],
      },
      permissions: ['workspace:read', 'process:spawn'],
    });

    const diff = diffManifests(before, after);

    expect(diff.capabilities).toEqual({ added: ['prompt'], removed: ['command'] });
    expect(diff.contributes.tools).toEqual({ added: ['search'], removed: [] });
    expect(diff.contributes.commands).toEqual({ added: [], removed: ['recap'] });
    expect(diff.contributes.promptSections).toEqual({ added: ['style'], removed: [] });
    expect(diff.contributes.hooks).toEqual({ added: ['weave.llm.request'], removed: [] });
    expect(diff.contributes.providers).toEqual({ added: [], removed: [] });
    expect(diff.permissions).toEqual({ added: ['process:spawn'], removed: [] });
    expect(diff.changed).toBe(true);
  });

  it('treats a missing list as empty', () => {
    const diff = diffManifests(
      manifest({ contributes: undefined, permissions: undefined }),
      manifest(),
    );

    expect(diff.contributes.tools.added).toEqual(['note']);
    expect(diff.permissions.added).toEqual(['workspace:read']);
  });

  it('does not count a different name, description or engines range as a change', () => {
    const diff = diffManifests(
      manifest(),
      manifest({ name: 'Notes 2', description: 'now with a description', engines: { weave: '*' } }),
    );

    expect(diff.changed).toBe(false);
  });

  it('keeps each list in the order of the manifest it comes from', () => {
    const diff = diffManifests(
      manifest({ permissions: ['workspace:read', 'network:request'] }),
      manifest({ permissions: ['process:spawn', 'workspace:write', 'workspace:read'] }),
    );

    expect(diff.permissions).toEqual({
      added: ['process:spawn', 'workspace:write'],
      removed: ['network:request'],
    });
  });
});
