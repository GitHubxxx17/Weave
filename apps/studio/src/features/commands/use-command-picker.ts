import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type RefObject,
} from 'react';

import { fetchCommands } from './command-api.js';
import type { SlashCommand } from './command-types.js';
import { expandSlashCommand, insertCommand, matchCommands, slashQuery } from './slash-commands.js';

export interface CommandPickerOptions {
  /** The composer's draft. */
  readonly draft: string;
  readonly setDraft: (draft: string) => void;
  readonly inputRef: RefObject<HTMLTextAreaElement | null>;
}

/** The slash-command picker over the composer's draft. */
export interface CommandPicker {
  /** Whether the picker is showing. */
  readonly open: boolean;
  /** The commands that fit what was typed after the slash. */
  readonly items: readonly SlashCommand[];
  readonly activeIndex: number;
  setActiveIndex(index: number): void;
  /** Puts a command into the composer. */
  select(command: SlashCommand): void;
  /** Handles a key while the picker is open; returns whether it took the key. */
  handleKeyDown(event: ReactKeyboardEvent<HTMLTextAreaElement>): boolean;
  /** The text to send for a draft: a known `/command arguments` is expanded. */
  expand(draft: string): string;
}

/**
 * Drives the slash-command picker. The command list is requested whenever the
 * draft starts with `/` after not doing so, so it is current each time the user
 * opens the picker, and a failed request keeps the last list.
 */
export function useCommandPicker(options: CommandPickerOptions): CommandPicker {
  const { draft, setDraft, inputRef } = options;
  const [commands, setCommands] = useState<readonly SlashCommand[]>([]);
  const [activeIndex, setActiveIndex] = useState(0);
  const [dismissedDraft, setDismissedDraft] = useState<string | null>(null);
  const [caretRequest, setCaretRequest] = useState<{ readonly caret: number } | null>(null);

  const query = slashQuery(draft);
  const startsWithSlash = draft.startsWith('/');

  useEffect(() => {
    if (!startsWithSlash) {
      return undefined;
    }
    const controller = new AbortController();
    fetchCommands(controller.signal).then(
      (loaded) => {
        if (!controller.signal.aborted) {
          setCommands(loaded);
        }
      },
      () => undefined,
    );
    return () => controller.abort();
  }, [startsWithSlash]);

  useEffect(() => {
    setActiveIndex(0);
  }, [query]);

  useLayoutEffect(() => {
    if (caretRequest === null) {
      return;
    }
    const input = inputRef.current;
    input?.focus();
    input?.setSelectionRange(caretRequest.caret, caretRequest.caret);
  }, [caretRequest, inputRef]);

  const items = useMemo(
    () => (query === undefined ? [] : matchCommands(commands, query)),
    [commands, query],
  );
  const open = items.length > 0 && dismissedDraft !== draft;
  const active = Math.min(activeIndex, Math.max(items.length - 1, 0));

  function select(command: SlashCommand): void {
    const { text, caret } = insertCommand(command);
    setDismissedDraft(text);
    setDraft(text);
    setCaretRequest({ caret });
  }

  function handleKeyDown(event: ReactKeyboardEvent<HTMLTextAreaElement>): boolean {
    if (!open || event.nativeEvent.isComposing) {
      return false;
    }
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        setActiveIndex((active + 1) % items.length);
        return true;
      case 'ArrowUp':
        event.preventDefault();
        setActiveIndex((active - 1 + items.length) % items.length);
        return true;
      case 'Tab':
      case 'Enter': {
        if (event.shiftKey) {
          return false;
        }
        const command = items[active];
        if (command === undefined) {
          return false;
        }
        event.preventDefault();
        select(command);
        return true;
      }
      case 'Escape':
        event.preventDefault();
        setDismissedDraft(draft);
        return true;
      default:
        return false;
    }
  }

  return {
    open,
    items,
    activeIndex: active,
    setActiveIndex,
    select,
    handleKeyDown,
    expand: (text) => expandSlashCommand(text, commands),
  };
}
