import { execFile, fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { lstatSync } from 'node:fs';
import {
  access,
  copyFile,
  link,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it, type TestContext } from 'vitest';
import { z } from 'zod';

const repositoryRoot = fileURLToPath(new URL('../../../', import.meta.url));
const serverRoot = join(repositoryRoot, 'apps/server');
const fixtureFile = fileURLToPath(
  new URL('./support/plugin-store-owner-child.mjs', import.meta.url),
);
const execFileAsync = promisify(execFile);
const compileTimeout = 60_000;
const eventTimeout = 8_000;
const testTimeout = 90_000;
const ownerFilename = 'ownership.sqlite';
const ownerTableSql = `CREATE TABLE managed_store_binding_events (
  sequence INTEGER NOT NULL PRIMARY KEY CHECK (sequence = 1),
  occurred_at TEXT NOT NULL,
  event_json TEXT NOT NULL
)`;
const bindingSchema = z.strictObject({
  version: z.literal(1),
  databaseId: z.uuid(),
  databaseFile: z.string(),
  storeId: z.uuid(),
  storeDirectory: z.string(),
  ownerDatabaseFile: z.string(),
});
const childMessageSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('prepared'), databaseId: z.uuid() }),
  z.strictObject({
    kind: z.literal('held'),
    pid: z.number().int().positive(),
    binding: bindingSchema,
    nodeVersion: z.string(),
    sqliteVersion: z.string(),
  }),
  z.strictObject({
    kind: z.literal('error'),
    phase: z.enum(['acquire', 'fixture']),
    code: z.string().nullable(),
    detail: z.string(),
  }),
  z.strictObject({
    kind: z.literal('wrote-main'),
    written: z.unknown(),
    events: z.array(z.unknown()),
  }),
  z.strictObject({ kind: z.literal('closed') }),
]);
type Binding = z.infer<typeof bindingSchema>;
type ChildMessage = z.infer<typeof childMessageSchema>;
type MessageKind = ChildMessage['kind'];
type OwnerConfig = {
  databaseFile: string;
  directory: string;
  initialBinding?: 'allow-unbound' | 'require-bound';
  keepAliveOnError?: boolean;
};
type ChildCommand = { kind: 'start' | 'close' } | { kind: 'write-main'; pluginId: string };
type ChildExit = { code: number | null; signal: NodeJS.Signals | null };

let outputRoot: string | undefined;
let compiledModules: { authorityModule: string; storeModule: string };
const liveChildren = new Set<ReturnType<typeof startOwnerChild>>();
const testDirectories = new Set<string>();

beforeAll(async () => {
  // 不在测试里重新构建依赖包：并行运行的其他包测试（如 plugin-cli）会读取这些 dist，
  // 重写会让它们读到不完整的声明。依赖由 turbo 的 test -> ^build 保证；
  // 单独运行本文件前先执行 `pnpm turbo run build --filter=@weave/server^...`。
  await access(join(repositoryRoot, 'packages/protocol/dist/index.js')).catch(() => {
    throw new Error('依赖包尚未构建，请先运行 pnpm turbo run build --filter=@weave/server^...');
  });
  const cache = join(serverRoot, 'node_modules/.cache');
  await mkdir(cache, { recursive: true });
  outputRoot = await mkdtemp(join(cache, 'weave-owner-test-'));
  try {
    const destination = join(outputRoot, 'server');
    const typescript = createRequire(import.meta.url).resolve('typescript/bin/tsc');
    await execFileAsync(
      process.execPath,
      [typescript, '-p', join(serverRoot, 'tsconfig.json'), '--outDir', destination],
      { cwd: repositoryRoot, timeout: compileTimeout },
    );
    await writeFile(join(outputRoot, 'package.json'), '{"type":"module"}');
    const authorityModule = join(destination, 'plugin-authority-store.js');
    const storeModule = join(destination, 'owned-plugin-artifact-store.js');
    await Promise.all([access(authorityModule), access(storeModule)]);
    compiledModules = {
      authorityModule: pathToFileURL(authorityModule).href,
      storeModule: pathToFileURL(storeModule).href,
    };
  } catch (error: unknown) {
    await rm(outputRoot, { recursive: true, force: true });
    outputRoot = undefined;
    throw error;
  }
}, compileTimeout + 10_000);

afterAll(
  async () => {
    await terminateChildren(liveChildren);
    const directories = [...testDirectories];
    if (outputRoot !== undefined) directories.push(outputRoot);
    await Promise.all(
      directories.map((directory) => rm(directory, { recursive: true, force: true })),
    );
  },
  2 * eventTimeout + 2_000,
);

