# Weave 插件内核接口设计

- 日期：2026-11-19
- 配套决策：ADR 0002（已接受）。基线 `main@0d64a2b`。
- 原则：**库还是库，插件只负责装配**。插件只依赖 `@weave/plugin` + `@weave/protocol`；现有分层方向不变。

## 1. 范围

内核只提供 6 种装配机制：服务、扩展点、钩子、作用域回收、Generation 快照、清单 + 信任。内核不含任何产品功能。现有 `@weave/plugin` 的 `registerTool`/`registerProvider` 路径在 Stage 1 保留可用，Stage 2 起逐步迁移到扩展点。

## 2. 分层与包边界

```text
protocol
  ↑
llm   session   workspace        纯库，不知道内核
  ↑
runtime                          Agent 循环 / Tool Pipeline 库代码，不知道内核
  ↑
@weave/plugin                    内核 + 全部接缝定义 + 插件作者类型
  ↑
packages/plugins/*               内置插件：把库装进内核
  ↑
apps/server | desktop | cli      宿主 = 一个 profile（选插件 + 配置）
studio                           仍只走 HTTP/SSE
```

ESLint 边界新增规则：

- 内置插件只能额外 import 它所包装的那个库；
- 任何插件不得 import 别的插件实现（只能经服务/扩展点交互）；
- `@weave/plugin` 不得 import 具体库实现（只依赖 `@weave/protocol` 类型与结构类型）。

## 3. 插件作者 API

```ts
// 来自 @weave/plugin
export interface PluginEnv {
  readonly manifest: PluginManifest;
  /** 提供一个服务实现（工厂可声明对别的服务的依赖）。返回 disposer。 */
  provide<T, D extends DepMap>(ref: ServiceRef<T>, impl: ServiceImpl<T, D>): Disposer;
  /** 消费一个服务（仅限 manifest.permissions 允许的 service:<id>）。 */
  use<T>(ref: ServiceRef<T>): ServiceHandle<T>;
  /** 向扩展点贡献内容；owner 初始化前可多次累加。返回 disposer。 */
  contribute<T>(point: ExtensionPoint<T>, contributor: (api: T) => void): Disposer;
  /** 注册钩子监听。返回 disposer。 */
  onHook<I, O>(hook: Hook<I, O>, handler: HookHandler<I, O>): Disposer;
  /** 注册本插件的持久事件类型（schema + 投影），类型名自动加前缀 <pluginId>/。 */
  defineEvent<P>(name: string, spec: PluginEventSpec<P>): Disposer;
  /** 本插件的 Zod 配置 schema；Studio 据此生成设置表单。 */
  config<C>(schema: ZodType<C>): ServiceHandle<C>;
  /** 作用域 AbortSignal：插件卸载 / 本 generation 失效时 abort。 */
  readonly signal: AbortSignal;
}

export interface WeavePlugin {
  readonly manifest: PluginManifest;
  setup(env: PluginEnv): void | Promise<void>;
  dispose?(): void | Promise<void>;
}

export function definePlugin(plugin: WeavePlugin): WeavePlugin;
```

`setup` 只拿到 `env`，拿不到宿主 `ctx`、fs、HTTP 对象。进程内这不是安全边界（插件仍能直接 `import 'node:fs'`），其价值是这套权限模型能原样搬到进程外插件（MCP / 子进程 / WASM）。

## 4. 服务 `ServiceRef<T>`

```ts
export type ServiceScope = 'root' | 'workspace' | 'session';

export interface ServiceRef<T> {
  readonly id: string;        // 'weave.tools.pipeline'
  readonly scope: ServiceScope;
  readonly multi: boolean;    // 默认 false=单实现；true=可多实现（收集为数组）
  readonly __type?: T;        // 仅类型携带，运行时为 undefined
}
export function defineServiceRef<T>(spec: {
  id: string;
  scope?: ServiceScope;       // 默认 'root'
  multi?: boolean;            // 默认 false
}): ServiceRef<T>;

export interface ServiceImpl<T, D extends DepMap = {}> {
  readonly deps?: D;                                           // { ws: workspaceRef }
  readonly factory: (deps: Resolved<D>, ctx: ServiceInitCtx) => T | Promise<T>;
  readonly dispose?: (value: T) => void | Promise<void>;
}
```

