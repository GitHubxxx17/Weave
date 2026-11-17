import { z } from 'zod';

const nonEmptyStringSchema = z.string().trim().min(1);

export const providerSettingsRecordSchema = z
  .object({
    id: nonEmptyStringSchema,
    label: nonEmptyStringSchema,
    type: z.literal('openai-compatible'),
    baseUrl: z.string().url(),
    encryptedApiKey: z.string().min(1).nullable(),
    defaultModel: nonEmptyStringSchema,
    createdAt: nonEmptyStringSchema,
    updatedAt: nonEmptyStringSchema,
  })
  .strict();

export type ProviderSettingsRecord = z.infer<typeof providerSettingsRecordSchema>;

export const createProviderSettingsInputSchema = z
  .object({
    id: nonEmptyStringSchema,
    label: nonEmptyStringSchema,
    type: z.literal('openai-compatible'),
    baseUrl: z.string().url(),
    apiKey: nonEmptyStringSchema,
    defaultModel: nonEmptyStringSchema,
    makeDefault: z.boolean().default(false),
  })
  .strict();

export type CreateProviderSettingsInput = z.infer<typeof createProviderSettingsInputSchema>;

export const updateProviderSettingsInputSchema = z
  .object({
    label: nonEmptyStringSchema.optional(),
    baseUrl: z.string().url().optional(),
    apiKey: z.string().optional(),
    clearApiKey: z.boolean().optional(),
    defaultModel: nonEmptyStringSchema.optional(),
    makeDefault: z.boolean().optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.clearApiKey === true && value.apiKey !== undefined && value.apiKey.trim() !== '') {
      context.addIssue({
        code: 'custom',
        path: ['apiKey'],
        message: 'apiKey and clearApiKey cannot be used together',
      });
    }
  });

export type UpdateProviderSettingsInput = z.infer<typeof updateProviderSettingsInputSchema>;

export const providerSettingsDescriptorSchema = z
  .object({
    id: nonEmptyStringSchema,
    label: nonEmptyStringSchema,
    type: z.enum(['mock', 'openai-compatible']),
    defaultModel: nonEmptyStringSchema.optional(),
    baseUrl: z.string().url().optional(),
    hasApiKey: z.boolean(),
    editable: z.boolean(),
  })
  .strict();

export type ProviderSettingsDescriptor = z.infer<typeof providerSettingsDescriptorSchema>;
