import { realpath } from 'node:fs/promises';
import { basename, dirname, join, posix, resolve, win32 } from 'node:path';
import { z } from 'zod';

const nonEmptyStringSchema = z.string().min(1);

function joinForPlatform(platform: NodeJS.Platform, ...paths: string[]): string {
  return (platform === 'win32' ? win32 : posix).join(...paths);
}

function parseNonEmptyString(value: string, name: string): string {
  try {
    return nonEmptyStringSchema.parse(value);
  } catch {
    throw new Error(`${name} must be a non-empty string`);
  }
}

function resolveHomeDirectory(
  environment: NodeJS.ProcessEnv,
  homeDirectory: string | undefined,
): string {
  const configuredHome = homeDirectory ?? environment.HOME ?? environment.USERPROFILE;
  if (configuredHome === undefined) {
    throw new Error('Unable to resolve Weave data directory: home directory is required');
  }
  return parseNonEmptyString(configuredHome, 'home directory');
}

export function resolveDefaultDataDirectory(
  environment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
  homeDirectory?: string,
): string {
  let dataDirectory: string;

  if (platform === 'darwin') {
    dataDirectory = joinForPlatform(
      platform,
      resolveHomeDirectory(environment, homeDirectory),
      'Library',
      'Application Support',
      'Weave',
    );
  } else if (platform === 'win32') {
    const appData = environment.APPDATA;
    dataDirectory =
      appData === undefined
        ? joinForPlatform(
            platform,
            resolveHomeDirectory(environment, homeDirectory),
            'AppData',
            'Roaming',
            'Weave',
          )
        : joinForPlatform(platform, parseNonEmptyString(appData, 'APPDATA'), 'Weave');
  } else {
    const xdgDataHome = environment.XDG_DATA_HOME;
    dataDirectory =
      xdgDataHome === undefined
        ? joinForPlatform(
            platform,
            resolveHomeDirectory(environment, homeDirectory),
            '.local',
            'share',
            'weave',
          )
        : joinForPlatform(platform, parseNonEmptyString(xdgDataHome, 'XDG_DATA_HOME'), 'weave');
  }

  return parseNonEmptyString(dataDirectory, 'data directory');
}

export interface ResolveDatabaseFileOptions {
  readonly databaseFile?: string;
  readonly dataDirectory?: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
  readonly homeDirectory?: string;
}

export function resolveDatabaseFile(options: ResolveDatabaseFileOptions = {}): string {
  const environment = options.environment ?? process.env;

  if (options.databaseFile !== undefined) {
    return parseNonEmptyString(options.databaseFile, 'database file');
  }

  if (options.dataDirectory !== undefined) {
    return joinForPlatform(
      options.platform ?? process.platform,
      parseNonEmptyString(options.dataDirectory, 'data directory'),
      'weave.sqlite',
    );
  }

  if (environment.WEAVE_DATABASE_FILE !== undefined) {
    return parseNonEmptyString(environment.WEAVE_DATABASE_FILE, 'WEAVE_DATABASE_FILE');
  }

  if (environment.WEAVE_DATA_DIR !== undefined) {
    return joinForPlatform(
      options.platform ?? process.platform,
      parseNonEmptyString(environment.WEAVE_DATA_DIR, 'WEAVE_DATA_DIR'),
      'weave.sqlite',
    );
  }

  return joinForPlatform(
    options.platform ?? process.platform,
    resolveDefaultDataDirectory(environment, options.platform, options.homeDirectory),
    'weave.sqlite',
  );
}

/** Resolves Session aliases before deriving independently versioned sidecars. */
async function resolveSidecarFile(databaseFile: string, suffix: string): Promise<string> {
  const absolute = resolve(parseNonEmptyString(databaseFile, 'database file'));
  let canonical: string;
  try {
    canonical = await realpath(absolute);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause;
    canonical = join(await realpath(dirname(absolute)), basename(absolute));
  }
  return `${canonical}.${suffix}.sqlite`;
}

export const resolveMemoryDatabaseFile = (databaseFile: string) =>
  resolveSidecarFile(databaseFile, 'memory');

export const resolveRetrievalDatabaseFile = (databaseFile: string) =>
  resolveSidecarFile(databaseFile, 'retrieval');
