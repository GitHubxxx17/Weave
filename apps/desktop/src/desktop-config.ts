import { join, relative, resolve } from 'node:path';
import { z } from 'zod';

const defaultStudioUrl = 'http://127.0.0.1:5173';
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
});

export interface DesktopConfig {
  readonly userDataDirectory: string;
  readonly databaseFile: string;
  readonly pluginsDirectory: string;
  readonly allowInitialManagedPluginBinding: boolean;
  readonly studioUrl: string;
  readonly studioOrigin: string;
}

export interface CreateDesktopConfigInput {
  readonly userDataDirectory: string;
  readonly environment?: NodeJS.ProcessEnv;
}

export function createDesktopConfig(input: CreateDesktopConfigInput): DesktopConfig {
  const parsed = desktopConfigInputSchema.parse({
    userDataDirectory: input.userDataDirectory,
    pluginsDirectory: input.environment?.WEAVE_PLUGINS_DIR,
    studioUrl: input.environment?.WEAVE_STUDIO_URL,
  });
  const userDataDirectory = resolve(parsed.userDataDirectory);
  const databaseFile = join(userDataDirectory, 'weave.sqlite');

  if (relative(userDataDirectory, databaseFile).startsWith('..')) {
    throw new Error('Desktop database file must stay inside the Electron user data directory');
  }

  const override = parsed.pluginsDirectory;
  const pluginsDirectory = override ?? join(userDataDirectory, 'plugins');
  const allowInitialManagedPluginBinding = override === undefined;

  return {
    userDataDirectory,
    databaseFile,
    pluginsDirectory,
    allowInitialManagedPluginBinding,
    studioUrl: parsed.studioUrl ?? defaultStudioUrl,
    studioOrigin: new URL(parsed.studioUrl ?? defaultStudioUrl).origin,
  };
}
