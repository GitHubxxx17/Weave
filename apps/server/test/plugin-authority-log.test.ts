import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { RecordedPluginTrustEvent } from '@weave/plugin-host';
import { afterEach, describe, expect, it } from 'vitest';
import {
  appendManagedTransitionTx,
  initializeAuthoritySchemaTx,
  readAuthoritySnapshotTx,
  resolveManagedTransition,
} from '../src/plugin-authority-log.js';
import { canonicalizeManagedRequest } from '../src/plugin-authority-data.js';
import type {
  ManagedCommitInput,
  PluginAuthoritySnapshot,
  RecordedManagedOperation,
  RecordedPluginInstallEvent,
} from '../src/plugin-authority-types.js';
import { createTrustTableSync, appendRecordedTrustEventTx } from '../src/plugin-trust-sqlite.js';
import {
  activateInput,
  artifact,
  decisionInput,
  digestA,
  digestB,
  importInput,
} from './support/plugin-authority-fixtures.js';

const occurredAt = '2026-11-21T00:00:00.000Z';
const databaseId = 'ba4b95b9-83c4-49fc-a897-ae07dd0c99a2';
const databases: DatabaseSync[] = [];
const filenames: string[] = [];

function open(file?: string): DatabaseSync {
  const filename = file ?? join(tmpdir(), `weave-authority-log-${randomUUID()}.sqlite`);
  if (file === undefined) filenames.push(filename);
  const database = new DatabaseSync(filename);
  databases.push(database);
  return database;
}
function tx<T>(database: DatabaseSync, action: () => T): T {
  database.exec('BEGIN IMMEDIATE');
  try {
    const result = action();
    database.exec('COMMIT');
    return result;
  } catch (error: unknown) {
    if (database.isTransaction) database.exec('ROLLBACK');
    throw error;
  }
}
function initialized(): DatabaseSync {
  const database = open();
  tx(database, () => initializeAuthoritySchemaTx(database, () => databaseId));
  return database;
}
function empty(): PluginAuthoritySnapshot {
  return {
    identity: { version: 1, databaseId },
    heads: { installSequence: 0, trustSequence: 0, operationSequence: 0 },
    trustEvents: [],
    installEvents: [],
    operationEvents: [],
    installations: [],
  };
}
function imported(): PluginAuthoritySnapshot {
  const input = importInput('import-a', 0);
  const event: RecordedPluginInstallEvent = {
    kind: 'imported',
    ...artifact(),
    provenance:
      input.prepared.kind === 'import'
        ? input.prepared.provenance
        : { kind: 'local-directory', sourceDirectory: '/unused' },
    sequence: 1,
    occurredAt,
    scope: 'user',
    operationSequence: 1,
  };
  return {
    ...empty(),
    heads: { installSequence: 1, trustSequence: 0, operationSequence: 1 },
    installEvents: [event],
    installations: [
      {
        pluginId: 'notes',
        firstImportSequence: 1,
        candidates: [{ ...artifact(), provenance: event.provenance, firstImportSequence: 1 }],
        selection: null,
      },
    ],
  };
}
function selected(enabled = true): PluginAuthoritySnapshot {
  const before = imported();
  const trust: RecordedPluginTrustEvent = {
    kind: 'trusted',
    pluginId: 'notes',
    digest: digestA,
    manifest: artifact().manifest,
    sequence: 1,
    occurredAt,
    scope: 'user',
  };
  const activation: RecordedPluginInstallEvent = {
    kind: 'activated',
    pluginId: 'notes',
    digest: digestA,
    candidateImportSequence: 1,
    previousSelection: null,
    trustEventSequence: 1,
    intent: 'activate',
    sequence: 2,
    occurredAt,
    scope: 'user',
    operationSequence: 2,
  };
  return {
    ...before,
    heads: {
      installSequence: 2,
      trustSequence: enabled ? 1 : 2,
      operationSequence: enabled ? 2 : 3,
    },
    installEvents: [...before.installEvents, activation],
    trustEvents: enabled
      ? [trust]
      : [trust, { kind: 'disabled', pluginId: 'notes', sequence: 2, occurredAt, scope: 'user' }],
    installations: [
      {
        ...before.installations[0]!,
        selection: { digest: digestA, candidateImportSequence: 1, activationSequence: 2 },
      },
    ],
  };
}
function state(
  selection: PluginAuthoritySnapshot['installations'][number]['selection'],
  enabled: boolean | null,
) {
  return {
    selection,
    trust: enabled === null ? null : { digest: digestA, manifest: artifact().manifest, enabled },
  };
}
function apply(database: DatabaseSync, input: ManagedCommitInput) {
  return tx(database, () => {
    const transition = resolveManagedTransition(
      readAuthoritySnapshotTx(database),
      input,
      occurredAt,
    );
    appendManagedTransitionTx(database, transition);
    return readAuthoritySnapshotTx(database);
  });
}
function protocol(action: () => unknown): void {
  expect(action).toThrow(expect.objectContaining({ code: 'plugin-authority-protocol' }));
}
function replaceOperation(
  database: DatabaseSync,
  mutate: (event: RecordedManagedOperation) => unknown,
  sequence = 1,
): void {
  const row = database
    .prepare('SELECT event_json FROM plugin_operation_events WHERE sequence = ?')
    .get(sequence);
  const event = JSON.parse(String(row?.event_json)) as RecordedManagedOperation;
  database
    .prepare('UPDATE plugin_operation_events SET event_json = ? WHERE sequence = ?')
    .run(JSON.stringify(mutate(event)), sequence);
}

