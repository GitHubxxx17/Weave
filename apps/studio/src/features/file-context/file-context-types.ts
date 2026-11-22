import { z } from 'zod';

/** Logical paths only: the Server captures bytes at acceptance. */
export const filePathSchema = z
  .string()
  .min(1)
  .max(1024)
  .refine(
    (path) =>
      path.length <= 1024 &&
      !/[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}\\:]/u.test(path) &&
      !path.startsWith('/') &&
      path.split('/').every((part) => part !== '' && part !== '.' && part !== '..'),
  );
export const fileReferenceSchema = z.strictObject({ path: filePathSchema });
export const fileReferencesSchema = z
  .array(fileReferenceSchema)
  .min(1)
  .max(8)
  .readonly()
  .refine((files) => new Set(files.map(({ path }) => path)).size === files.length);
export const fileAttachmentSummarySchema = z.strictObject({
  path: filePathSchema,
  encoding: z.literal('utf-8'),
  byteLength: z.number().int().nonnegative().max(65536),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
});
export const fileAttachmentSummariesSchema = z
  .array(fileAttachmentSummarySchema)
  .min(1)
  .max(8)
  .readonly()
  .refine((files) => new Set(files.map(({ path }) => path)).size === files.length);
export type FileReference = z.infer<typeof fileReferenceSchema>;
export type FileAttachmentSummary = z.infer<typeof fileAttachmentSummarySchema>;
