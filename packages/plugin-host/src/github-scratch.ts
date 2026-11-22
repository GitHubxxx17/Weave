import fs from 'node:fs/promises';
import path from 'node:path';

const operationName = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function unexpected(): Error {
  return new Error('The private GitHub acquisition directory contains an unexpected entry');
}

/** Validate the complete removal plan before touching any abandoned content. */
async function planRemoval(directory: string): Promise<{ directory: boolean; filename: string }[]> {
  const plan: { directory: boolean; filename: string }[] = [];
  let entries = 0;
  const walk = async (filename: string, depth: number): Promise<void> => {
    if (depth > 64 || ++entries > 10_001) throw unexpected();
    const stat = await fs.lstat(filename);
    if (!stat.isDirectory() && !stat.isFile()) throw unexpected();
    if (depth === 0 && !stat.isDirectory()) throw unexpected();
    if (stat.isDirectory()) {
      for await (const entry of await fs.opendir(filename))
        await walk(path.join(filename, entry.name), depth + 1);
    }
    plan.push({ directory: stat.isDirectory(), filename });
  };
  await walk(directory, 0);
  return plan;
}

export async function removeGithubOperation(directory: string): Promise<void> {
  for (const entry of await planRemoval(directory)) {
    if (entry.directory) await fs.rmdir(entry.filename);
    else await fs.unlink(entry.filename);
  }
}

export async function recoverGithubScratch(directory: string, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  try {
    await fs.mkdir(directory, { mode: 0o700 });
  } catch (error: unknown) {
    if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
  }
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory()) throw unexpected();
  const operations: string[] = [];
  for await (const entry of await fs.opendir(directory)) {
    signal.throwIfAborted();
    if (!operationName.test(entry.name) || !entry.isDirectory()) throw unexpected();
    operations.push(path.join(directory, entry.name));
    if (operations.length > 64) throw unexpected();
  }
  const plans = [];
  for (const operation of operations) {
    signal.throwIfAborted();
    plans.push(await planRemoval(operation));
  }
  for (const plan of plans) {
    signal.throwIfAborted();
    for (const entry of plan) {
      if (entry.directory) await fs.rmdir(entry.filename);
      else await fs.unlink(entry.filename);
    }
  }
}
