import type { SlashCommand } from './command-types.js';

/**
 * Slash commands are prompt templates plugins declare. These functions turn a
 * draft and a command into the text that is shown and sent; they run no plugin
 * code, so what the user sees in the composer is what goes to the model.
 */

/** Marks where, in a command's prompt, what the user typed after the command goes. */
export const argumentsPlaceholder = '$ARGUMENTS';

/** The most commands the picker lists at once. */
export const maxPickerCommands = 8;

/**
 * What the user has typed after the slash while still choosing a command, or
 * `undefined` once the draft is not a command being typed: it must start with
 * `/` and contain no whitespace yet.
 */
export function slashQuery(draft: string): string | undefined {
  return /^\/(\S*)$/.exec(draft)?.[1];
}

/**
 * The commands that fit what was typed, best first: names that start with it,
 * then names or titles that contain it. An empty query lists every command.
 */
export function matchCommands(
  commands: readonly SlashCommand[],
  query: string,
): readonly SlashCommand[] {
  const needle = query.toLowerCase();
  const starts = commands.filter((command) => command.name.startsWith(needle));
  const contains = commands.filter(
    (command) =>
      !command.name.startsWith(needle) &&
      (command.name.includes(needle) || command.title.toLowerCase().includes(needle)),
  );
  return [...starts, ...contains].slice(0, maxPickerCommands);
}

/**
 * Puts a command into the composer: its prompt with the arguments marker
 * removed, and the caret where the arguments belong.
 */
export function insertCommand(command: SlashCommand): { text: string; caret: number } {
  const index = command.prompt.indexOf(argumentsPlaceholder);
  const text = command.prompt.split(argumentsPlaceholder).join('');
  return { text, caret: index === -1 ? text.length : index };
}

/**
 * A command's prompt with `args` in place of the arguments marker. A prompt
 * without a marker takes the arguments after a blank line. The arguments are
 * placed as written, not interpreted: `$&` and the like stay literal.
 */
export function expandCommand(command: SlashCommand, args: string): string {
  const trimmed = args.trim();
  if (command.prompt.includes(argumentsPlaceholder)) {
    return command.prompt.split(argumentsPlaceholder).join(trimmed);
  }
  return trimmed === '' ? command.prompt : `${command.prompt}\n\n${trimmed}`;
}

/**
 * Expands a draft that invokes a known command (`/name`, optionally followed by
 * whitespace and arguments) into the text to send. Any other draft, including a
 * `/name` nobody contributed, is returned as it is.
 */
export function expandSlashCommand(draft: string, commands: readonly SlashCommand[]): string {
  const match = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(draft.trim());
  if (match === null) {
    return draft;
  }
  const command = commands.find((candidate) => candidate.name === match[1]);
  return command === undefined ? draft : expandCommand(command, match[2] ?? '').trim();
}
