import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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

function startElectron(repositoryRoot: string): ChildProcess {
  const caFile = process.env.NODE_EXTRA_CA_CERTS ?? process.env.SSL_CERT_FILE;
  const environment =
    caFile !== undefined && existsSync(caFile)
      ? { ...process.env, NODE_EXTRA_CA_CERTS: caFile }
      : process.env;

  return spawn(pnpmCommand, ['exec', 'electron', 'dist/main.js'], {
    cwd: resolve(repositoryRoot, 'apps/desktop'),
    env: environment,
    stdio: 'inherit',
  });
}

async function waitForStudio(studioUrl: string): Promise<void> {
  const deadline = Date.now() + startupTimeoutMs;
  let lastError = 'unknown error';

  while (Date.now() < deadline) {
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
    await waitForStudio(studioUrl);
    electron = startElectron(repositoryRoot);

    await new Promise<void>((resolvePromise, rejectPromise) => {
      electron?.once('exit', (code, signal) => {
        if (shuttingDown || code === 0) {
          resolvePromise();
          return;
        }
        rejectPromise(
          new Error(`Electron exited with ${signal === null ? `code ${code}` : signal}.`),
        );
      });
      electron?.once('error', rejectPromise);
    });
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
