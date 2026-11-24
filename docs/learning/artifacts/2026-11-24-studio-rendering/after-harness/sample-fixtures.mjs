import { z } from 'zod';
import { startPerformanceFixture } from './fixture.mjs';

export const runnerOptionsSchema = z.strictObject({
  counts: z
    .array(
      z.coerce
        .number()
        .int()
        .min(2)
        .max(5000)
        .refine((n) => n % 2 === 0),
    )
    .min(1)
    .max(3),
  variants: z
    .array(z.enum(['markdown', 'tools']))
    .min(1)
    .max(2),
  historyShapes: z
    .array(z.enum(['standard', 'mixed']))
    .min(1)
    .max(2)
    .default(['standard']),
  toolsPerTurn: z.coerce.number().int().min(1).max(500).default(1),
  streamVariants: z
    .array(z.enum(['text', 'tools']))
    .min(1)
    .max(2)
    .default(['text']),
  repeats: z.coerce.number().int().min(1).max(5),
  output: z.string().min(1).default('dist/performance/studio-baseline.json'),
});

/** Each browser sample must see a new Session, including repeated matrix cells. */
export async function* performanceSamples(input) {
  const options = runnerOptionsSchema.parse(input);
  for (const variant of options.variants)
    for (const count of options.counts)
      for (const historyShape of options.historyShapes)
        for (const streamVariant of options.streamVariants) {
          for (let repeat = 0; repeat < options.repeats; repeat++) {
            const fixture = await startPerformanceFixture({
              count,
              variant,
              streamVariant,
              historyShape,
              toolsPerTurn: options.toolsPerTurn,
            });
            try {
              yield {
                count,
                variant,
                streamVariant,
                historyShape,
                toolsPerTurn: options.toolsPerTurn,
                repeat,
                fixture,
              };
            } finally {
              await fixture.close();
            }
          }
        }
}
