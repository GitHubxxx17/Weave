# LLM Provider Routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 Weave Server 根据本地配置注册多个 LLM Provider，Runtime 按请求路由 Provider，Studio 使用真实的可用 Provider 和默认模型。

**Architecture:** `@weave/llm` 提供进程内 `LlmProviderRegistry`，保存 Provider id、公开描述和私有 `LlmClient`。Runtime 在 Server 组合根注入 Registry，并按 `AgentRunRequest.provider` 选择客户端；HTTP 只暴露脱敏的 Provider 元数据，Studio 通过设置 API 读取并提交所选 Provider。

**Tech Stack:** TypeScript、ESM、Zod、Vitest、Hono、React、Vite、现有 OpenAI-compatible SSE adapter。

**Spec:** `docs/superpowers/specs/2026-11-16-llm-provider-routing-design.md`

## Global Constraints

- TypeScript, ESM, and strict typing.
- Validate external input with Zod before use.
- Keep HTTP handlers thin; agent behavior belongs in the runtime.
- API Key 只保存在 Server 进程，不进入浏览器、Session、SSE 或日志。
- 保留 Mock Provider，未配置外部服务时 `pnpm dev` 仍可运行。
- 依赖方向保持 `protocol -> llm -> runtime -> server`，Studio 只调用 HTTP API。
- 每个任务完成独立测试后使用中文 Conventional Commit。
- 代码注释只解释必要的边界，详细说明放在学习文档。

---

### Task 1: 实现 LLM Provider Registry

**Files:**

- Create: `packages/llm/src/provider-registry.ts`
- Modify: `packages/llm/src/index.ts`
- Create: `packages/llm/test/provider-registry.test.ts`
- Modify: `docs/superpowers/specs/2026-11-16-llm-provider-routing-design.md`
- Modify: `docs/superpowers/plans/2026-11-16-llm-provider-routing.md`

**Interfaces:**

- Consumes: `LlmClient` from `packages/llm/src/client.ts`.
- Produces:

  ```ts
  export type LlmProviderType = 'mock' | 'openai-compatible';

  export interface LlmProviderRegistration {
    readonly id: string;
    readonly label: string;
    readonly type: LlmProviderType;
    readonly client: LlmClient;
    readonly defaultModel?: string;
  }

  export interface LlmProviderDescriptor {
    readonly id: string;
    readonly label: string;
    readonly type: LlmProviderType;
    readonly defaultModel?: string;
  }

  export interface LlmProviderRegistry {
    register(provider: LlmProviderRegistration): void;
    get(providerId: string): LlmClient | undefined;
    getDescriptor(providerId: string): LlmProviderDescriptor | undefined;
    list(): readonly LlmProviderDescriptor[];
  }

  export function createLlmProviderRegistry(
    providers?: readonly LlmProviderRegistration[],
  ): LlmProviderRegistry;
  ```

- [ ] **Step 1: Write the failing Registry tests**

  Add tests for registration, lookup, descriptor listing, duplicate ids and
  secret isolation:

  ```ts
  it('registers and resolves a provider by id', () => {
    const client = createMockLlmClient([{ type: 'finish', reason: 'stop' }]);
    const registry = createLlmProviderRegistry([
      {
        id: 'deepseek',
        label: 'DeepSeek',
        type: 'openai-compatible',
        client,
        defaultModel: 'deepseek-chat',
      },
    ]);

    expect(registry.get('deepseek')).toBe(client);
    expect(registry.list()).toEqual([
      {
        id: 'deepseek',
        label: 'DeepSeek',
        type: 'openai-compatible',
        defaultModel: 'deepseek-chat',
      },
    ]);
  });

  it('rejects duplicate provider ids', () => {
    const registry = createLlmProviderRegistry();
    const registration = {
      id: 'mock',
      label: '本地演示',
      type: 'mock' as const,
      client: createMockLlmClient([{ type: 'finish', reason: 'stop' }]),
    };

    registry.register(registration);
    expect(() => registry.register(registration)).toThrow(
      'LLM provider "mock" is already registered',
    );
  });

  it('does not expose private client configuration through descriptors', () => {
    const registry = createLlmProviderRegistry();
    registry.register({
      id: 'deepseek',
      label: 'DeepSeek',
      type: 'openai-compatible',
      client: createMockLlmClient([{ type: 'finish', reason: 'stop' }]),
    });

    expect(JSON.stringify(registry.list())).not.toContain('apiKey');
  });
  ```

