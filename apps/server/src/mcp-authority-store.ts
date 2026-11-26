import type { DatabaseSync } from 'node:sqlite';
import { isSqliteBusyError, openSharedDatabase } from './sqlite-busy-timeout.js';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import {
  freezeMcpValue,
  mcpConfigDigest,
  mcpConfigDigestV2,
  mcpConfigDigestSchema,
  mcpServerConfigSchema,
  mcpServerIdSchema,
  type McpServerConfig,
} from './mcp-environment.js';
import { McpAuthorityError } from './mcp-errors.js';
export { McpAuthorityError, type McpAuthorityErrorCode } from './mcp-errors.js';

export type McpAuthorityEvent =
  | {
      readonly kind: 'configured';
      readonly config: McpServerConfig;
      readonly configDigest: string;
      /** Present on policy 2 events; absent events are policy 1 (launch configuration only). */
      readonly policyVersion?: 2 | undefined;
      readonly contentDigest?: string | undefined;
    }
  | {
      readonly kind: 'trusted' | 'enabled';
      readonly serverId: string;
      readonly configDigest: string;
    }
  | { readonly kind: 'disabled' | 'revoked' | 'removed'; readonly serverId: string };
export type RecordedMcpAuthorityEvent = McpAuthorityEvent & {
  readonly schemaVersion: 1;
  readonly sequence: number;
  readonly occurredAt: string;
  readonly scope: 'user';
};
export type McpAuthorityCommand =
  | {
      readonly kind: 'create' | 'update';
      readonly config: McpServerConfig;
      /** Omitted only by legacy callers; such a configuration is recorded as policy 1. */
      readonly contentDigest?: string | undefined;
    }
  | { readonly kind: 'trust' | 'enable'; readonly serverId: string; readonly configDigest: string }
  | { readonly kind: 'disable' | 'revoke' | 'remove'; readonly serverId: string };
export interface McpReviewedConfig {
  readonly config: McpServerConfig;
  readonly configDigest: string;
  readonly trustedAt: string;
}
export interface McpAuthorityRecord {
  readonly config: McpServerConfig;
  readonly configDigest: string;
  readonly policyVersion: 1 | 2;
  readonly contentDigest: string | null;
  readonly trustedDigest: string | null;
  readonly trustState: 'untrusted' | 'changed' | 'trusted';
  readonly enabled: boolean;
  readonly removed: boolean;
  readonly reviewed: McpReviewedConfig | null;
}
export interface McpAuthorityLog {
  readonly sequence: number;
  readonly events: readonly RecordedMcpAuthorityEvent[];
  readonly records: readonly McpAuthorityRecord[];
}
export interface McpAuthorityMutation extends McpAuthorityLog {
  readonly appended: RecordedMcpAuthorityEvent | null;
}
export interface McpAuthorityStore {
  read(options?: {
    readonly knownPrefix?: readonly RecordedMcpAuthorityEvent[];
  }): Promise<McpAuthorityLog>;
  mutate(
    command: McpAuthorityCommand,
    options: {
      readonly expectedSequence: number;
      readonly knownPrefix: readonly RecordedMcpAuthorityEvent[];
    },
  ): Promise<McpAuthorityMutation>;
  close(): Promise<void>;
}

const safeInteger = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const timestamp = z.iso.datetime().refine((value) => {
  try {
    return new Date(value).toISOString() === value;
  } catch {
    return false;
  }
});
const metadata = {
  schemaVersion: z.literal(1),
  sequence: safeInteger.refine((value) => value > 0),
  occurredAt: timestamp,
  scope: z.literal('user'),
};
const configuredShape = {
  kind: z.literal('configured'),
  config: mcpServerConfigSchema,
  configDigest: mcpConfigDigestSchema,
  policyVersion: z.literal(2).optional(),
  contentDigest: mcpConfigDigestSchema.optional(),
};
const trustedShape = {
  kind: z.literal('trusted'),
  serverId: mcpServerIdSchema,
  configDigest: mcpConfigDigestSchema,
};
const enabledShape = {
  kind: z.literal('enabled'),
  serverId: mcpServerIdSchema,
  configDigest: mcpConfigDigestSchema,
};
const disabledShape = { kind: z.literal('disabled'), serverId: mcpServerIdSchema };
const revokedShape = { kind: z.literal('revoked'), serverId: mcpServerIdSchema };
const removedShape = { kind: z.literal('removed'), serverId: mcpServerIdSchema };
export const recordedMcpAuthorityEventSchema: z.ZodType<RecordedMcpAuthorityEvent> =
  z.discriminatedUnion('kind', [
    z
      .strictObject({ ...configuredShape, ...metadata })
      .refine(
        (event) => (event.policyVersion === undefined) === (event.contentDigest === undefined),
      ),
    z.strictObject({ ...trustedShape, ...metadata }),
    z.strictObject({ ...enabledShape, ...metadata }),
    z.strictObject({ ...disabledShape, ...metadata }),
    z.strictObject({ ...revokedShape, ...metadata }),
    z.strictObject({ ...removedShape, ...metadata }),
  ]);
