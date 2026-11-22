import type { PluginFactory } from '@weave/plugin';

export default ((sdk) => ({
  setup(env) {
    env.contribute(sdk.toolsExtensionPoint, (api) => {
      api.addTool({
        name: 'hello-tool',
        description: 'Return the supplied text for an authoring workflow check.',
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
          return { text: input.text };
        },
      });
    });
  },
})) satisfies PluginFactory;