- [ ] **Step 2: Run the focused test and verify the expected failure**

  Run:

  ```bash
  pnpm exec vitest run packages/llm/test/provider-registry.test.ts --config vitest.config.ts
  ```

  Expected: FAIL because the Registry module and factory do not exist yet.

- [ ] **Step 3: Implement the minimal Registry**

  Use a private `Map<string, LlmProviderRegistration>`. Validate the public
  registration fields with a local Zod schema at the Registry boundary, reject
  duplicate ids, return frozen descriptor objects, and never include the client
  in `list()` results.

- [ ] **Step 4: Export the Registry and run the focused test**

  Export the types and factory from `packages/llm/src/index.ts`, then run the
  focused test again. Expected: all Registry tests pass.

- [ ] **Step 5: Commit the Registry**

  ```bash
  git add packages/llm/src/provider-registry.ts packages/llm/src/index.ts packages/llm/test/provider-registry.test.ts
  git commit -m "feat: 增加 LLM Provider 注册表"
  ```

### Task 2: 让 Agent Runner 按 Provider 路由

**Files:**

- Modify: `packages/runtime/src/agent-types.ts`
- Modify: `packages/runtime/src/agent-runner.ts`
- Modify: `packages/runtime/src/index.ts`
- Modify: `packages/runtime/test/agent-runner.test.ts`
- Modify: `packages/runtime/test/runtime.test.ts`

**Interfaces:**

- Consumes: `LlmProviderRegistry` from `@weave/llm`.
- Produces:

  ```ts
  export interface AgentRunnerOptions {
    readonly llm?: LlmClient;
    readonly llmRegistry?: LlmProviderRegistry;
    readonly sessionStore: SessionEventStore;
    readonly toolRegistry?: ToolRegistry;
    readonly toolPipeline?: ToolPipeline;
    readonly maxSteps?: number;
  }
  ```

- `AgentRunErrorCode` gains:

  ```ts
  | 'agent-provider-unavailable'
  ```

- [ ] **Step 1: Add the failing routing tests**

  Add a test with two deterministic clients. The first emits `甲`, the second
  emits `乙`; requests using `provider: 'alpha'` and `provider: 'beta'` must
  persist and stream the corresponding response. Add a test that an unknown
  provider throws `AgentRunError` with code
  `agent-provider-unavailable` before any model call.

- [ ] **Step 2: Run the focused tests and verify failure**

  ```bash
  pnpm exec vitest run packages/runtime/test/agent-runner.test.ts --config vitest.config.ts
  ```

  Expected: FAIL because `AgentRunnerOptions` has no Registry route and the
  current Runner always uses one `llm`.

- [ ] **Step 3: Resolve the client inside the execution path**

  Add a small resolver:

  ```ts
  function resolveLlm(
    options: AgentRunnerOptions,
    provider: string,
  ): LlmClient {
    if (options.llmRegistry !== undefined) {
      const client = options.llmRegistry.get(provider);
      if (client === undefined) {
        throw new AgentRunError(
          'agent-provider-unavailable',
          `LLM provider "${provider}" is not configured`,
        );
      }
      return client;
    }
    if (options.llm !== undefined) {
      return options.llm;
    }
    throw new AgentRunError('agent-provider-unavailable', 'No LLM provider is configured');
  }
  ```

  Resolve after the request schema succeeds and before the first lifecycle
  event is appended, so a bad Provider does not create a misleading running
  Turn. Use the resolved client for every model step in that run.

