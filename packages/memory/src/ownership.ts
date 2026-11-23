import { lstatSync, realpathSync, openSync, closeSync, type BigIntStats } from 'node:fs';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { MemoryStoreError, persistence } from './errors.js';

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
    const file = `${filename}${suffix}`;
    const stat = lstatSync(file, { bigint: true, throwIfNoEntry: false });
    if (stat !== undefined) {
      if (rollbackOnly && suffix !== '-journal') throw persistence();
      identity(file);
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
export interface MemoryOwnership {
  readonly filename: string;
  assertHeldSync(): void;
  close(): void;
}
export function acquireMemoryOwnership(input: string): MemoryOwnership {
  let owner: DatabaseSync | undefined;
  try {
    if (!isAbsolute(input) || input.includes('\0')) throw persistence();
    const filename = join(realpathSync.native(dirname(input)), basename(input));
    const ownerFilename = `${filename}.owner.sqlite`;
    const ownerIdentity = reserve(ownerFilename);
    checkSidecars(ownerFilename, true);
    checkSidecars(filename, false);
    // No main data connection or migration is opened until this rollback-journal lock is held.
    owner = new DatabaseSync(ownerFilename);
    owner.exec('PRAGMA busy_timeout = 0');
    const mode = owner.prepare('PRAGMA journal_mode').get();
    if (mode?.journal_mode !== 'delete') throw persistence();
    owner.exec('BEGIN EXCLUSIVE');
    const dataIdentity = reserve(filename);
    const connection = owner;
    let released = false;
    let invalid = false;
    return {
      filename,
      assertHeldSync() {
        try {
          if (released || invalid || !connection.isOpen || !connection.isTransaction)
            throw persistence();
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
        if (released) return;
        try {
          if (connection.isTransaction) connection.exec('ROLLBACK');
          if (connection.isOpen) connection.close();
          released = true;
        } catch (error) {
          throw persistence(error);
        }
      },
    };
  } catch (error) {
    try {
      owner?.close();
    } catch {
      /* Preserve acquisition failure. */
    }
    if (
      typeof error === 'object' &&
      error !== null &&
      'errcode' in error &&
      typeof error.errcode === 'number' &&
      [5, 6].includes(error.errcode & 0xff)
    )
      throw new MemoryStoreError('memory-busy');
    throw persistence(error);
  }
}
