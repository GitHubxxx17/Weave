import { z } from 'zod';

/** Skill names use the same bounded directory-safe spelling in every source. */
export const skillNamePattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Resource paths are opaque bundle-relative POSIX paths, never host paths. */
export function isSkillResourcePath(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 512 &&
    !/[\\\0:]/.test(value) &&
    value
      .split('/')
      .every(
        (part) =>
          part !== '' &&
          part !== '.' &&
          part !== '..' &&
          !['__proto__', 'prototype', 'constructor'].includes(part),
      )
  );
}

export interface SkillContribution {
  readonly name: string;
  readonly description: string;
  readonly instructions: string;
  readonly invocation?: { readonly user: boolean; readonly model: boolean } | undefined;
  readonly resources?: Readonly<Record<string, string>> | undefined;
}

export interface AttributedSkillContribution extends SkillContribution {
  readonly pluginId: string;
}

export interface SkillsExtensionApi {
  addSkill(skill: SkillContribution): void;
}

const encoder = new TextEncoder();
const byteLength = (value: string): number => encoder.encode(value).byteLength;
const text = (limit: number) =>
  z.string().refine((value) => !value.includes('\0') && byteLength(value) <= limit);
const shape = {
  name: z.string().max(64).regex(skillNamePattern),
  description: z
    .string()
    .max(8192)
    .transform((value) => value.replace(/\s+/g, ' ').trim())
    .pipe(z.string().min(1).max(1024)),
  instructions: text(64 * 1024)
    .transform((value) => value.replace(/^\ufeff/, '').replace(/\r\n/g, '\n'))
    .refine((value) => value.trim() !== ''),
  invocation: z.object({ user: z.boolean(), model: z.boolean() }).strict().optional(),
  resources: z
    .preprocess(
      (value, context) => {
        if (
          value !== null &&
          typeof value === 'object' &&
          Object.keys(value).some((key) => !isSkillResourcePath(key))
        ) {
          context.addIssue({
            code: 'custom',
            message: 'Skill resource path must be a safe relative path',
          });
        }
        return value;
      },
      z.record(z.string().refine(isSkillResourcePath), text(256 * 1024)),
    )
    .superRefine((resources, context) => {
      if (
        Object.keys(resources).length > 64 ||
        Object.values(resources).reduce((bytes, value) => bytes + byteLength(value), 0) >
          2 * 1024 * 1024
      ) {
        context.addIssue({
          code: 'custom',
          message: 'Skill resources exceed the file or byte limit',
        });
      }
    })
    .optional(),
};

/** Strict declarative data only: a Skill never supplies callbacks or permissions. */
export const skillContributionSchema: z.ZodType<SkillContribution> = z.object(shape).strict();

/** Collector-only validation of the real contributor assigned by the guard. */
export const attributedSkillContributionSchema: z.ZodType<AttributedSkillContribution> = z
  .object({
    ...shape,
    pluginId: z.string().regex(skillNamePattern),
  })
  .strict();
