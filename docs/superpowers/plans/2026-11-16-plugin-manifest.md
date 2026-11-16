# Plugin Manifest Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 Weave 增加第一版受信任进程内插件能力，让插件通过 Manifest 和受控 Context 注册 Tool/Provider，并由 Server 组合根接入现有 Runtime 边界。

**Architecture:** 新增独立的 `@weave/plugin` 包。插件包只负责 Manifest 校验、能力声明、注册暂存、冲突检查和生命周期，不执行模型请求或工具调用；Tool 继续进入 `@weave/runtime` 的 `ToolRegistry`/`ToolPipeline`，Provider 继续进入 `@weave/llm` 的 `LlmProviderRegistry`。Server 负责创建宿主 Registry、注册显式传入的受信任插件，并把注册后的能力交给 Agent Runner。

**Tech Stack:** TypeScript、ESM、Zod、Vitest、pnpm workspace、Turborepo、现有 `@weave/llm` 和 `@weave/runtime` API。

**Spec:** `docs/superpowers/specs/2026-11-16-plugin-manifest-design.md`

## Global Constraints

- TypeScript、ESM 和 strict typing。
- 所有 Manifest、插件定义和外部输入在使用前经过 Zod 校验。
- `@weave/plugin` 不依赖 Hono、React、Server 内部文件或浏览器 API。
- 插件只能通过 `PluginContext` 注册 Tool/Provider，不能直接访问 Runtime、Session Store、Workspace 根目录或 Server 路由。
- Tool 必须继续通过 `ToolRegistry -> ToolPipeline -> Approval / Workspace` 执行。
- Provider 必须继续通过 `LlmProviderRegistry` 路由，公开快照不得包含客户端和 API Key。
- 第一版只支持宿主显式传入的受信任进程内插件，不实现 GitHub 下载、动态 import、依赖安装、沙箱或插件市场 UI。
- 每个任务完成独立测试后提交一次中文 Conventional Commit。
- 代码注释只解释必要的边界和原因，详细解释写入学习文档。
- 不复制 Orbit 的 `RunManager` 或 `runAgent()` 作为 Plugin/Runtime 边界。

---

### Task 1: 创建 `@weave/plugin` 包并接入工程边界

**Files:**

- Create: `packages/plugin/package.json`
- Create: `packages/plugin/tsconfig.json`
- Create: `packages/plugin/src/index.ts`
- Create: `packages/plugin/test/scaffold.test.ts`
- Modify: `eslint.config.js`
- Modify: `pnpm-lock.yaml`

**Interfaces:**

- Consumes: 现有 pnpm workspace、TypeScript、ESLint、Vitest 配置。
- Produces: 可被其他 workspace package 导入的 `@weave/plugin` 包。

- [ ] **Step 1: Write the failing scaffold test**

Create `packages/plugin/test/scaffold.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { pluginApiVersion } from '../src/index.js';

describe('@weave/plugin package', () => {
  it('exports the current Plugin API version', () => {
    expect(pluginApiVersion).toBe('1.0.0');
  });
});
```

Run:

```bash
pnpm exec vitest run packages/plugin/test/scaffold.test.ts --config vitest.config.ts
```

Expected: FAIL because `packages/plugin` and `pluginApiVersion` do not exist.

- [ ] **Step 2: Add the package manifest and TypeScript configuration**

Create `packages/plugin/package.json` with:

```json
{
  "name": "@weave/plugin",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js"
    }
  },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "lint": "eslint src test",
    "test": "vitest run --root ../.. --config vitest.config.ts",
    "typecheck": "tsc -p tsconfig.json --noEmit"
  },
  "dependencies": {
    "@weave/llm": "workspace:*",
    "@weave/runtime": "workspace:*",
    "zod": "4.6.7"
  },
  "devDependencies": {
    "@types/node": "24.10.1"
  }
}
```

Create `packages/plugin/tsconfig.json` using the same strict NodeNext
configuration and declaration output pattern as `packages/runtime/tsconfig.json`.
Keep tests outside `src/`.