const eventsSchema = z.array(recordedMcpAuthorityEventSchema);
const recordSchema = z.strictObject({
  config: mcpServerConfigSchema,
  configDigest: mcpConfigDigestSchema,
  policyVersion: z.union([z.literal(1), z.literal(2)]),
  contentDigest: mcpConfigDigestSchema.nullable(),
  trustedDigest: mcpConfigDigestSchema.nullable(),
  trustState: z.enum(['untrusted', 'changed', 'trusted']),
  enabled: z.boolean(),
  removed: z.boolean(),
  reviewed: z
    .strictObject({
      config: mcpServerConfigSchema,
      configDigest: mcpConfigDigestSchema,
      trustedAt: timestamp,
    })
    .nullable(),
});
const logSchema = z.strictObject({
  sequence: safeInteger,
  events: eventsSchema,
  records: z.array(recordSchema),
  appended: recordedMcpAuthorityEventSchema.nullable().optional(),
});
const commandSchema: z.ZodType<McpAuthorityCommand> = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('create'),
    config: mcpServerConfigSchema,
    contentDigest: mcpConfigDigestSchema.optional(),
  }),
  z.strictObject({
    kind: z.literal('update'),
    config: mcpServerConfigSchema,
    contentDigest: mcpConfigDigestSchema.optional(),
  }),
  z.strictObject({
    kind: z.literal('trust'),
    serverId: mcpServerIdSchema,
    configDigest: mcpConfigDigestSchema,
  }),
  z.strictObject({
    kind: z.literal('enable'),
    serverId: mcpServerIdSchema,
    configDigest: mcpConfigDigestSchema,
  }),
  z.strictObject({ kind: z.literal('disable'), serverId: mcpServerIdSchema }),
  z.strictObject({ kind: z.literal('revoke'), serverId: mcpServerIdSchema }),
  z.strictObject({ kind: z.literal('remove'), serverId: mcpServerIdSchema }),
]);
const rowSchema = z.strictObject({
  sequence: z.bigint().positive().max(BigInt(Number.MAX_SAFE_INTEGER)).transform(Number),
  occurred_at: timestamp,
  scope: z.literal('user'),
  event_json: z.string().min(1),
});
const optionsSchema = z.strictObject({
  filename: z.string().min(1),
  now: z.custom<() => Date>((value) => typeof value === 'function').optional(),
});
const mutateOptionsSchema = z.strictObject({
  expectedSequence: safeInteger,
  knownPrefix: eventsSchema,
});

function protocol(): never {
  throw new McpAuthorityError('mcp-authority-protocol');
}
function conflict(): never {
  throw new McpAuthorityError('mcp-conflict');
}
function live(records: Map<string, McpAuthorityRecord>, id: string): McpAuthorityRecord {
  const record = records.get(id);
  if (record === undefined || record.removed) protocol();
  return record;
}

/** Replay is deliberately strict: impossible stored decisions are corruption. */
function foldEvents(events: readonly RecordedMcpAuthorityEvent[]): readonly McpAuthorityRecord[] {
  const records = new Map<string, McpAuthorityRecord>();
  for (const [index, event] of events.entries()) {
    if (event.sequence !== index + 1) protocol();
    if (event.kind === 'configured') {
      // Policy 1 events replay as before; they cannot carry content paths.
      if (event.contentDigest === undefined) {
        if (event.config.contentPaths !== undefined || event.config.callTimeoutMs !== undefined)
          protocol();
        if (mcpConfigDigest(event.config) !== event.configDigest) protocol();
      } else if (mcpConfigDigestV2(event.config, event.contentDigest) !== event.configDigest)
        protocol();
      const before = records.get(event.config.id);
      const sameLifecycle = before !== undefined && !before.removed;
      const sameDigest = sameLifecycle && before.configDigest === event.configDigest;
      records.set(event.config.id, {
        config: event.config,
        configDigest: event.configDigest,
        policyVersion: event.contentDigest === undefined ? 1 : 2,
        contentDigest: event.contentDigest ?? null,
        removed: false,
        trustedDigest: sameDigest ? before.trustedDigest : null,
        trustState: sameDigest
          ? before.trustState
          : sameLifecycle && (before.trustState === 'trusted' || before.trustState === 'changed')
            ? 'changed'
            : 'untrusted',
        enabled: sameDigest ? before.enabled : false,
        reviewed: sameLifecycle ? before.reviewed : null,
      });
      if ([...records.values()].filter((record) => !record.removed).length > 8) protocol();
      continue;
    }
    const existing = records.get(event.serverId);
    if (event.kind === 'removed' && existing?.removed) continue;
    const before = live(records, event.serverId);
    switch (event.kind) {
      case 'trusted':
        if (before.configDigest !== event.configDigest) protocol();
        records.set(event.serverId, {
          ...before,
          trustedDigest: event.configDigest,
          trustState: 'trusted',
          enabled: true,
          reviewed: {
            config: before.config,
            configDigest: before.configDigest,
            trustedAt: event.occurredAt,
          },
        });
        break;
      case 'enabled':
        if (
          before.configDigest !== event.configDigest ||
          before.trustedDigest !== event.configDigest ||
          before.trustState !== 'trusted'
        )
          protocol();
        records.set(event.serverId, { ...before, enabled: true });
        break;
      case 'disabled':
        records.set(event.serverId, { ...before, enabled: false });
        break;
      case 'revoked':
        records.set(event.serverId, {
          ...before,
          enabled: false,
          trustedDigest: null,
          trustState: 'untrusted',
        });
        break;
      case 'removed':
        records.set(event.serverId, {
          ...before,
          removed: true,
          enabled: false,
          trustedDigest: null,
          trustState: 'untrusted',
        });
        break;
    }
  }
  return [...records.values()];
}

