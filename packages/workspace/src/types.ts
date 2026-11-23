import { isAbsolute } from 'node:path';
import { z } from 'zod';

const nonEmptyStringSchema = z.string().min(1);

/** Runtime validation for a Project identifier. */
export const projectIdSchema = nonEmptyStringSchema;

/** Runtime validation for a Session identifier stored in a Project relation. */
export const projectSessionIdSchema = nonEmptyStringSchema;

/** Runtime validation for a Project display name. */
export const projectNameSchema = nonEmptyStringSchema;

/** Runtime validation for an absolute local Project folder. */
export const projectFolderPathSchema = z
  .string()
  .min(1)
  .refine(isAbsolute, { message: 'folderPath must be absolute' });

/** Runtime validation for caller-provided Project fields. */
export const createProjectInputSchema = z
  .object({
    name: projectNameSchema,
    folderName: nonEmptyStringSchema,
    folderPath: projectFolderPathSchema.optional(),
  })
  .strict();

/** Runtime validation for a Project read from a Store. */
export const projectSchema = z.object({
  id: nonEmptyStringSchema,
  name: nonEmptyStringSchema,
  folderName: nonEmptyStringSchema,
  folderPath: z.string().min(1).optional(),
  folderRevision: z.int().nonnegative(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

/** Runtime validation for a Project/Session relation read from a Store. */
export const projectSessionRefSchema = z.object({
  projectId: nonEmptyStringSchema,
  sessionId: nonEmptyStringSchema,
  createdAt: z.iso.datetime(),
});

/**
 * Metadata identifying a local Project.
 *
 * `folderPath` is optional because browser directory pickers do not always
 * expose a durable absolute path to the Server.
 */
export interface Project {
  readonly id: string;
  readonly name: string;
  readonly folderName: string;
  readonly folderPath: string | undefined;
  readonly folderRevision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** A durable relationship between one Project and one Session. */
export interface ProjectSessionRef {
  readonly projectId: string;
  readonly sessionId: string;
  readonly createdAt: string;
}

/** Fields accepted when creating a Project. */
export interface CreateProjectInput {
  readonly name: string;
  readonly folderName: string;
  readonly folderPath?: string | undefined;
}
