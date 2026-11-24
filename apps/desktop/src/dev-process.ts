import type { ChildProcess } from 'node:child_process';

/**
 * Rejects when `child` exits or fails to spawn, unless `isExpected()` says the
 * exit is part of an orderly shutdown (then the promise never settles).
 * Used by the dev launcher so a dead Vite process fails fast.
 */
export function watchChildExit(
  child: Pick<ChildProcess, 'once'>,
  label: string,
  isExpected: () => boolean = () => false,
): Promise<never> {
  return new Promise<never>((_resolve, reject) => {
    child.once('exit', (code: number | null, signal: NodeJS.Signals | null) => {
      if (isExpected()) {
        return;
      }
      reject(new Error(`${label} exited with ${signal === null ? `code ${code}` : signal}.`));
    });
    child.once('error', (error: Error) => {
      reject(new Error(`${label} failed: ${error.message}`));
    });
  });
}
