import { join } from 'node:path';
import { z } from 'zod';

const nonEmptyStringSchema = z.string().min(1);

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
    dataDirectory = join(
      resolveHomeDirectory(environment, homeDirectory),
      'Library',
      'Application Support',
      'Weave',
    );
  } else if (platform === 'win32') {
    const appData = environment.APPDATA;
    dataDirectory =
      appData === undefined
        ? join(resolveHomeDirectory(environment, homeDirectory), 'AppData', 'Roaming', 'Weave')
        : join(parseNonEmptyString(appData, 'APPDATA'), 'Weave');
  } else {
    const xdgDataHome = environment.XDG_DATA_HOME;
    dataDirectory =
      xdgDataHome === undefined
        ? join(resolveHomeDirectory(environment, homeDirectory), '.local', 'share', 'weave')
        : join(parseNonEmptyString(xdgDataHome, 'XDG_DATA_HOME'), 'weave');
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

  if (environment.WEAVE_DATABASE_FILE !== undefined) {
    return parseNonEmptyString(environment.WEAVE_DATABASE_FILE, 'WEAVE_DATABASE_FILE');
  }

  if (options.dataDirectory !== undefined) {
    return join(parseNonEmptyString(options.dataDirectory, 'data directory'), 'weave.sqlite');
  }

  if (environment.WEAVE_DATA_DIR !== undefined) {
    return join(parseNonEmptyString(environment.WEAVE_DATA_DIR, 'WEAVE_DATA_DIR'), 'weave.sqlite');
  }

  return join(
    resolveDefaultDataDirectory(environment, options.platform, options.homeDirectory),
    'weave.sqlite',
  );
}
