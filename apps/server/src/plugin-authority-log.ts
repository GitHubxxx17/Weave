import type { DatabaseSync, StatementSync } from 'node:sqlite';
import {
  foldTrust,
  type RecordedPluginTrustEvent,
  type PluginTrustEvent,
} from '@weave/plugin-host';
import { z } from 'zod';
import { canonicalJson, canonicalizeManagedRequest } from './plugin-authority-data.js';
import {
  managedPreparationSchema,
  pluginDatabaseIdentitySchema,
  recordedManagedOperationSchema,
  recordedPluginInstallEventSchema,
  PluginAuthorityError,
  type ManagedCommitInput,
  type ManagedPluginRecord,
  type ManagedPluginState,
  type PluginAuthoritySnapshot,
  type PluginDatabaseIdentity,
  type RecordedManagedOperation,
  type RecordedPluginInstallEvent,
  type ValidatedArtifactIdentity,
} from './plugin-authority-types.js';
import {
  appendRecordedTrustEventTx,
  createRecordedTrustEvent,
  createTrustTableSync,
  PluginTrustStoreError,
  readTrustEventsTx,
} from './plugin-trust-sqlite.js';

export interface ResolvedManagedTransition {
  readonly trustEvent: RecordedPluginTrustEvent | null;
  readonly installEvent: RecordedPluginInstallEvent | null;
  readonly operation: RecordedManagedOperation;
}

const protocolMessage = 'Plugin authority contains invalid persisted data';
const authorityTables = [
  'plugin_authority_identity',
  'plugin_install_events',
  'plugin_operation_events',
] as const;
const tableColumns = {
  plugin_trust_events: {
    sequence: 'INTEGER',
    occurred_at: 'TEXT',
    scope: 'TEXT',
    event_json: 'TEXT',
  },
  plugin_authority_identity: { singleton: 'INTEGER', identity_json: 'TEXT' },
  plugin_install_events: {
    sequence: 'INTEGER',
    occurred_at: 'TEXT',
    scope: 'TEXT',
    operation_sequence: 'INTEGER',
    event_json: 'TEXT',
  },
  plugin_operation_events: {
    sequence: 'INTEGER',
    occurred_at: 'TEXT',
    scope: 'TEXT',
    request_id: 'TEXT',
    fingerprint: 'TEXT',
    event_json: 'TEXT',
  },
} as const;
const metadataColumnSchema = z.object({
  name: z.string(),
  type: z.string(),
  notnull: z.bigint(),
  pk: z.bigint(),
});
const indexSchema = z.object({ name: z.string(), unique: z.bigint(), partial: z.bigint() });
const indexKeySchema = z.object({
  name: z.string().nullable(),
  key: z.bigint(),
  coll: z.string().nullable(),
});
const safeSqlSequence = z
  .bigint()
  .positive()
  .max(BigInt(Number.MAX_SAFE_INTEGER))
  .transform(Number);
const envelopeShape = {
  sequence: safeSqlSequence,
  occurred_at: z.string(),
  scope: z.literal('user'),
  event_json: z.string().min(1),
};
const installRowSchema = z.object({ ...envelopeShape, operation_sequence: safeSqlSequence });
const operationRowSchema = z.object({
  ...envelopeShape,
  request_id: z.string(),
  fingerprint: z.string(),
});

