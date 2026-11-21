import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { detachAndFreeze } from './plugin-authority-data.js';
import {
  managedRootRegistrationSchema,
  type ManagedStoreBinding,
} from './plugin-authority-types.js';
import {
  initialBindingSchema,
  PluginStoreOwnershipError,
  recordedManagedStoreBindingSchema,
  type RecordedManagedStoreBinding,
} from './plugin-store-ownership-types.js';
import {
  assertStorePathIdentity,
  checkOwnerSidecars,
  hasStorePathCode,
  readStorePathIdentity,
  scanStoreLayout,
  validatedStorePathsSchema,
} from './plugin-store-paths.js';

export interface ManagedStoreLease {
  readonly binding: ManagedStoreBinding;
  assertHeldSync(): void;
  close(): Promise<void>;
}

const acquireOptionsSchema = z.strictObject({
  paths: validatedStorePathsSchema,
  databaseId: z.string().uuid(),
  existingRegistration: managedRootRegistrationSchema.nullable(),
  initialBinding: initialBindingSchema,
});

const tableName = 'managed_store_binding_events';
const createBindingTable = `CREATE TABLE ${tableName} (
  sequence INTEGER NOT NULL PRIMARY KEY CHECK (sequence = 1),
  occurred_at TEXT NOT NULL,
  event_json TEXT NOT NULL
)`;
const tableDefinitionSchema = z.tuple([
  z.strictObject({ name: z.literal(tableName), type: z.literal('table'), sql: z.string() }),
]);
const bindingRowSchema = z.tuple([
  z.strictObject({
    sequence: z.literal(1n),
    occurred_at: z.iso.datetime(),
    event_json: z.string(),
  }),
]);
const journalModeSchema = z.strictObject({ journal_mode: z.literal('delete') });
const busyTimeoutSchema = z.strictObject({ timeout: z.literal(0) });
const sqliteErrorSchema = z.object({ errcode: z.number().int() });

function recoveryRequired(cause?: unknown): PluginStoreOwnershipError {
  return new PluginStoreOwnershipError(
    'plugin-store-recovery-required',
    'Managed store owner metadata requires recovery',
    { cause },
  );
}

function protocol(cause?: unknown): PluginStoreOwnershipError {
  return new PluginStoreOwnershipError(
    'plugin-store-protocol',
    'Managed store owner metadata is invalid',
    { cause },
  );
}

function storage(cause: unknown): PluginStoreOwnershipError {
  return new PluginStoreOwnershipError(
    'plugin-store-storage',
    'Managed store ownership operation failed',
    { cause },
  );
}

function acquisitionError(error: unknown): PluginStoreOwnershipError {
  if (error instanceof PluginStoreOwnershipError) return error;
  const sqlite = sqliteErrorSchema.safeParse(error);
  const code = sqlite.success ? sqlite.data.errcode & 0xff : undefined;
  if (code === 5 || code === 6) {
    return new PluginStoreOwnershipError(
      'plugin-store-busy',
      'Managed store is held by another owner',
      { cause: error },
    );
  }
  if (code === 11 || code === 26) return recoveryRequired(error);
  return storage(error);
}

function readAndValidateBinding(owner: DatabaseSync): RecordedManagedStoreBinding {
  const definitions = owner.prepare('SELECT name, type, sql FROM main.sqlite_schema LIMIT 2').all();
  if (definitions.length === 0) throw recoveryRequired();
  const definition = tableDefinitionSchema.safeParse(definitions);
  if (!definition.success) throw protocol(definition.error);
  // Only the private version-1 writer defines this table, including its singleton CHECK.
  const normalize = (sql: string) => sql.replace(/\s+/g, ' ').trim();
  if (normalize(definition.data[0].sql) !== normalize(createBindingTable)) throw protocol();
  const query = owner.prepare(
    `SELECT sequence, occurred_at, event_json FROM main.${tableName} LIMIT 2`,
  );
  query.setReadBigInts(true);
  const rows = query.all();
  try {
    const [row] = bindingRowSchema.parse(rows);
    const event = recordedManagedStoreBindingSchema.parse(JSON.parse(row.event_json) as unknown);
    if (event.occurredAt !== row.occurred_at) throw protocol();
    return detachAndFreeze(event);
  } catch (error: unknown) {
    if (error instanceof PluginStoreOwnershipError) throw error;
    throw protocol(error);
  }
}

