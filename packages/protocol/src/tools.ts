import { z } from 'zod';

export interface ToolCall {
  readonly id: string;
  readonly name: string;
  readonly arguments: string;
}

export const toolCallSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    arguments: z.string(),
  })
  .passthrough();

export interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly parameters: unknown;
}

export const toolDefinitionSchema = z
  .object({
    name: z.string(),
    description: z.string(),
    parameters: z.unknown(),
  })
  .passthrough();
