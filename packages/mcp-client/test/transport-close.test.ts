import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const hostFixture = fileURLToPath(new URL('./fixtures/close-host.mjs', import.meta.url));

type HostReport = {
  closeCount: number;
  pendingSettled: boolean;
  initializeFailed: boolean;
  stderrDestroyed: boolean;
  closeMs: number;
};

async function runHost(
  distribution: 'esm' | 'cjs',
  scenario: 'inherited' | 'pending' | 'normal' | 'invalid-initialize',
): Promise<{
  exited: boolean;
  descendantAlive: boolean;
  report: HostReport;
  stderr: string;
}> {
  const directory = await mkdtemp(join(tmpdir(), 'weave-mcp-close-'));
  const pidFile = join(directory, 'pids.json');
  const host = spawn(process.execPath, [hostFixture, distribution, scenario, pidFile]);
  let stdout = '';
  let stderr = '';
  host.stdout.setEncoding('utf8').on('data', (chunk: string) => {
    stdout += chunk;
  });
  host.stderr.setEncoding('utf8').on('data', (chunk: string) => {
    stderr += chunk;
  });
  try {
    const exited = await waitForExit(host, 5_500);
    const report = JSON.parse(stdout.trim()) as HostReport;
    const pids = JSON.parse(await readFile(pidFile, 'utf8')) as {
      descendantPid?: number;
    };
    const descendantAlive = pids.descendantPid !== undefined && isAlive(pids.descendantPid);
    return { exited, descendantAlive, report, stderr };
  } finally {
    await cleanupHost(host, pidFile, directory);
  }
}

async function cleanupHost(host: ChildProcess, pidFile: string, directory: string): Promise<void> {
  // The transport releases its own handles; this test owns descendant cleanup.
  try {
    const pids = JSON.parse(await readFile(pidFile, 'utf8')) as {
      servicePid: number;
      descendantPid?: number;
    };
    for (const pid of [pids.descendantPid, pids.servicePid]) {
      if (pid !== undefined) killIfAlive(pid);
    }
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
  } finally {
    if (host.exitCode === null && host.signalCode === null) host.kill('SIGKILL');
    await waitForExit(host, 1_000);
    await rm(directory, { recursive: true, force: true });
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ESRCH') return false;
    throw error;
  }
}

function killIfAlive(pid: number): void {
  try {
    process.kill(pid, 'SIGKILL');
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) throw error;
  }
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.off('exit', onExit);
      child.off('error', onError);
      resolve(false);
    }, timeoutMs);
    function onExit(): void {
      clearTimeout(timer);
      child.off('error', onError);
      resolve(true);
    }
    function onError(error: Error): void {
      clearTimeout(timer);
      child.off('exit', onExit);
      reject(error);
    }
    child.once('exit', onExit);
    child.once('error', onError);
  });
}

describe.each(['esm', 'cjs'] as const)('%s stdio transport close', (distribution) => {
  it('allows an independent host to exit while a descendant holds inherited pipes', async () => {
    const { exited, descendantAlive, report, stderr } = await runHost(distribution, 'inherited');
    expect(stderr).toBe('');
    expect(descendantAlive).toBe(true);
    expect(report.closeMs).toBeLessThan(5_000);
    expect(exited, 'host must exit before the descendant is cleaned up').toBe(true);
    expect(report).toMatchObject({ closeCount: 1, stderrDestroyed: true });
  }, 8_000);

  it('settles pending requests once when inherited pipes prevent process close', async () => {
    const { exited, descendantAlive, report, stderr } = await runHost(distribution, 'pending');
    expect(stderr).toBe('');
    expect(descendantAlive).toBe(true);
    expect(report).toMatchObject({
      closeCount: 1,
      pendingSettled: true,
      stderrDestroyed: true,
    });
    expect(exited).toBe(true);
  }, 8_000);

  it('closes normal services and repeated close calls only notify once', async () => {
    const { exited, report, stderr } = await runHost(distribution, 'normal');
    expect(stderr).toBe('');
    expect(exited).toBe(true);
    expect(report).toMatchObject({ closeCount: 1, stderrDestroyed: true });
  }, 8_000);

  it('releases resources after initialization fails', async () => {
    const { exited, report, stderr } = await runHost(distribution, 'invalid-initialize');
    expect(stderr).toBe('');
    expect(exited).toBe(true);
    expect(report).toMatchObject({
      initializeFailed: true,
      closeCount: 1,
      stderrDestroyed: true,
    });
  }, 8_000);
});