解析规则（**启动前校验**，失败即拒绝启动，错误定位到插件与引用 id）：

- **缺失依赖**：`deps` 的某 ref 无实现 → `plugin-service-missing-dependency`。
- **循环依赖**：拓扑排序检测环 → `plugin-service-cycle`，打印环路径。
- **重复实现**：`multi=false` 的 ref 有 >1 实现 → `plugin-service-duplicate`。`multi=true` 收集为稳定顺序数组。
- **作用域**：`session` / `workspace` 服务按会话 / 工作区惰性实例化并随其销毁；`root` 单例。依赖只能指向同级或更粗作用域（session → workspace → root），反向 → `plugin-service-scope-violation`。

这一步**取代** `apps/server/src/runtime.ts` 现在的 4 WeakMap + 3 WeakSet 手工装配：服务声明依赖后由容器拓扑装配，Agent Runner 不再需要"启动后再拼"。

## 5. 扩展点 `ExtensionPoint<T>`

```ts
export interface ExtensionPoint<T> { readonly id: string; readonly __api?: T; }
export function defineExtensionPoint<T>(spec: {
  id: string;
  singleSlot?: boolean;   // true=只允许一个实现（如 context.compaction）
}): ExtensionPoint<T>;
```

- 某个服务 / 插件是扩展点的 **owner**；其他插件 `env.contribute(point, api => api.addX(...))`。
- **初始化时机**：owner 在"本 generation 所有 `contribute` 跑完"后才读取聚合结果初始化（保证顺序无关）。
- 两类：**累加型**（`addTool` 可多次）与 **单槽型**（`set`，第二次 set → `plugin-extension-single-slot`）。

## 6. 钩子 `Hook`

```ts
export type HookMode = 'observe' | 'wrap' | 'decide';
export interface Hook<I, O = void> { readonly id: string; readonly mode: HookMode; }
export function defineHook<I, O = void>(spec: { id: string; mode: HookMode }): Hook<I, O>;

// observe：只读，并行，异常被隔离，不影响主流程与彼此
type ObserveHandler<I> = (input: I) => void | Promise<void>;
// wrap：洋葱中间件；必须调 next() 才继续；可改入 / 出参
type WrapHandler<I, O> = (input: I, next: (input: I) => Promise<O>) => Promise<O>;
// decide：安全决策；只能返回 deny | ask | abstain，不能返回 allow
type DecideHandler<I> = (input: I) => PolicyVote | Promise<PolicyVote>;
export type PolicyVote = 'deny' | 'ask' | 'abstain';
```

**decide 合并语义（核心红线）**：收集所有票，按 `deny > ask > abstain` 取最严；全 `abstain` → 放行。**没有任何插件能投 allow**。需要"放宽"时，插件只能提交一条**建议规则**，用户在设置里确认后变成用户自己的规则（不是插件自动批准）。

`wrap` 用于重试 / 超时 / 流包裹；`observe` 用于读事件。高频流（`text-delta`）**只给整条流的 wrap**，不逐条 observe，保证红线 ⑤（持久 vs 临时分离）。

## 7. Generation 快照与重载

```ts
export interface Generation {
  readonly id: number;
  readonly plugins: readonly PluginSnapshot[];
  resolve<T>(ref: ServiceRef<T>, scope?: ScopeKey): T;     // 该快照内的实现
  readonly tools: readonly RegisteredToolDefinition[];      // 固定工具集
  readonly promptSections: readonly PromptSection[];        // 固定提示段顺序
}
```

- 一个 **turn 在开始时 pin 一份 generation**，整轮工具集 / 提示前缀不变（利于 provider 前缀缓存）。
- 重载 = 构建**新 generation**，**从下一轮生效**；未变的插件实例在新快照里沿用。
- 必须立刻撤下的插件：可 `cancelTurn()` 取消正在跑的那一轮，再切新 generation。

## 8. Manifest 增补（向后兼容）

