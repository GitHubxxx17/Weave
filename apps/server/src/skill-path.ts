import { dirname, join } from 'node:path';
import { z } from 'zod';
import { resolveDefaultDataDirectory } from './persistence-path.js';
const pathSchema = z
  .string()
  .min(1)
  .refine((path) => !path.includes('\0'));
export interface ResolveSkillsDirectoryOptions {
  readonly skillsDirectory?: string | false;
  readonly dataDirectory?: string;
  readonly databaseFile?: string;
  readonly environment?: NodeJS.ProcessEnv;
}
/** Resolve the operator-owned user Skill root without creating or scanning it. */
export function resolveSkillsDirectory(
  options: ResolveSkillsDirectoryOptions = {},
): string | false {
  if (options.skillsDirectory === false) return false;
  const environment = options.environment ?? process.env;
  const configured = options.skillsDirectory ?? environment.WEAVE_SKILLS_DIR;
  if (configured !== undefined) return pathSchema.parse(configured);
  const data =
    options.dataDirectory ??
    environment.WEAVE_DATA_DIR ??
    (options.databaseFile === undefined
      ? resolveDefaultDataDirectory(environment)
      : dirname(options.databaseFile));
  return join(pathSchema.parse(data), 'skills');
}