function protocol(cause?: unknown): never {
  throw new PluginAuthorityError('plugin-authority-protocol', protocolMessage, { cause });
}
function invalid(cause?: unknown): never {
  throw new PluginAuthorityError('plugin-authority-invalid', 'Plugin authority input is invalid', {
    cause,
  });
}
function fail(
  code:
    | 'plugin-authority-conflict'
    | 'plugin-authority-not-found'
    | 'plugin-authority-activation-required',
): never {
  throw new PluginAuthorityError(code, 'Plugin authority decision cannot be completed');
}
function parsePersisted<T>(action: () => T): T {
  try {
    return action();
  } catch (error: unknown) {
    return protocol(error);
  }
}
function equal(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}
function lossless(statement: StatementSync): StatementSync {
  statement.setReadBigInts(true);
  return statement;
}
function quote(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function tableNames(database: DatabaseSync): Set<string> {
  const rows = database.prepare("SELECT name FROM sqlite_schema WHERE type = 'table'").all();
  return new Set(
    parsePersisted(() =>
      z
        .array(z.object({ name: z.string() }))
        .parse(rows)
        .map((row) => row.name),
    ),
  );
}
function validateSchema(database: DatabaseSync): void {
  const names = tableNames(database);
  for (const [table, expected] of Object.entries(tableColumns)) {
    if (!names.has(table)) protocol();
    const raw = lossless(database.prepare(`PRAGMA table_info(${quote(table)})`)).all();
    const columns = parsePersisted(() => z.array(metadataColumnSchema).parse(raw));
    const primaryName = table === 'plugin_authority_identity' ? 'singleton' : 'sequence';
    for (const [name, type] of Object.entries(expected)) {
      const column = columns.find((value) => value.name === name);
      if (
        column?.type.toUpperCase() !== type ||
        column.notnull !== 1n ||
        column.pk !== (name === primaryName ? 1n : 0n)
      )
        protocol();
    }
    if (columns.some((column) => column.pk !== 0n && column.name !== primaryName)) protocol();
  }
  for (const [table, required] of [
    ['plugin_install_events', 'operation_sequence'],
    ['plugin_operation_events', 'request_id'],
  ] as const) {
    const raw = lossless(database.prepare(`PRAGMA index_list(${quote(table)})`)).all();
    const indexes = parsePersisted(() => z.array(indexSchema).parse(raw));
    let found = false;
    for (const index of indexes) {
      if (index.unique !== 1n || index.partial !== 0n) continue;
      const keysRaw = lossless(database.prepare(`PRAGMA index_xinfo(${quote(index.name)})`)).all();
      const keys = parsePersisted(() => z.array(indexKeySchema).parse(keysRaw)).filter(
        (key) => key.key === 1n,
      );
      if (keys.length === 1 && keys[0]?.name === required && keys[0].coll === 'BINARY')
        found = true;
    }
    if (!found) protocol();
  }
}
function readIdentity(database: DatabaseSync): PluginDatabaseIdentity {
  const rows = lossless(
    database.prepare('SELECT singleton, identity_json FROM plugin_authority_identity'),
  ).all();
  return parsePersisted(() => {
    const parsed = z
      .array(z.object({ singleton: z.literal(1n), identity_json: z.string().min(1) }))
      .length(1)
      .parse(rows);
    return pluginDatabaseIdentitySchema.parse(JSON.parse(parsed[0]!.identity_json) as unknown);
  });
}

export function initializeAuthoritySchemaTx(
  database: DatabaseSync,
  newDatabaseId: () => string,
): PluginDatabaseIdentity {
  const names = tableNames(database);
  const existing = authorityTables.filter((name) => names.has(name)).length;
  if (existing !== 0 && existing !== authorityTables.length) protocol();
  if (existing === 0) {
    createTrustTableSync(database);
    database.exec(`
      CREATE TABLE plugin_authority_identity (
        singleton INTEGER NOT NULL PRIMARY KEY CHECK (singleton = 1),
        identity_json TEXT NOT NULL
      );
      CREATE TABLE plugin_install_events (
        sequence INTEGER NOT NULL PRIMARY KEY,
        occurred_at TEXT NOT NULL,
        scope TEXT NOT NULL,
        operation_sequence INTEGER NOT NULL UNIQUE,
        event_json TEXT NOT NULL
      );
      CREATE TABLE plugin_operation_events (
        sequence INTEGER NOT NULL PRIMARY KEY,
        occurred_at TEXT NOT NULL,
        scope TEXT NOT NULL,
        request_id TEXT NOT NULL UNIQUE,
        fingerprint TEXT NOT NULL,
        event_json TEXT NOT NULL
      );
    `);
    let identity: PluginDatabaseIdentity;
    try {
      identity = pluginDatabaseIdentitySchema.parse({ version: 1, databaseId: newDatabaseId() });
    } catch (error: unknown) {
      return invalid(error);
    }
    database
      .prepare('INSERT INTO plugin_authority_identity (singleton, identity_json) VALUES (1, ?)')
      .run(JSON.stringify(identity));
  }
  validateSchema(database);
  return readIdentity(database);
}

function nextSequence(head: number): number {
  if (!Number.isSafeInteger(head) || head < 0 || head >= Number.MAX_SAFE_INTEGER) protocol();
  return head + 1;
}
function pluginState(snapshot: PluginAuthoritySnapshot, pluginId: string): ManagedPluginState {
  const trusted = foldTrust(snapshot.trustEvents).get(pluginId);
  return {
    selection:
      snapshot.installations.find((record) => record.pluginId === pluginId)?.selection ?? null,
    trust:
      trusted === undefined
        ? null
        : { digest: trusted.digest, manifest: trusted.manifest, enabled: trusted.enabled },
  };
}
function artifactIdentity(candidate: ValidatedArtifactIdentity): ValidatedArtifactIdentity {
  return {
    pluginId: candidate.pluginId,
    digest: candidate.digest,
    manifest: candidate.manifest,
    files: candidate.files,
    bytes: candidate.bytes,
  };
}

/** This policy is used both for fresh commits and for validating every historical prefix. */
export function resolveManagedTransition(
  before: PluginAuthoritySnapshot,
  input: ManagedCommitInput,
  occurredAt: string,
): ResolvedManagedTransition {
  let canonical: ReturnType<typeof canonicalizeManagedRequest>;
  let prepared: ManagedCommitInput['prepared'];
  try {
    canonicalJson(input);
    z.object({ request: z.unknown(), prepared: z.unknown() }).strict().parse(input);
    canonical = canonicalizeManagedRequest(input.request);
    prepared = managedPreparationSchema.parse(input.prepared);
    z.iso.datetime().parse(occurredAt);
  } catch (error: unknown) {
    return invalid(error);
  }
  const { request, fingerprint } = canonical;
  const command = request.command;
  if (command.kind !== prepared.kind) invalid();
  if (command.expectedInstallSequence !== before.heads.installSequence)
    fail('plugin-authority-conflict');
  if (command.kind !== 'import' && command.expectedTrustSequence !== before.heads.trustSequence)
    fail('plugin-authority-conflict');
  const pluginId =
    command.kind === 'import' && prepared.kind === 'import'
      ? prepared.artifact.pluginId
      : command.kind !== 'import'
        ? command.pluginId
        : invalid();
  const installation = before.installations.find((record) => record.pluginId === pluginId);
  if (command.kind !== 'import' && installation === undefined) fail('plugin-authority-not-found');
  const pluginBefore = pluginState(before, pluginId);
  if (command.kind === 'activate') {
    if (command.previousSelection !== (pluginBefore.selection?.digest ?? null))
      fail('plugin-authority-conflict');
  } else if (command.kind !== 'import') {
    if (command.selectedDigest !== (pluginBefore.selection?.digest ?? null))
      fail('plugin-authority-conflict');
  }
  const operationSequence = nextSequence(before.heads.operationSequence);
  const trustSequence = (): number => nextSequence(before.heads.trustSequence);
  let trust: PluginTrustEvent | null = null;
  let install: RecordedPluginInstallEvent | null = null;
  const installMetadata = () => ({
    sequence: nextSequence(before.heads.installSequence),
    occurredAt,
    scope: 'user' as const,
    operationSequence,
  });
  switch (command.kind) {
    case 'import': {
      if (prepared.kind !== 'import') return invalid();
      const candidate = installation?.candidates.find(
        (value) => value.digest === prepared.artifact.digest,
      );
      if (candidate !== undefined) {
        if (!equal(artifactIdentity(candidate), prepared.artifact))
          fail('plugin-authority-conflict');
      } else {
        install = {
          kind: 'imported',
          ...prepared.artifact,
          provenance: prepared.provenance,
          ...installMetadata(),
        };
      }
      break;
    }
    case 'activate': {
      if (prepared.kind !== 'activate') return invalid();
      const candidate = installation!.candidates.find((value) => value.digest === command.digest);
      if (candidate === undefined) fail('plugin-authority-not-found');
      if (
        !equal(artifactIdentity(candidate), prepared.artifact) ||
        !equal(command.manifest, candidate.manifest)
      )
        fail('plugin-authority-conflict');
      trust = { kind: 'trusted', pluginId, digest: command.digest, manifest: command.manifest };
      install = {
        kind: 'activated',
        pluginId,
        digest: command.digest,
        candidateImportSequence: candidate.firstImportSequence,
        previousSelection: command.previousSelection,
        trustEventSequence: trustSequence(),
        intent: command.intent,
        ...installMetadata(),
      };
      break;
    }
    case 'enable': {
      if (prepared.kind !== 'enable') return invalid();
      const candidate = installation!.candidates.find(
        (value) => value.digest === command.selectedDigest,
      );
      if (
        candidate === undefined ||
        pluginBefore.selection === null ||
        pluginBefore.trust === null ||
        pluginBefore.trust.digest !== candidate.digest ||
        !equal(pluginBefore.trust.manifest, candidate.manifest)
      )
        fail('plugin-authority-activation-required');
      if (!equal(artifactIdentity(candidate), prepared.artifact)) fail('plugin-authority-conflict');
      if (!pluginBefore.trust.enabled) trust = { kind: 'enabled', pluginId };
      break;
    }
    case 'disable':
      if (pluginBefore.trust?.enabled === true) trust = { kind: 'disabled', pluginId };
      break;
    case 'revoke':
      if (pluginBefore.trust !== null) trust = { kind: 'revoked', pluginId };
      break;
    case 'uninstall':
      if (pluginBefore.selection !== null || pluginBefore.trust !== null) {
        trust = { kind: 'revoked', pluginId };
        install = {
          kind: 'uninstalled',
          pluginId,
          previousSelection: command.selectedDigest,
          trustEventSequence: trustSequence(),
          ...installMetadata(),
        };
      }
      break;
  }
  const trustEvent =
    trust === null ? null : createRecordedTrustEvent(trust, trustSequence(), occurredAt);
  const installEvent = install === null ? null : recordedPluginInstallEventSchema.parse(install);
  const afterInstallations =
    installEvent === null
      ? before.installations
      : foldInstallations([...before.installEvents, installEvent]);
  const pluginAfter = pluginState(
    {
      ...before,
      installations: afterInstallations,
      trustEvents: trustEvent === null ? before.trustEvents : [...before.trustEvents, trustEvent],
    },
    pluginId,
  );
  const operation = recordedManagedOperationSchema.parse({
    version: 1,
    sequence: operationSequence,
    occurredAt,
    scope: 'user',
    requestId: request.requestId,
    command,
    fingerprint,
    evidence: prepared,
    decision: {
      kind: command.kind,
      pluginId,
      changed: installEvent !== null || trustEvent !== null,
      before: {
        installSequence: before.heads.installSequence,
        trustSequence: before.heads.trustSequence,
      },
      after: {
        installSequence: installEvent?.sequence ?? before.heads.installSequence,
        trustSequence: trustEvent?.sequence ?? before.heads.trustSequence,
      },
      pluginBefore,
      pluginAfter,
      links: {
        installEventSequence: installEvent?.sequence ?? null,
        trustEventSequence: trustEvent?.sequence ?? null,
      },
    },
  });
  return { trustEvent, installEvent, operation };
}

function foldInstallations(
  events: readonly RecordedPluginInstallEvent[],
): readonly ManagedPluginRecord[] {
  const records = new Map<string, ManagedPluginRecord>();
  for (const event of events) {
    const previous = records.get(event.pluginId);
    if (event.kind === 'imported') {
      const candidate = {
        ...artifactIdentity(event),
        firstImportSequence: event.sequence,
        provenance: event.provenance,
      };
      records.set(
        event.pluginId,
        previous === undefined
          ? {
              pluginId: event.pluginId,
              firstImportSequence: event.sequence,
              candidates: [candidate],
              selection: null,
            }
          : { ...previous, candidates: [...previous.candidates, candidate] },
      );
    } else {
      if (previous === undefined) protocol();
      records.set(event.pluginId, {
        ...previous,
        selection:
          event.kind === 'uninstalled'
            ? null
            : {
                digest: event.digest,
                candidateImportSequence: event.candidateImportSequence,
                activationSequence: event.sequence,
              },
      });
    }
  }
  return [...records.values()];
}

function readInstallEvents(database: DatabaseSync): readonly RecordedPluginInstallEvent[] {
  const rows = lossless(
    database.prepare(
      'SELECT sequence, occurred_at, scope, operation_sequence, event_json FROM plugin_install_events ORDER BY sequence ASC',
    ),
  ).all();
  return rows.map((raw, index) =>
    parsePersisted(() => {
      const row = installRowSchema.parse(raw);
      const event = recordedPluginInstallEventSchema.parse(JSON.parse(row.event_json) as unknown);
      if (
        row.sequence !== index + 1 ||
        event.sequence !== row.sequence ||
        event.occurredAt !== row.occurred_at ||
        event.scope !== row.scope ||
        event.operationSequence !== row.operation_sequence
      )
        protocol();
      return event;
    }),
  );
}
function readOperations(database: DatabaseSync): readonly RecordedManagedOperation[] {
  const rows = lossless(
    database.prepare(
      'SELECT sequence, occurred_at, scope, request_id, fingerprint, event_json FROM plugin_operation_events ORDER BY sequence ASC',
    ),
  ).all();
  return rows.map((raw, index) =>
    parsePersisted(() => {
      const row = operationRowSchema.parse(raw);
      const event = recordedManagedOperationSchema.parse(JSON.parse(row.event_json) as unknown);
      if (
        row.sequence !== index + 1 ||
        event.sequence !== row.sequence ||
        event.occurredAt !== row.occurred_at ||
        event.scope !== row.scope ||
        event.requestId !== row.request_id ||
        event.fingerprint !== row.fingerprint
      )
        protocol();
      return event;
    }),
  );
}

export function readAuthoritySnapshotTx(database: DatabaseSync): PluginAuthoritySnapshot {
  let trustEvents: readonly RecordedPluginTrustEvent[];
  // Genuine SQL failures must reach the owner as storage errors, including the legacy dropped-table case.
  try {
    trustEvents = readTrustEventsTx(database);
  } catch (error: unknown) {
    if (error instanceof PluginTrustStoreError && error.code === 'plugin-trust-protocol')
      protocol(error);
    throw error;
  }
  validateSchema(database);
  const identity = readIdentity(database);
  const installEvents = readInstallEvents(database);
  const operationEvents = readOperations(database);
  let prefix: PluginAuthoritySnapshot = {
    identity,
    heads: { installSequence: 0, trustSequence: 0, operationSequence: 0 },
    trustEvents: [],
    installEvents: [],
    operationEvents: [],
    installations: [],
  };
  const seenRequests = new Set<string>();
  const consumeManual = (through: number): void => {
    if (through < prefix.heads.trustSequence || through > trustEvents.length) protocol();
    while (prefix.heads.trustSequence < through) {
      const event = trustEvents[prefix.heads.trustSequence]!;
      if (prefix.installations.some((record) => record.pluginId === event.pluginId)) protocol();
      prefix = {
        ...prefix,
        heads: { ...prefix.heads, trustSequence: event.sequence },
        trustEvents: [...prefix.trustEvents, event],
      };
    }
  };
  for (const operation of operationEvents) {
    if (seenRequests.has(operation.requestId)) protocol();
    seenRequests.add(operation.requestId);
    if (operation.decision.before.installSequence !== prefix.heads.installSequence) protocol();
    consumeManual(operation.decision.before.trustSequence);
    const expected = parsePersisted(() =>
      resolveManagedTransition(
        prefix,
        {
          request: { requestId: operation.requestId, command: operation.command },
          prepared: operation.evidence,
        },
        operation.occurredAt,
      ),
    );
    if (!equal(expected.operation, operation)) protocol();
    if (
      expected.installEvent !== null &&
      !equal(expected.installEvent, installEvents[prefix.heads.installSequence] ?? null)
    )
      protocol();
    if (
      expected.trustEvent !== null &&
      !equal(expected.trustEvent, trustEvents[prefix.heads.trustSequence] ?? null)
    )
      protocol();
    const nextInstallEvents =
      expected.installEvent === null
        ? prefix.installEvents
        : [...prefix.installEvents, expected.installEvent];
    prefix = {
      identity,
      heads: { ...operation.decision.after, operationSequence: operation.sequence },
      trustEvents:
        expected.trustEvent === null
          ? prefix.trustEvents
          : [...prefix.trustEvents, expected.trustEvent],
      installEvents: nextInstallEvents,
      operationEvents: [...prefix.operationEvents, operation],
      installations: foldInstallations(nextInstallEvents),
    };
  }
  consumeManual(trustEvents.length);
  if (prefix.heads.installSequence !== installEvents.length) protocol();
  return { ...prefix, trustEvents, installEvents, operationEvents };
}

export function appendManagedTransitionTx(
  database: DatabaseSync,
  transition: ResolvedManagedTransition,
): void {
  if (transition.trustEvent !== null) appendRecordedTrustEventTx(database, transition.trustEvent);
  if (transition.installEvent !== null) {
    const event = transition.installEvent;
    database
      .prepare(
        'INSERT INTO plugin_install_events (sequence, occurred_at, scope, operation_sequence, event_json) VALUES (?, ?, ?, ?, ?)',
      )
      .run(
        event.sequence,
        event.occurredAt,
        event.scope,
        event.operationSequence,
        JSON.stringify(event),
      );
  }
  const event = transition.operation;
  database
    .prepare(
      'INSERT INTO plugin_operation_events (sequence, occurred_at, scope, request_id, fingerprint, event_json) VALUES (?, ?, ?, ?, ?, ?)',
    )
    .run(
      event.sequence,
      event.occurredAt,
      event.scope,
      event.requestId,
      event.fingerprint,
      JSON.stringify(event),
    );
}
