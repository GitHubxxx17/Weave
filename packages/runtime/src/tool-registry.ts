import {
  type RegisteredToolDefinition,
  toolDefinitionSchema,
  type ToolDefinition,
} from './tool-types.js';

/** Public lookup and registration boundary for Runtime tools. */
export interface ToolRegistry {
  /**
   * Registers one executable tool under its stable model-facing name.
   *
   * @throws {TypeError} When the definition is invalid.
   * @throws {Error} When another tool already uses the name.
   */
  register<TInput, TOutput>(tool: ToolDefinition<TInput, TOutput>): void;
  /** Finds a registered tool by name. */
  get(name: string): RegisteredToolDefinition | undefined;
  /** Returns a frozen snapshot in registration order. */
  list(): readonly RegisteredToolDefinition[];
}

/** Creates an empty Tool Registry. */
export function createToolRegistry(): ToolRegistry {
  const tools = new Map<string, RegisteredToolDefinition>();

  return {
    register<TInput, TOutput>(tool: ToolDefinition<TInput, TOutput>): void {
      const parsed = toolDefinitionSchema.safeParse(tool);
      if (!parsed.success) {
        throw new TypeError('Invalid tool definition');
      }
      if (tools.has(tool.name)) {
        throw new Error(`Tool "${tool.name}" is already registered`);
      }
      tools.set(tool.name, tool as unknown as RegisteredToolDefinition);
    },

    get(name: string): RegisteredToolDefinition | undefined {
      return tools.get(name);
    },

    list(): readonly RegisteredToolDefinition[] {
      return Object.freeze([...tools.values()]);
    },
  };
}
