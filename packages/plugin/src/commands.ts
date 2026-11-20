import { z } from 'zod';

/**
 * Slash commands a plugin contributes. A command is declarative: a prompt
 * template the user can drop into the composer. It runs no plugin code, so
 * what Studio shows and sends is exactly the text the plugin declared.
 */

/** Marks where, in a command's `prompt`, what the user typed after the command goes. */
export const commandArgumentsPlaceholder = '$ARGUMENTS';

/** Matches a command name, what the user types after the slash. */
export const commandNamePattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** One command a plugin contributes to `weave.commands`. */
export interface PluginCommand {
  /** What the user types after the slash: lowercase and hyphen-separated, unique in the Server. */
  readonly name: string;
  /** The name shown in the picker, 1 to 80 characters. */
  readonly title: string;
  /** One line about what the command does, up to 300 characters. */
  readonly description?: string | undefined;
  /**
   * The text the command stands for, up to 20000 characters. Every
   * {@link commandArgumentsPlaceholder} is replaced by what the user typed after
   * the command; without one, that text follows the prompt after a blank line.
   */
  readonly prompt: string;
}

/** Validates a command as a plugin contributes it. */
export const pluginCommandSchema: z.ZodType<PluginCommand> = z
  .object({
    name: z.string().regex(commandNamePattern, {
      message: 'Command names are lowercase letters and digits separated by single hyphens',
    }),
    title: z.string().trim().min(1).max(80),
    description: z.string().trim().min(1).max(300).optional(),
    prompt: z
      .string()
      .max(20_000)
      .refine((value) => value.trim() !== '', { message: 'A command prompt must not be blank' }),
  })
  .strict();
