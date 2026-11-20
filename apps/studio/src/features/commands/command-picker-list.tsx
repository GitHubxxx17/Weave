import type { ReactElement } from 'react';

import type { SlashCommand } from './command-types.js';

/** The id of the list, for the composer's `aria-controls`. */
export const commandPickerListId = 'command-picker-list';

/** The id of one option, for the composer's `aria-activedescendant`. */
export function commandOptionId(name: string): string {
  return `command-option-${name}`;
}

export interface CommandPickerListProps {
  readonly commands: readonly SlashCommand[];
  readonly activeIndex: number;
  readonly onSelect: (command: SlashCommand) => void;
  readonly onHover: (index: number) => void;
}

/**
 * The slash commands that fit the draft. Options take the mouse press instead of
 * the click so the composer keeps its focus and caret while one is chosen.
 */
export function CommandPickerList({
  commands,
  activeIndex,
  onSelect,
  onHover,
}: CommandPickerListProps): ReactElement {
  return (
    <ul className="command-picker" id={commandPickerListId} role="listbox" aria-label="斜杠命令">
      {commands.map((command, index) => (
        <li
          key={command.name}
          id={commandOptionId(command.name)}
          role="option"
          aria-selected={index === activeIndex}
          className={`command-option${index === activeIndex ? ' command-option-active' : ''}`}
          onMouseDown={(event) => {
            event.preventDefault();
            onSelect(command);
          }}
          onMouseEnter={() => onHover(index)}
        >
          <span className="command-name">/{command.name}</span>
          <span className="command-title">{command.title}</span>
          {command.description === undefined ? null : (
            <span className="command-description">{command.description}</span>
          )}
        </li>
      ))}
    </ul>
  );
}
