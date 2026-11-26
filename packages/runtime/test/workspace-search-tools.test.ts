import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createToolPipeline,
  createToolRegistry,
  createWorkspacePolicy,
  createWorkspaceSearchTools,
} from '../src/index.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function createProject(options: { git: boolean }): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'weave-search-'));
  temporaryDirectories.push(root);
  await mkdir(join(root, 'src', 'nested'), { recursive: true });
  await mkdir(join(root, 'dist'));
  await mkdir(join(root, 'node_modules', 'pkg'), { recursive: true });
  await writeFile(join(root, 'README.md'), '# Demo\nCall createAgentRunner here.\n', 'utf8');
  await writeFile(
    join(root, 'src', 'index.ts'),
    'export function createAgentRunner() {\n  return 1;\n}\n',
    'utf8',
  );
  await writeFile(
    join(root, 'src', 'nested', 'deep.ts'),
    'const DEEP = createAgentRunner();\n',
    'utf8',
  );
  await writeFile(join(root, 'dist', 'index.js'), 'createAgentRunner();\n', 'utf8');
  await writeFile(join(root, 'node_modules', 'pkg', 'index.js'), 'createAgentRunner();\n', 'utf8');
  await writeFile(join(root, '.env'), 'API_KEY=createAgentRunner-secret\n', 'utf8');
  if (options.git) {
    await writeFile(join(root, '.gitignore'), 'dist/\nnode_modules/\n.env\n', 'utf8');
    execFileSync('git', ['init', '-q'], { cwd: root });
  }
  return root;
}

function createPipeline(root: string, options: { searchTimeoutMs?: number } = {}) {
  const registry = createToolRegistry();
  const tools = createWorkspaceSearchTools({
    workspace: createWorkspacePolicy({ root }),
    ...options,
  });
  registry.register(tools.listDir);
  registry.register(tools.glob);
  registry.register(tools.grep);
  const pipeline = createToolPipeline({ registry });
  const run = async (name: string, args: unknown): Promise<string> =>
    (await pipeline.execute({ toolCallId: `${name}-call`, name, arguments: JSON.stringify(args) }))
      .content;
  return { pipeline, run, tools };
}

