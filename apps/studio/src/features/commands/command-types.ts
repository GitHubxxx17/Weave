import { z } from 'zod';

/**
 * One slash command as `GET /commands` lists it. Studio does not share types
 * with the Server, so this mirrors the contract in the plugin kernel design
 * (section 19).
 */
export const commandSchema = z.object({
  /** What the user types after the slash. */
  name: z.string(),
  title: z.string(),
  description: z.string().optional(),
  /** The prompt template; `$ARGUMENTS` marks where the user's arguments go. */
  prompt: z.string(),
  /** The plugin that contributed the command. */
  pluginId: z.string(),
});

export type SlashCommand = z.infer<typeof commandSchema>;

export const commandListSchema = z.object({ commands: z.array(commandSchema) });
