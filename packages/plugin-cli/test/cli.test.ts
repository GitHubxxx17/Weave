import { execFile } from 'node:child_process';
import { mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeAll, describe, expect, test } from 'vitest';

const require = createRequire(import.meta.url);
const packageRoot = fileURLToPath(new URL('..', import.meta.url));
const bin = path.join(packageRoot, 'dist/cli.js');
const compiler = require.resolve('typescript/lib/tsc.js');
const temporary: string[] = [];

interface ProcessResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}
function processResult(
  args: readonly string[],
  cwd: string,
  nodeArgs: readonly string[] = [],
): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [...nodeArgs, bin, ...args],
      { cwd, timeout: 30_000 },
      (error, stdout, stderr) => {
        if (error !== null && typeof error.code !== 'number') {
          reject(error);
          return;
        }
        resolve({ code: error?.code ?? 0, stdout, stderr });
      },
    );
  });
}

beforeAll(async () => {
  await new Promise<void>((resolve, reject) => {
    execFile(
      process.execPath,
      [compiler, '-p', path.join(packageRoot, 'tsconfig.json')],
      (error, stdout, stderr) => {
        if (error !== null)
          reject(new Error(`CLI compilation failed:\n${stdout}${stderr}`, { cause: error }));
        else resolve();
      },
    );
  });
}, 60_000);

afterEach(async () => {
  await Promise.all(
    temporary.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function externalDirectory(): Promise<string> {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), 'weave-cli-bin-')));
  temporary.push(directory);
  return directory;
}

// The current public Plugin barrel loads Node's experimental SQLite module
// transitively. Keep Node warnings visible without confusing them with CLI errors.
function expectSuccessfulOperation(result: ProcessResult): void {
  expect(result.code).toBe(0);
  const diagnostics = result.stderr.replace(
    /\(node:\d+\) ExperimentalWarning: SQLite is an experimental feature and might change at any time\r?\n\(Use `node --trace-warnings \.\.\.` to show where the warning was created\)\r?\n/g,
    '',
  );
  expect(diagnostics).toBe('');
}

