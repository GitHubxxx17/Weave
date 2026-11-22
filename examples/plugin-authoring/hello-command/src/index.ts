import type { PluginFactory } from '@weave/plugin';

export default ((sdk) => ({
  setup(env) {
    env.contribute(sdk.commandsExtensionPoint, (api) => {
      api.addCommand({
        name: 'hello-command',
        title: 'Review a change',
        description: 'Prepare a request to review a coding change.',
        prompt:
          'Review the following change for concrete defects. Explain the trigger and effect of each finding.\n\n$ARGUMENTS',
      });
    });
  },
})) satisfies PluginFactory;
