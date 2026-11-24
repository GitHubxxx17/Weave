import { closeSync, lstatSync, openSync, realpathSync, type BigIntStats } from 'node:fs';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { persistence, RetrievalStoreError } from './errors.js';

function identity(filename: string): BigIntStats {
  const stat = lstatSync(filename, { bigint: true });
  if (
    !stat.isFile() ||
    stat.nlink !== 1n ||
    stat.dev <= 0n ||
    stat.ino <= 0n ||
    realpathSync.native(filename) !== filename
  )
    throw persistence();
  return stat;
}

function checkSidecars(filename: string, rollbackOnly: boolean): void {
  for (const suffix of ['-journal', '-wal', '-shm']) {
    const sidecar = `${filename}${suffix}`;
    if (lstatSync(sidecar, { bigint: true, throwIfNoEntry: false }) !== undefined) {
      if (rollbackOnly && suffix !== '-journal') throw persistence();
      identity(sidecar);
    }
  }
}

function reserve(filename: string): BigIntStats {
  try {
    closeSync(openSync(filename, 'wx', 0o600));
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
  }
  return identity(filename);
}

export function createRetrievalOwnership(input: string) {
  let connection: DatabaseSync | undefined;
  let dataIdentity: BigIntStats;
  let ownerIdentity: BigIntStats;
  let invalid = false;
  if (!isAbsolute(input) || input.includes('\0')) throw persistence();
  const filename = join(realpathSync.native(dirname(input)), basename(input));
  const ownerFilename = `${filename}.owner.sqlite`;
  return {
    filename,
    get isOpen() {
      return connection?.isOpen === true;
    },
    acquire() {
      try {
        ownerIdentity = reserve(ownerFilename);
        checkSidecars(ownerFilename, true);
        checkSidecars(filename, false);
        connection = new DatabaseSync(ownerFilename, { open: false });
        connection.open();
        connection.exec('PRAGMA busy_timeout = 0');
        if (connection.prepare('PRAGMA journal_mode').get()?.journal_mode !== 'delete')
          throw persistence();
        connection.exec('BEGIN EXCLUSIVE');
        dataIdentity = reserve(filename);
        this.assertHeldSync();
      } catch (error) {
        if (
          typeof error === 'object' &&
          error !== null &&
          'errcode' in error &&
          typeof error.errcode === 'number' &&
          [5, 6].includes(error.errcode & 0xff)
        )
          throw new RetrievalStoreError('retrieval-busy', { cause: error });
        throw persistence(error);
      }
    },
    assertHeldSync() {
      try {
        if (invalid || !connection?.isOpen || !connection.isTransaction) throw persistence();
        checkSidecars(ownerFilename, true);
        checkSidecars(filename, false);
        for (const [file, expected] of [
          [ownerFilename, ownerIdentity],
          [filename, dataIdentity],
        ] as const) {
          const actual = identity(file);
          if (actual.dev !== expected.dev || actual.ino !== expected.ino) throw persistence();
        }
      } catch (error) {
        invalid = true;
        throw persistence(error);
      }
    },
    close() {
      if (connection?.isOpen) connection.close();
    },
  };
}