- [ ] **Step 3: Register the package in the ESLint boundary rule**

Add `@weave/plugin` to `workspacePackageNames` and add a package-layer entry
whose allowed workspace dependencies are exactly `@weave/llm` and
`@weave/runtime`. Keep the package independent from `@weave/server`,
`@weave/session`, `@weave/workspace`, Hono and React.

The boundary rule must continue rejecting relative imports into another
workspace package and undeclared workspace dependencies.

- [ ] **Step 4: Add the version export and install workspace metadata**

Create `packages/plugin/src/index.ts` with:

```ts
/** Current Plugin Context compatibility version. */
export const pluginApiVersion = '1.0.0' as const;
```

Run:

```bash
pnpm install --lockfile-only
pnpm exec vitest run packages/plugin/test/scaffold.test.ts --config vitest.config.ts
pnpm --filter @weave/plugin typecheck
pnpm --filter @weave/plugin lint
```

Expected: the focused test, typecheck and lint pass.

- [ ] **Step 5: Commit the package scaffold**

```bash
git add packages/plugin eslint.config.js pnpm-lock.yaml
git diff --cached --check
git commit -m "chore: 创建插件包工程边界"
```

### Task 2: 实现 Plugin Manifest 和稳定错误类型

**Files:**

- Create: `packages/plugin/src/manifest.ts`
- Create: `packages/plugin/src/plugin-errors.ts`
- Create: `packages/plugin/test/manifest.test.ts`
- Modify: `packages/plugin/src/index.ts`

**Interfaces:**

- Consumes: `pluginApiVersion` from `packages/plugin/src/index.ts`.
- Produces:

  ```ts
  export const pluginApiVersion: '1.0.0';
  export type PluginCapability = 'tool' | 'llm-provider';
  export interface PluginManifest {
    readonly id: string;
    readonly name: string;
    readonly version: string;
    readonly apiVersion: string;
    readonly description?: string;
    readonly capabilities: readonly PluginCapability[];
  }
  export const pluginManifestSchema: z.ZodType<PluginManifest>;
  export type PluginErrorCode =
    | 'plugin-invalid-manifest'
    | 'plugin-invalid-definition'
    | 'plugin-api-version-unsupported'
    | 'plugin-duplicate-id'
    | 'plugin-capability-not-declared'
    | 'plugin-setup-failed'
    | 'plugin-registration-conflict'
    | 'plugin-dispose-failed';
  export class PluginError extends Error {
    readonly code: PluginErrorCode;
  }
  ```

- [ ] **Step 1: Write failing Manifest and error tests**

Create tests covering valid data and every schema rule:

```ts
import { describe, expect, it } from 'vitest';
import { pluginApiVersion, pluginManifestSchema } from '../src/index.js';

const validManifest = {
  id: 'example-tools',
  name: 'Example Tools',
  version: '1.0.0',
  apiVersion: pluginApiVersion,
  capabilities: ['tool'],
} as const;

describe('Plugin Manifest', () => {
  it('accepts a valid manifest', () => {
    expect(pluginManifestSchema.parse(validManifest)).toEqual(validManifest);
  });

  it.each([
    { ...validManifest, id: 'Example Tools' },
    { ...validManifest, id: '-example-tools' },
    { ...validManifest, version: '1.0' },
    { ...validManifest, apiVersion: '2.0.0' },
    { ...validManifest, capabilities: [] },
    { ...validManifest, capabilities: ['tool', 'tool'] },
  ])('rejects an invalid manifest', (manifest) => {
    expect(() => pluginManifestSchema.parse(manifest)).toThrow();
  });

  it('rejects unknown manifest fields', () => {
    expect(() =>
      pluginManifestSchema.parse({ ...validManifest, entry: './dist/index.js' }),
    ).toThrow();
  });
});
```

Add an error test that constructs `new PluginError('plugin-invalid-manifest', ...)`
and checks `name`, `code`, and `cause` behavior.

Run the focused test and verify it fails because the schema and error class do
not exist.

