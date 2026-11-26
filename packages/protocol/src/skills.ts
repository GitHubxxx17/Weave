import { z } from 'zod';

const digestSchema = z.string().regex(/^[0-9a-f]{64}$/);
const nameSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
const idSchema = z
  .string()
  .max(240)
  .regex(
    /^(?:builtin:[a-z0-9]+(?:-[a-z0-9]+)*|plugin:[a-z0-9]+(?:-[a-z0-9]+)*\/[a-z0-9]+(?:-[a-z0-9]+)*|project:[0-9a-f]{32}\/(?:native|agents)\/[a-z0-9]+(?:-[a-z0-9]+)*|user:[0-9a-f]{32}\/[a-z0-9]+(?:-[a-z0-9]+)*)$/,
  );

/** An exact instruction bundle; short names never resolve an explicit selection. */
export const skillRefSchema = z
  .object({
    id: idSchema,
    instructionSha256: digestSchema,
    bundleSha256: digestSchema,
  })
  .strict();
export type SkillRef = z.infer<typeof skillRefSchema>;

export const skillRefsSchema = z
  .array(skillRefSchema)
  .max(32)
  .refine(
    (refs) => new Set(refs.map((ref) => ref.id)).size === refs.length,
    'Skill selections must have unique identities',
  );

export const skillSourceSchema = z
  .object({
    kind: z.enum(['builtin', 'plugin', 'project', 'user']),
    label: z.string().trim().min(1).max(300),
    pluginId: z
      .string()
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
      .optional(),
  })
  .strict()
  .refine(
    (source) => (source.kind === 'plugin') === (source.pluginId !== undefined),
    'Only a plugin source carries its real plugin owner',
  );
export type SkillSource = z.infer<typeof skillSourceSchema>;

export const skillSummarySchema = skillRefSchema
  .extend({
    name: nameSchema,
    description: z.string().trim().min(1).max(1024),
    source: skillSourceSchema,
    invocation: z.object({ user: z.boolean(), model: z.boolean() }).strict(),
    /** Frontmatter fields Weave does not support; they were ignored and never affect behavior. */
    ignoredFields: z.array(z.string().min(1).max(100)).max(32).optional(),
  })
  .strict()
  .refine((skill) => {
    if (!skill.id.endsWith(`:${skill.name}`) && !skill.id.endsWith(`/${skill.name}`)) return false;
    if (skill.source.kind === 'plugin')
      return skill.id === `plugin:${skill.source.pluginId}/${skill.name}`;
    return skill.id.startsWith(`${skill.source.kind}:`);
  }, 'Skill source, name and identity must agree');
export type SkillSummary = z.infer<typeof skillSummarySchema>;

export const skillIssueSchema = z
  .object({
    source: z.string().min(1).max(300),
    code: z.enum([
      'unreadable',
      'invalid-document',
      'unsafe-entry',
      'source-changed',
      'limit-exceeded',
    ]),
    skillId: idSchema.optional(),
    /** Frontmatter field that made the document invalid. */
    field: z.string().min(1).max(100).optional(),
  })
  .strict();
export type SkillIssue = z.infer<typeof skillIssueSchema>;

export const skillCatalogSchema = z
  .object({
    schemaVersion: z.literal(1),
    generation: z.number().int().positive().safe(),
    fingerprint: digestSchema,
    entries: z.array(skillSummarySchema).max(512),
    complete: z.boolean(),
    truncated: z.boolean(),
    issues: z.array(skillIssueSchema).max(64),
  })
  .strict()
  .refine((catalog) => !catalog.truncated || !catalog.complete, 'A clipped catalog is incomplete');
export type SkillCatalog = z.infer<typeof skillCatalogSchema>;

/** Resources are bundle-relative POSIX paths, never filesystem authorities. */
export const skillResourcePathSchema = z
  .string()
  .min(1)
  .max(1024)
  .refine(
    (path) =>
      !/[\\\0:]/.test(path) &&
      !path.startsWith('/') &&
      path.split('/').every((part) => part !== '' && part !== '.' && part !== '..'),
    'Expected a confined relative resource path',
  );

export const skillPageSchema = z
  .object({
    skill: skillRefSchema,
    kind: z.enum(['instructions', 'resource']),
    path: skillResourcePathSchema.optional(),
    contentSha256: digestSchema,
    text: z.string(),
    offset: z.number().int().nonnegative().safe(),
    eof: z.boolean(),
    nextCursor: z.string().min(1).max(256).optional(),
  })
  .strict()
  .refine(
    (page) => page.eof === (page.nextCursor === undefined),
    'Only nonfinal pages have a continuation',
  )
  .refine(
    (page) => (page.kind === 'resource') === (page.path !== undefined),
    'Resource pages carry a relative path',
  );
export type SkillPage = z.infer<typeof skillPageSchema>;

/** Original run settings for exact retry; image bytes remain in the linked message. */
export const turnRequestMetadataSchema = z
  .object({
    provider: z.string().min(1),
    model: z.string().min(1),
    temperature: z.number().finite().nonnegative().optional(),
    useProviderDefaults: z.boolean().optional(),
    maxTokens: z.number().finite().nonnegative().optional(),
    reasoningEffort: z.string().min(1).optional(),
    permissionMode: z.enum(['ask', 'trust', 'yolo']),
  })
  .strict();
export type TurnRequestMetadata = z.infer<typeof turnRequestMetadataSchema>;
