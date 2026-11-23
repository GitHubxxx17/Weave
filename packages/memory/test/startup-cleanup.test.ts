import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { createSqliteMemoryStore, MemoryStoreStartupError } from '../src/index.js';

interface Cleanup {
  closeSync(): void;
  drain(): Promise<void>;
  close(): Promise<void>;
}
const probeOwner = `import { DatabaseSync } from 'node:sqlite';
const database = new DatabaseSync(process.argv[1]);
database.exec('PRAGMA busy_timeout = 0');
try { database.exec('BEGIN EXCLUSIVE'); process.exitCode = 2; }
catch (error) { if ((error.errcode & 255) !== 5) throw error; process.stdout.write('busy'); }
finally { database.close(); }`;

describe('partially acquired Memory startup cleanup', () => {
  it.each(['before-close', 'after-close'] as const)(
    'retains the same owner until actual cleanup succeeds after %s failure',
    async (mode) => {
      const directory = mkdtempSync(join(tmpdir(), 'weave-memory-startup-'));
      const filename = join(directory, 'memory.sqlite');
      const initial = new DatabaseSync(filename);
      initial.exec('PRAGMA user_version = 2');
      initial.close();
      let blocked = true;
      let data: DatabaseSync | undefined;
      let failure: unknown;
      class CloseFailureDatabase extends DatabaseSync {
        override close() {
          if (blocked && mode === 'before-close') throw new Error('Injected data close failure');
          super.close();
          if (blocked) throw new Error('Injected data close acknowledgement failure');
        }
      }
      try {
        try {
          createSqliteMemoryStore({
            filename,
            databaseFactory: (file) => {
              data = new CloseFailureDatabase(file);
              return data;
            },
          });
        } catch (error) {
          failure = error;
        }
        expect(failure).toBeInstanceOf(MemoryStoreStartupError);
        expect(failure).toMatchObject({ code: 'memory-persistence-error' });
        expect(data?.isOpen).toBe(mode === 'before-close');
        expect(() => createSqliteMemoryStore({ filename })).toThrow(
          expect.objectContaining({ code: 'memory-busy' }),
        );
        const probe = spawnSync(
          process.execPath,
          ['--input-type=module', '-e', probeOwner, `${filename}.owner.sqlite`],
          { encoding: 'utf8', timeout: 5000 },
        );
        expect(probe.status).toBe(0);
        expect(probe.stdout).toBe('busy');
        expect(failure).toHaveProperty('cleanup');
        const cleanup = (failure as { cleanup: Cleanup }).cleanup;
        cleanup.closeSync();
        await cleanup.drain();
        if (mode === 'before-close')
          await expect(cleanup.close()).rejects.toMatchObject({ code: 'memory-persistence-error' });
        expect(() => createSqliteMemoryStore({ filename })).toThrow(
          expect.objectContaining({ code: 'memory-busy' }),
        );
        blocked = false;
        await cleanup.close();
        await cleanup.close();
        expect(data?.isOpen).toBe(false);
        const repair = new DatabaseSync(filename);
        repair.exec('PRAGMA user_version = 0');
        repair.close();
        const reopened = createSqliteMemoryStore({ filename });
        await reopened.close();
      } finally {
        blocked = false;
        if (failure !== null && typeof failure === 'object' && 'cleanup' in failure)
          await (failure as { cleanup: Cleanup }).cleanup.close();
        if (data?.isOpen) DatabaseSync.prototype.close.call(data);
        rmSync(directory, { recursive: true, force: true });
      }
    },
  );
});