- [ ] **Step 4: Preserve the old single-client contract**

  Update existing tests and type exports so existing callers that pass only
  `llm` continue to work. Reject construction only when both `llm` and
  `llmRegistry` are absent; allow exactly one or both with Registry precedence.

- [ ] **Step 5: Run Runtime tests and commit**

  ```bash
  pnpm exec vitest run packages/runtime/test/agent-runner.test.ts packages/runtime/test/runtime.test.ts --config vitest.config.ts
  git add packages/runtime/src packages/runtime/test
  git commit -m "feat: 增加 Agent Provider 路由"
  ```

### Task 3: 增加 Server Provider 配置和元数据 API

**Files:**

- Create: `apps/server/src/llm-providers.ts`
- Modify: `apps/server/src/runtime.ts`
- Modify: `apps/server/src/app.ts`
- Create: `apps/server/src/provider-api.ts`
- Modify: `apps/server/src/main.ts`
- Create: `apps/server/test/provider-api.test.ts`
- Modify: `apps/server/test/health.test.ts`
- Modify: `apps/server/package.json` only if a declared workspace dependency is required

**Interfaces:**

- Consumes: `createLlmProviderRegistry`, `createMockLlmClient`,
  `createOpenAiCompatibleClient`, and `AgentRunnerOptions.llmRegistry`.
- Produces:

  ```ts
  export interface ServerLlmProviderConfig {
    readonly id: string;
    readonly label: string;
    readonly type: 'openai-compatible';
    readonly baseUrl: string;
    readonly apiKey: string;
    readonly defaultModel: string;
  }

  export interface ServerProviderDescriptor {
    readonly id: string;
    readonly label: string;
    readonly type: 'mock' | 'openai-compatible';
    readonly defaultModel?: string;
  }

  export function createServerLlmProviders(options?: {
    readonly environment?: NodeJS.ProcessEnv;
    readonly fetch?: typeof globalThis.fetch;
    readonly mockScript?: readonly StreamEvent[];
  }): {
    readonly registry: LlmProviderRegistry;
    readonly providers: readonly ServerProviderDescriptor[];
    readonly defaultProvider: string;
  };
  ```

- `GET /settings/providers` returns the public descriptors and default id.

- [ ] **Step 1: Write failing config and API tests**

  Cover:

  ```ts
  it('always exposes the local mock provider by default', async () => {
    const response = await app.request('/settings/providers');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      providers: [
        {
          id: 'mock',
          label: '本地演示',
          type: 'mock',
          defaultModel: 'weave-local-demo',
        },
      ],
      defaultProvider: 'mock',
    });
  });

  it('registers configured OpenAI-compatible providers without exposing api keys', async () => {
    const app = createTestApp({
      providersJson: JSON.stringify([
        {
          id: 'deepseek',
          label: 'DeepSeek',
          type: 'openai-compatible',
          baseUrl: 'https://api.deepseek.com/v1',
          apiKey: 'server-secret',
          defaultModel: 'deepseek-chat',
        },
      ]),
    });
    const body = await (await app.request('/settings/providers')).json();

    expect(body.providers).toContainEqual({
      id: 'deepseek',
      label: 'DeepSeek',
      type: 'openai-compatible',
      defaultModel: 'deepseek-chat',
    });
    expect(JSON.stringify(body)).not.toContain('server-secret');
  });
  ```

  Also test invalid JSON, invalid URL and duplicate ids during configuration
  creation.

- [ ] **Step 2: Run the focused Server tests and verify failure**

  ```bash
  pnpm exec vitest run apps/server/test/provider-api.test.ts --config vitest.config.ts
  ```

  Expected: FAIL because the config factory and route do not exist.