function validatedEvents(input: unknown): readonly RecordedMcpAuthorityEvent[] {
  const events = eventsSchema.parse(input);
  foldEvents(events);
  return events;
}
function requirePrefix(
  events: readonly RecordedMcpAuthorityEvent[],
  knownPrefix: readonly RecordedMcpAuthorityEvent[],
): void {
  if (knownPrefix.some((event, index) => !isDeepStrictEqual(event, events[index]))) protocol();
}
function logFromEvents(
  input: unknown,
  knownPrefix: readonly RecordedMcpAuthorityEvent[] = [],
): McpAuthorityLog {
  const events = validatedEvents(input);
  const prefix = validatedEvents(knownPrefix);
  requirePrefix(events, prefix);
  return freezeMcpValue({ sequence: events.length, events, records: foldEvents(events) });
}

/** Validate injected-store replies and their entire durable prefix before installation. */
export function validateMcpAuthorityLog(
  input: unknown,
  knownPrefix: readonly RecordedMcpAuthorityEvent[] = [],
): McpAuthorityLog {
  try {
    const parsed = logSchema.parse(input);
    const log = logFromEvents(parsed.events, knownPrefix);
    if (parsed.sequence !== log.sequence || !isDeepStrictEqual(parsed.records, log.records))
      protocol();
    if (
      parsed.appended !== undefined &&
      parsed.appended !== null &&
      !isDeepStrictEqual(parsed.appended, log.events.at(-1))
    )
      protocol();
    return log;
  } catch {
    return protocol();
  }
}

function readLog(
  database: DatabaseSync,
  prefix: readonly RecordedMcpAuthorityEvent[],
): McpAuthorityLog {
  const statement = database.prepare(
    'SELECT sequence, occurred_at, scope, event_json FROM mcp_authority_events ORDER BY sequence ASC',
  );
  statement.setReadBigInts(true);
  const rows = statement.all();
  try {
    const events = rows.map((input, index) => {
      const row = rowSchema.parse(input);
      const event = recordedMcpAuthorityEventSchema.parse(JSON.parse(row.event_json) as unknown);
      if (
        row.sequence !== index + 1 ||
        event.sequence !== row.sequence ||
        event.occurredAt !== row.occurred_at ||
        event.scope !== row.scope
      )
        protocol();
      return event;
    });
    return logFromEvents(events, prefix);
  } catch {
    return protocol();
  }
}

