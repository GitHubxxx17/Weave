import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createGithubPluginAcquirer } from '@weave/plugin-host';
import {
  generateMarketplaceIndex,
  prepareMarketplaceSubmission,
  writeMarketplaceSubmission,
} from './marketplace-tooling.js';
import { readMarketplaceJson } from './marketplace-tool-files.js';

const usage = `Usage:
  marketplace generate [--submissions <directory>] [--output <index.json>]
  marketplace check [--submissions <directory>] [--output <index.json>]
  marketplace entry --input <request.json> --output <submission.json>

Generate and check are offline. Entry reads one pinned public GitHub release
without executing it and creates a new submission file. No command installs,
trusts, activates, commits, pushes, or publishes a plugin.`;

interface MarketplaceCliIo {
  readonly write: (message: string) => void;
  readonly error: (message: string) => void;
}

function parseArguments(
  args: readonly string[],
): { command: 'generate' | 'check' | 'entry'; values: Map<string, string> } | undefined {
  const [command, ...options] = args;
  if (command !== 'generate' && command !== 'check' && command !== 'entry') return undefined;
  const allowed = command === 'entry' ? ['--input', '--output'] : ['--submissions', '--output'];
  const values = new Map<string, string>();
  for (let index = 0; index < options.length; index += 2) {
    const flag = options[index]!;
    const value = options[index + 1];
    if (
      !allowed.includes(flag) ||
      values.has(flag) ||
      value === undefined ||
      value === '' ||
      value.startsWith('--')
    )
      return undefined;
    values.set(flag, value);
  }
  if (command === 'entry' && (!values.has('--input') || !values.has('--output'))) return undefined;
  return { command, values };
}

export async function runMarketplaceCli(
  args: readonly string[],
  io: MarketplaceCliIo = {
    write: (message) => process.stdout.write(`${message}\n`),
    error: (message) => process.stderr.write(`${message}\n`),
  },
): Promise<number> {
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) {
    io.write(usage);
    return 0;
  }
  const parsed = parseArguments(args);
  if (parsed === undefined) {
    io.error(usage);
    return 2;
  }
  try {
    if (parsed.command === 'entry') {
      const input = await readMarketplaceJson(resolve(parsed.values.get('--input')!), 64 * 1024);
      const temporary = await mkdtemp(join(tmpdir(), 'weave-marketplace-entry-'));
      try {
        const acquirer = createGithubPluginAcquirer({ directory: join(temporary, 'acquisition') });
        const entry = await prepareMarketplaceSubmission(input, { acquirer });
        const outputFile = resolve(parsed.values.get('--output')!);
        await writeMarketplaceSubmission(outputFile, entry);
        io.write(`Prepared ${entry.id}@${entry.releases[0]!.manifest.version}: ${outputFile}`);
      } finally {
        await rm(temporary, { recursive: true, force: true });
      }
    } else {
      const base = fileURLToPath(new URL('../../../marketplace/', import.meta.url));
      const result = await generateMarketplaceIndex({
        submissionsDirectory: resolve(
          parsed.values.get('--submissions') ?? join(base, 'submissions'),
        ),
        outputFile: resolve(parsed.values.get('--output') ?? join(base, 'index.json')),
        mode: parsed.command === 'check' ? 'check' : 'write',
      });
      io.write(
        `Marketplace ${parsed.command}: ${result.plugins} plugins, ${result.changed ? 'updated' : 'up to date'}`,
      );
    }
    return 0;
  } catch (cause: unknown) {
    io.error(cause instanceof Error ? cause.message : 'Marketplace command failed');
    return 1;
  }
}

const invokedFile = process.argv[1];
if (invokedFile !== undefined && import.meta.url === pathToFileURL(resolve(invokedFile)).href) {
  process.exitCode = await runMarketplaceCli(process.argv.slice(2));
}
