import { z } from 'zod';
import { runtimeApiUrl } from '../runtime/runtime-bridge.js';

const availabilitySchema = z.strictObject({
  gitChanges: z.strictObject({
    available: z.boolean(),
    reason: z.literal('git-unavailable').optional(),
  }),
  projectTree: z.strictObject({ available: z.literal(true) }),
});
export type ContextAvailability = z.infer<typeof availabilitySchema>;

/**
 * Asks the Server which composer contexts a project can supply. "Git changes"
 * needs a Git repository with at least one commit; the Server runs the check.
 */
export async function fetchContextAvailability(
  projectId: string,
  options?: { readonly signal?: AbortSignal },
): Promise<ContextAvailability> {
  const response = await fetch(
    runtimeApiUrl(`/projects/${encodeURIComponent(projectId)}/context-availability`),
    { method: 'GET', ...(options?.signal === undefined ? {} : { signal: options.signal }) },
  );
  if (!response.ok) throw new Error(`context availability ${response.status}`);
  return availabilitySchema.parse(await response.json());
}
