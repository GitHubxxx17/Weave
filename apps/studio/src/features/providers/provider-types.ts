import { z } from 'zod';

const nonEmptyStringSchema = z.string().trim().min(1);

const providerTypeSchema = z.enum(['mock', 'openai-compatible']);

/** Public Provider metadata returned by the local Server. */
export const providerDescriptorSchema = z
  .object({
    id: nonEmptyStringSchema,
    label: nonEmptyStringSchema,
    type: providerTypeSchema,
    baseUrl: z.string().url().optional(),
    defaultModel: nonEmptyStringSchema.optional(),
    hasApiKey: z.boolean(),
    editable: z.boolean(),
  })
  .strict();

/** Response returned by `GET /settings/providers`. */
export const providerSettingsSchema = z
  .object({
    providers: z.array(providerDescriptorSchema),
    defaultProvider: nonEmptyStringSchema,
    canManage: z.boolean(),
  })
  .strict();

export type ProviderDescriptor = z.infer<typeof providerDescriptorSchema>;
export type ProviderSettings = z.infer<typeof providerSettingsSchema>;

export interface ProviderSettingsInput {
  readonly id: string;
  readonly label: string;
  readonly type: 'openai-compatible';
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly defaultModel: string;
  readonly makeDefault: boolean;
}

export interface ProviderSettingsPatch {
  readonly label?: string;
  readonly baseUrl?: string;
  readonly apiKey?: string;
  readonly clearApiKey?: boolean;
  readonly defaultModel?: string;
  readonly makeDefault?: boolean;
}
