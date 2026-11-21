import type { DatabaseSync, StatementSync } from 'node:sqlite';
import { z } from 'zod';
import { canonicalJson } from './plugin-authority-data.js';
import {
  managedRootRegistrationSchema,
  PluginAuthorityError,
  type ManagedRootRegistration,
  type PluginDatabaseIdentity,
} from './plugin-authority-types.js';

export interface ManagedRootSchemaMarker {
  readonly version: 1;
  readonly databaseId: string;
}

export const managedRootSchemaMarkerSchema: z.ZodType<ManagedRootSchemaMarker> = z.strictObject({
  version: z.literal(1),
  databaseId: z.string().uuid(),
});

const markerTable = 'plugin_managed_root_schema';
const rootTable = 'plugin_managed_root_events';
const tableSchema = z.array(
  z.strictObject({
    name: z.enum([markerTable, rootTable]),
    type: z.literal('table'),
  }),
);
const columnSchema = z.array(
  z.strictObject({
    name: z.string(),
    type: z.string(),
    notnull: z.literal(1n),
    pk: z.union([z.literal(0n), z.literal(1n)]),
    hidden: z.literal(0n),
  }),
);
const markerRowsSchema = z
  .array(
    z.strictObject({
      singleton: z.literal(1n),
      marker_json: z.string(),
    }),
  )
  .length(1);
const registrationRowsSchema = z
  .array(
    z.strictObject({
      sequence: z.literal(1n),
      occurred_at: z.string(),
      event_json: z.string(),
    }),
  )
  .max(1);

function protocol(cause?: unknown): never {
  throw new PluginAuthorityError(
    'plugin-authority-protocol',
    'Plugin authority contains invalid managed root metadata',
    { cause },
  );
}

function parsePersisted<T>(parse: () => T): T {
  try {
    return parse();
  } catch (cause: unknown) {
    return protocol(cause);
  }
}

function readBigInts(statement: StatementSync) {
  statement.setReadBigInts(true);
  return statement.all();
}

function registryTables(database: DatabaseSync) {
  const rows = database
    .prepare(
      `
    SELECT name, type FROM main.sqlite_schema
    WHERE name COLLATE NOCASE IN (?, ?) AND type IN ('table', 'view', 'index')
  `,
    )
    .all(markerTable, rootTable);
  return parsePersisted(() => tableSchema.parse(rows));
}

function validateColumns(
  database: DatabaseSync,
  table: typeof markerTable | typeof rootTable,
  primary: string,
  textColumns: readonly string[],
): void {
  const query = database.prepare(`
    SELECT name, type, "notnull", pk, hidden FROM pragma_table_xinfo(?, 'main')
  `);
  query.setReadBigInts(true);
  const rows = query.all(table);
  const columns = parsePersisted(() => columnSchema.parse(rows));
  if (
    columns.length !== textColumns.length + 1 ||
    !columns.some(
      ({ name, type, pk }) => name === primary && type.toUpperCase() === 'INTEGER' && pk === 1n,
    )
  )
    protocol();
  for (const name of textColumns) {
    if (
      !columns.some(
        (column) =>
          column.name === name && column.type.toUpperCase() === 'TEXT' && column.pk === 0n,
      )
    )
      protocol();
  }
}

function readRegistration(
  database: DatabaseSync,
  identity: PluginDatabaseIdentity,
): ManagedRootRegistration | null {
  validateColumns(database, markerTable, 'singleton', ['marker_json']);
  validateColumns(database, rootTable, 'sequence', ['occurred_at', 'event_json']);
  const markerRows = readBigInts(
    database.prepare(`SELECT singleton, marker_json FROM main.${markerTable} LIMIT 2`),
  );
  const marker = parsePersisted(() => {
    const [row] = markerRowsSchema.parse(markerRows);
    return managedRootSchemaMarkerSchema.parse(JSON.parse(row!.marker_json) as unknown);
  });
  if (marker.databaseId !== identity.databaseId) protocol();

  const registrationRows = readBigInts(
    database.prepare(`SELECT sequence, occurred_at, event_json FROM main.${rootTable} LIMIT 2`),
  );
  const [row] = parsePersisted(() => registrationRowsSchema.parse(registrationRows));
  if (row === undefined) return null;
  const event = parsePersisted(() =>
    managedRootRegistrationSchema.parse(JSON.parse(row.event_json) as unknown),
  );
  if (event.occurredAt !== row.occurred_at || event.binding.databaseId !== identity.databaseId)
    protocol();
  return event;
}

export function initializeManagedRootSchemaTx(
  database: DatabaseSync,
  identity: PluginDatabaseIdentity,
): void {
  const tables = registryTables(database);
  if (tables.length === 0) {
    // With both tables absent, legacy state and full external erasure are indistinguishable.
    database.exec(`
      CREATE TABLE plugin_managed_root_schema (
        singleton INTEGER NOT NULL PRIMARY KEY CHECK (singleton = 1),
        marker_json TEXT NOT NULL
      );
      CREATE TABLE plugin_managed_root_events (
        sequence INTEGER NOT NULL PRIMARY KEY CHECK (sequence = 1),
        occurred_at TEXT NOT NULL,
        event_json TEXT NOT NULL
      );
    `);
    const marker: ManagedRootSchemaMarker = { version: 1, databaseId: identity.databaseId };
    database
      .prepare(`INSERT INTO ${markerTable} (singleton, marker_json) VALUES (1, ?)`)
      .run(JSON.stringify(marker));
  } else if (tables.length !== 2) {
    protocol();
  }
  readRegistration(database, identity);
}

export function readManagedRootRegistrationTx(
  database: DatabaseSync,
  identity: PluginDatabaseIdentity,
): ManagedRootRegistration | null {
  if (registryTables(database).length !== 2) protocol();
  return readRegistration(database, identity);
}

export function appendManagedRootRegistrationTx(
  database: DatabaseSync,
  identity: PluginDatabaseIdentity,
  event: ManagedRootRegistration,
): void {
  database
    .prepare(`INSERT INTO main.${rootTable} (sequence, occurred_at, event_json) VALUES (1, ?, ?)`)
    .run(event.occurredAt, JSON.stringify(event));
  const stored = readManagedRootRegistrationTx(database, identity);
  if (canonicalJson(stored) !== canonicalJson(event)) protocol();
}
