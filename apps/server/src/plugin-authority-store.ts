import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import type { PluginTrustStore } from '@weave/plugin-host';
import { z } from 'zod';
import {
  canonicalJson,
  canonicalizeManagedRequest,
  detachAndFreeze,
  type CanonicalManagedRequest,
} from './plugin-authority-data.js';
import {
  appendManagedTransitionTx,
  initializeAuthoritySchemaTx,
  readAuthoritySnapshotTx,
  resolveManagedTransition,
} from './plugin-authority-log.js';
import {
  managedPreparationSchema,
  pluginAuthorityOptionsSchema,
  PluginAuthorityError,
  type ManagedCommit,
  type ManagedCommitInput,
  type ManagedLookup,
  type PluginAuthorityDatabase,
  type PluginAuthorityOptions,
  type PluginAuthoritySnapshot,
  type RecordedManagedOperation,
} from './plugin-authority-types.js';
import {
  appendRecordedTrustEventTx,
  createRecordedTrustEvent,
  PluginTrustStoreError,
  validateTrustInput,
} from './plugin-trust-sqlite.js';

const invalidMessage = 'Plugin authority input is invalid';
const storageMessage = 'Plugin authority database operation failed';
const commitContainerSchema = z.custom<Record<string, unknown>>((value) => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  const request = Object.getOwnPropertyDescriptor(value, 'request');
  return (
    request !== undefined &&
    request.enumerable === true &&
    'value' in request &&
    Reflect.ownKeys(value).every((key) => key === 'request' || key === 'prepared')
  );
});

function invalid(cause: unknown): never {
  throw new PluginAuthorityError('plugin-authority-invalid', invalidMessage, { cause });
}

function authorityError(error: unknown): PluginAuthorityError {
  if (error instanceof PluginAuthorityError) return error;
  if (error instanceof PluginTrustStoreError) {
    const code =
      error.code === 'plugin-trust-protocol'
        ? 'plugin-authority-protocol'
        : error.code === 'plugin-trust-invalid'
          ? 'plugin-authority-invalid'
          : error.code === 'plugin-trust-closed'
            ? 'plugin-authority-closed'
            : 'plugin-authority-storage';
    return new PluginAuthorityError(code, storageMessage, { cause: error.cause ?? error });
  }
  const sqlite = z.object({ errcode: z.number() }).safeParse(error);
  const busy = sqlite.success && [5, 6].includes(sqlite.data.errcode & 0xff);
  return new PluginAuthorityError(
    busy ? 'plugin-authority-busy' : 'plugin-authority-storage',
    storageMessage,
    { cause: error },
  );
}

function trustError(error: unknown): PluginTrustStoreError {
  if (error instanceof PluginTrustStoreError) return error;
  const authority = authorityError(error);
  const code =
    authority.code === 'plugin-authority-invalid'
      ? 'plugin-trust-invalid'
      : authority.code === 'plugin-authority-protocol'
        ? 'plugin-trust-protocol'
        : authority.code === 'plugin-authority-closed'
          ? 'plugin-trust-closed'
          : 'plugin-trust-storage';
  return new PluginTrustStoreError(code, 'Plugin Trust Store database operation failed', {
    cause: authority.cause ?? authority,
  });
}

function lookupOperation(
  snapshot: PluginAuthoritySnapshot,
  canonical: CanonicalManagedRequest,
): RecordedManagedOperation | undefined {
  const operation = snapshot.operationEvents.find(
    (event) => event.requestId === canonical.request.requestId,
  );
  if (
    operation !== undefined &&
    (operation.fingerprint !== canonical.fingerprint ||
      canonicalJson({ version: 1, command: operation.command }) !== canonical.canonicalCommand)
  ) {
    throw new PluginAuthorityError(
      'plugin-authority-request-conflict',
      'Plugin authority request ID already identifies a different command',
    );
  }
  return operation;
}