describe('actual CLI bin', () => {
  test('shows commands without performing an operation', async () => {
    const directory = await externalDirectory();
    const result = await processResult(['--help'], directory);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('weave-plugin create');
    expect(result.stdout).toContain('weave-plugin pack');
    expect(result.stderr).toBe('');
  });

  test.each([
    ['create', '--template', 'skills', '--id', 'good', '--directory', 'project', '--unexpected'],
    ['create', '--template', 'skills', '--id', 'good', '--directory', 'project', '--id', 'other'],
    [
      'create',
      '--template',
      'skills',
      '--id',
      'good',
      '--directory',
      'project',
      '--json',
      '--json',
    ],
    [
      'create',
      '--template',
      'skills',
      '--id',
      'good',
      '--directory',
      'project',
      '--sdk-directory',
      'sdk',
    ],
    ['validate', '--source', 'project', '--artifact', 'project'],
    ['validate', '--artifact', 'project', '--sdk-directory', 'sdk'],
    ['build', '--source', 'project', '--out', 'build', '--template', 'tool'],
    ['pack', '--source', 'project', '--out', 'packed'],
    ['create', '--template', 'skills', '--id', 'good', '--directory', 'project', 'extra'],
    ['install', '--source', 'project'],
    [],
  ])('rejects malformed or contradictory options before side effects: %j', async (...args) => {
    const directory = await externalDirectory();
    const result = await processResult(args, directory);
    expect(result.code).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('plugin-cli-usage');
    await expect(stat(path.join(directory, 'project'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(path.join(directory, 'build'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  test('runs create, validate, build and pack with one JSON object per result from a clean external cwd', async () => {
    const directory = await externalDirectory();
    const created = await processResult(
      [
        'create',
        '--template',
        'skills',
        '--id',
        'checked-work',
        '--directory',
        'project',
        '--json',
      ],
      directory,
    );
    expectSuccessfulOperation(created);
    expect(JSON.parse(created.stdout)).toMatchObject({
      command: 'create',
      projectDirectory: path.join(directory, 'project'),
      variant: 'skills',
    });

    const validated = await processResult(['validate', '--source', 'project', '--json'], directory);
    expectSuccessfulOperation(validated);
    expect(JSON.parse(validated.stdout)).toMatchObject({
      mode: 'artifact',
      artifact: { kind: 'skills' },
    });

    const built = await processResult(
      ['build', '--source', 'project', '--out', 'built', '--json'],
      directory,
    );
    expectSuccessfulOperation(built);
    expect(JSON.parse(built.stdout)).toMatchObject({
      command: 'build',
      payloadDirectory: path.join(directory, 'built/payload'),
    });

    const packed = await processResult(
      ['pack', '--artifact', 'built/payload', '--out', 'release', '--json'],
      directory,
    );
    expectSuccessfulOperation(packed);
    const result = JSON.parse(packed.stdout) as { receipt: unknown };
    expect(result).toMatchObject({
      command: 'pack',
      payloadDirectory: path.join(directory, 'release/payload'),
      receipt: { schemaVersion: 1, variant: 'skills', manifest: { id: 'checked-work' } },
    });
    expect(
      JSON.parse(await readFile(path.join(directory, 'release/receipt.json'), 'utf8')),
    ).toEqual(result.receipt);
    await expect(stat(path.join(directory, 'node_modules'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  }, 60_000);

  test('operation failure uses stderr and preserves a previously created directory', async () => {
    const directory = await externalDirectory();
    const options = [
      'create',
      '--template',
      'skills',
      '--id',
      'existing-work',
      '--directory',
      'project',
      '--json',
    ];
    expect((await processResult(options, directory)).code).toBe(0);
    const before = await readFile(path.join(directory, 'project/weave-plugin.json'), 'utf8');
    const repeated = await processResult(options, directory);
    expect(repeated.code).toBe(1);
    expect(repeated.stdout).toBe('');
    expect(repeated.stderr).toContain('plugin-cli-output-conflict');
    expect(await readFile(path.join(directory, 'project/weave-plugin.json'), 'utf8')).toBe(before);
  });

  test.each([false, true])(
    'reports cancellation and preserves unowned cleanup data (%s)',
    async (insertUnowned) => {
      const directory = await externalDirectory();
      const project = path.join(directory, 'project');
      const preload = path.join(directory, 'race.mjs');
      await writeFile(
        preload,
        `
import fs from 'node:fs/promises';
import path from 'node:path';
import { setImmediate } from 'node:timers/promises';
const open = fs.open;
fs.open = async (...args) => {
  const handle = await open(...args);
  if (String(args[0]) === ${JSON.stringify(path.join(project, 'weave-plugin.json'))}) {
    ${insertUnowned ? `await fs.writeFile(path.join(${JSON.stringify(project)}, 'unowned.txt'), 'Unrelated concurrent data');` : ''}
    process.kill(process.pid, 'SIGINT');
    await setImmediate();
  }
  return handle;
};
`,
      );
      const result = await processResult(
        [
          'create',
          '--template',
          'skills',
          '--id',
          'cancelled-work',
          '--directory',
          'project',
          '--json',
        ],
        directory,
        ['--import', preload],
      );
      expect(result.stdout).toBe('');
      if (insertUnowned) {
        expect(result.code).toBe(1);
        expect(result.stderr).toContain('plugin-cli-io');
        expect(result.stderr).toContain(project);
        expect(result.stderr).toContain('preserved');
        expect(await readFile(path.join(project, 'unowned.txt'), 'utf8')).toBe(
          'Unrelated concurrent data',
        );
      } else {
        expect(result.code).toBe(130);
        expect(result.stderr).toContain('plugin-cli-cancelled');
        await expect(stat(project)).rejects.toMatchObject({ code: 'ENOENT' });
      }
    },
  );
});
