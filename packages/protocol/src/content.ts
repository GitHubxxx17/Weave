import { z } from 'zod';

/**
 * A content fragment carried by a model message.
 *
 * Keeping text and reasoning as separate parts lets the UI decide whether to
 * render reasoning, collapse it, or omit it without changing message shape.
 */
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

/**
 * Validates content fragments crossing a package or provider boundary.
 */
export const contentPartSchema = z.discriminatedUnion('type', [
  textContentPartSchema,
  reasoningContentPartSchema,
]);
