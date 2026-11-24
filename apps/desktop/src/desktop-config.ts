import { join, resolve } from 'node:path';
import { z } from 'zod';

const loopbackHosts = new Set(['localhost', '127.0.0.1', '[::1]']);

const desktopConfigInputSchema = z.object({
  userDataDirectory: z.string().min(1),
  pluginsDirectory: z.string().optional(),
  studioUrl: z
    .string()
    .url()
    .superRefine((value, context) => {
      const url = new URL(value);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        context.addIssue({
          code: 'custom',
          message: 'Studio URL must use HTTP or HTTPS',
        });
      }
      if (!loopbackHosts.has(url.hostname)) {
        context.addIssue({
          code: 'custom',
          message: 'Studio URL must point to a loopback host',
        });
      }
    })
    .optional(),
  host: z
    .string()
    .trim()
    .min(1)
    .max(253)
    .regex(/^[A-Za-z0-9.:[\]-]+$/, 'Host must be a hostname or IP address')
    .optional(),
});

export interface DesktopConfig {
  readonly userDataDirectory: string;
  readonly databaseFile: string;
  readonly pluginsDirectory: string;
  readonly allowInitialManagedPluginBinding: boolean;
  /**
   * Studio URL from `WEAVE_STUDIO_URL` (development, usually Vite). When unset
   * the window loads the built Studio hosted by the embedded Server.
   */
  readonly studioUrl: string | undefined;
  /** Origin of `studioUrl`; `undefined` when the embedded Server hosts Studio. */
  readonly studioOrigin: string | undefined;
  /** Studio `vite build` output hosted by the embedded Server. */
  readonly studioDirectory: string | undefined;
  /** Server listen address from `--host` or `WEAVE_HOST`; `undefined` means loopback. */
  readonly host: string | undefined;
}

export interface CreateDesktopConfigInput {
  readonly userDataDirectory: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly studioDirectory?: string;
  /** Command-line arguments after the executable and script, e.g. `process.argv.slice(1)`. */
  readonly argv?: readonly string[];
}

/** Reads `--host <address>` or `--host=<address>`, falling back to `WEAVE_HOST`. */
function readHost(
  argv: readonly string[],
  environment: NodeJS.ProcessEnv | undefined,
): string | undefined {
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--host') {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new Error('--host requires an address');
      }
      return value;
    }
    if (argument?.startsWith('--host=') === true) {
      return argument.slice('--host='.length);
    }
  }
  const fromEnvironment = environment?.WEAVE_HOST?.trim();
  return fromEnvironment === undefined || fromEnvironment === '' ? undefined : fromEnvironment;
}

export function createDesktopConfig(input: CreateDesktopConfigInput): DesktopConfig {
  const parsed = desktopConfigInputSchema.parse({
    userDataDirectory: input.userDataDirectory,
    pluginsDirectory: input.environment?.WEAVE_PLUGINS_DIR,
    studioUrl: input.environment?.WEAVE_STUDIO_URL,
    host: readHost(input.argv ?? [], input.environment),
  });
  const userDataDirectory = resolve(parsed.userDataDirectory);
  const databaseFile = join(userDataDirectory, 'weave.sqlite');

  const override = parsed.pluginsDirectory;
  const pluginsDirectory = override ?? join(userDataDirectory, 'plugins');
  const allowInitialManagedPluginBinding = override === undefined;

  return {
    userDataDirectory,
    databaseFile,
    pluginsDirectory,
    allowInitialManagedPluginBinding,
    studioUrl: parsed.studioUrl,
    studioOrigin: parsed.studioUrl === undefined ? undefined : new URL(parsed.studioUrl).origin,
    studioDirectory: input.studioDirectory,
    host: parsed.host,
  };
}