function nextEvent(command: McpAuthorityCommand, log: McpAuthorityLog): McpAuthorityEvent | null {
  if ('config' in command) {
    const before = log.records.find((record) => record.config.id === command.config.id);
    if (command.kind === 'create') {
      if (before !== undefined && !before.removed) conflict();
      if (log.records.filter((record) => !record.removed).length >= 8) conflict();
    } else if (before === undefined || before.removed) {
      throw new McpAuthorityError('mcp-not-found');
    }
    if (
      command.kind === 'update' &&
      isDeepStrictEqual(before?.config, command.config) &&
      before?.contentDigest === (command.contentDigest ?? null)
    )
      return null;
    if (command.contentDigest === undefined)
      return {
        kind: 'configured',
        config: command.config,
        configDigest: mcpConfigDigest(command.config),
      };
    return {
      kind: 'configured',
      config: command.config,
      configDigest: mcpConfigDigestV2(command.config, command.contentDigest),
      policyVersion: 2,
      contentDigest: command.contentDigest,
    };
  }
  const before = log.records.find((record) => record.config.id === command.serverId);
  if (before === undefined || (before.removed && command.kind !== 'remove'))
    throw new McpAuthorityError('mcp-not-found');
  switch (command.kind) {
    case 'trust':
      if (before.configDigest !== command.configDigest) conflict();
      if (before.trustedDigest === command.configDigest && before.enabled) return null;
      return { kind: 'trusted', serverId: command.serverId, configDigest: command.configDigest };
    case 'enable':
      if (
        before.configDigest !== command.configDigest ||
        before.trustedDigest !== command.configDigest ||
        before.trustState !== 'trusted'
      )
        conflict();
      return before.enabled
        ? null
        : { kind: 'enabled', serverId: command.serverId, configDigest: command.configDigest };
    case 'disable':
      return before.enabled ? { kind: 'disabled', serverId: command.serverId } : null;
    case 'revoke':
      return before.trustState === 'untrusted' && before.trustedDigest === null && !before.enabled
        ? null
        : { kind: 'revoked', serverId: command.serverId };
    case 'remove':
      return before.removed ? null : { kind: 'removed', serverId: command.serverId };
  }
}

function storage<T>(operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    if (error instanceof McpAuthorityError) throw error;
    throw new McpAuthorityError(
      isSqliteBusyError(error) ? 'mcp-authority-busy' : 'mcp-authority-storage',
    );
  }
}

/** Dedicated append-only table; this store owns no database-wide schema version. */
export function createSqliteMcpAuthorityStore(options: {
  readonly filename: string;
  readonly now?: () => Date;
}): McpAuthorityStore {
  let parsedOptions: z.infer<typeof optionsSchema>;
  try {
    parsedOptions = optionsSchema.parse(options);
  } catch {
    throw new McpAuthorityError('mcp-invalid');
  }
  const database = storage(() => {
    const opened = openSharedDatabase(parsedOptions.filename);
    try {
      opened.exec(
        'CREATE TABLE IF NOT EXISTS mcp_authority_events (sequence INTEGER NOT NULL PRIMARY KEY, occurred_at TEXT NOT NULL, scope TEXT NOT NULL, event_json TEXT NOT NULL)',
      );
      return opened;
    } catch (error) {
      opened.close();
      throw error;
    }
  });
  const now = parsedOptions.now ?? (() => new Date());
  let closed = false;
  const ensureOpen = () => {
    if (closed) throw new McpAuthorityError('mcp-closed');
  };
  return {
    async read(options = {}) {
      ensureOpen();
      let prefix: readonly RecordedMcpAuthorityEvent[];
      try {
        prefix =
          z.strictObject({ knownPrefix: eventsSchema.optional() }).parse(options).knownPrefix ?? [];
      } catch {
        throw new McpAuthorityError('mcp-invalid');
      }
      return storage(() => readLog(database, prefix));
    },
    async mutate(commandInput, optionsInput) {
      ensureOpen();
      let command: McpAuthorityCommand;
      let mutationOptions: z.infer<typeof mutateOptionsSchema>;
      try {
        command = commandSchema.parse(commandInput);
        mutationOptions = mutateOptionsSchema.parse(optionsInput);
      } catch {
        throw new McpAuthorityError('mcp-invalid');
      }
      return storage(() => {
        database.exec('BEGIN IMMEDIATE');
        try {
          const before = readLog(database, mutationOptions.knownPrefix);
          if (before.sequence !== mutationOptions.expectedSequence) conflict();
          const event = nextEvent(command, before);
          if (event === null) {
            database.exec('COMMIT');
            return freezeMcpValue({ ...before, appended: null });
          }
          let recorded: RecordedMcpAuthorityEvent;
          try {
            recorded = recordedMcpAuthorityEventSchema.parse({
              ...event,
              schemaVersion: 1,
              sequence: before.sequence + 1,
              occurredAt: z.date().parse(now()).toISOString(),
              scope: 'user',
            });
          } catch {
            throw new McpAuthorityError('mcp-invalid');
          }
          const next = logFromEvents([...before.events, recorded], before.events);
          database
            .prepare(
              'INSERT INTO mcp_authority_events (sequence, occurred_at, scope, event_json) VALUES (?, ?, ?, ?)',
            )
            .run(recorded.sequence, recorded.occurredAt, recorded.scope, JSON.stringify(recorded));
          database.exec('COMMIT');
          return freezeMcpValue({ ...next, appended: recorded });
        } catch (error) {
          try {
            database.exec('ROLLBACK');
          } catch {
            /* Preserve the failed operation's safe error. */
          }
          throw error;
        }
      });
    },
    async close() {
      if (closed) return;
      storage(() => database.close());
      closed = true;
    },
  };
}
