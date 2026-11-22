import { createHash } from 'node:crypto';
import { fileAttachmentSummarySchema, type FileAttachmentSummary } from '@weave/protocol';
import { z } from 'zod';

const digestSchema = z.string().regex(/^[0-9a-f]{64}$/);

const capturedFileSchema = fileAttachmentSummarySchema
  .extend({ content: z.string().max(65_536), fileIdentity: digestSchema })
  .strict()
  .refine((file) => {
    if (file.content.includes('\0')) return false;
    const bytes = Buffer.from(file.content, 'utf8');
    return (
      bytes.length === file.byteLength &&
      new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes) === file.content &&
      createHash('sha256').update(bytes).digest('hex') === file.sha256
    );
  }, 'Captured file must preserve exact UTF-8 bytes, length and SHA-256');
export type CapturedFile = z.infer<typeof capturedFileSchema>;

/** The single durable copy of a batch captured before execution acceptance. */
export const capturedFileContextSchema = z
  .object({
    version: z.literal(1),
    projectId: z.string().min(1).max(240),
    rootIdentity: digestSchema,
    files: z.array(capturedFileSchema).min(1).max(8).readonly(),
  })
  .strict()
  .refine(
    ({ files }) =>
      files.reduce((total, file) => total + file.byteLength, 0) <= 262_144 &&
      new Set(files.map(({ path }) => path)).size === files.length &&
      new Set(files.map(({ fileIdentity }) => fileIdentity)).size === files.length,
    'Captured batch must fit the byte budget and contain unique paths and file identities',
  );
export type CapturedFileContext = z.infer<typeof capturedFileContextSchema>;

export function fileAttachmentSummaries(
  context: CapturedFileContext,
): readonly FileAttachmentSummary[] {
  return context.files.map(({ path, encoding, byteLength, sha256 }) => ({
    path,
    encoding,
    byteLength,
    sha256,
  }));
}