现有 `{ id, name, version, apiVersion, description?, capabilities[] }` 之上新增可选字段。下列字段已在 Stage 3.1 落地：

```ts
type PluginCapability = 'tool' | 'llm-provider' | 'prompt'; // 新增 'prompt'
type PluginHost = 'in-process' | 'mcp' | 'subprocess';
type PluginPermission =
  | 'workspace:read' | 'workspace:write' | 'process:spawn' | 'network:request'
  | `service:${string}`;                         // 内核唯一会强制的一类

interface PluginManifest {
  // …现有字段…
  host?: PluginHost;                             // 默认 in-process
  engines?: { weave: string };                   // 宿主 Weave 版本需满足的范围
  contributes?: {                                // 声明贡献的名字
    tools?: string[];                            // 工具名
    providers?: string[];                        // LLM provider id
    promptSections?: string[];                   // 提示词片段 id
    services?: string[];                         // 本插件 provide 的服务 id
  };
  permissions?: PluginPermission[];
}
```

`commands` / `events` / `ui` 三类贡献随各自的扩展点落地时再加入 `contributes`（新增可选键，向后兼容）。`capabilities` 保留（旧插件不变）。`contributes` / `permissions` 是声明式面：Studio 不运行代码即可列出插件加了什么、要什么权限。

**语义**

- **未声明即不校验，声明即封闭。** 没有 `contributes` / `permissions` 的插件行为与之前完全一致。一旦声明，该清单是封闭的：未列出的键视为空列表，贡献该类的任何名字都会被拒绝。
- **跨字段一致性**（解析 manifest 时检查，违反为 `plugin-invalid-manifest`）：`contributes.tools` 非空要求 `capabilities` 含 `tool`，`providers` 要求 `llm-provider`，`promptSections` 要求 `prompt`。每个列表内不得重复。
- **受治理的扩展点**：`weave.tools`、`weave.llm.providers`、`weave.prompt.sections` 各绑定一个 capability 与一个 `contributes` 键。向这些点贡献前，插件必须声明对应 capability（`env.contribute` 时抛 `plugin-capability-not-declared`，与旧路径 `registerTool` 的规则一致）。插件声明了 `contributes` 时，owner 回放贡献的那一刻逐个核对名字，不在清单内则抛 `plugin-contributes-exceeds-manifest`，该名字不会进入 owner。
- **服务**：声明了 `contributes` 的插件，`env.provide(ref)` 的 `ref.id` 必须在 `contributes.services` 内。
- **`permissions`**：内核只强制 `service:<id>`。声明了 `permissions` 的插件，经 `env.use` 或 `provide` 的 `deps` 使用的服务必须在列表内，本插件自己提供的服务除外；在 `setup` 结束后统一检查，违反为 `plugin-permission-denied`；`setup` 结束之后才调用的 `env.use` 即时检查。`workspace:*`、`process:spawn`、`network:request` 只是声明，供信任确认界面展示，内核不强制（进程内不是安全边界，见第 3 节；进程外宿主再由代理强制）。
- **`engines.weave`**：使用 semver 范围的子集，版本一律写完整的 `x.y.z`。支持 `*`、`1.x`、`1.2.x`，以及带可选前缀 `>=` `>` `<=` `<` `=` `^` `~` 的 `x.y.z`；多个条件用空格连接，表示"且"。不支持预发布标签、`||`、连字符范围和省略补零的简写（如 `>=1.2`），写法不受支持时 manifest 无效。内核与旧注册表通过选项 `hostVersion`（完整的 `x.y.z`）得知宿主的 Weave 版本；插件声明了 `engines` 而宿主没有提供 `hostVersion` 时一律拒载（不满足与无法判断都不放行），错误码 `plugin-engine-unsupported`。
- **`host`**：内核不解释，只记录。宿主 / 加载器据此决定如何装载，Studio 据此展示运行方式。

**校验时机**

