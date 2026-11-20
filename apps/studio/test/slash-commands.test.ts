import { describe, expect, it } from 'vitest';

import type { SlashCommand } from '../src/features/commands/command-types.js';
import {
  argumentsPlaceholder,
  expandCommand,
  expandSlashCommand,
  insertCommand,
  matchCommands,
  maxPickerCommands,
  slashQuery,
} from '../src/features/commands/slash-commands.js';

function command(name: string, over: Partial<SlashCommand> = {}): SlashCommand {
  return {
    name,
    title: `Title of ${name}`,
    prompt: `Do ${name}: $ARGUMENTS`,
    pluginId: 'kit',
    ...over,
  };
}

describe('slashQuery', () => {
  it.each([
    ['/', ''],
    ['/rev', 'rev'],
    ['/fix-tests', 'fix-tests'],
  ])('reads what follows the slash in %j', (draft, expected) => {
    expect(slashQuery(draft)).toBe(expected);
  });

  it.each(['', 'review', ' /review', '/review now', '/review\nnow', '/review ', 'a /review'])(
    'is not a command being typed: %j',
    (draft) => {
      expect(slashQuery(draft)).toBeUndefined();
    },
  );
});

describe('matchCommands', () => {
  const commands = [
    command('review', { title: 'Check the changes' }),
    command('explain', { title: 'Explain the code' }),
    command('fix-review', { title: 'Fix review comments' }),
    command('summarize', { title: 'Summarize a review' }),
  ];

  it('lists every command for an empty query', () => {
    expect(matchCommands(commands, '').map((entry) => entry.name)).toEqual([
      'review',
      'explain',
      'fix-review',
      'summarize',
    ]);
  });

  it('puts names that start with the query ahead of the ones that only contain it', () => {
    expect(matchCommands(commands, 'rev').map((entry) => entry.name)).toEqual([
      'review',
      'fix-review',
      'summarize',
    ]);
  });

  it('matches titles too, ignoring case', () => {
    expect(matchCommands(commands, 'EXPLAIN T').map((entry) => entry.name)).toEqual(['explain']);
    expect(matchCommands(commands, 'the code').map((entry) => entry.name)).toEqual(['explain']);
  });

  it('lists nothing when nothing fits', () => {
    expect(matchCommands(commands, 'zzz')).toEqual([]);
  });

  it('lists at most as many as the picker shows', () => {
    const many = Array.from({ length: maxPickerCommands + 5 }, (_, index) =>
      command(`cmd-${String(index)}`),
    );

    expect(matchCommands(many, '')).toHaveLength(maxPickerCommands);
  });
});

describe('insertCommand', () => {
  it('removes the arguments marker and puts the caret where it was', () => {
    expect(insertCommand(command('review', { prompt: 'Review this:\n$ARGUMENTS' }))).toEqual({
      text: 'Review this:\n',
      caret: 'Review this:\n'.length,
    });
    expect(insertCommand(command('review', { prompt: 'Review $ARGUMENTS for bugs' }))).toEqual({
      text: 'Review  for bugs',
      caret: 'Review '.length,
    });
  });

  it('puts the caret at the end when the prompt has no marker', () => {
    expect(insertCommand(command('review', { prompt: 'Review the changes' }))).toEqual({
      text: 'Review the changes',
      caret: 'Review the changes'.length,
    });
  });

  it('removes every marker and puts the caret at the first', () => {
    expect(insertCommand(command('twice', { prompt: 'A $ARGUMENTS B $ARGUMENTS' }))).toEqual({
      text: 'A  B ',
      caret: 'A '.length,
    });
  });
});

describe('expandCommand', () => {
  it('puts the arguments where the marker is', () => {
    expect(expandCommand(command('review', { prompt: 'Review $ARGUMENTS now' }), 'a.ts')).toBe(
      'Review a.ts now',
    );
  });

  it('fills every marker', () => {
    expect(expandCommand(command('twice', { prompt: '$ARGUMENTS and $ARGUMENTS' }), 'x')).toBe(
      'x and x',
    );
  });

  it('puts the arguments after a blank line when the prompt has no marker', () => {
    expect(expandCommand(command('review', { prompt: 'Review the changes' }), ' a.ts ')).toBe(
      'Review the changes\n\na.ts',
    );
    expect(expandCommand(command('review', { prompt: 'Review the changes' }), '  ')).toBe(
      'Review the changes',
    );
  });

  it('keeps arguments that look like replacement patterns literal', () => {
    expect(expandCommand(command('review', { prompt: 'Run: $ARGUMENTS' }), "$& $1 $' $$")).toBe(
      "Run: $& $1 $' $$",
    );
  });

  it('uses the marker the Server documents', () => {
    expect(argumentsPlaceholder).toBe('$ARGUMENTS');
  });
});

describe('expandSlashCommand', () => {
  const commands = [
    command('recap', { prompt: 'Recap so far:\n$ARGUMENTS' }),
    command('review', { prompt: 'Review the changes' }),
  ];

  it('expands a command followed by arguments', () => {
    expect(expandSlashCommand('/recap the login page', commands)).toBe(
      'Recap so far:\nthe login page',
    );
  });

  it('expands a bare command and trims what is left', () => {
    expect(expandSlashCommand('/recap', commands)).toBe('Recap so far:');
    expect(expandSlashCommand('  /review  ', commands)).toBe('Review the changes');
  });

  it('keeps multi-line arguments', () => {
    expect(expandSlashCommand('/recap line one\nline two', commands)).toBe(
      'Recap so far:\nline one\nline two',
    );
  });

  it('returns a draft that is not a known command as it is', () => {
    expect(expandSlashCommand('/unknown thing', commands)).toBe('/unknown thing');
    expect(expandSlashCommand('hello /recap', commands)).toBe('hello /recap');
    expect(expandSlashCommand('/recapx', commands)).toBe('/recapx');
    expect(expandSlashCommand('', commands)).toBe('');
    expect(expandSlashCommand('/', commands)).toBe('/');
  });

  it('returns every draft as it is when no command is known', () => {
    expect(expandSlashCommand('/recap now', [])).toBe('/recap now');
  });
});
