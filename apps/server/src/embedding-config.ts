import { createOpenAiEmbeddingClient, type EmbeddingClient } from '@weave/llm';
import { z } from 'zod';

const providerSchema = z.literal('openai');
const credentialSchema = z.string().regex(/^[\x21-\x7E]{1,512}$/);

export function createServerEmbeddingClient(
  environment: NodeJS.ProcessEnv,
  fetch?: typeof globalThis.fetch,
): EmbeddingClient | undefined {
  const provider = environment.WEAVE_EMBEDDING_PROVIDER;
  const credential = environment.WEAVE_OPENAI_EMBEDDING_API_KEY;
  if (provider !== undefined && !providerSchema.safeParse(provider).success)
    throw new Error('WEAVE_EMBEDDING_PROVIDER must be openai');
  if (credential !== undefined && !credentialSchema.safeParse(credential).success)
    throw new Error(
      'WEAVE_OPENAI_EMBEDDING_API_KEY must be 1 to 512 printable ASCII characters without whitespace',
    );
  if (provider === undefined || credential === undefined) return undefined;
  return createOpenAiEmbeddingClient({
    apiKey: credential,
    ...(fetch === undefined ? {} : { fetch }),
  });
}
