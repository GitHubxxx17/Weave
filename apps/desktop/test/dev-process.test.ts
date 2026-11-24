import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { watchChildExit } from '../src/dev-process.js';

describe('watchChildExit', () => {
  it('rejects when the child exits unexpectedly', async () => {
    const child = new EventEmitter();
    const watched = watchChildExit(child as never, 'Vite');
    child.emit('exit', 1, null);
    await expect(watched).rejects.toThrow('Vite exited with code 1.');
  });

  it('reports the terminating signal', async () => {
    const child = new EventEmitter();
    const watched = watchChildExit(child as never, 'Vite');
    child.emit('exit', null, 'SIGKILL');
    await expect(watched).rejects.toThrow('Vite exited with SIGKILL.');
  });

  it('rejects when the child fails to spawn', async () => {
    const child = new EventEmitter();
    const watched = watchChildExit(child as never, 'Vite');
    child.emit('error', new Error('ENOENT'));
    await expect(watched).rejects.toThrow('Vite failed: ENOENT');
  });

  it('stays pending when the exit is part of an orderly shutdown', async () => {
    const child = new EventEmitter();
    let settled = false;
    void watchChildExit(child as never, 'Vite', () => true).catch(() => {
      settled = true;
    });
    child.emit('exit', 0, null);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(settled).toBe(false);
  });
});