afterEach(async () => {
  for (const database of databases.splice(0)) if (database.isOpen) database.close();
  await Promise.all(filenames.splice(0).map((filename) => rm(filename, { force: true })));
});

describe('authority schema and complete log', () => {
  it('upgrades trust-only files additively and retains the database identity across reopen', () => {
    const database = open();
    createTrustTableSync(database);
    const old: RecordedPluginTrustEvent = {
      kind: 'trusted',
      pluginId: 'notes',
      digest: digestA,
      manifest: artifact().manifest,
      sequence: 1,
      occurredAt: 'legacy timestamp',
      scope: 'user',
    };
    appendRecordedTrustEventTx(database, old);
    database.exec('PRAGMA user_version = 17; CREATE TABLE unrelated (value TEXT NOT NULL)');
    database.prepare('INSERT INTO unrelated VALUES (?)').run('keep');
    expect(tx(database, () => initializeAuthoritySchemaTx(database, () => databaseId))).toEqual({
      version: 1,
      databaseId,
    });
    expect(readAuthoritySnapshotTx(database)).toEqual({
      ...empty(),
      heads: { installSequence: 0, trustSequence: 1, operationSequence: 0 },
      trustEvents: [old],
    });
    expect(database.prepare('PRAGMA user_version').get()?.user_version).toBe(17);
    expect(database.prepare('SELECT value FROM unrelated').get()?.value).toBe('keep');
    expect(
      JSON.parse(
        String(database.prepare('SELECT event_json FROM plugin_trust_events').get()?.event_json),
      ),
    ).toEqual(old);
    database.close();
    const reopened = open(filenames[0]);
    expect(
      tx(reopened, () =>
        initializeAuthoritySchemaTx(reopened, () => {
          throw new Error('must not generate another identity');
        }),
      ),
    ).toEqual({ version: 1, databaseId });
    expect(readAuthoritySnapshotTx(reopened).trustEvents).toEqual([old]);
  });

  it('initializes an empty database and permits unrelated indexes', () => {
    const database = initialized();
    database.exec('CREATE INDEX unrelated_index ON plugin_operation_events (occurred_at)');
    expect(readAuthoritySnapshotTx(database)).toEqual(empty());
  });

  it.each([
    'CREATE TABLE plugin_authority_identity (singleton INTEGER NOT NULL PRIMARY KEY, identity_json TEXT NOT NULL)',
    'CREATE TABLE plugin_install_events (sequence INTEGER NOT NULL PRIMARY KEY)',
    'CREATE TABLE plugin_operation_events (sequence INTEGER NOT NULL PRIMARY KEY)',
  ])('rejects partial new schemas: %s', (sql) => {
    const database = open();
    database.exec(sql);
    protocol(() => tx(database, () => initializeAuthoritySchemaTx(database, () => databaseId)));
  });

  it.each([
    'DELETE FROM plugin_authority_identity',
    "UPDATE plugin_authority_identity SET identity_json = '{}'",
    "UPDATE plugin_authority_identity SET identity_json = '{invalid'",
    'UPDATE plugin_authority_identity SET identity_json = \'{"version":1,"databaseId":"bad"}\'',
    'DROP TABLE plugin_trust_events',
  ])('rejects missing or invalid identity/schema on reopen: %s', (sql) => {
    const database = initialized();
    database.exec(sql);
    protocol(() => tx(database, () => initializeAuthoritySchemaTx(database, () => databaseId)));
  });

  it('rejects an invalid injected database identity without retaining partial initialization', () => {
    const database = open();
    expect(() => tx(database, () => initializeAuthoritySchemaTx(database, () => 'bad'))).toThrow(
      expect.objectContaining({ code: 'plugin-authority-invalid' }),
    );
    expect(
      database.prepare("SELECT name FROM sqlite_schema WHERE name LIKE 'plugin_%'").all(),
    ).toEqual([]);
  });

  it.each([
    'CREATE TABLE plugin_operation_events (sequence INTEGER NOT NULL PRIMARY KEY, occurred_at TEXT NOT NULL, scope TEXT NOT NULL, request_id TEXT NOT NULL, fingerprint TEXT NOT NULL, event_json TEXT NOT NULL)',
    'CREATE TABLE plugin_operation_events (sequence INTEGER NOT NULL PRIMARY KEY, occurred_at TEXT NOT NULL, scope TEXT NOT NULL, request_id TEXT NOT NULL COLLATE NOCASE UNIQUE, fingerprint TEXT NOT NULL, event_json TEXT NOT NULL)',
    'CREATE TABLE plugin_operation_events (sequence INTEGER NOT NULL PRIMARY KEY, occurred_at TEXT NOT NULL, scope TEXT NOT NULL, request_id TEXT, fingerprint TEXT NOT NULL, event_json TEXT NOT NULL, UNIQUE(request_id))',
  ])('rejects incompatible required columns/indexes: %s', (sql) => {
    const database = initialized();
    database.exec('DROP TABLE plugin_operation_events');
    database.exec(sql);
    protocol(() => readAuthoritySnapshotTx(database));
  });
});

