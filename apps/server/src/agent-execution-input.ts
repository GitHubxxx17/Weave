import type { LlmProviderDescriptor } from '@weave/llm';
import { agentExecutionInputSchema, type AgentExecutionInput } from '@weave/runtime';

/** Snapshot public request defaults only; provider clients and credentials stay private. */
export function freezeExecutionInput(
  input: AgentExecutionInput,
  descriptor: LlmProviderDescriptor | undefined,
): AgentExecutionInput {
  const temperature =
    input.temperature ??
    (input.useProviderDefaults === false ? undefined : descriptor?.temperature);
  const maxTokens =
    input.maxTokens ?? (input.useProviderDefaults === false ? undefined : descriptor?.maxTokens);
  return agentExecutionInputSchema.parse(
    structuredClone({
      ...input,
      useProviderDefaults: false,
      ...(temperature === undefined ? {} : { temperature }),
      ...(maxTokens === undefined ? {} : { maxTokens }),
    }),
  );
}
