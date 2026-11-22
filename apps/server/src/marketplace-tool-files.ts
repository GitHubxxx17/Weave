import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, rename, rm } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join } from 'node:path';

export function assertMarketplaceFilePath(file: string): void {
  if (!isAbsolute(file) || file.includes('\0')) {
    throw new Error('Marketplace tooling requires an absolute file path');
  }
}

/** Read ordinary files only, including a cap while reading a file that grows. */
export async function readMarketplaceFile(file: string, maxBytes: number): Promise<Buffer> {
  assertMarketplaceFilePath(file);
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > maxBytes)
      throw new Error('Invalid or oversized marketplace file');
    const bytes = Buffer.alloc(maxBytes + 1);
    let length = 0;
    while (length < bytes.length) {
      const chunk = await handle.read(bytes, length, bytes.length - length, null);
      if (chunk.bytesRead === 0) break;
      length += chunk.bytesRead;
    }
    if (length > maxBytes) throw new Error('Marketplace file exceeds its size limit');
    return bytes.subarray(0, length);
  } finally {
    await handle.close();
  }
}

export async function readMarketplaceJson(file: string, maxBytes: number): Promise<unknown> {
  return JSON.parse(
    new TextDecoder('utf-8', { fatal: true }).decode(await readMarketplaceFile(file, maxBytes)),
  ) as unknown;
}

export function isMissingMarketplaceFile(cause: unknown): boolean {
  return typeof cause === 'object' && cause !== null && 'code' in cause && cause.code === 'ENOENT';
}

/** Validate before opening an output; never follow a pre-existing output link. */
export async function writeMarketplaceFile(
  file: string,
  content: string,
  replace: boolean,
): Promise<void> {
  assertMarketplaceFilePath(file);
  if (!replace) {
    const handle = await open(
      file,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o644,
    );
    try {
      await handle.writeFile(content, 'utf8');
      await handle.sync();
    } catch (cause: unknown) {
      await handle.close();
      await rm(file);
      throw cause;
    }
    await handle.close();
    return;
  }
  try {
    const existing = await lstat(file);
    if (!existing.isFile() || existing.isSymbolicLink())
      throw new Error('Marketplace output must be an ordinary file');
  } catch (cause: unknown) {
    if (!isMissingMarketplaceFile(cause)) throw cause;
  }
  const temporary = join(dirname(file), `.${basename(file)}.${randomUUID()}.tmp`);
  const handle = await open(
    temporary,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o644,
  );
  try {
    await handle.writeFile(content, 'utf8');
    await handle.sync();
    await handle.close();
    await rename(temporary, file);
  } catch (cause: unknown) {
    await handle.close();
    await rm(temporary, { force: true });
    throw cause;
  }
}
