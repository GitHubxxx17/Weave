import type { PluginFactory } from '@weave/plugin';

export default ((sdk) => ({
  setup(env) {
    env.contribute(sdk.commandsExtensionPoint, (api) => {
      api.addCommand({
        name: 'hello-command',
        title: 'Review a change',
        description: 'Prepare a concrete review request.',
        prompt: 'Review the following change for concrete correctness issues:\n\n$ARGUMENTS',
      });
    });
  },
})) satisfies PluginFactory;