describe('deterministic managed transitions', () => {
  it('imports without selecting or trusting and records an exact operation', () => {
    const input = importInput('import-a', 0);
    const next = resolveManagedTransition(empty(), input, occurredAt);
    expect(next.trustEvent).toBeNull();
    expect(next.installEvent).toEqual(imported().installEvents[0]);
    expect(next.operation).toEqual({
      version: 1,
      sequence: 1,
      occurredAt,
      scope: 'user',
      requestId: 'import-a',
      command: input.request.command,
      fingerprint: canonicalizeManagedRequest(input.request).fingerprint,
      evidence: input.prepared,
      decision: {
        kind: 'import',
        pluginId: 'notes',
        changed: true,
        before: { installSequence: 0, trustSequence: 0 },
        after: { installSequence: 1, trustSequence: 0 },
        pluginBefore: state(null, null),
        pluginAfter: state(null, null),
        links: { installEventSequence: 1, trustEventSequence: null },
      },
    });
  });

  it('records repeated import as a fresh no-op while preserving original provenance', () => {
    const input = importInput('import-again', 1);
    if (input.prepared.kind !== 'import') throw new Error('fixture');
    const next = resolveManagedTransition(
      imported(),
      {
        ...input,
        prepared: {
          ...input.prepared,
          provenance: { kind: 'local-directory', sourceDirectory: '/new-place' },
        },
      },
      occurredAt,
    );
    expect(next.installEvent).toBeNull();
    expect(next.trustEvent).toBeNull();
    expect(next.operation.sequence).toBe(2);
    expect(next.operation.decision).toEqual({
      kind: 'import',
      pluginId: 'notes',
      changed: false,
      before: { installSequence: 1, trustSequence: 0 },
      after: { installSequence: 1, trustSequence: 0 },
      pluginBefore: state(null, null),
      pluginAfter: state(null, null),
      links: { installEventSequence: null, trustEventSequence: null },
    });
  });

  it.each(['activate', 'rollback'] as const)(
    'always adds new exact trusted and selected facts for same-digest %s',
    (intent) => {
      const before = selected();
      const next = resolveManagedTransition(
        before,
        activateInput('select-again', before, artifact(), intent),
        occurredAt,
      );
      const selection = { digest: digestA, candidateImportSequence: 1, activationSequence: 3 };
      expect(next.trustEvent).toEqual({
        kind: 'trusted',
        pluginId: 'notes',
        digest: digestA,
        manifest: artifact().manifest,
        sequence: 2,
        occurredAt,
        scope: 'user',
      });
      expect(next.installEvent).toEqual({
        kind: 'activated',
        pluginId: 'notes',
        digest: digestA,
        candidateImportSequence: 1,
        previousSelection: digestA,
        trustEventSequence: 2,
        intent,
        sequence: 3,
        occurredAt,
        scope: 'user',
        operationSequence: 3,
      });
      expect(next.operation.decision).toEqual({
        kind: 'activate',
        pluginId: 'notes',
        changed: true,
        before: { installSequence: 2, trustSequence: 1 },
        after: { installSequence: 3, trustSequence: 2 },
        pluginBefore: state(before.installations[0]!.selection, true),
        pluginAfter: state(selection, true),
        links: { installEventSequence: 3, trustEventSequence: 2 },
      });
    },
  );

  it.each([
    ['enable', true, null, false],
    ['enable', false, 'enabled', true],
    ['disable', true, 'disabled', true],
    ['disable', false, null, false],
    ['revoke', true, 'revoked', true],
    ['revoke', false, 'revoked', true],
  ] as const)(
    'resolves %s with current enabled=%s into %s',
    (kind, enabled, trustKind, changed) => {
      const before = selected(enabled);
      const next = resolveManagedTransition(
        before,
        decisionInput(kind, 'decision', before),
        occurredAt,
      );
      expect(next.installEvent).toBeNull();
      expect(next.trustEvent).toEqual(
        trustKind === null
          ? null
          : {
              kind: trustKind,
              pluginId: 'notes',
              sequence: before.heads.trustSequence + 1,
              occurredAt,
              scope: 'user',
            },
      );
      expect(next.operation.sequence).toBe(before.heads.operationSequence + 1);
      expect(next.operation.decision).toEqual({
        kind,
        pluginId: 'notes',
        changed,
        before: { installSequence: 2, trustSequence: before.heads.trustSequence },
        after: { installSequence: 2, trustSequence: before.heads.trustSequence + Number(changed) },
        pluginBefore: state(before.installations[0]!.selection, enabled),
        pluginAfter: state(
          before.installations[0]!.selection,
          kind === 'revoke' ? null : kind === 'enable',
        ),
        links: {
          installEventSequence: null,
          trustEventSequence: changed ? before.heads.trustSequence + 1 : null,
        },
      });
    },
  );

  it.each(['disable', 'revoke', 'uninstall'] as const)(
    'records absent-trust unselected %s as a fresh no-op',
    (kind) => {
      const before = imported();
      const next = resolveManagedTransition(
        before,
        decisionInput(kind, kind, before, true),
        occurredAt,
      );
      expect(next.trustEvent).toBeNull();
      expect(next.installEvent).toBeNull();
      expect(next.operation.decision).toEqual({
        kind,
        pluginId: 'notes',
        changed: false,
        before: { installSequence: 1, trustSequence: 0 },
        after: { installSequence: 1, trustSequence: 0 },
        pluginBefore: state(null, null),
        pluginAfter: state(null, null),
        links: { installEventSequence: null, trustEventSequence: null },
      });
    },
  );

  it('imports an additional candidate without replacing the selected version or existing trust', () => {
    const before = selected();
    const identity = artifact(digestB, '2.0.0');
    const input = importInput('import-b', 2, identity);
    const next = resolveManagedTransition(before, input, occurredAt);
    expect(next.installEvent).toEqual({
      kind: 'imported',
      ...identity,
      provenance: input.prepared.kind === 'import' ? input.prepared.provenance : {},
      sequence: 3,
      occurredAt,
      scope: 'user',
      operationSequence: 3,
    });
    expect(next.trustEvent).toBeNull();
    expect(next.operation.decision).toEqual({
      kind: 'import',
      pluginId: 'notes',
      changed: true,
      before: { installSequence: 2, trustSequence: 1 },
      after: { installSequence: 3, trustSequence: 1 },
      pluginBefore: state(before.installations[0]!.selection, true),
      pluginAfter: state(before.installations[0]!.selection, true),
      links: { installEventSequence: 3, trustEventSequence: null },
    });
  });

  it('uninstalls an unselected imported plugin with legacy trust using removal plus revocation', () => {
    const before = imported();
    const trusted = {
      ...before,
      heads: { ...before.heads, trustSequence: 1 },
      trustEvents: selected().trustEvents,
    };
    const next = resolveManagedTransition(
      trusted,
      decisionInput('uninstall', 'remove-trust', trusted),
      occurredAt,
    );
    expect(next.installEvent).toEqual({
      kind: 'uninstalled',
      pluginId: 'notes',
      previousSelection: null,
      trustEventSequence: 2,
      sequence: 2,
      occurredAt,
      scope: 'user',
      operationSequence: 2,
    });
    expect(next.trustEvent).toEqual({
      kind: 'revoked',
      pluginId: 'notes',
      sequence: 2,
      occurredAt,
      scope: 'user',
    });
    expect(next.operation.decision.pluginBefore).toEqual(state(null, true));
    expect(next.operation.decision.pluginAfter).toEqual(state(null, null));
  });

  it('rejects missing candidates, changed activation review, and enable artifact metadata before granting authority', () => {
    const before = selected();
    const activation = activateInput('activate', before);
    if (activation.request.command.kind !== 'activate' || activation.prepared.kind !== 'activate')
      throw new Error('fixture');
    const changed = (fields: Partial<typeof activation.request.command>) => ({
      ...activation,
      request: { ...activation.request, command: { ...activation.request.command, ...fields } },
    });
    for (const fields of [
      { expectedInstallSequence: 1 },
      { expectedTrustSequence: 0 },
      { previousSelection: null },
      { manifest: { ...artifact().manifest, name: 'Changed' } },
    ]) {
      expect(() => resolveManagedTransition(before, changed(fields), occurredAt)).toThrow(
        expect.objectContaining({ code: 'plugin-authority-conflict' }),
      );
    }
    expect(() =>
      resolveManagedTransition(before, changed({ digest: digestB }), occurredAt),
    ).toThrow(expect.objectContaining({ code: 'plugin-authority-not-found' }));
    const enable = decisionInput('enable', 'enable', before);
    expect(() =>
      resolveManagedTransition(
        before,
        { ...enable, prepared: { kind: 'enable', artifact: { ...artifact(), bytes: 999 } } },
        occurredAt,
      ),
    ).toThrow(expect.objectContaining({ code: 'plugin-authority-conflict' }));
    const manifestMismatch = {
      ...before,
      trustEvents: [
        { ...before.trustEvents[0]!, manifest: { ...artifact().manifest, name: 'Changed' } },
      ],
    } as PluginAuthoritySnapshot;
    expect(() =>
      resolveManagedTransition(
        manifestMismatch,
        decisionInput('enable', 'enable', manifestMismatch),
        occurredAt,
      ),
    ).toThrow(expect.objectContaining({ code: 'plugin-authority-activation-required' }));
  });

  it('uninstalls selected-but-revoked metadata with an unconditional paired revocation', () => {
    const before = selected();
    const revoked: PluginAuthoritySnapshot = {
      ...before,
      heads: { ...before.heads, trustSequence: 2, operationSequence: 3 },
      trustEvents: [
        ...before.trustEvents,
        { kind: 'revoked', pluginId: 'notes', sequence: 2, occurredAt, scope: 'user' },
      ],
    };
    const next = resolveManagedTransition(
      revoked,
      decisionInput('uninstall', 'uninstall', revoked),
      occurredAt,
    );
    expect(next.trustEvent).toEqual({
      kind: 'revoked',
      pluginId: 'notes',
      sequence: 3,
      occurredAt,
      scope: 'user',
    });
    expect(next.installEvent).toEqual({
      kind: 'uninstalled',
      pluginId: 'notes',
      previousSelection: digestA,
      trustEventSequence: 3,
      sequence: 3,
      occurredAt,
      scope: 'user',
      operationSequence: 4,
    });
    expect(next.operation.decision.pluginAfter).toEqual(state(null, null));
  });

  it.each(['disable', 'revoke', 'uninstall'] as const)(
    'checks stale global review and selection before %s no-op',
    (kind) => {
      const before = imported();
      const input = decisionInput(kind, kind, before);
      expect(() =>
        resolveManagedTransition(
          before,
          {
            ...input,
            request: {
              ...input.request,
              command: { ...input.request.command, expectedTrustSequence: 1 },
            } as ManagedCommitInput['request'],
          },
          occurredAt,
        ),
      ).toThrow(expect.objectContaining({ code: 'plugin-authority-conflict' }));
      expect(() =>
        resolveManagedTransition(
          before,
          {
            ...input,
            request: {
              ...input.request,
              command: { ...input.request.command, selectedDigest: digestA },
            } as ManagedCommitInput['request'],
          },
          occurredAt,
        ),
      ).toThrow(expect.objectContaining({ code: 'plugin-authority-conflict' }));
    },
  );

  it('refuses stale repeated import, candidate metadata disagreement, mismatched preparation and unmanaged decisions', () => {
    expect(() => resolveManagedTransition(imported(), importInput('stale', 0), occurredAt)).toThrow(
      expect.objectContaining({ code: 'plugin-authority-conflict' }),
    );
    expect(() =>
      resolveManagedTransition(
        imported(),
        importInput('different', 1, { ...artifact(), files: 3 }),
        occurredAt,
      ),
    ).toThrow(expect.objectContaining({ code: 'plugin-authority-conflict' }));
    expect(() =>
      resolveManagedTransition(
        empty(),
        { ...importInput('bad-kind', 0), prepared: { kind: 'disable' } },
        occurredAt,
      ),
    ).toThrow(expect.objectContaining({ code: 'plugin-authority-invalid' }));
    expect(() =>
      resolveManagedTransition(empty(), decisionInput('disable', 'missing', empty()), occurredAt),
    ).toThrow(expect.objectContaining({ code: 'plugin-authority-not-found' }));
  });

  it('allocates sequences only for streams that the successful command appends', () => {
    const before = imported();
    const exhausted = {
      ...before,
      heads: {
        installSequence: Number.MAX_SAFE_INTEGER,
        trustSequence: Number.MAX_SAFE_INTEGER,
        operationSequence: 1,
      },
    };
    const noop = resolveManagedTransition(
      exhausted,
      importInput('noop-max', Number.MAX_SAFE_INTEGER),
      occurredAt,
    );
    expect(noop.operation.decision.after).toEqual({
      installSequence: Number.MAX_SAFE_INTEGER,
      trustSequence: Number.MAX_SAFE_INTEGER,
    });
    expect(noop.operation.sequence).toBe(2);
    expect(noop.installEvent).toBeNull();
    expect(noop.trustEvent).toBeNull();
    const trustFull = {
      ...empty(),
      heads: { installSequence: 0, trustSequence: Number.MAX_SAFE_INTEGER, operationSequence: 0 },
    };
    expect(
      resolveManagedTransition(trustFull, importInput('import-max-trust', 0), occurredAt)
        .installEvent?.sequence,
    ).toBe(1);
    expect(() =>
      resolveManagedTransition(
        exhausted,
        importInput('cannot-insert', Number.MAX_SAFE_INTEGER, artifact(digestB)),
        occurredAt,
      ),
    ).toThrow(expect.objectContaining({ code: 'plugin-authority-protocol' }));
    const operationsFull = {
      ...before,
      heads: { ...before.heads, operationSequence: Number.MAX_SAFE_INTEGER },
    };
    expect(() =>
      resolveManagedTransition(operationsFull, importInput('cannot-record', 1), occurredAt),
    ).toThrow(expect.objectContaining({ code: 'plugin-authority-protocol' }));
  });

  it('requires exact current selected trust for enable, including after revoke', () => {
    const before = selected();
    const revoked = {
      ...before,
      heads: { ...before.heads, trustSequence: 2 },
      trustEvents: [
        ...before.trustEvents,
        {
          kind: 'revoked' as const,
          pluginId: 'notes',
          sequence: 2,
          occurredAt,
          scope: 'user' as const,
        },
      ],
    };
    expect(() =>
      resolveManagedTransition(revoked, decisionInput('enable', 'enable', revoked), occurredAt),
    ).toThrow(expect.objectContaining({ code: 'plugin-authority-activation-required' }));
    const mismatched = {
      ...before,
      trustEvents: [{ ...before.trustEvents[0]!, digest: digestB }],
    } as PluginAuthoritySnapshot;
    expect(() =>
      resolveManagedTransition(
        mismatched,
        decisionInput('enable', 'enable', mismatched),
        occurredAt,
      ),
    ).toThrow(expect.objectContaining({ code: 'plugin-authority-activation-required' }));
  });
});

