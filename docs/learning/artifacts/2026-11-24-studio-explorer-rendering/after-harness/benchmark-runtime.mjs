import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { platform, arch, cpus } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import process from 'node:process';

const execute = promisify(execFile);
export const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
export const productionDist = join(repositoryRoot, 'apps/studio/dist');

/** A unique named browser per runner; every sample opens and closes it afresh. */
export function browserCli(session) {
  return async (...args) => {
    const { stdout } = await execute('playwright-cli', [`-s=${session}`, '--raw', ...args], {
      timeout: 240000,
      maxBuffer: 16 * 1024 * 1024,
    });
    if (/^### Error/m.test(stdout)) throw Error(stdout);
    return stdout.trim();
  };
}

async function snapshot(directory, prefix = '') {
  const files = [];
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    const relative = prefix + entry.name;
    if (entry.isDirectory())
      files.push(...(await snapshot(join(directory, entry.name), relative + '/')));
    else {
      const body = await readFile(join(directory, entry.name));
      files.push({
        path: relative,
        bytes: body.length,
        sha256: createHash('sha256').update(body).digest('hex'),
      });
    }
  }
  return files;
}

export async function benchmarkEnvironment(dist, harnessFiles) {
  const git = async (...args) =>
    (await execute('git', args, { cwd: repositoryRoot })).stdout.trim();
  const distFiles = await snapshot(dist);
  const harnessHash = createHash('sha256')
    .update(
      (await Promise.all(harnessFiles.map((name) => readFile(new URL(name, import.meta.url)))))
        .map((body) => body.toString())
        .join('\n'),
    )
    .digest('hex');
  return {
    commit: await git('rev-parse', 'HEAD'),
    dirty: Boolean(await git('status', '--porcelain')),
    recordedAt: new Date().toISOString(),
    platform: platform(),
    arch: arch(),
    cpu: cpus()[0]?.model,
    node: process.version,
    harnessHash,
    harnessFiles,
    distHash: createHash('sha256').update(JSON.stringify(distFiles)).digest('hex'),
    distHashAlgorithm: 'SHA256(JSON.stringify(sorted relative path/bytes/sha256 metadata))',
    distFiles,
    synthetic: true,
    viewport: { width: 1440, height: 1000 },
    browserIsolation: 'fresh-browser-per-sample',
    assetCache: 'no-store',
    readinessWaitTimeoutMs: 120000,
    timeoutNote:
      'Each readiness wait <=120s; each browser phase CLI command <=240s, not a total120s phase deadline',
    cliTimeoutMs: 240000,
  };
}