- [ ] **Step 2: Implement the strict Manifest schema**

In `manifest.ts`:

- use a strict `z.object`;
- validate ids with `/^[a-z0-9]+(?:-[a-z0-9]+)*$/`;
- validate `version` and `apiVersion` with `/^\d+\.\d+\.\d+$/`;
- use `z.enum(['tool', 'llm-provider'])`;
- require at least one capability;
- reject duplicate capabilities with a custom refinement;
- preserve `description` only when it is a non-empty string;
- export `pluginManifestSchema` and the related types.

Keep API version compatibility checking separate from structural parsing so the
Registry can report `plugin-api-version-unsupported` rather than a generic
schema error.

- [ ] **Step 3: Implement `PluginError`**

Create a stable error class:

```ts
export class PluginError extends Error {
  readonly code: PluginErrorCode;

  constructor(code: PluginErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'PluginError';
    this.code = code;
  }
}
```

Do not include full Provider configuration, API keys, tool arguments or other
secret values in messages.

- [ ] **Step 4: Export the public contract and run focused tests**

Export the schema, types, version and error class from `src/index.ts`.

Run:

```bash
pnpm exec vitest run packages/plugin/test/manifest.test.ts --config vitest.config.ts
pnpm --filter @weave/plugin typecheck
pnpm --filter @weave/plugin lint
```

Expected: all focused tests pass.

- [ ] **Step 5: Commit the Manifest contract**

```bash
git add packages/plugin/src packages/plugin/test
git diff --cached --check
git commit -m "feat: 增加插件清单与错误契约"
```

### Task 3: 实现受控 Plugin Context 和注册快照类型

**Files:**

- Create: `packages/plugin/src/plugin-types.ts`
- Create: `packages/plugin/test/plugin-context.test.ts`
- Modify: `packages/plugin/src/index.ts`

**Interfaces:**

- Consumes: `PluginManifest`, `PluginError`, `ToolDefinition`,
  `LlmProviderRegistration`.
- Produces:

  ```ts
  export interface PluginContext {
    registerTool<TInput, TOutput>(tool: ToolDefinition<TInput, TOutput>): void;
    registerProvider(provider: LlmProviderRegistration): void;
  }

  export interface StagedPluginContext extends PluginContext {
    readonly getTools: () => readonly RegisteredToolDefinition[];
    readonly getProviders: () => readonly LlmProviderRegistration[];
  }

  export function createPluginContext(
    manifest: PluginManifest,
  ): StagedPluginContext;

  export interface WeavePlugin {
    readonly manifest: PluginManifest;
    setup(context: PluginContext): void | Promise<void>;
    dispose?(): void | Promise<void>;
  }

  export interface PluginSnapshot {
    readonly id: string;
    readonly name: string;
    readonly version: string;
    readonly apiVersion: string;
    readonly description?: string;
    readonly capabilities: readonly PluginCapability[];
    readonly tools: readonly string[];
    readonly providers: readonly string[];
  }
  ```

  `PluginContext` is created internally by the Registry and is not a public
  constructor. The implementation stores staged registrations privately.

- [ ] **Step 1: Write failing Context tests**

Export `createPluginContext` from `plugin-types.ts` for package-internal tests,
but do not re-export it from the package root `index.ts`. The tests must verify:

```ts
it('stages a declared Tool without executing it', () => {
  const context = createPluginContext({
    id: 'example-tools',
    name: 'Example Tools',
    version: '1.0.0',
    apiVersion: '1.0.0',
    capabilities: ['tool'],
  });
  context.registerTool(echoTool);
  expect(context.getTools()).toEqual([echoTool]);
});

it('rejects a Tool when the plugin did not declare tool capability', () => {
  const context = createPluginContext({
    id: 'example-provider',
    name: 'Example Provider',
    version: '1.0.0',
    apiVersion: '1.0.0',
    capabilities: ['llm-provider'],
  });
  expect(() => context.registerTool(echoTool)).toThrowError(
    expect.objectContaining({ code: 'plugin-capability-not-declared' }),
  );
});

it('rejects malformed registrations before setup completes', () => {
  const context = createPluginContext({
    id: 'example-tools',
    name: 'Example Tools',
    version: '1.0.0',
    apiVersion: '1.0.0',
    capabilities: ['tool'],
  });
  expect(() => context.registerTool({ ...echoTool, name: '' })).toThrow();
});
```