function assertExactBinding(actual: ManagedStoreBinding, expected: ManagedStoreBinding): void {
  if (
    actual.version !== expected.version ||
    actual.databaseId !== expected.databaseId ||
    actual.databaseFile !== expected.databaseFile ||
    actual.storeId !== expected.storeId ||
    actual.storeDirectory !== expected.storeDirectory ||
    actual.ownerDatabaseFile !== expected.ownerDatabaseFile
  ) {
    throw new PluginStoreOwnershipError(
      'plugin-store-owner-mismatch',
      'Managed store belongs to a different authority or root',
    );
  }
}

function configureConnection(owner: DatabaseSync, created: boolean): void {
  const timeout = owner.prepare('PRAGMA busy_timeout = 0').get();
  const timeoutResult = busyTimeoutSchema.safeParse(timeout);
  if (!timeoutResult.success) throw protocol(timeoutResult.error);
  const journal = owner
    .prepare(created ? 'PRAGMA journal_mode = DELETE' : 'PRAGMA journal_mode')
    .get();
  const journalResult = journalModeSchema.safeParse(journal);
  if (!journalResult.success) throw protocol(journalResult.error);
}

function commitFirstBinding(owner: DatabaseSync, binding: ManagedStoreBinding) {
  owner.exec('BEGIN EXCLUSIVE');
  owner.exec(createBindingTable);
  const event = recordedManagedStoreBindingSchema.parse({
    version: 1,
    sequence: 1,
    kind: 'managed-store-bound',
    occurredAt: new Date().toISOString(),
    binding,
  });
  owner
    .prepare(`INSERT INTO ${tableName} (sequence, occurred_at, event_json) VALUES (1, ?, ?)`)
    .run(event.occurredAt, JSON.stringify(event));
  const recorded = readAndValidateBinding(owner);
  assertExactBinding(recorded.binding, binding);
  owner.exec('COMMIT');
  return recorded.binding;
}

function releaseConnection(owner: DatabaseSync): void {
  const failures: unknown[] = [];
  try {
    if (owner.isOpen && owner.isTransaction) {
      owner.exec('ROLLBACK');
      if (owner.isTransaction) throw new Error('Managed store rollback left an active transaction');
    }
  } catch (error: unknown) {
    failures.push(error);
  }
  try {
    if (owner.isOpen) owner.close();
    if (owner.isOpen) throw new Error('Managed store owner connection remains open');
  } catch (error: unknown) {
    failures.push(error);
  }
  if (failures.length > 0) {
    throw storage(failures.length === 1 ? failures[0] : new AggregateError(failures));
  }
}

async function reserveOwnerFile(path: string) {
  let handle;
  try {
    handle = await fs.open(path, 'wx', 0o600);
  } catch (error: unknown) {
    if (hasStorePathCode(error, 'EEXIST')) return undefined;
    throw error;
  }
  let identity;
  try {
    const stat = await handle.stat({ bigint: true });
    identity = { dev: stat.dev, ino: stat.ino };
  } catch (error: unknown) {
    try {
      await handle.close();
    } catch (cleanup: unknown) {
      throw storage(new AggregateError([error, cleanup], 'Closing the owner reservation failed'));
    }
    throw error;
  }
  await handle.close();
  return identity;
}

