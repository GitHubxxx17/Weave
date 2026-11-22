import { z } from 'zod';

const digest = z.string().regex(/^[0-9a-f]{64}$/);
const id = z
  .string()
  .max(240)
  .regex(
    /^(?:builtin:[a-z0-9]+(?:-[a-z0-9]+)*|plugin:[a-z0-9]+(?:-[a-z0-9]+)*\/[a-z0-9]+(?:-[a-z0-9]+)*|project:[0-9a-f]{32}\/(?:native|agents)\/[a-z0-9]+(?:-[a-z0-9]+)*|user:[0-9a-f]{32}\/[a-z0-9]+(?:-[a-z0-9]+)*)$/,
  );
const refFields = { id, instructionSha256: digest, bundleSha256: digest };
export const skillRefSchema = z.strictObject(refFields).readonly();
export const skillRefsSchema = z
  .array(skillRefSchema)
  .max(32)
  .refine((refs) => new Set(refs.map((ref) => ref.id)).size === refs.length, 'Duplicate Skill ids')
  .readonly();
export const skillSummarySchema = z
  .strictObject({
    ...refFields,
    name: z
      .string()
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
      .max(64),
    description: z.string().trim().min(1).max(1024),
    source: z
      .strictObject({
        kind: z.enum(['builtin', 'plugin', 'project', 'user']),
        label: z.string().trim().min(1).max(300),
        pluginId: z
          .string()
          .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
          .optional(),
      })
      .refine((source) =>
        source.kind === 'plugin' ? source.pluginId !== undefined : source.pluginId === undefined,
      )
      .readonly(),
    invocation: z.strictObject({ user: z.boolean(), model: z.boolean() }).readonly(),
  })
  .readonly();
export const skillCatalogSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    generation: z.number().int().positive().safe(),
    fingerprint: digest,
    entries: z.array(skillSummarySchema).max(512).readonly(),
    complete: z.boolean(),
    truncated: z.boolean(),
    issues: z
      .array(
        z
          .strictObject({
            source: z.string().min(1).max(300),
            code: z.enum([
              'unreadable',
              'invalid-document',
              'unsafe-entry',
              'source-changed',
              'limit-exceeded',
            ]),
            skillId: id.optional(),
          })
          .readonly(),
      )
      .max(64)
      .readonly(),
  })
  .refine((catalog) => !catalog.truncated || !catalog.complete, 'A clipped catalog is incomplete')
  .readonly();
export const skillPreviewSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    skill: skillSummarySchema,
    instructions: z.string().max(65536),
  })
  .readonly();
export const turnSkillsSchema = z
  .strictObject({
    requested: skillRefsSchema,
    applications: z
      .array(
        z
          .strictObject({
            skill: skillSummarySchema,
            invocation: z.enum(['user', 'model']),
            placement: z.number().int().nonnegative(),
            toolCallId: z.string().min(1).optional(),
            delivery: z.enum(['prepared', 'delivered']),
          })
          .readonly(),
      )
      .readonly(),
    failures: z
      .array(
        z
          .strictObject({
            skill: skillRefSchema,
            stage: z.enum(['selection', 'load', 'resource']),
            toolCallId: z.string().min(1).optional(),
            code: z.enum([
              'skill-not-found',
              'skill-source-changed',
              'skill-not-invocable',
              'skill-unavailable',
            ]),
          })
          .readonly(),
      )
      .readonly(),
  })
  .readonly();
export type SkillRef = z.infer<typeof skillRefSchema>;
export type SkillSummary = z.infer<typeof skillSummarySchema>;
export type SkillCatalog = z.infer<typeof skillCatalogSchema>;
export type SkillPreview = z.infer<typeof skillPreviewSchema>;
export type TurnSkills = z.infer<typeof turnSkillsSchema>;
export function sameSkill(left: SkillRef, right: SkillRef): boolean {
  return (
    left.id === right.id &&
    left.instructionSha256 === right.instructionSha256 &&
    left.bundleSha256 === right.bundleSha256
  );
}
export function skillRef(skill: SkillRef): SkillRef {
  return {
    id: skill.id,
    instructionSha256: skill.instructionSha256,
    bundleSha256: skill.bundleSha256,
  };
}