Also verify that registering a Provider requires `llm-provider` and that
registration does not call the Provider client or execute the Tool.

- [ ] **Step 2: Implement the internal staged Context**

Use private arrays for staged Tools and Providers. On each registration:

1. check the corresponding Manifest capability;
2. validate the Tool with the existing `toolDefinitionSchema`;
3. validate Provider shape with a local Zod schema matching the public
   `LlmProviderRegistration` contract;
4. reject duplicate names within the same plugin;
5. store the original definition for later commit.

The Context must not expose the Runtime, registries, Session Store, Workspace
policy, Approval Broker, Node APIs or HTTP objects.

- [ ] **Step 3: Implement immutable snapshots**

Add a snapshot factory that copies and freezes capability, tool and provider
name arrays. Never place the Tool implementation, Provider client, API key,
base URL or other private registration data in `PluginSnapshot`.

- [ ] **Step 4: Run focused tests**

Run:

```bash
pnpm exec vitest run packages/plugin/test/plugin-context.test.ts --config vitest.config.ts
pnpm --filter @weave/plugin typecheck
pnpm --filter @weave/plugin lint
```

Expected: all Context tests pass.

- [ ] **Step 5: Commit the Context contract**

```bash
git add packages/plugin/src/plugin-types.ts packages/plugin/src/index.ts packages/plugin/test/plugin-context.test.ts
git diff --cached --check
git commit -m "feat: 增加插件受控注册上下文"
```

### Task 4: 实现 Plugin Registry 的校验、事务提交和生命周期

**Files:**

- Create: `packages/plugin/src/plugin-registry.ts`
- Create: `packages/plugin/test/plugin-registry.test.ts`
- Modify: `packages/plugin/src/index.ts`

**Interfaces:**

- Consumes: `ToolRegistry`, `LlmProviderRegistry`, `WeavePlugin`,
  `PluginContext`, `PluginSnapshot`, `PluginError`.
- Produces:

  ```ts
  export interface PluginRegistryOptions {
    readonly toolRegistry: ToolRegistry;
    readonly providerRegistry: LlmProviderRegistry;
    readonly apiVersion?: string;
  }

  export interface PluginRegistry {
    register(plugin: WeavePlugin): Promise<PluginSnapshot>;
    get(pluginId: string): PluginSnapshot | undefined;
    list(): readonly PluginSnapshot[];
    dispose(): Promise<void>;
  }

  export function createPluginRegistry(options: PluginRegistryOptions): PluginRegistry;
  ```

- [ ] **Step 1: Write failing Registry tests**

Create tests for:

```ts
it('registers a plugin and exposes a secret-free frozen snapshot', async () => {
  const plugin = createToolPlugin();
  const snapshot = await registry.register(plugin);

  expect(snapshot).toEqual({
    id: 'example-tools',
    name: 'Example Tools',
    version: '1.0.0',
    apiVersion: '1.0.0',
    capabilities: ['tool'],
    tools: ['echo'],
    providers: [],
  });
  expect(Object.isFrozen(snapshot)).toBe(true);
  expect(JSON.stringify(snapshot)).not.toContain('apiKey');
  expect(registry.get('example-tools')).toBe(snapshot);
});

it('rejects unsupported API versions before setup executes', async () => {
  const setup = vi.fn();
  await expect(
    registry.register({
      manifest: { ...validManifest, apiVersion: '2.0.0' },
      setup,
    }),
  ).rejects.toMatchObject({ code: 'plugin-api-version-unsupported' });
  expect(setup).not.toHaveBeenCalled();
});

it('does not leave Tool or Provider registrations after setup fails', async () => {
  await expect(
    registry.register({
      manifest: validManifest,
      setup(context) {
        context.registerTool(echoTool);
        throw new Error('setup failed');
      },
    }),
  ).rejects.toMatchObject({ code: 'plugin-setup-failed' });

  expect(toolRegistry.get('echo')).toBeUndefined();
  expect(registry.get('example-tools')).toBeUndefined();
});

it('rejects conflicts before committing any staged registration', async () => {
  toolRegistry.register(existingTool);
  await expect(
    registry.register({
      manifest: { ...validManifest, id: 'conflict-plugin' },
      setup(context) {
        context.registerTool(existingTool);
        context.registerTool(anotherTool);
      },
    }),
  ).rejects.toMatchObject({ code: 'plugin-registration-conflict' });
  expect(toolRegistry.get('another')).toBeUndefined();
});

function createPlugin(id: string, dispose: () => void): WeavePlugin {
  return {
    manifest: {
      id,
      name: id,
      version: '1.0.0',
      apiVersion: '1.0.0',
      capabilities: ['tool'],
    },
    setup(context) {
      context.registerTool({
        name: `${id}-tool`,
        description: 'Lifecycle test tool',
        parameters: { type: 'object', properties: {} },
        inputSchema: z.object({}),
        execute: () => 'ok',
      });
    },
    dispose,
  };
}

it('disposes plugins in reverse registration order and aggregates failures', async () => {
  const disposeOrder: string[] = [];
  await registry.register(createPlugin('first', () => {
    disposeOrder.push('first');
    throw new Error('first dispose failed');
  }));
  await registry.register(createPlugin('second', () => {
    disposeOrder.push('second');
    throw new Error('second dispose failed');
  }));
  await registry.register(createPlugin('third', () => {
    disposeOrder.push('third');
  }));

  let caught: unknown;
  try {
    await registry.dispose();
  } catch (error: unknown) {
    caught = error;
  }

  expect(disposeOrder).toEqual(['third', 'second', 'first']);
  expect(caught).toBeInstanceOf(AggregateError);
  expect((caught as AggregateError).errors).toHaveLength(2);
  expect(registry.list()).toEqual([]);
});
```

The lifecycle test must use actual assertions for disposal order and aggregated
error count; the implementation must contain the complete test body.

- [ ] **Step 2: Implement registration validation**

In `createPluginRegistry`:

1. keep a private `Map<string, PluginSnapshot>` and a private ordered list of
   registered plugin definitions;
2. validate the plugin object and Manifest before calling `setup`;
3. compare `manifest.apiVersion` with `options.apiVersion ?? pluginApiVersion`;
4. reject duplicate plugin ids;
5. create a private staged Context and await `plugin.setup(context)`;
6. wrap setup failures as `PluginError('plugin-setup-failed', ...)` with the
   original error as `cause`.

- [ ] **Step 3: Implement preflight conflict checks**

Before mutating either host Registry:

- check each staged Tool name against the host `ToolRegistry`;
- check each staged Provider id against the host `LlmProviderRegistry`;
- check duplicate names within the staged arrays;
- validate all staged definitions;
- reject undeclared capability attempts during Context registration.

Use `plugin-registration-conflict` for conflicts that can be reported at the
Plugin boundary. Include the plugin id and conflicting name in the message,
without including secrets or tool arguments.

- [ ] **Step 4: Commit staged registrations and record snapshots**

After preflight succeeds, register all staged Tools and Providers in a stable
order, then create and store an immutable `PluginSnapshot`. The implementation
must never add the plugin snapshot before host registration succeeds.

Because the existing host registries expose registration but not removal, the
preflight must cover every known validation and conflict failure before commit.
Unexpected lower-level failures must be wrapped as
`plugin-registration-conflict`; add a regression test that proves normal
validation errors are caught during preflight.

- [ ] **Step 5: Implement lookup, listing and disposal**