| 检查 | 触发点 | 时机 | 错误码 |
|---|---|---|---|
| manifest 形状、跨字段一致性、`engines` 语法、权限词表 | `register()` 解析 | 注册 | `plugin-invalid-manifest` |
| `engines.weave` 与宿主版本 | `register()` | 注册 | `plugin-engine-unsupported` |
| 对受治理扩展点声明了对应 capability | `env.contribute` | `setup` 内 | `plugin-capability-not-declared` |
| `provide` 的服务在 `contributes.services` 内 | `env.provide` | `setup` 内 | `plugin-contributes-exceeds-manifest` |
| 使用的服务在 `permissions` 的 `service:<id>` 内 | `register()` 末尾 | 注册 | `plugin-permission-denied` |
| 贡献的名字在 `contributes.<key>` 内 | owner 回放贡献（`collect`） | owner 服务初始化 | `plugin-contributes-exceeds-manifest` |

最后一项发生在宿主 seal 之后首次解析 owner 服务时，宿主应在启动阶段立即解析（现有 server 装配已如此），使它等同于启动期错误。旧的 `createPluginRegistry` 路径同样遵守 `contributes` 与 `engines`：`registerTool` / `registerProvider` 的名字在 `setup` 内即时核对。

**已知缺口**：钩子（`onHook`）目前不在 `contributes` 内声明。钩子可以观察工具结果，将来还可以对工具调用投 `deny` / `ask`。信任确认界面（Stage 4）展示"插件要什么"之前，需要给 `contributes` 增补 `hooks` 键。

## 9. 内核接缝清单（现有库 → 服务 / 扩展点 / 钩子）

| 现有 | 接缝 | 层级 |
|---|---|---|
| Tool Registry + Pipeline (`createToolPipeline`) | `tools.pipeline` 服务；`tools` 扩展点（累加）；`tools.policy`（decide）、`tools.around`（wrap）、`tools.result`（observe） | core |
| Approval Broker (`createApprovalBroker`) | `approval.broker` 服务；`approval.channels` 扩展点（现 Studio 卡片） | core |
| Workspace policy / tools | `workspace` 服务（**session 作用域**，取代按 sessionId 反查）；`workspace-policy` core + `tools-fs` builtin | core / builtin |
| `@weave/llm` providers (mock / openai-compatible) | `llm.providers` 扩展点；`llm.router` 服务；`llm.request`（wrap：重试 / 超时） | builtin |
| `@weave/session` store (memory / sqlite) | `session.store` 服务；`session.events` 扩展点（类型 + 投影） | builtin |
| `@weave/workspace` projects | `projects.store` 服务 | builtin |
| Agent Runner (`createAgentRunner`) | `agent.loop` 服务（builtin，可替换）；`turn.start` / `step.before` / `turn.end` 钩子 | builtin |
| `agent-instructions.ts`（server） | `prompt.sections` 扩展点（`prompt-core` builtin；提示移进 runtime 侧插件） | builtin |
| recall / update_plan / command 工具 | 各自向 `tools` 扩展点贡献 | builtin |
| 未来命令 / 压缩 / UI | `commands` 扩展点、`context.compaction`（单槽）、`ui.contributions` | — |

## 10. 事件模型改造（`packages/session/src/events.ts`）

现在是封闭 `discriminatedUnion`。改为 **内核事件（固定）+ 插件事件（开放命名空间）**：

```ts
// 插件事件：type 形如 "git/commit-captured"，payload 由插件 schema 校验
const pluginEventSchema = z.object({
  type: z.string().regex(/^[a-z0-9-]+\/[a-z0-9-]+$/),
  payload: z.record(z.unknown()),   // 具体校验在投影注册表里按 type 做
});
export const newSessionEventSchema = z.union([coreEventSchema, pluginEventSchema]);
```

- 插件经 `env.defineEvent(name, { schema, project })` 注册；投影注册表按 type 路由。
- 卸载插件后：旧事件**保留**，投影时该 type 无注册 → **跳过**（会话仍能打开），不报错。
- 向后兼容：现有 core 事件 schema 不动；只是把"未知 type 直接拒绝"改成"core 严格 + 插件命名空间走注册表"。new / persisted 两套并集同步改。

## 11. 兼容与迁移

