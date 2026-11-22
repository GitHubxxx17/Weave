import { z } from 'zod';

/** A literal project-relative POSIX path, without filesystem authority. */
export const fileReferenceSchema = z
  .object({
    path: z
      .string()
      .min(1)
      .max(1024)
      .refine(
        (path) =>
          path.length <= 1024 &&
          !/[\\:\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u.test(path) &&
          !path.startsWith('/') &&
          path.split('/').every((part) => part !== '' && part !== '.' && part !== '..'),
        'Expected a printable project-relative file path',
      ),
  })
  .strict();
export type FileReference = z.infer<typeof fileReferenceSchema>;

export const fileReferencesSchema = z
  .array(fileReferenceSchema)
  .min(1)
  .max(8)
  .readonly()
  .refine(
    (files) => new Set(files.map(({ path }) => path)).size === files.length,
    'File references must have unique paths',
  );

/** Safe metadata for an accepted file; content and object identities stay internal. */
export const fileAttachmentSummarySchema = fileReferenceSchema
  .extend({
    encoding: z.literal('utf-8'),
    byteLength: z.number().int().nonnegative().max(65_536),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();
export type FileAttachmentSummary = z.infer<typeof fileAttachmentSummarySchema>;
