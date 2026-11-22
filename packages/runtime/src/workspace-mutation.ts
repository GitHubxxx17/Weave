import { createHash } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';

const roots = new Map<string, Promise<unknown>>();
export function fileContentDigest(content: string | Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}
/** Inode numbers can be reused after unlink; bind identity to its incarnation. */
export function workspaceObjectIdentity(metadata: {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly birthtimeNs?: bigint;
}): string {
  if (typeof metadata.birthtimeNs !== 'bigint' || metadata.birthtimeNs <= 0n)
    throw new Error('Workspace file identity requires positive birth-time evidence');
  return fileContentDigest(`${metadata.dev}\0${metadata.ino}\0${metadata.birthtimeNs}`);
}
export async function workspaceRootIdentity(root: string): Promise<string> {
  const canonical = await realpath(root);
  const metadata = await stat(canonical, { bigint: true });
  return fileContentDigest(`${canonical}\0${workspaceObjectIdentity(metadata)}`);
}
export async function workspaceFileIdentity(target: string): Promise<string> {
  const metadata = await stat(target, { bigint: true });
  return workspaceObjectIdentity(metadata);
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