export async function acquireManagedStoreLease(
  options: Readonly<z.input<typeof acquireOptionsSchema>>,
): Promise<ManagedStoreLease> {
  const parsed = acquireOptionsSchema.safeParse(options);
  if (!parsed.success) {
    throw new PluginStoreOwnershipError(
      'plugin-store-invalid',
      'Managed store options are invalid',
      {
        cause: parsed.error,
      },
    );
  }
  const { paths, databaseId, existingRegistration, initialBinding } = parsed.data;
  const { databaseFile, storeDirectory, ownerDatabaseFile, mainIdentity } = paths;
  if (ownerDatabaseFile !== join(storeDirectory, 'ownership.sqlite')) {
    throw new PluginStoreOwnershipError(
      'plugin-store-invalid',
      'Managed store owner path is invalid',
    );
  }
  const requestedBinding = {
    version: 1,
    databaseId,
    databaseFile,
    storeDirectory,
    ownerDatabaseFile,
  } as const;
  if (existingRegistration !== null) {
    assertExactBinding(existingRegistration.binding, {
      ...requestedBinding,
      storeId: existingRegistration.binding.storeId,
    });
  }
  const mayInitialize = existingRegistration === null && initialBinding === 'allow-unbound';

  let owner: DatabaseSync | undefined;
  try {
    let { rootIdentity, ownerIdentity } = paths;
    if (rootIdentity === undefined) {
      if (!mayInitialize) throw recoveryRequired();
      try {
        await fs.mkdir(storeDirectory);
      } catch (error: unknown) {
        if (!hasStorePathCode(error, 'EEXIST')) throw error;
      }
      rootIdentity = await readStorePathIdentity(storeDirectory, 'directory');
      if (rootIdentity === undefined) throw recoveryRequired();
      ownerIdentity = await scanStoreLayout(storeDirectory, 'before-acquisition');
    }
    assertStorePathIdentity(databaseFile, 'file', mainIdentity);
    assertStorePathIdentity(storeDirectory, 'directory', rootIdentity);

    let created = false;
    if (ownerIdentity === undefined && mayInitialize) {
      ownerIdentity = await readStorePathIdentity(ownerDatabaseFile, 'file');
      if (ownerIdentity === undefined) {
        checkOwnerSidecars(ownerDatabaseFile, false);
        ownerIdentity = await reserveOwnerFile(ownerDatabaseFile);
        created = ownerIdentity !== undefined;
      }
    }
    ownerIdentity ??= await readStorePathIdentity(ownerDatabaseFile, 'file');
    if (ownerIdentity === undefined) throw recoveryRequired();
    function checkOwnerIdentity() {
      try {
        assertStorePathIdentity(ownerDatabaseFile, 'file', ownerIdentity!);
      } catch (error: unknown) {
        throw recoveryRequired(error);
      }
    }
    function checkLeafIdentities() {
      assertStorePathIdentity(databaseFile, 'file', mainIdentity);
      assertStorePathIdentity(storeDirectory, 'directory', rootIdentity!);
      checkOwnerIdentity();
    }

    checkOwnerSidecars(ownerDatabaseFile, !created);
    checkLeafIdentities();
    // Node 24.4 has no read-write/no-create flag. If native open creates an empty
    // file after a disappearance, the identity check prevents binding that file.
    owner = new DatabaseSync(ownerDatabaseFile);
    checkLeafIdentities();
    configureConnection(owner, created);

    const binding = created
      ? commitFirstBinding(owner, { ...requestedBinding, storeId: randomUUID() })
      : readAndValidateBinding(owner).binding;
    assertExactBinding(binding, { ...requestedBinding, storeId: binding.storeId });
    if (existingRegistration !== null) assertExactBinding(binding, existingRegistration.binding);
    owner.exec('BEGIN EXCLUSIVE');
    if (!owner.isOpen || !owner.isTransaction)
      throw new Error('Managed store did not acquire a transaction');
    const held = readAndValidateBinding(owner).binding;
    assertExactBinding(held, binding);
    await scanStoreLayout(storeDirectory, 'held');
    checkLeafIdentities();
    if (!owner.isOpen || !owner.isTransaction)
      throw new Error('Managed store lease did not survive validation');
    return heldLease(owner, binding, checkLeafIdentities);
  } catch (error: unknown) {
    const primary = acquisitionError(error);
    if (owner !== undefined) {
      try {
        releaseConnection(owner);
      } catch (cleanup: unknown) {
        throw new PluginStoreOwnershipError(primary.code, primary.message, {
          cause: new AggregateError([primary, cleanup], 'Managed store acquisition cleanup failed'),
        });
      }
    }
    throw primary;
  }
}

function heldLease(
  owner: DatabaseSync,
  binding: ManagedStoreBinding,
  checkLeafIdentities: () => void,
): ManagedStoreLease {
  let closing = false;
  let confirmedClosed = false;
  let closeAttempt: Promise<void> | undefined;
  let loss: PluginStoreOwnershipError | undefined;
  return {
    binding,
    assertHeldSync() {
      if (closing)
        throw new PluginStoreOwnershipError('plugin-store-closed', 'Managed store lease is closed');
      if (loss !== undefined) throw loss;
      try {
        if (!owner.isOpen || !owner.isTransaction)
          throw new Error('Managed store transaction ended');
        checkLeafIdentities();
      } catch (error: unknown) {
        loss = new PluginStoreOwnershipError(
          'plugin-store-ownership-lost',
          'Managed store ownership was lost',
          {
            cause: error,
          },
        );
        throw loss;
      }
    },
    close() {
      closing = true;
      if (confirmedClosed) return Promise.resolve();
      closeAttempt ??= Promise.resolve()
        .then(() => {
          releaseConnection(owner);
          confirmedClosed = true;
        })
        .finally(() => {
          closeAttempt = undefined;
        });
      return closeAttempt;
    },
  };
}
