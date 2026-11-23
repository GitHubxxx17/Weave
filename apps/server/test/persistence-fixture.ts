import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';

/** Creates a unique SQLite filename and removes it when the fixture is closed. */
export function createTemporaryDatabaseFile(): {
  readonly filename: string;
  readonly cleanup: () => Promise<void>;
} {
  const filename = join(tmpdir(), `weave-server-${randomUUID()}.sqlite`);
  return {
    filename,
    cleanup: async () => {
      await Promise.all(
        [
          filename,
          `${filename}.memory.sqlite`,
          `${filename}.memory.sqlite-wal`,
          `${filename}.memory.sqlite-shm`,
          `${filename}.memory.sqlite.owner.sqlite`,
          `${filename}.memory.sqlite.owner.sqlite-journal`,
        ].map((path) => rm(path, { force: true })),
      );
    },
  };
}

/** Reserves an ephemeral TCP port for a Server integration test. */
export async function reservePort(): Promise<number> {
  const server = createServer().listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => {
    server.once('listening', resolve);
  });

  const address = server.address();
  if (address === null || typeof address === 'string') {
    server.close();
    throw new Error('Expected an address for the test server');
  }

  const port = address.port;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
  return port;
}
