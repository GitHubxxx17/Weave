import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { watchChildExit } from './dev-process.js';

const defaultStudioUrl = 'http://127.0.0.1:5173';
const startupTimeoutMs = 30_000;
const pollIntervalMs = 250;
const pnpmCommand = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';

function getRepositoryRoot(): string {
  return resolve(fileURLToPath(new URL('../../..', import.meta.url)));
}

function getStudioRoot(repositoryRoot: string): string {
  return resolve(repositoryRoot, 'apps/studio');
}

function getStudioUrl(): string {
  return process.env.WEAVE_STUDIO_URL ?? defaultStudioUrl;
}

function getStudioPort(studioUrl: string): string {
  const parsedUrl = new URL(studioUrl);
  return parsedUrl.port || (parsedUrl.protocol === 'https:' ? '443' : '80');
}

function startStudio(repositoryRoot: string, studioUrl: string): ChildProcess {
  return spawn(
    pnpmCommand,
    ['exec', 'vite', '--host', '127.0.0.1', '--port', getStudioPort(studioUrl), '--strictPort'],
    {
      cwd: getStudioRoot(repositoryRoot),
      env: process.env,
      stdio: 'inherit',
    },
  );
}

function startElectron(repositoryRoot: string, studioUrl: string): ChildProcess {
  const caFile = process.env.NODE_EXTRA_CA_CERTS ?? process.env.SSL_CERT_FILE;
  // Development always points Electron at the Vite server started above; without
  // this the window would load the built Studio hosted by the embedded Server.
  const environment = {
    ...process.env,
    WEAVE_STUDIO_URL: studioUrl,
    ...(caFile !== undefined && existsSync(caFile) ? { NODE_EXTRA_CA_CERTS: caFile } : {}),
  };

  return spawn(pnpmCommand, ['exec', 'electron', 'dist/main.js'], {
    cwd: resolve(repositoryRoot, 'apps/desktop'),
    env: environment,
    stdio: 'inherit',
  });
}

async function waitForStudio(studioUrl: string, isCancelled: () => boolean): Promise<void> {
  const deadline = Date.now() + startupTimeoutMs;
  let lastError = 'unknown error';

  while (Date.now() < deadline) {
    if (isCancelled()) {
      return;
    }
    try {
      const response = await fetch(studioUrl);
      if (response.status < 500) {
        return;
      }
      lastError = `HTTP ${response.status}`;
    } catch (error: unknown) {
      lastError = error instanceof Error ? error.message : String(error);
    }

    await new Promise<void>((resolvePromise) => {
      setTimeout(resolvePromise, pollIntervalMs);
    });
  }

  throw new Error(
    `Studio did not become ready at ${studioUrl} within ${startupTimeoutMs / 1000} seconds (${lastError}).`,
  );
}

function studioExited(child: ChildProcess | undefined): boolean {
  return child !== undefined && child.exitCode !== null;
}

function stopChildProcess(child: ChildProcess | undefined): void {
  if (child !== undefined && child.exitCode === null) {
    child.kill('SIGTERM');
  }
}

async function run(): Promise<void> {
  const repositoryRoot = getRepositoryRoot();
  const studioUrl = getStudioUrl();
  let studio: ChildProcess | undefined;
  let electron: ChildProcess | undefined;
  let shuttingDown = false;

  const shutdown = (exitCode: number): void => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    stopChildProcess(electron);
    stopChildProcess(studio);
    process.exitCode = exitCode;
  };

  process.once('SIGINT', () => shutdown(130));
  process.once('SIGTERM', () => shutdown(143));

  try {
    studio = startStudio(repositoryRoot, studioUrl);
    const studioFailure = watchChildExit(studio, 'Vite', () => shuttingDown);
    // Avoid an unhandled rejection if Vite dies after another branch has settled.
    studioFailure.catch(() => undefined);
    await Promise.race([
      waitForStudio(studioUrl, () => shuttingDown || studioExited(studio)),
      studioFailure,
    ]);
    if (studioExited(studio)) {
      throw new Error('Vite exited before Studio became ready.');
    }
    electron = startElectron(repositoryRoot, studioUrl);
    const electronChild = electron;

    await Promise.race([
      studioFailure,
      new Promise<void>((resolvePromise, rejectPromise) => {
        electronChild.once('exit', (code, signal) => {
          if (shuttingDown || code === 0) {
            resolvePromise();
            return;
          }
          rejectPromise(
            new Error(`Electron exited with ${signal === null ? `code ${code}` : signal}.`),
          );
        });
        electronChild.once('error', rejectPromise);
      }),
    ]);
  } catch (error: unknown) {
    console.error(
      `桌面开发模式启动失败：${error instanceof Error ? error.message : String(error)}`,
    );
    shutdown(1);
  } finally {
    stopChildProcess(electron);
    stopChildProcess(studio);
  }
}

await run();
