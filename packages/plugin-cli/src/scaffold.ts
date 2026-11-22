import path from 'node:path';

import { z } from 'zod';

import { PluginCliError } from './errors.js';
import { writeProject } from './output.js';
import { resolvePluginSdk } from './sdk.js';
import { renderPluginTemplate } from './templates.js';
import type { CreatedPluginProject, CreatePluginProjectOptions } from './types.js';

const absoluteDirectory = z
  .string()
  .min(1)
  .refine((value) => path.isAbsolute(value) && !value.includes('\0'));
const createOptions = z
  .strictObject({
    template: z.enum(['tool', 'command', 'skills']),
    id: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    directory: absoluteDirectory,
    name: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .refine((value) =>
        [...value].every(
          (character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127,
        ),
      )
      .optional(),
    sdkDirectory: absoluteDirectory.optional(),
    signal: z.instanceof(AbortSignal).optional(),
  })
  .superRefine((value, context) => {
    if (value.template === 'skills' && value.sdkDirectory !== undefined)
      context.addIssue({
        code: 'custom',
        path: ['sdkDirectory'],
        message: 'Skills do not use an SDK',
      });
  });

/** Creates a fresh author project without importing or executing author code. */
export async function createPluginProject(
  options: CreatePluginProjectOptions,
): Promise<CreatedPluginProject> {
  const parsed = createOptions.safeParse(options);
  if (!parsed.success)
    throw new PluginCliError('plugin-cli-invalid-project', 'Invalid create options', {
      cause: parsed.error,
    });
  const checked = parsed.data;
  checked.signal?.throwIfAborted();
  const sdk =
    checked.template === 'skills'
      ? undefined
      : await resolvePluginSdk(checked.sdkDirectory, checked.signal);
  checked.signal?.throwIfAborted();
  const files = renderPluginTemplate({
    template: checked.template,
    id: checked.id,
    name:
      checked.name ??
      checked.id
        .split('-')
        .map((part) => `${part[0]!.toUpperCase()}${part.slice(1)}`)
        .join(' '),
    sdk,
  });
  await writeProject(checked.directory, files, checked.signal);
  return {
    command: 'create',
    projectDirectory: path.resolve(checked.directory),
    variant: checked.template === 'skills' ? 'skills' : 'entry',
    files: [...files.keys()].sort(),
  };
}
