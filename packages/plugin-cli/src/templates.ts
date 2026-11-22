import { pluginApiVersion, type PluginManifest } from '@weave/plugin';
import { parseDescriptor } from '@weave/plugin-host';

import type { PluginTemplate, ResolvedPluginSdk } from './types.js';

const encode = (value: string): Uint8Array => new TextEncoder().encode(value);
const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

interface TemplateOptions {
  readonly template: PluginTemplate;
  readonly id: string;
  readonly name: string;
  readonly sdk?: ResolvedPluginSdk | undefined;
}

function toolSource(id: string): string {
  return `import type { PluginFactory } from '@weave/plugin';

export default ((sdk) => ({
  setup(env) {
    env.contribute(sdk.toolsExtensionPoint, (api) => {
      api.addTool({
        name: ${JSON.stringify(id)},
        description: 'Return the supplied text.',
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
`;
}

function commandSource(id: string): string {
  return `import type { PluginFactory } from '@weave/plugin';

export default ((sdk) => ({
  setup(env) {
    env.contribute(sdk.commandsExtensionPoint, (api) => {
      api.addCommand({
        name: ${JSON.stringify(id)},
        title: 'Review a change',
        description: 'Prepare a concrete review request.',
        prompt: 'Review this change for concrete correctness issues:\\n\\n$ARGUMENTS',
      });
    });
  },
})) satisfies PluginFactory;
`;
}

function readme(options: TemplateOptions): string {
  const source =
    options.template === 'skills'
      ? 'This project is already a declarative Skills payload. Its documents and resources remain inert text; no plugin entry or compiler is needed.\n'
      : `This TypeScript ESM project uses the real public SDK at ${JSON.stringify(options.sdk!.directory)}. Before an SDK is published, typechecking is tied to this Weave checkout. Use --sdk-directory with another genuine built local @weave/plugin package to select its SDK. The generated tsconfig.json is an editor aid; the CLI uses its own checked compiler settings.\n\nThe source descriptor declares the eventual index.mjs, which is created only in build output. Source itself is not an installable executable payload. Runtime values come from the injected SDK; @weave/plugin is imported only for types.\n`;
  return `# ${options.name}

${source}
Use Node.js 24.4 or newer and the repository's pnpm version. Run these commands
from your Weave repository checkout, replacing each absolute example path:

\`\`\`sh
pnpm plugin:validate --source /absolute/path/to/project
pnpm plugin:build --source /absolute/path/to/project --out /absolute/path/to/new-build
pnpm plugin:validate --artifact /absolute/path/to/new-build/payload
pnpm plugin:pack --artifact /absolute/path/to/new-build/payload --out /absolute/path/to/new-release
\`\`\`

Each output directory must be new. The installable directory is the reported
payload child; receipt.json stays outside its digest. No dependency install,
author script, code execution, trust change or publication happens in these steps.
Optional --host-version checks an actual selected Weave release; omission does not
claim engine compatibility with an invented product version.

Commit only the prepared payload you intend to release into your own repository.
Then use Weave's documented marketplace:entry flow against a real fixed GitHub
commit and request collection review. The CLI does not publish or submit PRs.
Installation, trust and activation remain separate user actions. Static checks
and receipts do not provide a sandbox or certify publisher identity.
`;
}

/** Pure template rendering; writes belong to the exclusive output owner. */
export function renderPluginTemplate(options: TemplateOptions): ReadonlyMap<string, Uint8Array> {
  const { template, id, name, sdk } = options;
  const manifest: PluginManifest = {
    id,
    name,
    version: '0.1.0',
    apiVersion: pluginApiVersion,
    host: template === 'skills' ? 'declarative' : 'in-process',
    capabilities: [template === 'skills' ? 'skill' : template],
    contributes:
      template === 'skills'
        ? { skills: [id] }
        : template === 'tool'
          ? { tools: [id] }
          : { commands: [id] },
    permissions: [],
  };
  const descriptor =
    template === 'skills'
      ? { schemaVersion: 2, kind: 'skills', manifest }
      : { schemaVersion: 1, entry: 'index.mjs', manifest };
  const descriptorText = json(descriptor);
  parseDescriptor(descriptorText);
  const files = new Map<string, Uint8Array>([
    ['weave-plugin.json', encode(descriptorText)],
    ['README.md', encode(readme(options))],
  ]);
  if (template === 'skills') {
    files.set(
      `skills/${id}/SKILL.md`,
      encode(`---
name: ${id}
description: Review a proposed change and verify concrete findings using existing workspace tools.
user-invocable: true
disable-model-invocation: false
---

Read the repository instructions and establish the requested change scope.
Inspect the relevant code and existing behavior tests. Use
references/checklist.md to check the findings before presenting them.
Use only the tools and permissions already granted by the host. This Skill
does not authorize editing, publishing or running scripts on its own.
`),
    );
    files.set(
      `skills/${id}/references/checklist.md`,
      encode(`# Review checklist

- Identify the concrete input or state that triggers each finding.
- Verify the behavior with relevant existing tests or a focused reproduction.
- Explain the impact and any remaining uncertainty.
`),
    );
    return files;
  }
  if (sdk === undefined) throw new Error('An ESM template requires the resolved real SDK');
  files.set('package.json', encode(json({ name: id, private: true, type: 'module' })));
  files.set('src/index.ts', encode(template === 'tool' ? toolSource(id) : commandSource(id)));
  files.set(
    'tsconfig.json',
    encode(
      json({
        compilerOptions: {
          target: 'ES2022',
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
          strict: true,
          noUncheckedIndexedAccess: true,
          exactOptionalPropertyTypes: true,
          isolatedModules: true,
          verbatimModuleSyntax: true,
          noEmit: true,
          skipLibCheck: false,
          paths: { '@weave/plugin': [sdk.typesPath] },
          types: ['node'],
          typeRoots: sdk.typeRoots,
        },
        include: ['src/**/*.ts'],
      }),
    ),
  );
  return files;
}