/** One private connection owns every authority transaction and its borrowed manual facade. */
export function createSqlitePluginAuthorityDatabase(
  options: PluginAuthorityOptions,
): PluginAuthorityDatabase {
  const parsed = pluginAuthorityOptionsSchema.safeParse(options);
  if (!parsed.success) invalid(parsed.error);
  let database: DatabaseSync;
  try {
    database = new DatabaseSync(parsed.data.filename);
  } catch (error: unknown) {
    throw authorityError(error);
  }
  const now = parsed.data.now ?? (() => new Date());
  const newDatabaseId = parsed.data.newDatabaseId ?? randomUUID;
  let unavailable = false;
  let closed = false;

  function requireOpen(): void {
    if (unavailable) {
      throw new PluginAuthorityError(
        'plugin-authority-closed',
        'Plugin authority database is closed',
      );
    }
  }

  function failedTransaction(primary: unknown, committing: boolean): never {
    let cleanupFailure: unknown;
    try {
      if (!database.isOpen) {
        unavailable = true;
      } else if (!database.isTransaction) {
        // A COMMIT exception may follow a durable save; reconcile the same request ID after reopen.
        if (committing) unavailable = true;
      } else {
        database.exec('ROLLBACK');
        if (database.isTransaction) {
          cleanupFailure = new Error('Plugin authority rollback left an active transaction');
          unavailable = true;
        }
      }
    } catch (error: unknown) {
      cleanupFailure = error;
      unavailable = true;
    }
    const failure = authorityError(primary);
    if (cleanupFailure !== undefined) {
      throw new PluginAuthorityError(failure.code, failure.message, {
        cause: new AggregateError(
          [primary, cleanupFailure],
          'Plugin authority transaction cleanup failed',
        ),
      });
    }
    throw failure;
  }

  function transaction<T>(begin: 'BEGIN' | 'BEGIN IMMEDIATE', operation: () => T): T {
    requireOpen();
    let committing = false;
    try {
      database.exec(begin);
      const result = operation();
      committing = true;
      database.exec('COMMIT');
      return result;
    } catch (error: unknown) {
      return failedTransaction(error, committing);
    }
  }

  function timestamp(): string {
    try {
      return z.date().parse(now()).toISOString();
    } catch (error: unknown) {
      return invalid(error);
    }
  }

  let identity: PluginAuthorityDatabase['identity'];
  try {
    identity = transaction('BEGIN IMMEDIATE', () =>
      detachAndFreeze(initializeAuthoritySchemaTx(database, newDatabaseId)),
    );
  } catch (error: unknown) {
    try {
      if (database.isOpen) database.close();
    } catch (cleanup: unknown) {
      const primary = authorityError(error);
      throw new PluginAuthorityError(primary.code, primary.message, {
        cause: new AggregateError(
          [error, cleanup],
          'Plugin authority initialization cleanup failed',
        ),
      });
    }
    throw error;
  }

  const trust: PluginTrustStore = {
    async append(input) {
      try {
        requireOpen();
        const event = validateTrustInput(input);
        return transaction('BEGIN IMMEDIATE', () => {
          const before = readAuthoritySnapshotTx(database);
          if (before.installations.some((record) => record.pluginId === event.pluginId)) {
            throw new PluginTrustStoreError(
              'plugin-trust-invalid',
              'Managed plugin trust requires the combined managed API',
            );
          }
          if (before.heads.trustSequence >= Number.MAX_SAFE_INTEGER) {
            throw new PluginAuthorityError(
              'plugin-authority-protocol',
              'Plugin authority trust sequence is exhausted',
            );
          }
          const recorded = createRecordedTrustEvent(
            event,
            before.heads.trustSequence + 1,
            timestamp(),
          );
          appendRecordedTrustEventTx(database, recorded);
          readAuthoritySnapshotTx(database);
          return structuredClone(recorded);
        });
      } catch (error: unknown) {
        if (error instanceof PluginAuthorityError && error.cause instanceof PluginTrustStoreError) {
          throw error.cause;
        }
        throw trustError(error);
      }
    },
    async events() {
      try {
        return transaction('BEGIN', () =>
          structuredClone(readAuthoritySnapshotTx(database).trustEvents),
        );
      } catch (error: unknown) {
        throw trustError(error);
      }
    },
  };

  return {
    identity,
    trust,
    snapshotSync() {
      return transaction('BEGIN', () => detachAndFreeze(readAuthoritySnapshotTx(database)));
    },
    lookupSync(input) {
      const canonical = canonicalizeManagedRequest(input);
      return transaction('BEGIN', () => {
        const snapshot = readAuthoritySnapshotTx(database);
        const operation = lookupOperation(snapshot, canonical);
        return detachAndFreeze<ManagedLookup>(
          operation === undefined
            ? { kind: 'absent' }
            : { kind: 'replayed', operation, currentSnapshot: snapshot },
        );
      });
    },
    commitSync(input) {
      let container: Record<string, unknown>;
      try {
        container = commitContainerSchema.parse(input);
      } catch (error: unknown) {
        return invalid(error);
      }
      const canonical = canonicalizeManagedRequest(container.request);
      return transaction('BEGIN IMMEDIATE', () => {
        const before = readAuthoritySnapshotTx(database);
        const operation = lookupOperation(before, canonical);
        if (operation !== undefined) {
          return detachAndFreeze<ManagedCommit>({
            kind: 'replayed',
            operation,
            currentSnapshot: before,
          });
        }
        const preparation = Object.getOwnPropertyDescriptor(container, 'prepared');
        if (preparation === undefined || !preparation.enumerable || !('value' in preparation)) {
          return invalid(new Error('A fresh managed request requires preparation'));
        }
        let prepared: ManagedCommitInput['prepared'];
        try {
          canonicalJson(preparation.value);
          prepared = managedPreparationSchema.parse(preparation.value);
          if (prepared.kind !== canonical.request.command.kind) {
            return invalid(new Error('Managed preparation must match its command'));
          }
        } catch (error: unknown) {
          return invalid(error);
        }
        const transition = resolveManagedTransition(
          before,
          {
            request: canonical.request,
            prepared,
          },
          timestamp(),
        );
        appendManagedTransitionTx(database, transition);
        const afterSnapshot = readAuthoritySnapshotTx(database);
        return detachAndFreeze<ManagedCommit>({
          kind: 'committed',
          operation: transition.operation,
          afterSnapshot,
        });
      });
    },
    async close() {
      if (closed) return;
      unavailable = true;
      try {
        if (database.isOpen) database.close();
        closed = true;
      } catch (error: unknown) {
        throw new PluginAuthorityError('plugin-authority-storage', storageMessage, {
          cause: error,
        });
      }
    },
  };
}