- [ ] **Step 3: Parse and validate `WEAVE_LLM_PROVIDERS`**

  Add a strict Zod schema for an array of external Provider configs. Read the
  environment value from an injectable `environment` object so tests never
  mutate process-global state. An absent or empty variable produces only the
  Mock Provider. A malformed value throws a stable `server-provider-config`
  error with the original validation error as `cause`, while its public message
  contains no secret.

- [ ] **Step 4: Build the Server Registry**

  Always register the existing deterministic Mock Provider under `mock`.
  For every valid external config, create an OpenAI-compatible client with the
  configured base URL, API Key and injected fetch, then register its public
  descriptor. Reject duplicate ids, including `mock`.

- [ ] **Step 5: Mount the metadata route**

  Add a thin `registerProviderRoutes()` adapter. It reads only the already-built
  public descriptors and returns JSON. Do not parse environment variables in the
  route and do not return Registry clients.

- [ ] **Step 6: Inject the Registry into the Server Agent Runner**

  Store the registry in a `WeakMap<Runtime, RuntimeService<LlmProviderRegistry>>`
  or an equivalent composition-root service. `createServerAgentRunner()` passes
  `llmRegistry` to `createAgentRunner()`. Existing Session and Approval services
  keep their current ownership.

- [ ] **Step 7: Run Server tests and commit**

  ```bash
  pnpm exec vitest run apps/server/test/provider-api.test.ts apps/server/test/agent-api.test.ts apps/server/test/health.test.ts --config vitest.config.ts
  git add apps/server/src apps/server/test
  git commit -m "feat: 增加 Server Provider 配置"
  ```

### Task 4: 接入 Studio Provider API 和模型选择

**Files:**

- Create: `apps/studio/src/features/providers/provider-types.ts`
- Create: `apps/studio/src/features/providers/provider-api.ts`
- Modify: `apps/studio/src/app/App.tsx`
- Modify: `apps/studio/test/App.test.tsx`
- Create: `apps/studio/test/provider-api.test.ts`
- Modify: `apps/studio/vite.config.ts` if a `/settings` proxy is needed

**Interfaces:**

```ts
export type ProviderDescriptor = {
  readonly id: string;
  readonly label: string;
  readonly type: 'mock' | 'openai-compatible';
  readonly defaultModel?: string;
};

export type ProviderSettings = {
  readonly providers: readonly ProviderDescriptor[];
  readonly defaultProvider: string;
};

export function createProviderApi(fetcher?: typeof fetch): {
  getProviders(): Promise<ProviderSettings>;
};
```

- [ ] **Step 1: Write failing API and App tests**

  Test `createProviderApi().getProviders()` validates the response and maps
  non-OK responses to a stable error. In `App.test.tsx`, mock
  `/settings/providers` with `mock` and `deepseek`, then assert that the model
  menu shows `DeepSeek`. Clicking it and submitting a message must send:

  ```json
  {
    "provider": "deepseek",
    "model": "deepseek-chat"
  }
  ```

  Add the fallback test for an API response containing only `mock`.

- [ ] **Step 2: Run focused Studio tests and verify failure**

  ```bash
  pnpm exec vitest run apps/studio/test/provider-api.test.ts apps/studio/test/App.test.tsx --config vitest.config.ts
  ```

  Expected: FAIL because the Provider API does not exist and App still uses a
  hard-coded model array and `provider: 'mock'`.

- [ ] **Step 3: Implement the browser Provider API**

  Use the existing `WorkspaceApiError` pattern or a focused
  `ProviderApiError`. Parse every response with Zod before returning it. Never
  include or accept an API Key field in the browser types.

- [ ] **Step 4: Load Provider metadata with workspace data**

  Start both requests before awaiting either one:

  ```ts
  const workspaceRequest = workspaceApi.listProjects({ includeArchived: true });
  const providersRequest = providerApi.getProviders();
  const [workspace, providerSettings] = await Promise.all([
    workspaceRequest,
    providersRequest,
  ]);
  ```

  Store `providerSettings`, select the configured default provider, and use its
  default model. If the Provider request fails, keep the workspace usable with
  Mock Provider and show a Chinese notice.