- Stage 1 内核落地时，`createPluginRegistry` 现有 `registerTool` / `registerProvider` 包装成"向 `tools` / `llm.providers` 扩展点贡献 + 单实现服务"，旧插件与现有 server 注册**零改动可跑**。
- Stage 2 把 server 的手工装配换成 profile（一组 builtin 插件 + 配置），分 2–3 个 PR，**行为不变、现有测试全绿**为验收线。

## 12. 校验与错误（新增错误码）

`plugin-service-missing-dependency` / `-cycle` / `-duplicate` / `-scope-violation`、`plugin-extension-single-slot`、`plugin-contributes-exceeds-manifest`（提供的服务或贡献的名字不在 `contributes` 内）、`plugin-permission-denied`（使用了 `permissions` 未授权的 `service:<id>`）、`plugin-engine-unsupported`（`engines.weave` 不满足，或宿主没有声明 `hostVersion`）。`plugin-capability-not-declared` 原本只用于旧路径，Stage 3.1 起内核路径向受治理扩展点贡献时同样适用。全部在**启动 / 注册时**抛出，不拖到运行时；贡献名字的核对发生在 owner 服务初始化时，时机见第 8 节的校验时机表。

## 13. 测试策略

- 内核单测：依赖解析顺序、缺失 / 循环 / 重复 / 作用域校验、扩展点累加与单槽、三类钩子语义（尤其 decide 合并 deny>ask>abstain、wrap 洋葱顺序、observe 隔离）、generation pin 与下一轮切换、回收 disposer。
- 迁移测：Stage 2 后 server 行为快照不变（现有 server / runtime / session 测试全过）。
- 事件：插件事件注册 → 追加 → 投影；卸载后旧事件被跳过且会话可打开。

## 14. 非目标（本轮不做）

进程外实际运行（MCP 之外的子进程 / WASM）、权限成为进程内安全边界、市场 / 安装器（M5 / Stage 6）。Studio 复杂面板沙箱 iframe 也留后。

## 15. Server 宿主（Stage 2 收尾）

`apps/server` 的手工装配收口为一个 `ServerHost`，由 `createServerRuntime` 创建并挂在返回的 Runtime 上（`runtime.serverHost`），取代原先的 4 个 `WeakMap` 与对 `createPluginRegistry` 的使用。

- **根服务仍由 Runtime 持有。** 审批 broker 与 Session Store 的创建和关闭属于宿主 Runtime 的生命周期（`runtime.get(approvalBrokerService)` 不变）。内置插件 `host-services` 把这两个实例作为 `weave.approval.broker`、`weave.session.store` 提供给内核插件，只借出，不销毁。工具与 provider 注册表同样由宿主持有，内置的 `tool-registry`、`provider-registry` 通过 `registry` 与 `existing: 'skip'` 选项把贡献收进宿主的注册表，重复回放是无害的。
- **旧插件路径是扩展点贡献。** `registerServerPlugins` 不再把工具与 provider 直接提交到注册表，而是用 `adaptLegacyPlugin` 把旧的 `registerTool` / `registerProvider` 插件改写成内核插件：旧 `setup` 只执行一次并在注册时校验（错误码与旧注册表一致），之后只重放暂存的工具与 provider。`createPluginRegistry` 仍然导出，供嵌入式宿主使用，server 不再使用它。
- **注册时机。** 旧插件必须在创建 Agent Runner 之前注册，之后注册会被拒绝。旧路径曾允许晚注册，但没有调用方依赖它，晚注册何时生效统一留给 Stage 4 的"下一轮生效"重载。
- **每个 runner 一个 kernel，装配顺序即工具顺序。** 顺序是：注册表与宿主服务、已注册的旧插件、`server-tool-host`（Tool Pipeline 与 server 自带工具）、`kernelPlugins`。模型看到的工具顺序因此仍是：旧插件工具、server 工具、内核插件工具，与重构前一致。装配失败时先销毁这个 kernel 再抛出。
- **销毁。** `disposeServerPlugins(runtime)` 先销毁各 runner 的 kernel，再销毁没有进过 kernel 的已注册插件，后注册的先销毁，每个插件的 `dispose` 至多执行一次。
