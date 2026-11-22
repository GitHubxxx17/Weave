#!/usr/bin/env node
import path from 'node:path';
import { parseArgs } from 'node:util';

import { PluginCliError } from './errors.js';
import type { PluginTemplate } from './types.js';

const help = `Weave plugin developer CLI (repository-local)

weave-plugin create --template tool|command|skills --id ID --directory NEW_DIRECTORY [--name NAME] [--sdk-directory SDK]
weave-plugin validate (--source DIRECTORY | --artifact DIRECTORY) [--sdk-directory SDK] [--host-version VERSION]
weave-plugin build --source DIRECTORY --out NEW_DIRECTORY [--sdk-directory SDK] [--host-version VERSION]
weave-plugin pack --artifact DIRECTORY --out NEW_DIRECTORY [--host-version VERSION]

Add --json for one JSON result. Use --help to show this text.
Build and pack report the installable payload child of the new output directory.
No author code, dependency installs, trust changes or publication are performed.
`;

const optionDefinitions = {
  template: { type: 'string' },
  id: { type: 'string' },
  directory: { type: 'string' },
  name: { type: 'string' },
  'sdk-directory': { type: 'string' },
  source: { type: 'string' },
  artifact: { type: 'string' },
  out: { type: 'string' },
  'host-version': { type: 'string' },
  json: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
} as const;
const commandOptions = {
  create: new Set(['template', 'id', 'directory', 'name', 'sdk-directory', 'json', 'help']),
  validate: new Set(['source', 'artifact', 'sdk-directory', 'host-version', 'json', 'help']),
  build: new Set(['source', 'out', 'sdk-directory', 'host-version', 'json', 'help']),
  pack: new Set(['artifact', 'out', 'host-version', 'json', 'help']),
};
type Command = keyof typeof commandOptions;
function usage(message: string): never {
  throw new PluginCliError('plugin-cli-usage', message);
}

function parseCommand(args: readonly string[]) {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...args],
      options: optionDefinitions,
      allowPositionals: true,
      strict: true,
      tokens: true,
    });
  } catch (cause: unknown) {
    throw new PluginCliError(
      'plugin-cli-usage',
      cause instanceof Error ? cause.message : 'Invalid command arguments',
      { cause },
    );
  }
  const seen = new Set<string>();
  for (const token of parsed.tokens) {
    if (token.kind !== 'option') continue;
    if (seen.has(token.name)) usage(`Option --${token.name} may be specified only once`);
    seen.add(token.name);
  }
  if (parsed.positionals.length === 0 && parsed.values.help === true && seen.size === 1)
    return { command: undefined, values: parsed.values };
  const [first] = parsed.positionals;
  if (parsed.positionals.length !== 1 || first === undefined || !(first in commandOptions))
    usage('Choose exactly one command: create, validate, build or pack');
  // An explicit switch avoids prototype property names being accepted as commands.
  if (first !== 'create' && first !== 'validate' && first !== 'build' && first !== 'pack')
    usage('Unknown command');
  const command: Command = first;
  for (const name of seen)
    if (!commandOptions[command].has(name))
      usage(`Option --${name} is not supported for ${command}`);
  const values = parsed.values;
  if (values.help === true) return { command, values };
  const required = (name: keyof typeof optionDefinitions): void => {
    if (typeof values[name] !== 'string' || values[name].trim() === '')
      usage(`Missing --${name} for ${command}`);
  };
  if (command === 'create') {
    required('template');
    required('id');
    required('directory');
    if (values.template !== 'tool' && values.template !== 'command' && values.template !== 'skills')
      usage('Template must be tool, command or skills');
    if (values.template === 'skills' && values['sdk-directory'] !== undefined)
      usage('Skills do not use --sdk-directory');
  } else if (command === 'validate') {
    if ((values.source === undefined) === (values.artifact === undefined))
      usage('Validate requires exactly one of --source and --artifact');
    required(values.source === undefined ? 'artifact' : 'source');
    if (values.artifact !== undefined && values['sdk-directory'] !== undefined)
      usage('Artifact validation does not use --sdk-directory');
  } else if (command === 'build') {
    required('source');
    required('out');
  } else {
    required('artifact');
    required('out');
  }
  for (const name of ['name', 'sdk-directory', 'host-version'] as const)
    if (values[name] !== undefined && values[name].trim() === '')
      usage(`Option --${name} must not be empty`);
  return { command, values };
}

