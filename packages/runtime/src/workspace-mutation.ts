import { createHash } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';

const roots = new Map<string, Promise<unknown>>();
export function fileContentDigest(content: string | Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}
export async function workspaceRootIdentity(root: string): Promise<string> {
  const canonical = await realpath(root);
  const metadata = await stat(canonical, { bigint: true });
  return fileContentDigest(`${canonical}\0${metadata.dev}\0${metadata.ino}`);
}
export async function workspaceFileIdentity(target: string): Promise<string> {
  const metadata = await stat(target, { bigint: true });
  return fileContentDigest(`${metadata.dev}\0${metadata.ino}`);
}
/** Serializes cooperating built-in writes and restore in this process only. */
export async function withWorkspaceMutation<T>(root: string, action: () => Promise<T>): Promise<T> {
  const key = await realpath(root);
  const previous = roots.get(key) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(action);
  roots.set(key, next);
  try {
    return await next;
  } finally {
    if (roots.get(key) === next) roots.delete(key);
  }
}
