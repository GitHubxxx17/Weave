import { z } from 'zod';

export type ContentPart =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'reasoning'; readonly text: string };

const textContentPartSchema = z
  .object({
    type: z.literal('text'),
    text: z.string(),
  })
  .passthrough();

const reasoningContentPartSchema = z
  .object({
    type: z.literal('reasoning'),
    text: z.string(),
  })
  .passthrough();

export const contentPartSchema = z.discriminatedUnion('type', [
  textContentPartSchema,
  reasoningContentPartSchema,
]);