function summary(result: unknown): string {
  if (typeof result !== 'object' || result === null) return 'Operation completed.\n';
  if ('payloadDirectory' in result) return `Verified payload: ${String(result.payloadDirectory)}\n`;
  if ('projectDirectory' in result) return `Created project: ${String(result.projectDirectory)}\n`;
  if ('mode' in result && result.mode === 'source')
    return 'Validated TypeScript source. Build it to create an installable payload.\n';
  return 'Validated plugin payload.\n';
}

function errorCode(error: unknown): string | undefined {
  if (!(error instanceof Error) || !('code' in error) || typeof error.code !== 'string')
    return undefined;
  return /^[a-z][a-z0-9-]{0,100}$/i.test(error.code) ? error.code : undefined;
}

function diagnostic(error: unknown): { message: string; aggregate: boolean } {
  const messages: string[] = [];
  const seen = new Set<unknown>();
  let aggregate = false;
  const visit = (value: unknown, depth: number): void => {
    if (depth > 3 || messages.length >= 8 || seen.has(value)) return;
    seen.add(value);
    if (!(value instanceof Error)) return;
    const code = errorCode(value);
    const message = value.message.replace(/[\p{Cc}]/gu, ' ').slice(0, 600);
    messages.push(`${code === undefined ? '' : `${code}: `}${message}`);
    if (value instanceof AggregateError) {
      aggregate = true;
      for (const child of value.errors) visit(child, depth + 1);
    } else if (value.cause instanceof AggregateError) {
      visit(value.cause, depth + 1);
    }
  };
  visit(error, 0);
  return { message: messages.join('; ') || 'Operation failed', aggregate };
}

async function main(): Promise<number> {
  const invocationDirectory = process.cwd();
  const abort = new AbortController();
  const cancel = (): void => {
    abort.abort(new PluginCliError('plugin-cli-cancelled', 'Operation cancelled'));
  };
  process.once('SIGINT', cancel);
  process.once('SIGTERM', cancel);
  try {
    const { command, values } = parseCommand(process.argv.slice(2));
    if (command === undefined || values.help === true) {
      process.stdout.write(help);
      return 0;
    }
    const absolute = (value: string): string => path.resolve(invocationDirectory, value);
    const sdkDirectory =
      values['sdk-directory'] === undefined ? undefined : absolute(values['sdk-directory']);
    const hostVersion = values['host-version'];
    const signal = abort.signal;
    let result: unknown;
    if (command === 'create') {
      const { createPluginProject } = await import('./scaffold.js');
      result = await createPluginProject({
        template: values.template as PluginTemplate,
        id: values.id!,
        directory: absolute(values.directory!),
        name: values.name,
        sdkDirectory,
        signal,
      });
    } else if (command === 'validate') {
      const { validatePlugin } = await import('./api.js');
      result =
        values.source !== undefined
          ? await validatePlugin({
              sourceDirectory: absolute(values.source),
              sdkDirectory,
              hostVersion,
              signal,
            })
          : await validatePlugin({
              artifactDirectory: absolute(values.artifact!),
              hostVersion,
              signal,
            });
    } else if (command === 'build') {
      const { buildPlugin } = await import('./api.js');
      result = await buildPlugin({
        sourceDirectory: absolute(values.source!),
        outputDirectory: absolute(values.out!),
        sdkDirectory,
        hostVersion,
        signal,
      });
    } else {
      const { packPlugin } = await import('./api.js');
      result = await packPlugin({
        artifactDirectory: absolute(values.artifact!),
        outputDirectory: absolute(values.out!),
        hostVersion,
        signal,
      });
    }
    process.stdout.write(values.json === true ? `${JSON.stringify(result)}\n` : summary(result));
    return 0;
  } catch (error: unknown) {
    const details = diagnostic(error);
    const cancelled =
      !details.aggregate &&
      (abort.signal.aborted ||
        (error instanceof PluginCliError && error.code === 'plugin-cli-cancelled'));
    const code = cancelled
      ? 'plugin-cli-cancelled'
      : details.aggregate
        ? 'plugin-cli-io'
        : (errorCode(error) ?? 'plugin-cli-io');
    process.stderr.write(`${code}: ${details.message}\n`);
    return cancelled ? 130 : code === 'plugin-cli-usage' ? 2 : 1;
  } finally {
    process.removeListener('SIGINT', cancel);
    process.removeListener('SIGTERM', cancel);
  }
}

process.exitCode = await main();
