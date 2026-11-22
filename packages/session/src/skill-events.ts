import {
  skillCatalogSchema,
  skillRefsSchema,
  skillRefSchema,
  skillSummarySchema,
} from '@weave/protocol';
import { z } from 'zod';

const id = z.string().min(1);
const turn = { turnId: id };
export const skillContentPayloadSchema = z
  .object({
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    text: z
      .string()
      .min(1)
      .refine((text) => new TextEncoder().encode(text).length <= 65536),
  })
  .strict();
export const skillCatalogAppliedPayloadSchema = z
  .object({
    ...turn,
    generation: z.number().int().positive().safe(),
    catalog: skillCatalogSchema,
  })
  .strict()
  .refine((value) => value.generation === value.catalog.generation);
export const skillRequestedPayloadSchema = z
  .object({
    ...turn,
    userMessageId: id,
    skills: skillRefsSchema,
  })
  .strict();
export const skillFailedPayloadSchema = z
  .object({
    ...turn,
    skill: skillRefSchema,
    stage: z.enum(['selection', 'load', 'resource']),
    code: z.enum([
      'skill-not-found',
      'skill-source-changed',
      'skill-not-invocable',
      'skill-unavailable',
    ]),
    toolCallId: id.optional(),
  })
  .strict();
export const skillAppliedPayloadSchema = z
  .object({
    ...turn,
    skill: skillSummarySchema,
    invocation: z.enum(['user', 'model']),
    placement: z.number().int().nonnegative().max(31),
    toolCallId: id.optional(),
  })
  .strict()
  .refine((value) => value.invocation !== 'model' || value.toolCallId !== undefined);

export type SkillFailure = Omit<z.infer<typeof skillFailedPayloadSchema>, 'turnId'>;
export type SkillApplication = Omit<z.infer<typeof skillAppliedPayloadSchema>, 'turnId'> & {
  readonly delivery: 'prepared' | 'delivered';
};
