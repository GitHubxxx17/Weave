import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { mcpConfigDigest, type McpServerConfig } from '../src/mcp-environment.js';
import { McpAuthorityError, createSqliteMcpAuthorityStore } from '../src/mcp-authority-store.js';
import {
  createSqliteProviderSettingsStore,
  ProviderSettingsStoreError,
  type ProviderSettingsRecord,
} from '../src/provider-settings-store.js';
import {
  SHARED_DATABASE_BUSY_TIMEOUT_MS,
  isSqliteBusyError,
  openSharedDatabase,
} from '../src/sqlite-busy-timeout.js';

const files: string[] = [];
const holders: ChildProcess[] = [];

afterEach(async () => {
  for (const holder of holders.splice(0)) holder.kill('SIGKILL');
  await Promise.all(
    files
      .splice(0)
      .flatMap((file) => [file, `${file}-wal`, `${file}-shm`, `${file}-journal`])
      .map((file) => rm(file, { force: true })),
  );
});

function databaseFile(): string {
  const file = join(tmpdir(), `weave-busy-timeout-${randomUUID()}.sqlite`);
  files.push(file);
  return file;
}

const holderScript = `
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync(process.argv[1]);
db.exec('BEGIN IMMEDIATE');
process.stdout.write('locked\\n');
setTimeout(() => { db.exec('COMMIT'); db.close(); process.exit(0); }, Number(process.argv[2]));
`;

/** Holds the write lock in another process so this process's synchronous waits can finish. */
async function holdWriteLock(file: string, milliseconds: number): Promise<() => Promise<void>> {
  const child = spawn(process.execPath, ['-e', holderScript, file, String(milliseconds)], {
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  holders.push(child);
  await new Promise<void>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', () => reject(new Error('lock holder exited early')));
    child.stdout?.once('data', () => resolve());
  });
  child.removeAllListeners('exit');
  return () => new Promise<void>((resolve) => child.once('exit', () => resolve()));
}

function seed(file: string): void {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; CREATE TABLE IF NOT EXISTS probe (id INTEGER)');
  db.close();
}

function mcpConfig(): McpServerConfig {
  return {
    schemaVersion: 1,
    id: 'notes',
    label: 'Notes',
    transport: 'stdio',
    command: process.execPath,
    args: [],
    cwd: tmpdir(),
    env: {},
  };
}

const now = '2026-11-26T00:00:00.000Z';

function providerRecord(): ProviderSettingsRecord {
  return {
    id: 'deepseek',
    label: 'DeepSeek',
    type: 'openai-compatible',
    baseUrl: 'https://api.deepseek.com',
    encryptedApiKey: 'encrypted-secret',
    defaultModel: 'deepseek-chat',
    isDefault: false,
    createdAt: now,
    updatedAt: now,
  };
}

describe('shared database busy timeout', () => {
  it('sets the same 5000 ms timeout the session and workspace stores use', () => {
    const file = databaseFile();
    const db = openSharedDatabase(file);
    try {
      expect(SHARED_DATABASE_BUSY_TIMEOUT_MS).toBe(5000);
      expect(db.prepare('PRAGMA busy_timeout').get()).toEqual({ timeout: 5000 });
    } finally {
      db.close();
    }
  });

  it('waits for a competing writer to commit instead of failing at once', async () => {
    const file = databaseFile();
    seed(file);
    const released = await holdWriteLock(file, 400);
    const plain = new DatabaseSync(file);
    let immediate: unknown;
    try {
      plain.exec('INSERT INTO probe VALUES (1)');
    } catch (error) {
      immediate = error;
    } finally {
      plain.close();
    }
    expect(isSqliteBusyError(immediate)).toBe(true);
    await released();

    await holdWriteLock(file, 400);
    const shared = openSharedDatabase(file);
    try {
      shared.exec('INSERT INTO probe VALUES (2)');
      expect(shared.prepare('SELECT id FROM probe').all()).toEqual([{ id: 2 }]);
    } finally {
      shared.close();
    }
  });

  it('classifies only SQLITE_BUSY and SQLITE_LOCKED errors as busy', () => {
    expect(isSqliteBusyError({ errcode: 5 })).toBe(true);
    expect(isSqliteBusyError({ errcode: 6 })).toBe(true);
    expect(isSqliteBusyError({ errcode: 261 })).toBe(true);
    expect(isSqliteBusyError({ errcode: 1 })).toBe(false);
    expect(isSqliteBusyError(new Error('plain'))).toBe(false);
    expect(isSqliteBusyError(null)).toBe(false);
  });

  it('lets the MCP authority store write after a competing writer commits', async () => {
    const file = databaseFile();
    const store = createSqliteMcpAuthorityStore({ filename: file });
    try {
      const log = await store.read();
      await holdWriteLock(file, 400);
      const created = await store.mutate(
        { kind: 'create', config: mcpConfig() },
        { expectedSequence: log.sequence, knownPrefix: log.events },
      );
      expect(created.appended?.sequence).toBe(1);
      expect(created.appended).toMatchObject({ configDigest: mcpConfigDigest(mcpConfig()) });
    } finally {
      await store.close();
    }
  });

  it('lets the Provider settings store write after a competing writer commits', async () => {
    const file = databaseFile();
    const store = createSqliteProviderSettingsStore({ filename: file });
    try {
      await holdWriteLock(file, 400);
      await store.create(providerRecord());
      await expect(store.get('deepseek')).resolves.toEqual(providerRecord());
    } finally {
      await store.close();
    }
  });

  it('maps a lock that outlasts the timeout to a busy MCP authority error', async () => {
    const file = databaseFile();
    const store = createSqliteMcpAuthorityStore({ filename: file });
    try {
      const log = await store.read();
      await holdWriteLock(file, 9000);
      const failure = await store
        .mutate(
          { kind: 'create', config: mcpConfig() },
          { expectedSequence: log.sequence, knownPrefix: log.events },
        )
        .catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(McpAuthorityError);
      expect(failure).toMatchObject({ code: 'mcp-authority-busy' });
    } finally {
      await store.close();
    }
  }, 30_000);

  it('maps a lock that outlasts the timeout to a busy Provider settings error', async () => {
    const file = databaseFile();
    const store = createSqliteProviderSettingsStore({ filename: file });
    try {
      await holdWriteLock(file, 9000);
      const failure = await store.create(providerRecord()).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(ProviderSettingsStoreError);
      expect(failure).toMatchObject({ code: 'provider-settings-busy' });
    } finally {
      await store.close();
    }
  }, 30_000);
});