describe('Workspace search tools', () => {
  it('declares every search tool read-only', async () => {
    const root = await createProject({ git: false });
    const { tools } = createPipeline(root);
    expect([tools.listDir.readOnly, tools.glob.readOnly, tools.grep.readOnly]).toEqual([
      true,
      true,
      true,
    ]);
  });

  it('lists a directory tree that follows .gitignore in a Git repository', async () => {
    const root = await createProject({ git: true });
    const { run } = createPipeline(root);

    const tree = await run('list_dir', {});

    expect(tree).toContain('  src/\n');
    expect(tree).toContain('    nested/  (1 个文件)');
    expect(tree).toMatch(/ {4}index\.ts {2}\d+ B/);
    expect(tree).toMatch(/ {2}README\.md {2}\d+ B/);
    expect(tree).not.toContain('dist/');
    expect(tree).not.toContain('node_modules');
    expect(tree).toContain('已按 .gitignore 规则过滤');

    await expect(run('list_dir', { depth: 3 })).resolves.toMatch(/ {6}deep\.ts {2}\d+ B/);
  });

  it('skips generated directories with the built-in list outside Git', async () => {
    const root = await createProject({ git: false });
    const { run } = createPipeline(root);

    const tree = await run('list_dir', { depth: 1 });

    expect(tree).toContain('src/  (2 个文件)');
    expect(tree).not.toContain('  node_modules/');
    expect(tree).not.toContain('  dist/');
    expect(tree).toContain('已跳过 node_modules、dist 等常见生成目录');
  });

  it('still lists an ignored directory when it is requested explicitly', async () => {
    const root = await createProject({ git: true });
    const { run } = createPipeline(root);

    const tree = await run('list_dir', { path: 'dist' });

    expect(tree).toContain('index.js');
    expect(tree).toContain('这个目录被忽略规则排除，已直接列出');
  });

  it('finds files by glob relative to the search path', async () => {
    const root = await createProject({ git: true });
    const { run } = createPipeline(root);

    await expect(run('glob', { pattern: '**/*.ts' })).resolves.toBe(
      'src/index.ts\nsrc/nested/deep.ts',
    );
    await expect(run('glob', { pattern: '*.ts', path: 'src' })).resolves.toBe('src/index.ts');
    await expect(run('glob', { pattern: '*.ts' })).resolves.toContain('请用 **/*.ts');
  });

  it('greps with line numbers, honours ignore rules and never reads .env files', async () => {
    const root = await createProject({ git: false });
    const { run } = createPipeline(root);

    const result = await run('grep', { pattern: 'createAgentRunner' });

    expect(result).toContain('README.md\n  2: Call createAgentRunner here.');
    expect(result).toContain('src/index.ts\n  1: export function createAgentRunner() {');
    expect(result).toContain('src/nested/deep.ts');
    expect(result).not.toContain('node_modules');
    expect(result).not.toContain('dist/index.js');
    expect(result).not.toContain('secret');
    expect(result).toContain('[共 3 处匹配，分布在 3 个文件]');
  });

  it('filters files with include and shows context lines', async () => {
    const root = await createProject({ git: false });
    const { run } = createPipeline(root);

    const result = await run('grep', { pattern: 'return', include: '*.ts', contextLines: 1 });

    expect(result).toBe(
      [
        'src/index.ts',
        '  1- export function createAgentRunner() {',
        '  2:   return 1;',
        '  3- }',
        '',
        '[共 1 处匹配，分布在 1 个文件]',
      ].join('\n'),
    );
  });

  it('supports case-insensitive regular expressions and reports bad patterns', async () => {
    const root = await createProject({ git: false });
    const { run, pipeline } = createPipeline(root);

    await expect(
      run('grep', { pattern: 'const\\s+deep', regex: true, ignoreCase: true }),
    ).resolves.toContain('src/nested/deep.ts');
    await expect(
      pipeline.execute({
        toolCallId: 'bad',
        name: 'grep',
        arguments: JSON.stringify({ pattern: '(', regex: true }),
      }),
    ).rejects.toMatchObject({
      code: 'tool-execution-failed',
      cause: expect.objectContaining({ code: 'workspace-search-invalid-pattern' }),
    });
    await expect(run('grep', { pattern: 'nothing-matches-this' })).resolves.toMatch(
      /^没有找到匹配的内容（搜索了 \d+ 个文件）$/,
    );
  });

  it('stops a catastrophic regular expression without blocking the process', async () => {
    const root = await createProject({ git: false });
    await writeFile(join(root, 'slow.txt'), `${'a'.repeat(40)}b\n`, 'utf8');
    const { pipeline } = createPipeline(root, { searchTimeoutMs: 300 });
    let ticks = 0;
    const ticker = setInterval(() => {
      ticks += 1;
    }, 20);

    const started = Date.now();
    await expect(
      pipeline.execute({
        toolCallId: 'slow',
        name: 'grep',
        arguments: JSON.stringify({ pattern: '(a+)+$', regex: true, path: 'slow.txt' }),
      }),
    ).rejects.toMatchObject({
      cause: expect.objectContaining({ code: 'workspace-search-failed' }),
    });
    clearInterval(ticker);

    expect(Date.now() - started).toBeLessThan(5000);
    // The main thread kept running timers while the worker was stuck.
    expect(ticks).toBeGreaterThan(5);
  });

  it('never greps a secret file through a symbolic link', async () => {
    for (const git of [false, true]) {
      const root = await createProject({ git });
      await symlink('.env', join(root, 'link-to-env'));
      if (git) {
        execFileSync('git', ['add', '-f', 'link-to-env'], { cwd: root });
      }
      const { run } = createPipeline(root);

      await expect(run('grep', { pattern: 'secret' })).resolves.toMatch(/^没有找到匹配的内容/);
      await expect(run('grep', { pattern: 'secret', path: 'link-to-env' })).resolves.toMatch(
        /^没有找到匹配的内容/,
      );
    }
  });

  it('does not follow symlinks that leave the Workspace', async () => {
    const root = await createProject({ git: false });
    const outside = await mkdtemp(join(tmpdir(), 'weave-search-outside-'));
    temporaryDirectories.push(outside);
    await writeFile(join(outside, 'secret.ts'), 'createAgentRunner leaked\n', 'utf8');
    await symlink(outside, join(root, 'linked'));
    const { run, pipeline } = createPipeline(root);

    await expect(run('grep', { pattern: 'leaked' })).resolves.toMatch(/^没有找到匹配的内容/);
    await expect(run('glob', { pattern: '**/secret.ts' })).resolves.toContain('没有匹配');
    await expect(
      pipeline.execute({
        toolCallId: 'list',
        name: 'list_dir',
        arguments: JSON.stringify({ path: 'linked' }),
      }),
    ).rejects.toMatchObject({
      cause: expect.objectContaining({ code: 'workspace-file-symlink-outside-root' }),
    });
  });

  it('rejects paths outside the Workspace and absolute patterns', async () => {
    const root = await createProject({ git: false });
    const { pipeline } = createPipeline(root);

    await expect(
      pipeline.execute({
        toolCallId: 'outside',
        name: 'list_dir',
        arguments: JSON.stringify({ path: '..' }),
      }),
    ).rejects.toMatchObject({
      cause: expect.objectContaining({ code: 'workspace-file-outside-root' }),
    });
    await expect(
      pipeline.execute({
        toolCallId: 'absolute',
        name: 'glob',
        arguments: JSON.stringify({ pattern: '/etc/*' }),
      }),
    ).rejects.toMatchObject({
      cause: expect.objectContaining({ code: 'workspace-file-invalid-input' }),
    });
  });
});