- [ ] **Step 5: Replace the cosmetic model menu**

  Render the actual provider descriptors. When a Provider is selected, set both
  the selected provider id and its default model. Submit the selected values to
  `streamAgentRun()`. Keep the current run disabled while streaming and keep
  provider state independent from Session messages.

- [ ] **Step 6: Add a minimal Settings view**

  Replace the placeholder Settings view with a compact list of configured
  Providers showing label, type and default model. Show a Chinese note that
  API Key is managed by the local Server configuration. Do not add a browser
  form for secrets in this slice.

- [ ] **Step 7: Run Studio tests and commit**

  ```bash
  pnpm exec vitest run apps/studio/test/provider-api.test.ts apps/studio/test/App.test.tsx --config vitest.config.ts
  git add apps/studio/src apps/studio/test
  git commit -m "feat: 接入 Studio Provider 选择"
  ```

### Task 5: 同步架构与学习文档

**Files:**

- Modify: `README.md`
- Modify: `docs/architecture/foundation.md`
- Create: `docs/learning/2026-11-16-llm-provider-routing.md`
- Modify: `docs/superpowers/specs/2026-11-16-llm-provider-routing-design.md`
- Modify: `docs/superpowers/plans/2026-11-16-llm-provider-routing.md`

- [ ] **Step 1: Document the request path**

  Add a diagram and explanation:

  ```text
  WEAVE_LLM_PROVIDERS
    -> Server config validation
    -> LlmProviderRegistry
    -> AgentRunner(provider)
    -> OpenAI-compatible client
    -> SSE
    -> Studio
  ```

  Explain why API Keys stay in Server and why Runtime sees a Registry rather
  than a provider-specific adapter.

- [ ] **Step 2: Add the local DeepSeek example**

  Document the shape of `WEAVE_LLM_PROVIDERS`, the required fields, the
  OpenAI-compatible base URL convention, and the local start flow. Use a
  placeholder such as `replace-with-your-key`; never add a real secret.

- [ ] **Step 3: Record implemented boundaries**

  Mark the design and plan status as implemented, record exact test counts,
  and explicitly list the deferred Plugin Runtime, provider fallback,
  model-discovery and browser secret-management work.

- [ ] **Step 4: Run documentation formatting**

  ```bash
  pnpm format:check
  git diff --check
  ```

- [ ] **Step 5: Commit documentation**

  ```bash
  git add README.md docs/architecture/foundation.md docs/learning docs/superpowers/specs/2026-11-16-llm-provider-routing-design.md docs/superpowers/plans/2026-11-16-llm-provider-routing.md
  git commit -m "docs: 补充 LLM Provider 路由说明"
  ```

### Task 6: 全量验证、推送和自动合并

**Files:**

- No new source files. Verify the complete branch.

- [ ] **Step 1: Run the full verification chain**

  ```bash
  pnpm check
  git diff --check
  git status --short --branch
  ```

  Expected: format check, lint, typecheck, all package tests and builds pass;
  the worktree is clean after the final commit.

- [ ] **Step 2: Push the feature branch**

  ```bash
  git push -u origin HEAD:refs/heads/feat/llm-provider-routing
  ```

- [ ] **Step 3: Create the Pull Request**

  Title:

  ```text
  feat: 增加 LLM Provider 路由
  ```

  The body should mention Provider Registry, Server-side configuration,
  Runtime routing, Studio provider selection and `pnpm check`. Do not paste
  the Feishu learning document into the PR.

- [ ] **Step 4: Enable automatic squash merge**

  ```bash
  gh pr merge <PR_NUMBER> --auto --squash --repo GitHubxxx17/Weave
  ```

  Wait for CI, verify the PR reaches `MERGED`, record the squash commit, and
  keep the remote feature branch because that is the current user preference.