function startOwnerChild(config: OwnerConfig) {
  const child = fork(fixtureFile, { execArgv: [], stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  const updates = new EventEmitter();
  const queue: ChildMessage[] = [];
  const received = new Set<MessageKind>();
  let exit: ChildExit | undefined;
  let failure: unknown;
  let stderr = '';
  let stderrClosed = child.stderr === null;
  let ipcClosed = false;

  function completedExit(): ChildExit | undefined {
    return stderrClosed && ipcClosed ? exit : undefined;
  }

  function childUpdated(): void {
    if (completedExit() !== undefined) liveChildren.delete(handle);
    updates.emit('update');
  }

  function childError(error: unknown): void {
    failure ??= error;
    updates.emit('update');
  }

  child.stderr?.setEncoding('utf8').on('data', (chunk: string) => {
    stderr = (stderr + chunk).slice(-8_000);
  });
  child.stderr?.once('close', () => {
    stderrClosed = true;
    childUpdated();
  });
  child.once('disconnect', () => {
    ipcClosed = true;
    childUpdated();
  });
  child.on('message', (value: unknown) => {
    const parsed = childMessageSchema.safeParse(value);
    if (!parsed.success) {
      childError(parsed.error);
      return;
    }
    if (received.has(parsed.data.kind)) {
      childError(new Error(`Duplicate child message ${parsed.data.kind}`));
      return;
    }
    received.add(parsed.data.kind);
    queue.push(parsed.data);
    updates.emit('update');
  });
  child.on('error', childError);
  child.once('exit', (code, signal) => {
    exit = { code, signal };
    childUpdated();
  });
  // A spawn failure emits 'close' without 'exit'.
  child.once('close', (code, signal) => {
    exit ??= { code, signal };
    stderrClosed = true;
    ipcClosed = true;
    childUpdated();
  });

  function diagnostic(message: string, cause?: unknown): Error {
    const exitStatus = exit ? ` (exit ${exit.code}, signal ${exit.signal})` : '';
    const output = stderr ? `\nChild stderr:\n${stderr}` : '';
    return new Error(`Owner child ${child.pid}: ${message}${exitStatus}${output}`, { cause });
  }

  function wait<T>(description: string, check: () => T | undefined): Promise<T> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        updates.off('update', onUpdate);
        reject(diagnostic(`timed out waiting for ${description}`, failure));
      }, eventTimeout);
      function onUpdate(): void {
        try {
          const value = check();
          if (value === undefined) return;
          resolve(value);
        } catch (error: unknown) {
          reject(error);
        }
        clearTimeout(timer);
        updates.off('update', onUpdate);
      }
      updates.on('update', onUpdate);
      onUpdate();
    });
  }

  function send(command: ChildCommand | { kind: 'configure'; config: object }): void {
    child.send(command, (error) => {
      if (error) childError(error);
    });
  }

  const handle = {
    send,
    waitFor<K extends MessageKind>(...kinds: K[]): Promise<Extract<ChildMessage, { kind: K }>> {
      return wait(kinds.join(' or '), () => {
        const matches = (message: ChildMessage): message is Extract<ChildMessage, { kind: K }> =>
          kinds.some((kind) => kind === message.kind);
        const message = queue.find(matches);
        if (message !== undefined) {
          queue.splice(queue.indexOf(message), 1);
          return message;
        }
        const reported = queue.find((message) => message.kind === 'error');
        if (reported) throw diagnostic(`${reported.phase} failed: ${reported.detail}`);
        if (failure !== undefined) throw diagnostic('IPC failure', failure);
        if (completedExit()) throw diagnostic(`exited before sending ${kinds.join(' or ')}`);
        return undefined;
      });
    },
    kill(signal: NodeJS.Signals): void {
      if (exit === undefined) child.kill(signal);
    },
    waitForExit(): Promise<ChildExit> {
      return wait('process exit and pipe closure', () => {
        if (failure !== undefined) throw diagnostic('IPC failure', failure);
        const status = completedExit();
        if (status && queue.length > 0) {
          throw diagnostic(
            `unexpected messages before exit: ${queue.map(({ kind }) => kind).join(', ')}`,
          );
        }
        return status;
      });
    },
    async terminate(): Promise<void> {
      // A graceful close lets the child release the store and authority in order.
      if (child.connected) send({ kind: 'close' });
      try {
        await wait('process exit and pipe closure', completedExit);
      } catch {
        if (exit === undefined) child.kill('SIGKILL');
        await wait('process exit after forced termination', completedExit);
      }
    },
  };
  liveChildren.add(handle);
  send({
    kind: 'configure',
    config: { initialBinding: 'allow-unbound', ...config, ...compiledModules },
  });
  return handle;
}

type OwnerChild = ReturnType<typeof startOwnerChild>;