`get()` returns a stored snapshot or `undefined`. `list()` returns a frozen
registration-order copy. `dispose()` calls plugin dispose hooks in reverse
registration order, continues after failures, clears Plugin Registry state,
and throws one `AggregateError` containing all disposal errors when needed.

The first version does not remove already registered Tools or Providers during
dispose; it only releases plugin-owned lifecycle resources and clears the
Plugin Registry snapshots. Hot unload requires ownership-aware host registries
and remains out of scope.

- [ ] **Step 6: Run focused Registry tests**

Run:

```bash
pnpm exec vitest run packages/plugin/test/plugin-registry.test.ts --config vitest.config.ts
pnpm --filter @weave/plugin typecheck
pnpm --filter @weave/plugin lint
```

Expected: all Registry tests pass.

- [ ] **Step 7: Commit the Registry**

```bash
git add packages/plugin/src/plugin-registry.ts packages/plugin/src/index.ts packages/plugin/test/plugin-registry.test.ts
git diff --cached --check
git commit -m "feat: 增加插件注册表与生命周期"
```

### Task 5: 在 Server 组合根接入显式插件

**Files:**

- Modify: `apps/server/package.json`
- Modify: `apps/server/src/main.ts`
- Modify: `apps/server/src/runtime.ts`
- Modify: `apps/server/test/agent-api.test.ts`
- Create: `apps/server/test/plugin-integration.test.ts`

**Interfaces:**

- Consumes: `createPluginRegistry`, `WeavePlugin`, `PluginSnapshot`,
  `ToolRegistry`, `ToolPipeline`, and the existing Server Provider Registry.
- Produces: Server can accept explicit trusted plugins during startup and route
  their Tools/Providers through existing Runtime boundaries.

- [ ] **Step 1: Write failing Server integration tests**

Add a `StartServerOptions.plugins?: readonly WeavePlugin[]` option and tests
with a plugin that registers:

```ts
const echoPlugin: WeavePlugin = {
  manifest: {
    id: 'server-echo',
    name: 'Server Echo',
    version: '1.0.0',
    apiVersion: '1.0.0',
    capabilities: ['tool'],
  },
  setup(context) {
    context.registerTool({
      name: 'echo',
      description: '回显文本',
      parameters: {
        type: 'object',
        properties: { text: { type: 'string' } },
        required: ['text'],
      },
      inputSchema: z.object({ text: z.string() }),
      execute: ({ text }) => text,
    });
  },
};
```

The test must start the Server with this plugin, send an Agent request through
the existing HTTP API, approve the tool if the test tool declares Approval,
and assert the tool result arrives through the existing SSE contract. Also add
a test that an invalid plugin prevents startup without exposing secret
configuration.

Run the focused integration test first and verify it fails because Server has
no plugin option or plugin assembly.

- [ ] **Step 2: Add the Server workspace dependency**

Declare `@weave/plugin: workspace:*` in `apps/server/package.json`, then run
the lockfile-only install. Do not import `packages/plugin/src/...` through a
relative path.

- [ ] **Step 3: Create host registries and assemble plugins**

In the Server composition root:

- create a `ToolRegistry` before plugin registration;
- use the existing `providerSettings.registry`;
- create a `PluginRegistry` with those two registries;
- register `options.plugins ?? []` serially before Agent Runner creation;
- create the existing `ToolPipeline` with the Runtime Approval Broker after
  Runtime startup;
- pass the same Tool Registry and Tool Pipeline into
  `createServerAgentRunner`.

Keep HTTP handlers thin. Do not add plugin loading logic to Hono routes.
Plugin setup errors must stop startup and be cleaned up using the existing
Server startup failure path.

- [ ] **Step 4: Expose plugin snapshots only where needed**

Return or retain the Plugin Registry in the Server startup handle only if the
existing test and shutdown lifecycle need it. Do not add a public HTTP
endpoint in this task unless the integration test requires it. If a future
Settings page needs plugin metadata, it should receive `PluginSnapshot` values
without Tool implementations or Provider clients.

- [ ] **Step 5: Run the Server integration tests**

Run:

```bash
pnpm exec vitest run apps/server/test/plugin-integration.test.ts --config vitest.config.ts
pnpm --filter @weave/server typecheck
pnpm --filter @weave/server lint
```

Expected: the plugin Tool is visible to the Agent Runner only through the
existing Tool Registry and executes only through the Tool Pipeline.

- [ ] **Step 6: Commit Server integration**

```bash
git add apps/server/package.json apps/server/src/main.ts apps/server/src/runtime.ts apps/server/test
git diff --cached --check
git commit -m "feat: 接入 Server 显式插件注册"
```

### Task 6: 补充架构、学习文档和完整验证

**Files:**

- Modify: `docs/architecture/foundation.md`
- Create: `docs/learning/2026-11-16-plugin-manifest.md`
- Modify: `README.md`

**Interfaces:**

- Consumes: completed `@weave/plugin` APIs and Server assembly behavior.
- Produces: architecture and learning documentation that explains why Plugin
  Registry does not execute tools directly and how GitHub installation will be
  added later.

- [ ] **Step 1: Update the architecture document**

Add a concise Plugin section to `docs/architecture/foundation.md` covering:

- `Plugin Manifest -> Plugin Context -> Tool/Provider Registry` flow;
- plugin code is trusted in this phase and is not sandboxed;
- Tool execution still uses Tool Pipeline, Approval and Workspace boundaries;
- Provider metadata remains secret-free;
- GitHub Catalog/Installer/Installed Store are future layers outside the
  current Runtime.

- [ ] **Step 2: Write the learning document**

Create `docs/learning/2026-11-16-plugin-manifest.md` with simple Chinese
explanations and code examples for:

- why Plugin Manifest is different from an npm package manifest;
- why the Plugin Context is narrower than Runtime;
- how staged registration prevents setup failures from partially mutating host
  registries;
- why a plugin Tool cannot call `execute` directly;
- how Provider secrets stay inside the Server process;
- why GitHub installation must lock repository, Commit and Monorepo path;
- why a future untrusted plugin needs a process boundary rather than only
  TypeScript types;
- an interview-ready explanation of the `Catalog -> Installer -> Store ->
  Registry -> Runtime` chain.

- [ ] **Step 3: Update README commands**

Document the package and the current scope:

```bash
pnpm --filter @weave/plugin test
pnpm --filter @weave/plugin typecheck
```

State clearly that the current phase accepts explicitly provided trusted
plugins and does not yet install arbitrary GitHub code.

- [ ] **Step 4: Run repository verification**

Run:

```bash
pnpm format
pnpm check
```

If formatting changes files, inspect the diff, stage only files owned by this
feature, and rerun `pnpm check`.

- [ ] **Step 5: Commit documentation and verification changes**

```bash
git add docs/architecture/foundation.md docs/learning/2026-11-16-plugin-manifest.md README.md
git diff --cached --check
git commit -m "docs: 补充插件开发与安装学习说明"
```

- [ ] **Step 6: Prepare the PR**

Before pushing, inspect:

```bash
git status --short --branch
git diff origin/main...HEAD --stat
git log --oneline origin/main..HEAD
```

Push the feature branch with an explicit refspec:

```bash
git push -u origin HEAD:refs/heads/feat/plugin-manifest
```

Create one Pull Request for this branch. The PR description should explain the
runtime behavior and validation commands, but should not paste the Feishu
learning document. Keep the remote feature branch because that is the project
workflow.

## Self-Review Checklist

- [ ] Every requirement in the Plugin Manifest design has an implementation
  task or is explicitly listed as a later Catalog/Installer scope.
- [ ] Each task names concrete validation rules and test behavior instead of
  delegating unspecified edge-case work to the implementer.
- [ ] The public types used by later tasks match the names and fields produced
  by earlier tasks.
- [ ] The plan keeps `@weave/plugin` out of Runtime core and keeps HTTP
  handlers thin.
- [ ] The plan does not claim process-internal plugins are sandboxed.
- [ ] All commits use Chinese Conventional Commit messages.
