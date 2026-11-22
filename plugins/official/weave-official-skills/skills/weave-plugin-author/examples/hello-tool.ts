import type { PluginFactory } from '@weave/plugin';

export default ((sdk) => ({
  setup(env) {
    env.contribute(sdk.toolsExtensionPoint, (api) => {
      api.addTool({
        name: 'hello-tool',
        description: 'Return the supplied text without accessing external state.',
        parameters: {
          type: 'object',
          properties: { text: { type: 'string' } },
          required: ['text'],
          additionalProperties: false,
        },
        inputSchema: sdk.z.strictObject({ text: sdk.z.string() }),
        readOnly: true,
        execute(input, context) {
          context.signal.throwIfAborted();
          return input.text;
        },
      });
    });
  },
})) satisfies PluginFactory;