describe('full lossless three-stream validation', () => {
  it('round-trips every successful fresh decision and sticky first-import order across reopen', () => {
    const database = initialized();
    let snapshot = apply(database, importInput('import-a', 0));
    snapshot = apply(database, activateInput('activate-a', snapshot));
    snapshot = apply(database, decisionInput('enable', 'enable-noop', snapshot));
    snapshot = apply(database, decisionInput('disable', 'disable', snapshot));
    snapshot = apply(database, decisionInput('disable', 'disable-noop', snapshot));
    snapshot = apply(database, decisionInput('enable', 'enable', snapshot));
    snapshot = apply(database, decisionInput('revoke', 'revoke', snapshot));
    snapshot = apply(database, decisionInput('revoke', 'revoke-noop', snapshot));
    snapshot = apply(database, decisionInput('uninstall', 'uninstall', snapshot));
    snapshot = apply(database, decisionInput('uninstall', 'uninstall-noop', snapshot));
    expect(snapshot.heads).toEqual({ installSequence: 3, trustSequence: 5, operationSequence: 10 });
    expect(snapshot.installations[0]).toEqual({ ...imported().installations[0], selection: null });
    expect(snapshot.operationEvents.map((event) => event.decision.changed)).toEqual([
      true,
      true,
      false,
      true,
      false,
      true,
      true,
      false,
      true,
      false,
    ]);
    const other = artifact(digestB);
    const otherArtifact = {
      ...other,
      pluginId: 'alpha',
      manifest: { ...other.manifest, id: 'alpha' },
    };
    apply(database, importInput('other', 3, otherArtifact));
    snapshot = apply(database, importInput('again', 4));
    expect(
      snapshot.installations.map((record) => [record.pluginId, record.firstImportSequence]),
    ).toEqual([
      ['notes', 1],
      ['alpha', 4],
    ]);
    database.close();
    const reopened = open(filenames[0]);
    expect(readAuthoritySnapshotTx(reopened)).toEqual(snapshot);
  });

  it('accepts manual trust before first import and for other IDs between operations', () => {
    const database = initialized();
    appendRecordedTrustEventTx(database, {
      kind: 'trusted',
      pluginId: 'notes',
      digest: digestA,
      manifest: artifact().manifest,
      sequence: 1,
      occurredAt: 'legacy timestamp',
      scope: 'user',
    });
    let snapshot = apply(database, importInput('import-a', 0));
    expect(snapshot.operationEvents[0]?.decision.pluginBefore).toEqual(state(null, true));
    appendRecordedTrustEventTx(database, {
      kind: 'enabled',
      pluginId: 'manual-only',
      sequence: 2,
      occurredAt: 'legacy timestamp',
      scope: 'user',
    });
    snapshot = apply(database, activateInput('activate', readAuthoritySnapshotTx(database)));
    appendRecordedTrustEventTx(database, {
      kind: 'revoked',
      pluginId: 'manual-only',
      sequence: 4,
      occurredAt: 'legacy timestamp',
      scope: 'user',
    });
    expect(readAuthoritySnapshotTx(database).heads).toEqual({
      installSequence: 2,
      trustSequence: 4,
      operationSequence: 2,
    });
    expect(snapshot.operationEvents[1]?.decision.before).toEqual({
      installSequence: 1,
      trustSequence: 2,
    });
  });

  it('checks manual ownership at its historical prefix between operations', () => {
    const database = initialized();
    const other = artifact(digestB);
    const alpha = { ...other, pluginId: 'alpha', manifest: { ...other.manifest, id: 'alpha' } };
    apply(database, importInput('alpha', 0, alpha));
    appendRecordedTrustEventTx(database, {
      kind: 'trusted',
      pluginId: 'notes',
      digest: digestA,
      manifest: artifact().manifest,
      sequence: 1,
      occurredAt: 'legacy timestamp',
      scope: 'user',
    });
    const snapshot = apply(database, importInput('notes', 1));
    expect(snapshot.operationEvents[1]?.decision.pluginBefore).toEqual(state(null, true));
    expect(snapshot.installations.map((record) => record.pluginId)).toEqual(['alpha', 'notes']);
  });

  it('retains first candidate provenance and order through later imports, activation and uninstall', () => {
    const database = initialized();
    let snapshot = apply(database, importInput('a', 0));
    apply(database, activateInput('activate-a', snapshot));
    snapshot = apply(database, importInput('b', 2, artifact(digestB, '2.0.0')));
    expect(
      snapshot.installations[0]?.candidates.map((candidate) => [
        candidate.digest,
        candidate.firstImportSequence,
      ]),
    ).toEqual([
      [digestA, 1],
      [digestB, 3],
    ]);
    expect(snapshot.installations[0]?.selection).toEqual({
      digest: digestA,
      candidateImportSequence: 1,
      activationSequence: 2,
    });
    snapshot = apply(database, activateInput('activate-b', snapshot, artifact(digestB, '2.0.0')));
    snapshot = apply(database, decisionInput('uninstall', 'remove', snapshot));
    expect(snapshot.installations[0]?.firstImportSequence).toBe(1);
    expect(snapshot.installations[0]?.candidates).toHaveLength(2);
    expect(snapshot.installations[0]?.selection).toBeNull();
  });

  it('rejects manual trust for owned IDs after import, including after uninstall', () => {
    const database = initialized();
    let snapshot = apply(database, importInput('import', 0));
    snapshot = apply(database, activateInput('activate', snapshot));
    apply(database, decisionInput('uninstall', 'uninstall', snapshot));
    appendRecordedTrustEventTx(database, {
      kind: 'enabled',
      pluginId: 'notes',
      sequence: 3,
      occurredAt,
      scope: 'user',
    });
    protocol(() => readAuthoritySnapshotTx(database));
  });

  it.each([
    (event: RecordedManagedOperation) => ({ ...event, fingerprint: digestB }),
    (event: RecordedManagedOperation) => ({
      ...event,
      decision: { ...event.decision, changed: false },
    }),
    (event: RecordedManagedOperation) => ({
      ...event,
      decision: { ...event.decision, before: { installSequence: 1, trustSequence: 0 } },
    }),
    (event: RecordedManagedOperation) => ({
      ...event,
      decision: { ...event.decision, after: { installSequence: 0, trustSequence: 0 } },
    }),
    (event: RecordedManagedOperation) => ({
      ...event,
      decision: {
        ...event.decision,
        links: { installEventSequence: null, trustEventSequence: null },
      },
    }),
    (event: RecordedManagedOperation) => ({
      ...event,
      evidence: {
        kind: 'import',
        artifact: { ...artifact(), files: 9 },
        provenance: event.evidence.kind === 'import' ? event.evidence.provenance : {},
      },
    }),
    (event: RecordedManagedOperation) => ({
      ...event,
      decision: {
        ...event.decision,
        pluginAfter: state(
          { digest: digestA, candidateImportSequence: 1, activationSequence: 1 },
          null,
        ),
      },
    }),
  ])('rejects individually corrupted operation identity, decision or evidence %#', (mutate) => {
    const database = initialized();
    apply(database, importInput('import', 0));
    replaceOperation(database, mutate);
    protocol(() => readAuthoritySnapshotTx(database));
  });

  it.each([
    "UPDATE plugin_install_events SET occurred_at = '2026-11-21T00:00:01.000Z'",
    'UPDATE plugin_install_events SET operation_sequence = 2',
    "UPDATE plugin_install_events SET scope = 'project'",
    "UPDATE plugin_install_events SET event_json = '{}'",
    'UPDATE plugin_install_events SET sequence = 2',
    'DELETE FROM plugin_operation_events',
    "UPDATE plugin_operation_events SET request_id = 'different'",
    "UPDATE plugin_operation_events SET fingerprint = 'different'",
    'UPDATE plugin_operation_events SET sequence = 9007199254740992',
  ])('rejects corrupt envelopes or unclaimed install facts: %s', (sql) => {
    const database = initialized();
    apply(database, importInput('import', 0));
    database.exec(sql);
    protocol(() => readAuthoritySnapshotTx(database));
  });

  it('rejects linked trust timestamp and kind tampering even if a final fold could match', () => {
    const database = initialized();
    const snapshot = apply(database, importInput('import', 0));
    apply(database, activateInput('activate', snapshot));
    const event = { kind: 'enabled', pluginId: 'notes', sequence: 1, occurredAt, scope: 'user' };
    database.prepare('UPDATE plugin_trust_events SET event_json = ?').run(JSON.stringify(event));
    protocol(() => readAuthoritySnapshotTx(database));
  });

  it('rejects corrupt linked timestamps and reused trust links', () => {
    const database = initialized();
    let snapshot = apply(database, importInput('import', 0));
    snapshot = apply(database, activateInput('activate', snapshot));
    apply(database, activateInput('activate-again', snapshot));
    replaceOperation(
      database,
      (event) => ({
        ...event,
        decision: { ...event.decision, links: { ...event.decision.links, trustEventSequence: 1 } },
      }),
      3,
    );
    protocol(() => readAuthoritySnapshotTx(database));
  });

  it('rejects linked trust timestamps even when both SQL envelope and JSON agree', () => {
    const database = initialized();
    const snapshot = apply(database, importInput('import', 0));
    apply(database, activateInput('activate', snapshot));
    const timestamp = '2026-11-21T00:00:01.000Z';
    const row = database.prepare('SELECT event_json FROM plugin_trust_events').get();
    const event = JSON.parse(String(row?.event_json)) as RecordedPluginTrustEvent;
    database
      .prepare('UPDATE plugin_trust_events SET occurred_at = ?, event_json = ?')
      .run(timestamp, JSON.stringify({ ...event, occurredAt: timestamp }));
    protocol(() => readAuthoritySnapshotTx(database));
  });

  it('retains genuine runtime SQL failures for owner storage classification', () => {
    const database = initialized();
    database.exec('DROP TABLE plugin_trust_events');
    expect(() => readAuthoritySnapshotTx(database)).toThrow(/no such table/);
  });
});
