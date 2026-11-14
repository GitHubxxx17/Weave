import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

const packageLayers = new Map([
  ['packages/protocol', []],
  ['packages/llm', ['@weave/protocol']],
  ['packages/runtime', ['@weave/protocol', '@weave/llm']],
  ['apps/server', ['@weave/protocol', '@weave/llm', '@weave/runtime']],
]);

const weaveBoundaryPlugin = {
  rules: {
    'no-cross-layer-internal-imports': {
      meta: {
        type: 'problem',
        docs: {
          description: 'Keep internal package imports aligned with the Weave dependency direction.',
        },
        schema: [],
        messages: {
          forbidden: 'This package cannot import {{specifier}}.',
        },
      },
      create(context) {
        const packagePath = context.filename.split('/').slice(-3, -1).join('/');
        const allowedImports = packageLayers.get(packagePath);

        if (!allowedImports) {
          return {};
        }

        return {
          ImportDeclaration(node) {
            const specifier = node.source.value;
            if (
              typeof specifier === 'string' &&
              specifier.startsWith('@weave/') &&
              !allowedImports.includes(specifier)
            ) {
              context.report({
                node,
                messageId: 'forbidden',
                data: { specifier },
              });
            }
          },
        };
      },
    },
  },
};

export default tseslint.config(
  {
    ignores: ['node_modules/**', 'dist/**', 'coverage/**'],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    plugins: {
      weave: weaveBoundaryPlugin,
    },
    rules: {
      // This boundary rule is intentionally local so package constraints can grow with the architecture.
      'weave/no-cross-layer-internal-imports': 'error',
    },
  },
);