async function terminateChildren(children: Iterable<OwnerChild>): Promise<void> {
  const cleanup = await Promise.allSettled([...children].map((child) => child.terminate()));
  const failures = cleanup
    .filter((result) => result.status === 'rejected')
    .map((result) => result.reason);
  if (failures.length > 0)
    throw new AggregateError(failures, 'Owner child cleanup failed', { cause: failures[0] });
}

async function closeChild(child: OwnerChild): Promise<void> {
  child.send({ kind: 'close' });
  await child.waitFor('closed');
  expect(await child.waitForExit()).toEqual({ code: 0, signal: null });
}

class SkipOwnerTest extends Error {}

function ownerTest(
  run: (work: {
    base: string;
    databaseFile: string;
    directory: string;
    prepare: (
      overrides?: Partial<OwnerConfig>,
    ) => Promise<{ child: OwnerChild; databaseId: string }>;
    hold: (overrides?: Partial<OwnerConfig>) => Promise<{ child: OwnerChild; binding: Binding }>;
    reject: (code: string, overrides?: Partial<OwnerConfig>) => Promise<void>;
  }) => Promise<void>,
) {
  return async (context: TestContext): Promise<void> => {
    const base = await mkdtemp(join(await realpath(tmpdir()), 'weave-owner-root-'));
    testDirectories.add(base);
    const databaseFile = join(base, 'authority.sqlite');
    const directory = join(base, 'store');
    const children = new Set<OwnerChild>();

    function prepare(overrides?: Partial<OwnerConfig>) {
      const child = startOwnerChild({ databaseFile, directory, ...overrides });
      children.add(child);
      return child.waitFor('prepared').then(({ databaseId }) => ({ child, databaseId }));
    }

    async function hold(overrides?: Partial<OwnerConfig>) {
      const { child, databaseId } = await prepare(overrides);
      child.send({ kind: 'start' });
      const held = await child.waitFor('held');
      expect(held.binding.databaseId).toBe(databaseId);
      expect(held.nodeVersion).toBe(process.version);
      expect(held.sqliteVersion).toBe(process.versions.sqlite);
      return { child, binding: held.binding };
    }

    async function reject(code: string, overrides?: Partial<OwnerConfig>) {
      const { child } = await prepare(overrides);
      child.send({ kind: 'start' });
      expect(await child.waitFor('error')).toMatchObject({ phase: 'acquire', code });
      expect(await child.waitForExit()).toEqual({ code: 0, signal: null });
    }

    const failures: unknown[] = [];
    let skip: SkipOwnerTest | undefined;
    try {
      await run({ base, databaseFile, directory, prepare, hold, reject });
    } catch (error: unknown) {
      if (error instanceof SkipOwnerTest) skip = error;
      else failures.push(error);
    } finally {
      try {
        await terminateChildren(children);
        await rm(base, { recursive: true, force: true });
        testDirectories.delete(base);
      } catch (error: unknown) {
        failures.push(error);
      }
    }
    if (failures.length > 1)
      throw new AggregateError(failures, 'Ownership test and cleanup failed', {
        cause: failures[0],
      });
    if (failures.length === 1) throw failures[0];
    if (skip) context.skip(skip.message);
  };
}

function withDatabase<T>(
  file: string,
  operation: (database: DatabaseSync) => T,
  options = { readOnly: false },
): T {
  const database = new DatabaseSync(file, options);
  try {
    return operation(database);
  } finally {
    database.close();
  }
}

function mainRows(file: string) {
  return withDatabase(
    file,
    (database) =>
      database.prepare('SELECT * FROM plugin_managed_root_events ORDER BY sequence').all(),
    { readOnly: true },
  );
}

function ownerRows(file: string) {
  return withDatabase(
    file,
    (database) => ({
      events: database
        .prepare('SELECT * FROM managed_store_binding_events ORDER BY sequence')
        .all(),
      integrity: database.prepare('PRAGMA integrity_check').get(),
    }),
    { readOnly: true },
  );
}

function assertOwnerAvailable(file: string): void {
  expect(lstatSync(file).isFile()).toBe(true);
  withDatabase(file, (database) => {
    database.exec('BEGIN EXCLUSIVE');
    database.exec('ROLLBACK');
  });
}

function registeredBinding(file: string): Binding {
  const rows = mainRows(file);
  expect(rows).toHaveLength(1);
  const row = z.object({ event_json: z.string() }).parse(rows[0]);
  return z.object({ binding: bindingSchema }).parse(JSON.parse(row.event_json)).binding;
}

function recordedOwnerBinding(file: string): Binding {
  const { events, integrity } = ownerRows(file);
  expect(integrity).toEqual({ integrity_check: 'ok' });
  expect(events).toHaveLength(1);
  const row = z
    .object({ sequence: z.literal(1), occurred_at: z.string(), event_json: z.string() })
    .parse(events[0]);
  const event = z
    .strictObject({
      version: z.literal(1),
      sequence: z.literal(1),
      kind: z.literal('managed-store-bound'),
      occurredAt: z.literal(row.occurred_at),
      binding: bindingSchema,
    })
    .parse(JSON.parse(row.event_json));
  return event.binding;
}

