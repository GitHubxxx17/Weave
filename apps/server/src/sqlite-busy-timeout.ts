import { DatabaseSync } from 'node:sqlite';

/**
 * Milliseconds a connection to the shared `weave.sqlite` waits on a competing writer
 * before SQLite reports `SQLITE_BUSY`. Matches the session and workspace stores.
 */
export const SHARED_DATABASE_BUSY_TIMEOUT_MS = 5000;

/** Opens a connection to the shared database file with the common busy timeout. */
export function openSharedDatabase(filename: string): DatabaseSync {
  return new DatabaseSync(filename, { timeout: SHARED_DATABASE_BUSY_TIMEOUT_MS });
}

/** True for SQLITE_BUSY (5) and SQLITE_LOCKED (6), including their extended codes. */
export function isSqliteBusyError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const errcode = (error as { readonly errcode?: unknown }).errcode;
  return typeof errcode === 'number' && [5, 6].includes(errcode & 0xff);
}
