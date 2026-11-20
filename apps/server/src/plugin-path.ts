import { posix, win32 } from 'node:path';
import { z } from 'zod';
import { resolveDefaultDataDirectory } from './persistence-path.js';

const pathSchema = z.string().min(1);

export interface ResolvePluginsDirectoryOptions {
  readonly pluginsDirectory?: string | false;
  readonly databaseFile?: string;
  readonly dataDirectory?: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
  readonly homeDirectory?: string;
}

/** Resolves configuration without reading, creating or loading a plugin directory. */
export function resolvePluginsDirectory(
  options: ResolvePluginsDirectoryOptions = {},
): string | false {
  const environment = options.environment ?? process.env;
  if (options.pluginsDirectory === false) return false;
  if (options.pluginsDirectory !== undefined) return pathSchema.parse(options.pluginsDirectory);
  if (environment.WEAVE_PLUGINS_DIR !== undefined)
    return pathSchema.parse(environment.WEAVE_PLUGINS_DIR);

  // An isolated database must not implicitly opt tests or embedders into the
  // real user's plugins. A plugin directory above explicitly opts back in.
  if (options.databaseFile !== undefined && options.dataDirectory === undefined) return false;

  const platform = options.platform ?? process.platform;
  const directory = options.dataDirectory ?? environment.WEAVE_DATA_DIR;
  const dataDirectory =
    directory === undefined
      ? resolveDefaultDataDirectory(environment, platform, options.homeDirectory)
      : pathSchema.parse(directory);
  return (platform === 'win32' ? win32 : posix).join(dataDirectory, 'plugins');
}
