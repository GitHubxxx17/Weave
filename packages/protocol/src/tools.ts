import { z } from 'zod';

/**
 * A complete tool invocation produced by a model response.
 *
 * Arguments remain a string at this boundary because providers stream JSON
 * arguments incrementally. The Tool Pipeline is responsible for parsing and
 * validating them only after the complete call has been assembled.
 */
export interface ToolCall {
  /** Provider or Runtime identifier for correlating deltas and results. */
  readonly id: string;
  /** Registered tool name selected by the model. */
  readonly name: string;
  /** Serialized arguments, usually JSON text. */
  readonly arguments: string;
}

/** Validates a complete model-produced tool invocation. */
export const toolCallSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    arguments: z.string(),
  })
  .passthrough();

/**
 * Model-visible description of a tool that may be called.
 *
 * `parameters` is intentionally provider-neutral JSON Schema data. The
 * Tool Registry owns the executable implementation and security policy.
 */
export interface ToolDefinition {
  /** Stable name used in model requests and tool calls. */
  readonly name: string;
  /** Human- and model-readable description of the tool. */
  readonly description: string;
  /** JSON Schema-like parameter definition exposed to the model. */
  readonly parameters: unknown;
}

/** Validates the model-facing shape of a tool definition. */
export const toolDefinitionSchema = z
  .object({
    name: z.string(),
    description: z.string(),
    parameters: z.unknown(),
  })
  .passthrough();
