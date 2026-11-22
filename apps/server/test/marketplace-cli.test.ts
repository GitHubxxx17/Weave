import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runMarketplaceCli } from '../src/marketplace-cli.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'weave-market-cli-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const submissions = join(root, 'submissions');
  await mkdir(submissions);
  const messages: string[] = [];
  const errors: string[] = [];
  return {
    root,
    submissions,
    messages,
    errors,
    io: {
      write: (value: string) => messages.push(value),
      error: (value: string) => errors.push(value),
    },
  };
}

describe('marketplace CLI', () => {
  it('generates and checks a directory through its documented command arguments', async () => {
    const { root, submissions, messages, io } = await fixture();
    const output = join(root, 'index.json');
    expect(
      await runMarketplaceCli(['generate', '--submissions', submissions, '--output', output], io),
    ).toBe(0);
    expect(JSON.parse(await readFile(output, 'utf8'))).toEqual({ schemaVersion: 1, plugins: [] });
    expect(
      await runMarketplaceCli(['check', '--submissions', submissions, '--output', output], io),
    ).toBe(0);
    expect(messages.join('\n')).toContain('0 plugins');
    await writeFile(output, '{}');
    expect(
      await runMarketplaceCli(['check', '--submissions', submissions, '--output', output], io),
    ).toBe(1);
    expect(await readFile(output, 'utf8')).toBe('{}');
  });

  it.each(
    [
      [],
      ['publish'],
      ['generate', '--token', 'secret'],
      ['entry', '--input', 'request.json'],
      ['check', '--output', 'a', '--output', 'b'],
    ].map((args) => ({ args })),
  )('rejects invalid arguments without generating anything: $args', async ({ args }) => {
    const { io, errors } = await fixture();
    expect(await runMarketplaceCli(args, io)).toBe(2);
    expect(errors.join('\n')).toContain('Usage:');
  });

  it('documents entry preparation and accepts --help without IO', async () => {
    const { io, messages } = await fixture();
    expect(await runMarketplaceCli(['--help'], io)).toBe(0);
    expect(messages.join('\n')).toContain('entry --input');
  });

  it('fails malformed entry JSON before starting remote acquisition', async () => {
    const { root, io, errors } = await fixture();
    const input = join(root, 'request.json');
    const output = join(root, 'notes.json');
    await writeFile(input, 'not json');
    expect(await runMarketplaceCli(['entry', '--input', input, '--output', output], io)).toBe(1);
    expect(errors.length).toBe(1);
    await expect(readFile(output)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