async function requireLinks(
  kind: 'hardlink' | 'symlink',
  create: () => Promise<void>,
): Promise<void> {
  try {
    await create();
  } catch (error: unknown) {
    const code = (error as NodeJS.ErrnoException).code;
    if (
      code === 'ENOSYS' ||
      code === 'ENOTSUP' ||
      code === 'EOPNOTSUPP' ||
      (process.platform === 'win32' && kind === 'symlink' && code === 'EPERM')
    ) {
      throw new SkipOwnerTest(`Local filesystem refused ${kind} creation with ${code}`, {
        cause: error,
      });
    }
    throw error;
  }
}

describe('plugin store ownership across Node processes', () => {
  it(
    'excludes a live same-root contender and reuses the binding after POSIX SIGKILL',
    { timeout: testTimeout },
    ownerTest(async ({ databaseFile, hold, reject }) => {
      if (process.platform === 'win32')
        throw new SkipOwnerTest('This case requires POSIX SIGKILL semantics');
      const seed = await hold();
      await closeChild(seed.child);
      const file = seed.binding.ownerDatabaseFile;
      const before = ownerRows(file);
      const mainBefore = mainRows(databaseFile);
      expect(before.events).toHaveLength(1);
      expect(before.integrity).toEqual({ integrity_check: 'ok' });
      expect(mainBefore).toHaveLength(1);

      const mode = { initialBinding: 'require-bound' } as const;
      const holder = await hold(mode);
      expect(holder.binding).toEqual(seed.binding);
      await reject('plugin-store-busy', mode);
      expect(mainRows(databaseFile)).toEqual(mainBefore);
      holder.child.kill('SIGKILL');
      expect(await holder.child.waitForExit()).toEqual({ code: null, signal: 'SIGKILL' });
      expect(ownerRows(file)).toEqual(before);

      const replacement = await hold(mode);
      expect(replacement.binding).toEqual(seed.binding);
      await closeChild(replacement.child);
      expect(ownerRows(file)).toEqual(before);
      expect(mainRows(databaseFile)).toEqual(mainBefore);
    }),
  );

  it(
    'keeps main writes available in both the holder and an independent connection',
    { timeout: testTimeout },
    ownerTest(async ({ databaseFile, hold }) => {
      const { child, binding } = await hold();
      withDatabase(databaseFile, (database) => {
        database.exec(`
        BEGIN IMMEDIATE;
        CREATE TABLE independent_write (value TEXT NOT NULL);
        INSERT INTO independent_write VALUES ('committed while owned');
        COMMIT;
      `);
      });

      child.send({ kind: 'write-main', pluginId: 'notes' });
      const { written, events } = await child.waitFor('wrote-main');
      expect(written).toMatchObject({ sequence: 1, kind: 'revoked', pluginId: 'notes' });
      expect(events).toEqual([written]);
      expect(registeredBinding(databaseFile)).toEqual(binding);
      expect(
        withDatabase(databaseFile, (database) =>
          database.prepare('SELECT value FROM independent_write').get(),
        ),
      ).toEqual({ value: 'committed while owned' });
      await closeChild(child);
    }),
  );

  it(
    'rejects a different database, a copied or relocated UUID, and a new UUID at the original path',
    { timeout: testTimeout },
    ownerTest(async ({ base, databaseFile, hold, reject }) => {
      const holder = await hold();
      await closeChild(holder.child);
      const before = ownerRows(holder.binding.ownerDatabaseFile);

      const foreign = join(base, 'different.sqlite');
      await reject('plugin-store-owner-mismatch', { databaseFile: foreign });
      expect(mainRows(foreign)).toEqual([]);

      const copy = join(base, 'copy.sqlite');
      await copyFile(databaseFile, copy);
      await reject('plugin-store-owner-mismatch', { databaseFile: copy });
      expect(registeredBinding(copy)).toEqual(holder.binding);

      const relocated = join(base, 'relocated.sqlite');
      await rename(databaseFile, relocated);
      await reject('plugin-store-owner-mismatch', { databaseFile: relocated });
      await reject('plugin-store-owner-mismatch');
      expect(mainRows(databaseFile)).toEqual([]);
      expect(registeredBinding(relocated)).toEqual(holder.binding);
      expect(ownerRows(holder.binding.ownerDatabaseFile)).toEqual(before);
    }),
  );

  it(
    'registers at most one of two racing roots and accepts an exact retry after a busy race',
    { timeout: testTimeout },
    ownerTest(async ({ base, databaseFile, directory, prepare, hold, reject }) => {
      const otherDirectory = join(base, 'other-store');
      const { child: first } = await prepare({ keepAliveOnError: true });
      const { child: second } = await prepare({
        directory: otherDirectory,
        keepAliveOnError: true,
      });

      first.send({ kind: 'start' });
      second.send({ kind: 'start' });
      const results = await Promise.all([
        first.waitFor('held', 'error'),
        second.waitFor('held', 'error'),
      ]);
      const winner = results.find((result) => result.kind === 'held');
      if (winner === undefined) {
        for (const result of results) {
          expect(result).toMatchObject({
            kind: 'error',
            phase: 'acquire',
            code: 'plugin-store-busy',
          });
        }
        expect(mainRows(databaseFile)).toEqual([]);
        const recorded = [directory, otherDirectory].flatMap((storeDirectory) => {
          const file = join(storeDirectory, ownerFilename);
          if (!lstatSync(file, { throwIfNoEntry: false })) return [];
          assertOwnerAvailable(file);
          const binding = recordedOwnerBinding(file);
          expect(binding).toMatchObject({ databaseFile, storeDirectory, ownerDatabaseFile: file });
          return [{ binding, rows: ownerRows(file) }];
        });
        const retry = recorded[0];
        if (!retry) throw new Error('The busy race left no committed owner binding');

        await Promise.all([closeChild(first), closeChild(second)]);
        const retried = await hold({
          directory: retry.binding.storeDirectory,
          initialBinding: 'require-bound',
        });
        expect(retried.binding).toEqual(retry.binding);
        expect(registeredBinding(databaseFile)).toEqual(retry.binding);
        await closeChild(retried.child);
        for (const record of recorded) {
          expect(ownerRows(record.binding.ownerDatabaseFile)).toEqual(record.rows);
        }
        return;
      }

      const firstWon = winner === results[0];
      const loser = results[firstWon ? 1 : 0];
      expect(loser).toMatchObject({
        kind: 'error',
        phase: 'acquire',
        code: expect.stringMatching(/^plugin-store-(owner-mismatch|busy)$/),
      });
      expect(registeredBinding(databaseFile)).toEqual(winner.binding);

      const losingDirectory = firstWon ? otherDirectory : directory;
      const losingChild = firstWon ? second : first;
      const loserFile = join(losingDirectory, ownerFilename);
      if (lstatSync(loserFile, { throwIfNoEntry: false })) {
        assertOwnerAvailable(loserFile);
      }
      await closeChild(losingChild);
      await closeChild(firstWon ? first : second);
      const before = mainRows(databaseFile);
      await reject('plugin-store-owner-mismatch', { directory: losingDirectory });
      expect(mainRows(databaseFile)).toEqual(before);
    }),
  );

  it(
    'releases the owner lease before a child exits when its main registration is busy',
    { timeout: testTimeout },
    ownerTest(async ({ databaseFile, directory, prepare, hold }) => {
      const { child } = await prepare({ keepAliveOnError: true });
      const main = new DatabaseSync(databaseFile);
      const ownerFile = join(directory, ownerFilename);
      try {
        // A reserved main lock allows the initial read and blocks the registration write.
        main.exec('BEGIN IMMEDIATE');
        child.send({ kind: 'start' });
        expect(await child.waitFor('error')).toMatchObject({
          phase: 'acquire',
          code: 'plugin-store-busy',
        });
        expect(mainRows(databaseFile)).toEqual([]);
        assertOwnerAvailable(ownerFile);
        expect(ownerRows(ownerFile).events).toHaveLength(1);
      } finally {
        main.close();
      }
      await closeChild(child);
      const before = ownerRows(ownerFile);
      const recovered = await hold({ initialBinding: 'require-bound' });
      expect(registeredBinding(databaseFile)).toEqual(recovered.binding);
      await closeChild(recovered.child);
      expect(ownerRows(ownerFile)).toEqual(before);
    }),
  );

  it(
    'allows at most one virgin root contender and checks the durable state after contention',
    { timeout: testTimeout },
    ownerTest(async ({ base, databaseFile, directory, prepare, hold, reject }) => {
      const otherDatabaseFile = join(base, 'other.sqlite');
      await mkdir(directory);
      const first = await prepare();
      const second = await prepare({ databaseFile: otherDatabaseFile });
      expect(first.databaseId).not.toBe(second.databaseId);
      first.child.send({ kind: 'start' });
      second.child.send({ kind: 'start' });

      const results = await Promise.all([
        first.child.waitFor('held', 'error'),
        second.child.waitFor('held', 'error'),
      ]);
      const ownerFile = join(directory, ownerFilename);
      const acquisitionFailure = {
        kind: 'error',
        phase: 'acquire',
        code: expect.stringMatching(/^plugin-store-(busy|recovery-required|owner-mismatch)$/),
      };
      const winner = results.find((result) => result.kind === 'held');
      if (!winner) {
        for (const result of results) expect(result).toMatchObject(acquisitionFailure);
        for (const { child } of [first, second]) {
          expect(await child.waitForExit()).toEqual({ code: 0, signal: null });
        }
        expect(mainRows(databaseFile)).toEqual([]);
        expect(mainRows(otherDatabaseFile)).toEqual([]);
        assertOwnerAvailable(ownerFile);
        const schema = withDatabase(
          ownerFile,
          (database) => database.prepare('SELECT name, type, sql FROM sqlite_schema').all(),
          { readOnly: true },
        );
        if (schema.length === 0) {
          for (const result of results) {
            expect(result).toMatchObject({
              code: expect.stringMatching(/^plugin-store-(busy|recovery-required)$/),
            });
          }
          expect(results).toContainEqual(expect.objectContaining({ code: 'plugin-store-busy' }));
          const before = await readFile(ownerFile);
          for (const file of [databaseFile, otherDatabaseFile]) {
            await reject('plugin-store-recovery-required', {
              databaseFile: file,
              initialBinding: 'require-bound',
            });
            expect(mainRows(file)).toEqual([]);
          }
          expect(await readFile(ownerFile)).toEqual(before);
          return;
        }

        const normalizeSql = (sql: string) => sql.replace(/\s+/g, ' ').trim();
        expect(schema).toHaveLength(1);
        const table = z
          .object({
            name: z.literal('managed_store_binding_events'),
            type: z.literal('table'),
            sql: z.string(),
          })
          .parse(schema[0]);
        expect(normalizeSql(table.sql)).toBe(normalizeSql(ownerTableSql));
        const binding = recordedOwnerBinding(ownerFile);
        const recordedFirst = binding.databaseFile === databaseFile;
        const recordedFile = recordedFirst ? databaseFile : otherDatabaseFile;
        const foreignFile = recordedFirst ? otherDatabaseFile : databaseFile;
        expect(binding).toMatchObject({
          databaseId: recordedFirst ? first.databaseId : second.databaseId,
          databaseFile: recordedFile,
          storeDirectory: directory,
          ownerDatabaseFile: ownerFile,
        });
        const before = ownerRows(ownerFile);
        const retried = await hold({ databaseFile: recordedFile, initialBinding: 'require-bound' });
        expect(retried.binding).toEqual(binding);
        await closeChild(retried.child);
        await reject('plugin-store-owner-mismatch', {
          databaseFile: foreignFile,
          initialBinding: 'require-bound',
        });
        expect(registeredBinding(recordedFile)).toEqual(binding);
        expect(mainRows(foreignFile)).toEqual([]);
        expect(ownerRows(ownerFile)).toEqual(before);
        return;
      }
      const firstWon = winner === results[0];
      expect(results[firstWon ? 1 : 0]).toMatchObject(acquisitionFailure);
      const winningFile = firstWon ? databaseFile : otherDatabaseFile;
      const losingFile = firstWon ? otherDatabaseFile : databaseFile;
      const winningChild = firstWon ? first : second;
      expect(await (firstWon ? second : first).child.waitForExit()).toEqual({
        code: 0,
        signal: null,
      });
      expect(winner.binding).toMatchObject({
        databaseFile: winningFile,
        databaseId: winningChild.databaseId,
        storeDirectory: directory,
        ownerDatabaseFile: ownerFile,
      });
      expect(registeredBinding(winningFile)).toEqual(winner.binding);
      expect(mainRows(losingFile)).toEqual([]);
      await closeChild(winningChild.child);
      expect(recordedOwnerBinding(ownerFile)).toEqual(winner.binding);
      expect(registeredBinding(winningFile)).toEqual(winner.binding);
      expect(mainRows(losingFile)).toEqual([]);
    }),
  );

  it(
    'completes a committed half-binding only for the recorded authority identity',
    { timeout: testTimeout },
    ownerTest(async ({ base, databaseFile, directory, prepare, hold, reject }) => {
      const { child, databaseId } = await prepare();
      await closeChild(child);
      await mkdir(directory);
      const binding = seedHalfBinding(databaseFile, directory, databaseId);
      const rootBefore = ownerRows(binding.ownerDatabaseFile);
      expect(mainRows(databaseFile)).toEqual([]);

      const copy = join(base, 'authority-copy.sqlite');
      await copyFile(databaseFile, copy);
      await reject('plugin-store-owner-mismatch', { databaseFile: copy });
      expect(mainRows(copy)).toEqual([]);
      expect(mainRows(databaseFile)).toEqual([]);
      expect(ownerRows(binding.ownerDatabaseFile)).toEqual(rootBefore);

      const recovered = await hold({ initialBinding: 'require-bound' });
      expect(recovered.binding).toEqual(binding);
      expect(registeredBinding(databaseFile)).toEqual(binding);
      await closeChild(recovered.child);
      expect(ownerRows(binding.ownerDatabaseFile)).toEqual(rootBefore);
    }),
  );

  it(
    'preserves a half-bound root when the same authority already registered another root',
    { timeout: testTimeout },
    ownerTest(async ({ base, databaseFile, directory, prepare, hold, reject }) => {
      const { child, databaseId } = await prepare();
      await closeChild(child);
      await mkdir(directory);
      const binding = seedHalfBinding(databaseFile, directory, databaseId);
      const rootBefore = ownerRows(binding.ownerDatabaseFile);

      const holder = await hold({ directory: join(base, 'winner') });
      await closeChild(holder.child);
      const mainBefore = mainRows(databaseFile);
      await reject('plugin-store-owner-mismatch', { initialBinding: 'require-bound' });
      expect(registeredBinding(databaseFile)).toEqual(holder.binding);
      expect(mainRows(databaseFile)).toEqual(mainBefore);
      expect(ownerRows(binding.ownerDatabaseFile)).toEqual(rootBefore);
    }),
  );

  for (const damage of ['missing', 'empty', 'corrupt'] as const) {
    it(
      `refuses a ${damage} owner file after registration`,
      { timeout: testTimeout },
      ownerTest(async ({ databaseFile, hold, reject }) => {
        const { child, binding } = await hold();
        await closeChild(child);
        const mainBefore = mainRows(databaseFile);
        const file = binding.ownerDatabaseFile;
        const damaged = damage === 'empty' ? '' : 'not a SQLite database';
        if (damage === 'missing') {
          await rm(file);
        } else {
          await writeFile(file, damaged);
        }

        await reject('plugin-store-recovery-required');
        expect(mainRows(databaseFile)).toEqual(mainBefore);
        if (damage === 'missing') {
          await expect(access(file)).rejects.toMatchObject({ code: 'ENOENT' });
        } else {
          expect(await readFile(file, 'utf8')).toBe(damaged);
        }
      }),
    );
  }

  it(
    'preserves a reserved but uninitialized owner file with no main registration',
    { timeout: testTimeout },
    ownerTest(async ({ databaseFile, directory, reject }) => {
      await mkdir(directory);
      const file = join(directory, ownerFilename);
      await writeFile(file, '', { flag: 'wx' });
      const before = lstatSync(file, { bigint: true });
      await reject('plugin-store-recovery-required');
      expect(lstatSync(file, { bigint: true })).toMatchObject({ ino: before.ino, size: 0n });
      expect(mainRows(databaseFile)).toEqual([]);
    }),
  );

  it(
    'rejects a main file with an extra hardlink',
    { timeout: testTimeout },
    ownerTest(async ({ base, databaseFile, directory, prepare, reject }) => {
      const { child } = await prepare();
      await closeChild(child);
      await requireLinks('hardlink', () => link(databaseFile, join(base, 'extra-main-link')));
      await reject('plugin-store-invalid');
      await expect(access(join(directory, ownerFilename))).rejects.toMatchObject({
        code: 'ENOENT',
      });
      expect(mainRows(databaseFile)).toEqual([]);
    }),
  );

  it(
    'rejects a bound owner file with an extra hardlink',
    { timeout: testTimeout },
    ownerTest(async ({ base, databaseFile, hold, reject }) => {
      const { child, binding } = await hold();
      await closeChild(child);
      const before = ownerRows(binding.ownerDatabaseFile);
      await requireLinks('hardlink', () =>
        link(binding.ownerDatabaseFile, join(base, 'extra-owner-link')),
      );
      await reject('plugin-store-invalid');
      expect(ownerRows(binding.ownerDatabaseFile)).toEqual(before);
      expect(registeredBinding(databaseFile)).toEqual(binding);
    }),
  );

  it(
    'rejects a symlink inside the managed root without following it',
    { timeout: testTimeout },
    ownerTest(async ({ base, databaseFile, directory, reject }) => {
      const outside = join(base, 'outside');
      await mkdir(outside);
      await mkdir(directory);
      await requireLinks('symlink', () => symlink(outside, join(directory, 'artifacts'), 'dir'));
      await reject('plugin-store-invalid');
      await expect(access(join(outside, ownerFilename))).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(access(join(directory, ownerFilename))).rejects.toMatchObject({
        code: 'ENOENT',
      });
      expect(mainRows(databaseFile)).toEqual([]);
    }),
  );

  it(
    'canonicalizes ancestor aliases and excludes the alias while the canonical root is held',
    { timeout: testTimeout },
    ownerTest(async ({ base, hold, reject }) => {
      const actual = join(base, 'actual');
      const alias = join(base, 'alias');
      await mkdir(actual);
      await requireLinks('symlink', () => symlink(actual, alias, 'dir'));
      const canonical = {
        databaseFile: join(actual, 'main.sqlite'),
        directory: join(actual, 'root'),
      };
      const aliases = { databaseFile: join(alias, 'main.sqlite'), directory: join(alias, 'root') };
      const { child, binding } = await hold(canonical);
      await reject('plugin-store-busy', aliases);
      await closeChild(child);
      const aliasOwner = await hold({ ...aliases, initialBinding: 'require-bound' });
      expect(aliasOwner.binding).toEqual(binding);
      expect(binding).toMatchObject({
        databaseFile: canonical.databaseFile,
        storeDirectory: canonical.directory,
      });
      await closeChild(aliasOwner.child);
    }),
  );

  it(
    'binds an explicitly allowed populated 6.1 root without executing or selecting its payloads',
    { timeout: testTimeout },
    ownerTest(async ({ base, databaseFile, directory, hold, reject }) => {
      const sourceDirectory = join(base, 'source');
      const staging = join(directory, 'staging', randomUUID());
      const deepStaging = join(staging, 'payload', ...Array<string>(64).fill('d'));
      await mkdir(sourceDirectory);
      const marker = join(base, 'executed');
      const source = `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(marker)}, 'executed');\n`;
      await writeFile(join(sourceDirectory, 'index.mjs'), source);
      await writeFile(
        join(sourceDirectory, 'weave-plugin.json'),
        JSON.stringify({
          schemaVersion: 1,
          entry: 'index.mjs',
          manifest: {
            id: 'notes',
            name: 'Notes',
            version: '1.0.0',
            apiVersion: '1.0.0',
            capabilities: ['command'],
            contributes: { commands: ['notes'] },
            permissions: [],
          },
        }),
      );
      const { createPluginArtifactStore } = await import('@weave/plugin-host');
      const artifact = await createPluginArtifactStore({ directory }).stage({ sourceDirectory });
      const entry = join(artifact.directory, 'index.mjs');
      const abandoned = join(deepStaging, 'partial');
      await mkdir(deepStaging, { recursive: true });
      await writeFile(abandoned, 'staging bytes');
      await reject('plugin-store-recovery-required', { initialBinding: 'require-bound' });
      await expect(access(join(directory, ownerFilename))).rejects.toMatchObject({
        code: 'ENOENT',
      });

      const { child, binding } = await hold();
      expect(registeredBinding(databaseFile)).toEqual(binding);
      expect(
        withDatabase(databaseFile, (database) => ({
          installs: database.prepare('SELECT * FROM plugin_install_events').all(),
          operations: database.prepare('SELECT * FROM plugin_operation_events').all(),
          trust: database.prepare('SELECT * FROM plugin_trust_events').all(),
        })),
      ).toEqual({ installs: [], operations: [], trust: [] });
      await closeChild(child);
      expect(await readFile(entry, 'utf8')).toBe(source);
      expect(await readFile(abandoned, 'utf8')).toBe('staging bytes');
      await expect(access(marker)).rejects.toMatchObject({ code: 'ENOENT' });
    }),
  );

  it(
    'refuses a first-binding layout beyond the staging depth limit',
    { timeout: testTimeout },
    ownerTest(async ({ databaseFile, directory, reject }) => {
      const deepStaging = join(
        directory,
        'staging',
        randomUUID(),
        'payload',
        ...Array<string>(65).fill('d'),
      );
      await mkdir(deepStaging, { recursive: true });
      await reject('plugin-store-invalid');
      await expect(access(join(directory, ownerFilename))).rejects.toMatchObject({
        code: 'ENOENT',
      });
      expect(mainRows(databaseFile)).toEqual([]);
    }),
  );
});

function seedHalfBinding(
  databaseFile: string,
  storeDirectory: string,
  databaseId: string,
): Binding {
  const binding: Binding = {
    version: 1,
    databaseId,
    databaseFile,
    storeId: randomUUID(),
    storeDirectory,
    ownerDatabaseFile: join(storeDirectory, ownerFilename),
  };
  const occurredAt = '2026-11-21T00:00:00.000Z';
  withDatabase(binding.ownerDatabaseFile, (database) => {
    database.exec(`
      PRAGMA journal_mode=DELETE;
      BEGIN EXCLUSIVE;
      ${ownerTableSql};
    `);
    const event = { version: 1, sequence: 1, kind: 'managed-store-bound', occurredAt, binding };
    database
      .prepare('INSERT INTO managed_store_binding_events VALUES (1, ?, ?)')
      .run(occurredAt, JSON.stringify(event));
    database.exec('COMMIT');
  });
  return binding;
}
