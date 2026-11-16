import { join, relative, resolve } from 'node:path';
import { z } from 'zod';

const defaultStudioUrl = 'http://127.0.0.1:5173';

const desktopConfigInputSchema = z.object({
  userDataDirectory: z.string().min(1),
  studioUrl: z
    .string()
    .url()
    .refine(
      (value) => {
        const protocol = new URL(value).protocol;
        return protocol === 'http:' || protocol === 'https:';
      },
      { message: 'Studio URL must use HTTP or HTTPS' },
    )
    .optional(),
});

export interface DesktopConfig {
  readonly userDataDirectory: string;
  readonly databaseFile: string;
  readonly studioUrl: string;
}

export interface CreateDesktopConfigInput {
  readonly userDataDirectory: string;
  readonly environment?: NodeJS.ProcessEnv;
}

export function createDesktopConfig(input: CreateDesktopConfigInput): DesktopConfig {
  const parsed = desktopConfigInputSchema.parse({
    userDataDirectory: input.userDataDirectory,
    studioUrl: input.environment?.WEAVE_STUDIO_URL,
  });
  const userDataDirectory = resolve(parsed.userDataDirectory);
  const databaseFile = join(userDataDirectory, 'weave.sqlite');

  if (relative(userDataDirectory, databaseFile).startsWith('..')) {
    throw new Error('Desktop database file must stay inside the Electron user data directory');
  }

  return {
    userDataDirectory,
    databaseFile,
    studioUrl: parsed.studioUrl ?? defaultStudioUrl,
  };
}
