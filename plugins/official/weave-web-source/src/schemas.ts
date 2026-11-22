import type { PluginSdk } from '@weave/plugin';

function boundedText(value: string, maxUnits: number, maxBytes: number): boolean {
  let wellFormed = true;
  try {
    encodeURIComponent(value);
  } catch {
    wellFormed = false;
  }
  return (
    value.length <= maxUnits &&
    Buffer.byteLength(value, 'utf8') <= maxBytes &&
    wellFormed &&
    [...value].every((point) => {
      const code = point.codePointAt(0)!;
      return code !== 127 && (code >= 32 || code === 9 || code === 10 || code === 13);
    })
  );
}

/** Refinements return booleans only; semantic WebToolErrors belong in callbacks. */
export function createWebSchemas(z: PluginSdk['z']) {
  return {
    search: z.strictObject({
      query: z
        .string()
        .trim()
        .min(1)
        .refine((value) => boundedText(value, 512, 2048)),
      maxResults: z.number().int().min(1).max(5).default(5),
    }),
    fetch: z.strictObject({
      url: z
        .string()
        .min(1)
        .refine((value) => boundedText(value, 2048, 4096)),
      maxChars: z.number().int().min(256).max(8000).default(6000),
    }),
  };
}
