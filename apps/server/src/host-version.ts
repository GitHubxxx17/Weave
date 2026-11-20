import { readFileSync } from 'node:fs';
import { z } from 'zod';

const packageSchema = z.object({ version: z.string().regex(/^\d+\.\d+\.\d+$/) });
const metadata: unknown = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
);

/** Product compatibility version shared by plugin discovery and kernel assembly. */
export const serverHostVersion: string = packageSchema.parse(metadata).version;
