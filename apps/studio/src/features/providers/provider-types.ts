import { z } from 'zod';

const nonEmptyStringSchema = z.string().trim().min(1);

const providerTypeSchema = z.enum(['mock', 'openai-compatible']);

/** Public Provider metadata returned by the local Server. */
export const providerDescriptorSchema = z
  .object({
    id: nonEmptyStringSchema,
    label: nonEmptyStringSchema,
    type: providerTypeSchema,
    defaultModel: nonEmptyStringSchema.optional(),
  })
  .strict();

/** Response returned by `GET /settings/providers`. */
export const providerSettingsSchema = z
  .object({
    providers: z.array(providerDescriptorSchema),
    defaultProvider: nonEmptyStringSchema,
  })
  .strict();

export type ProviderDescriptor = z.infer<typeof providerDescriptorSchema>;
export type ProviderSettings = z.infer<typeof providerSettingsSchema>;
