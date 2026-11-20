import { describe, expect, it } from 'vitest';

import {
  commandArgumentsPlaceholder,
  pluginCommandSchema,
  type PluginCommand,
} from '../src/commands.js';
import { createPluginKernel, definePlugin, type KernelPlugin } from '../src/kernel.js';
import { type PluginManifest } from '../src/manifest.js';
import { PluginError } from '../src/plugin-errors.js';
import { commandsExtensionPoint } from '../src/seams.js';

const review: PluginCommand = {
  name: 'review',
  title: 'Review changes',
  description: 'Look for problems in the current changes',
  prompt: 'Review the following and list the problems you find:\n$ARGUMENTS',
};

describe('plugin command schema', () => {
  it('accepts a command and keeps it as written', () => {
    expect(pluginCommandSchema.parse(review)).toEqual(review);
  });

  it('does not need a description', () => {
    const bare = { name: review.name, title: review.title, prompt: review.prompt };

    expect(pluginCommandSchema.parse(bare)).toEqual(bare);
  });

  it('trims the title and the description, not the prompt', () => {
    const parsed = pluginCommandSchema.parse({
      ...review,
      title: '  Review changes  ',
      description: ' Look for problems ',
      prompt: '  keep my spacing\n',
    });

    expect(parsed.title).toBe('Review changes');
    expect(parsed.description).toBe('Look for problems');
    expect(parsed.prompt).toBe('  keep my spacing\n');
  });

  it.each([
    ['a name with a slash', { name: '/review' }],
    ['a name with uppercase letters', { name: 'Review' }],
    ['an empty name', { name: '' }],
    ['a blank title', { title: '   ' }],
    ['a title over 80 characters', { title: 'x'.repeat(81) }],
    ['a blank description', { description: ' ' }],
    ['a description over 300 characters', { description: 'x'.repeat(301) }],
    ['a blank prompt', { prompt: ' \n ' }],
    ['a prompt over 20000 characters', { prompt: 'x'.repeat(20_001) }],
    ['a field it does not know', { handler: () => undefined }],
  ])('rejects %s', (_label, over) => {
    expect(pluginCommandSchema.safeParse({ ...review, ...over }).success).toBe(false);
  });

  it('accepts the longest title, description and prompt', () => {
    expect(
      pluginCommandSchema.safeParse({
        ...review,
        title: 'x'.repeat(80),
        description: 'x'.repeat(300),
        prompt: 'x'.repeat(20_000),
      }).success,
    ).toBe(true);
  });

  it('marks the arguments with $ARGUMENTS', () => {
    expect(commandArgumentsPlaceholder).toBe('$ARGUMENTS');
  });
});

describe('weave.commands extension point', () => {
  const manifest = (id: string, over: Partial<PluginManifest> = {}): PluginManifest => ({
    id,
    name: id,
    version: '0.1.0',
    apiVersion: '1.0.0',
    capabilities: ['command'],
    ...over,
  });

  const contributing = (id: string, commands: unknown[], over: Partial<PluginManifest> = {}) =>
    definePlugin({
      manifest: manifest(id, over),
      setup(env) {
        env.contribute(commandsExtensionPoint, (api) => {
          for (const command of commands) {
            api.addCommand(command as PluginCommand);
          }
        });
      },
    });

  async function collect(...plugins: KernelPlugin[]) {
    const kernel = createPluginKernel();
    for (const plugin of plugins) {
      await kernel.register(plugin);
    }
    await kernel.seal();
    const commands: PluginCommand[] = [];
    kernel.extensions.collect(commandsExtensionPoint, {
      addCommand: (command) => commands.push(command),
    });
    return { kernel, commands };
  }

  function pluginError(action: () => unknown): PluginError {
    try {
      action();
    } catch (error: unknown) {
      if (error instanceof PluginError) {
        return error;
      }
      throw error;
    }
    throw new Error('Expected the action to throw a PluginError');
  }

  it('hands the owner every contributed command, in registration order', async () => {
    const { commands, kernel } = await collect(
      contributing('first', [review, { ...review, name: 'explain', title: 'Explain' }]),
      contributing('second', [{ ...review, name: 'summarize', title: 'Summarize' }]),
    );

    expect(commands.map((command) => command.name)).toEqual(['review', 'explain', 'summarize']);
    expect(kernel.plugins().map((info) => info.contributed.commands)).toEqual([
      ['review', 'explain'],
      ['summarize'],
    ]);
  });

  it('hands the owner the checked copy, which cannot be changed', async () => {
    const { commands } = await collect(contributing('first', [{ ...review, title: '  Padded  ' }]));

    expect(commands[0]?.title).toBe('Padded');
    expect(Object.isFrozen(commands[0])).toBe(true);
  });

  it('needs the command capability', async () => {
    const kernel = createPluginKernel();

    await expect(
      kernel.register(contributing('first', [review], { capabilities: ['tool'] })),
    ).rejects.toMatchObject({ code: 'plugin-capability-not-declared' });
  });

  it('rejects a command the plugin did not list in contributes', async () => {
    const kernel = createPluginKernel();
    await kernel.register(
      contributing('first', [review, { ...review, name: 'explain' }], {
        contributes: { commands: ['review'] },
      }),
    );
    await kernel.seal();
    const commands: PluginCommand[] = [];

    expect(
      pluginError(() =>
        kernel.extensions.collect(commandsExtensionPoint, {
          addCommand: (command) => commands.push(command),
        }),
      ),
    ).toMatchObject({ code: 'plugin-contributes-exceeds-manifest' });
    expect(commands.map((command) => command.name)).toEqual(['review']);
  });

  it('rejects an invalid command, naming the plugin and the field', async () => {
    const kernel = createPluginKernel();
    await kernel.register(contributing('first', [{ ...review, name: 'Bad Name' }]));
    await kernel.seal();

    const error = pluginError(() =>
      kernel.extensions.collect(commandsExtensionPoint, { addCommand: () => undefined }),
    );

    expect(error.code).toBe('plugin-invalid-definition');
    expect(error.message).toContain('Plugin "first"');
    expect(error.message).toContain('name:');
    expect(kernel.plugins()[0]?.contributed.commands).toEqual([]);
  });

  it('rejects something that is not a command at all', async () => {
    const kernel = createPluginKernel();
    await kernel.register(contributing('first', [undefined]));
    await kernel.seal();

    expect(
      pluginError(() =>
        kernel.extensions.collect(commandsExtensionPoint, { addCommand: () => undefined }),
      ),
    ).toMatchObject({ code: 'plugin-invalid-definition' });
  });
});
