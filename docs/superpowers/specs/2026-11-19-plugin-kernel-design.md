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
type PluginCapability = 'tool' | 'llm-provider' | 'prompt' | 'event' | 'command'; // 'prompt'、'event'、'command' 为后增
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
    events?: string[];                           // 会话事件类型，形如 `<插件 id>/<名字>`
    commands?: string[];                         // 斜杠命令名
    services?: string[];                         // 本插件 provide 的服务 id
  };
  permissions?: PluginPermission[];
}
```

`ui` 类贡献随它的扩展点落地时再加入 `contributes`（新增可选键，向后兼容）；`events` 随 Stage 3.7、`commands` 随 Stage 3.8 加入。`capabilities` 保留（旧插件不变）。`contributes` / `permissions` 是声明式面：Studio 不运行代码即可列出插件加了什么、要什么权限。

**语义**

- **未声明即不校验，声明即封闭。** 没有 `contributes` / `permissions` 的插件行为与之前完全一致。一旦声明，该清单是封闭的：未列出的键视为空列表，贡献该类的任何名字都会被拒绝。
- **跨字段一致性**（解析 manifest 时检查，违反为 `plugin-invalid-manifest`）：`contributes.tools` 非空要求 `capabilities` 含 `tool`，`providers` 要求 `llm-provider`，`promptSections` 要求 `prompt`，`events` 要求 `event`，`commands` 要求 `command`。每个列表内不得重复。`events` 里的每个类型还必须是 `<插件 id>/<名字>` 的形状，且以本插件自己的 id 开头：插件只能在自己的命名空间里写事件；`commands` 里的名字是小写字母数字加连字符。
- **受治理的扩展点**：`weave.tools`、`weave.llm.providers`、`weave.prompt.sections`、`weave.session.events`、`weave.commands` 各绑定一个 capability 与一个 `contributes` 键。向这些点贡献前，插件必须声明对应 capability（`env.contribute` 时抛 `plugin-capability-not-declared`，与旧路径 `registerTool` 的规则一致）。插件声明了 `contributes` 时，owner 回放贡献的那一刻逐个核对名字，不在清单内则抛 `plugin-contributes-exceeds-manifest`，该名字不会进入 owner。
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
| `@weave/session` store (memory / sqlite) | `session.store` 服务；`session.events` 扩展点（类型 + 投影）；`session.plugin-events` 服务（插件事件注册表） | builtin |
| `@weave/workspace` projects | `projects.store` 服务 | builtin |
| Agent Runner (`createAgentRunner`) | `agent.loop` 服务（builtin，可替换）；`turn.start` / `step.before` / `turn.end` 钩子 | builtin |
| `agent-instructions.ts`（server） | `prompt.sections` 扩展点（`prompt-core` builtin；提示移进 runtime 侧插件） | builtin |
| recall / update_plan / command 工具 | 各自向 `tools` 扩展点贡献 | builtin |
| 斜杠命令（Stage 3.8） | `weave.commands` 扩展点（声明式提示词模板）；server 直接收集并经 `GET /commands` 提供 | core |
| 未来压缩 / UI 面板 | `context.compaction`（单槽）、`ui.contributions` | — |

## 10. 事件模型改造（`packages/session/src/events.ts`）

原先是封闭 `discriminatedUnion`。改为 **内核事件（固定）+ 插件事件（开放命名空间）**。Stage 3.7 已落地，细节见第 18 节。

```ts
// 插件事件：type 形如 "git/commit-captured"，payload 在 Store 里只确认是对象
const pluginEventSchema = z.object({
  type: z.custom<`${string}/${string}`>(/* 匹配 ^<段>/<段>$，段为小写字母数字加连字符 */),
  payload: z.record(z.string(), z.unknown()),
});
export const newSessionEventSchema = z.union([coreEventSchema, pluginEventSchema]);
```

- 插件经 `env.defineEvent(name, { schema, project? })` 注册，由宿主的插件事件注册表持有；Store 只检查信封，具体的 payload schema 由注册表在插件追加时检查。
- 卸载插件后：旧事件**保留**，投影时该 type 无注册 → **跳过**（会话仍能打开），不报错。读取和 `projectSession` 从不依赖注册。
- 向后兼容：现有 core 事件 schema 不动；只是把"未知 type 直接拒绝"改成"core 严格 + 带斜杠的插件命名空间"。new / persisted 两套并集同步改。

## 11. 兼容与迁移

- Stage 1 内核落地时，`createPluginRegistry` 现有 `registerTool` / `registerProvider` 包装成"向 `tools` / `llm.providers` 扩展点贡献 + 单实现服务"，旧插件与现有 server 注册**零改动可跑**。
- Stage 2 把 server 的手工装配换成 profile（一组 builtin 插件 + 配置），分 2–3 个 PR，**行为不变、现有测试全绿**为验收线。

## 12. 校验与错误（新增错误码）

`plugin-service-missing-dependency` / `-cycle` / `-duplicate` / `-scope-violation`、`plugin-extension-single-slot`、`plugin-contributes-exceeds-manifest`（提供的服务或贡献的名字不在 `contributes` 内）、`plugin-permission-denied`（使用了 `permissions` 未授权的 `service:<id>`）、`plugin-engine-unsupported`（`engines.weave` 不满足，或宿主没有声明 `hostVersion`）。`plugin-capability-not-declared` 原本只用于旧路径，Stage 3.1 起内核路径向受治理扩展点贡献时同样适用。`plugin-event-unknown`（追加了没有任何插件注册的事件类型，包括所有内核事件类型；或为没有投影的事件求投影）、`plugin-event-invalid`（事件的类型或名字形状不对、插件在别人的命名空间里定义事件、payload 不符合注册的 schema 或存不成 JSON 对象）。除了追加与投影事件时的检查发生在运行时，其余都在**启动 / 注册时**抛出，不拖到运行时；贡献名字的核对发生在 owner 服务初始化时，时机见第 8 节的校验时机表。钩子的错误码（`plugin-hook-invalid-vote` 等）见第 17 节。

## 13. 测试策略

- 内核单测：依赖解析顺序、缺失 / 循环 / 重复 / 作用域校验、扩展点累加与单槽、三类钩子语义（尤其 decide 合并 deny>ask>abstain、wrap 洋葱顺序、observe 隔离）、generation pin 与下一轮切换、回收 disposer。
- 迁移测：Stage 2 后 server 行为快照不变（现有 server / runtime / session 测试全过）。
- 事件：插件事件注册 → 追加 → 投影；卸载后旧事件被跳过且会话可打开。

## 14. 非目标（本轮不做）

进程外实际运行（MCP 之外的子进程 / WASM）、权限成为进程内安全边界、市场 / 安装器（M5 / Stage 6）。Studio 复杂面板沙箱 iframe 也留后。

## 15. Server 宿主（Stage 2 收尾）

`apps/server` 的手工装配收口为一个 `ServerHost`，由 `createServerRuntime` 创建并挂在返回的 Runtime 上（`runtime.serverHost`），取代原先的 4 个 `WeakMap` 与对 `createPluginRegistry` 的使用。

- **根服务仍由 Runtime 持有。** 审批 broker 与 Session Store 的创建和关闭属于宿主 Runtime 的生命周期（`runtime.get(approvalBrokerService)` 不变）。内置插件 `host-services` 把这两个实例作为 `weave.approval.broker`、`weave.session.store` 提供给内核插件，只借出，不销毁；其中 Session Store 是只接受插件已注册事件的受限视图（第 18 节），读取不受限。工具与 provider 注册表同样由宿主持有，内置的 `tool-registry`、`provider-registry` 通过 `registry` 与 `existing: 'skip'` 选项把贡献收进宿主的注册表，重复回放是无害的。
- **旧插件路径是扩展点贡献。** `registerServerPlugins` 不再把工具与 provider 直接提交到注册表，而是用 `adaptLegacyPlugin` 把旧的 `registerTool` / `registerProvider` 插件改写成内核插件：旧 `setup` 只执行一次并在注册时校验（错误码与旧注册表一致），之后只重放暂存的工具与 provider。`createPluginRegistry` 仍然导出，供嵌入式宿主使用，server 不再使用它。
- **注册时机。** 旧插件必须在创建 Agent Runner 之前注册，之后注册会被拒绝。旧路径曾允许晚注册，但没有调用方依赖它，晚注册何时生效统一留给 Stage 4 的"下一轮生效"重载。
- **每个 runner 一个 kernel，装配顺序即工具顺序。** 顺序是：注册表与宿主服务（`tool-registry`、`provider-registry`、`event-registry`、`host-services`）、已注册的旧插件、`server-tool-host`（Tool Pipeline 与 server 自带工具）、`kernelPlugins`。模型看到的工具顺序因此仍是：旧插件工具、server 工具、内核插件工具，与重构前一致。装配失败时先销毁这个 kernel 再抛出。
- **销毁。** `disposeServerPlugins(runtime)` 先销毁各 runner 的 kernel，再销毁没有进过 kernel 的已注册插件，后注册的先销毁，每个插件的 `dispose` 至多执行一次。

## 16. 插件列表接口（Stage 3.2）

Studio 不运行插件代码，就能列出已加载的插件加了什么、要什么权限。内核与 server 各出一半。

**内核**：`kernel.plugins()`（`Generation.plugins()` 是同一个函数）按注册顺序返回已加载的插件，每项是 `{ manifest, contributed }`。`contributed` 是插件实际放进内核的名字：`tools`、`providers`、`promptSections`、`events`、`commands` 由受治理的扩展点在 owner 回放贡献时记录，无论插件有没有声明 `contributes`；`services` 在 `setup` 里 `provide` 时即知。因此 owner 回放之前，前五类是空的，宿主应在装配完成后再读取。同一个名字重复回放只记一次，插件被销毁后不再列出。

**server**：`GET /plugins`，只读，响应 `{ plugins: PluginListItem[] }`，对象按装配时的注册顺序排列，指最近一个 Agent Runner 装配时加载的插件，没有 Agent Runner 时为空。

```ts
interface PluginListItem {
  id: string; name: string; version: string; description?: string;
  origin: 'builtin' | 'registered' | 'kernel';  // server 自带 | registerServerPlugins 注册的旧插件 | kernelPlugins
  host: 'in-process' | 'mcp' | 'subprocess';    // manifest 未写时为 in-process
  capabilities: ('tool' | 'llm-provider' | 'prompt' | 'event' | 'command')[];
  engines?: { weave: string };
  contributes?: { tools?: string[]; providers?: string[]; promptSections?: string[]; events?: string[]; commands?: string[]; services?: string[] }; // manifest 声明的清单，未声明则省略
  permissions?: string[];                        // manifest 声明的权限，未声明则省略
  provides: { tools: string[]; providers: string[]; promptSections: string[]; events: string[]; commands: string[]; services: string[] }; // 实际加入内核的名字
}
```

`contributes` / `permissions` 是插件声明的，`provides` 是实际发生的，二者可以不同：没有声明 `contributes` 的插件不受限制，所以 `provides` 才是它真实的足迹。接口本身没有写操作，启用 / 停用 / 重载属于 Stage 4。

**Studio**：右侧面板新增「插件」（面板种类 `plugins`，单实例，默认不固定，从面板的添加菜单打开）。列表按来源分为内置、已注册、扩展三组，每项可展开，查看实际提供的工具、模型提供方、提示词片段、会话事件、命令和服务，以及声明的权限与适用版本。面板打开时请求一次 `GET /plugins`，标题行的刷新按钮重新请求。Studio 不引用 `@weave/*`，自己定义响应类型，对不认识的来源、运行方式和能力原样显示，不让整个列表失败。

## 17. 钩子的落点（Stage 3.3 起）

钩子由宿主按各自的位置接线，位置决定了它能影响什么。下面逐个记录已落地的钩子。

### 17.1 `tools.around`（wrap）

包住一次完整的工具执行。落点在共享 Tool Pipeline 的**最外层**：`createToolPipeline` 新增选项 `around`，server 只在有插件注册了 `tools.around` 时才传入，没有时管线不被包装，行为不变。

- 中间件拿到的请求已经通过校验。它可以改写请求、重试（多次调用 `next`），或者不调用 `next` 直接作答。
- 因为它在管线最外层，被改写的请求仍然要经过参数校验和审批：审批弹出的是改写后的参数，重试会再次请求审批。这是有意的，插件不能在用户批准之后再改参数。
- 管线对返回值保持担保：结果必须仍是原调用的结果（`toolCallId`、`name` 不变），内容重新按字节上限截断，只保留 `toolCallId`、`name`、`content`、`truncated` 四个字段，不合规的结果报 `tool-execution-failed`。
- 中间件抛出的 `ToolExecutionError` 原样保留错误码，其他异常变为 `tool-execution-failed`，调用方已中止时变为 `tool-cancelled`。
- 洋葱顺序即注册顺序，先注册的在最外层。`tools.result` 的观察者看到的是 `around` 处理之后的最终结果。

### 17.2 `turn.start` / `turn.end`（observe）

宣告一个回合的开始与结束。落点在 **Session Store**，不在 Agent Runner 里。回合本来就把开始和结束记成会话事件：`turn.started`，以及完成、失败、取消三种结局都会写的 `turn.completed`。所以 server 用 `observeTurns` 包住交给 Agent Runner 的 Session Store，在这两类事件**成功追加之后**通知观察者，Runtime 不需要知道插件。

- 观察者不会看到存储没有记下的回合。它失败或抛出也不会撤销或隐藏已记录的事实，`turn.start` 失败不影响 `turn.end` 的通知。
- `turn.start` 带 `{ sessionId, turnId }`；`turn.end` 另带 `status`（`completed`、`failed`、`cancelled`）和可选的 `reason`（例如 `agent-step-limit`）。
- 没有插件注册这两个钩子时，Agent Runner 拿到的仍是原来的 Session Store。
- 处理函数会被等待，所以应当很快返回；它们的失败被隔离。
- 不逐条观察 `text-delta` 这类高频流事件，保持持久事实与临时状态的分离。

### 17.3 `tools.policy`（decide）

对每次工具调用投票，这是插件能影响安全结果的唯一入口，所以只能让结果更严。落点在共享 Tool Pipeline 内部：`createToolPipeline` 新增选项 `policy`，server 只在有插件注册了 `tools.policy` 时才传入，没有时行为不变。

**投票与合并**

- 票只有三种：`deny`、`ask`、`abstain`。没有 `allow`，任何插件都无法跳过审批或放宽权限模式。合并取最严：`deny > ask > abstain`，全部弃权则按原有流程走。
- 钩子的类型和运行时都拒绝 `allow`：处理函数返回别的值时，内核抛 `plugin-hook-invalid-vote`，管线把它按 `deny` 处理。

**落点**

- 在 `tools.around` 的里面，在参数解析校验之后、审批之前。因此 `around` 改写后的请求才是被评判的请求，中间件无法绕过策略；工具不存在、JSON 不合法或参数不合法的调用不会走到策略。
- `deny`：调用在审批之前结束，不创建审批，错误码 `tool-denied`。这个错误对模型是可恢复的，它会看到 `Tool "x" failed (tool-denied)` 并调整做法。
- `ask`：**必须经过审批**，而且无论工具自己有没有审批元数据、权限模式是 `ask`、`trust` 还是 `yolo`（完全访问）都一样：插件只能让结果更严，不会被模式放宽。工具有自己的审批元数据时，审批卡片沿用它（操作、风险、摘要）；没有时（例如只读工具）用通用卡片：操作 `plugin.policy`，风险 `medium`，摘要"插件策略要求确认工具 x 的调用"，附工具名和被截断到 1000 个字符的参数。没有审批 broker 时报 `tool-approval-required`，不会静默放行。
- 策略抛错、返回非法票、或在投票时出错，一律按 `deny` 处理（失败即关闭），错误信息区分"被策略拒绝"和"策略无法判定"，原因保留在 `cause`。

**已知限制**：投票时看不到是哪个插件投了哪一票，审计需要的"谁拒绝了"要等 Stage 4 的信任与权限界面一并设计。处理函数被等待，但一个一直不返回的策略不会让调用悬挂：调用方中止时报 `tool-cancelled`，到达工具超时时报 `tool-timeout`。

### 17.4 `llm.request`（wrap）

包住一个模型步骤的整条流，用于重试、超时、对发出的内容脱敏、对收到的流做转换。**只给整条流，不逐个分片**。落点在 Agent Runner：`createAgentRunner` 新增选项 `llmMiddleware`，server 只在有插件注册了 `llm.request` 时才传入，没有时行为不变。

中间件拿到 `{ request, signal }`，通过 `next` 取得模型的流，返回一条流。Runner 在中间件之外守住这些保证：

- **供应商和模型不能变**。用户选定的供应商和模型就是对话唯一会被发往的地方，中间件改写它们会把对话发到用户没有选的地方，所以 `next` 会拒绝换了供应商或模型的请求（报 `agent-stream-protocol`），模型不会被调用。其余字段（消息、采样参数）可以改写，这是脱敏等用途所需要的。
- **取消始终有效**。无论中间件传给 `next` 什么信号，传给模型的信号都与 Runner 自己的取消信号合并。
- **每个事件都要合法**。中间件产出的事件逐个按流协议的 schema 校验，不合法的报 `agent-stream-protocol`；缺少 `finish`、`finish` 之后还有事件等既有的协议检查对中间件的输出同样生效。
- **重试的边界**。中间件在产出第一个事件之前可以随意重试（再次调用 `next`）；产出之后事件已经到了消费者，再重试会重复，所以文档要求在产出之前重试。中间件自己抛出的错误和模型的错误一样结束这一回合。
- 洋葱顺序即注册顺序，先注册的在最外层。

故意的取舍：不限制请求里的 `tools` 字段，增删它只影响模型能看到什么，真正能执行什么仍由 Tool Pipeline 和它的策略、审批决定。也没有逐分片的观察钩子，那会把高频的临时流事件变成持久化接口。

## 18. 插件事件（Stage 3.7）

插件可以把自己的事实写进会话日志，并自己定义这些事实如何投影成状态。日志仍然只增不改，插件事件与内核事件共用同一条日志和同一个序号。

**类型与命名空间。** 插件事件的 `type` 是 `<插件 id>/<名字>`，两段都是小写字母数字加连字符。内核事件的类型从不含斜杠，所以两类不会撞名。`manifest.contributes.events` 列出完整类型，每个类型必须以本插件的 id 开头。`defineEvent` 自己拼出类型，直接向扩展点贡献别人命名空间里的类型会被拒绝（`plugin-event-invalid`）。

**三层各管一件事。**

| 层 | 管什么 | 不管什么 |
|---|---|---|
| `@weave/session` 的 Store | 信封：类型形如 `<段>/<段>`，payload 是对象；序号、时间、事件 id 仍由 Store 分配 | 谁拥有这个类型，payload 长什么样 |
| `@weave/plugin` 的注册表 | 每个类型的 schema 与可选投影；追加前 `parse`；按类型求投影 | 存储 |
| 宿主（server） | 给每个 kernel 一个注册表，把插件拿到的 Session Store 换成受限视图 | 业务语义 |

Store 不依赖注册，所以读取与 `projectSession` 在任何时候都能打开会话：卸载一个插件后，它的事件留在日志里，核心投影自然跳过未知类型。

**插件侧 API**

```ts
const noteAdded = env.defineEvent('note-added', {
  schema: z.object({ text: z.string().min(1) }),
  project: {                                    // 可选
    initial: () => [] as string[],
    apply: (notes, event) => [...notes, event.payload.text],
  },
});

const store = await env.use(sessionStoreRef).get();
await store.append(sessionId, [noteAdded.create({ text: '记一笔' })]);
const notes = noteAdded.project(await store.read(sessionId)); // 有 project 时才有
```

- `defineEvent` 需要 `event` 能力，是对受治理扩展点 `weave.session.events` 贡献的语法糖，返回的句柄只含 `type`、`create`，以及有投影时的 `project`。
- 事件在 kernel seal 之后、宿主解析 `weave.session.plugin-events` 时进入注册表（与工具、provider 同一时机）。在此之前不能追加。
- `schema` 的输出就是被存的内容：多余字段按 schema 的规则处理（zod 默认剔除）。`parse` 之后再走一遍 JSON 往返，因此内存 Store 与 SQLite Store 保存和读回的值一致；存不成 JSON 对象的 payload 报 `plugin-event-invalid`。
- 投影是纯函数的折叠：`apply(state, { sequence, occurredAt, payload })`。它只看自己类型的事件，**不再符合当前 schema 的旧事件被跳过**，不会让会话投影失败；日志只增不改，所以插件的 schema 要自己兼容想继续看到的旧形状。

**受限的 Session Store。** 插件通过 `weave.session.store` 拿到的不再是宿主的 Store，而是 `createPluginSessionStore(store, registry)`：

- `read` 原样透传（含内核事件，这与之前一致）。
- `append` 对每个事件先 `parse`：不是已注册的插件事件类型就报 `plugin-event-unknown`，**所有内核事件类型一律拒绝**，所以插件无法伪造回合、消息或工具结果；payload 不合 schema 报 `plugin-event-invalid`。一批里任何一个事件被拒，整批不写。
- `close` 什么也不做，Store 的生命周期属于宿主。
- server 自己的工具（`recall`、文件快照）继续用真实的 Store，不经过这一层。

**已知限制**

- 受限视图不区分是哪个插件在追加：插件 B 可以追加插件 A 已注册的事件类型，只要 payload 合 A 的 schema。进程内插件互相信任，这不是安全边界；要强制"只能写自己的"，需要每个插件一个 Store 视图，留给 Stage 4 与信任模型一起做。
- 追加的事件不会出现在 Agent 的实时流里，只在日志里。Studio 目前不展示插件事件，也没有读取它们的 HTTP 接口。
- 注册表属于单个 kernel，不跨 kernel 复用；同一类型定义两次会报 `plugin-registration-conflict`。
- 没有为插件事件做大小限制。

## 19. 命令（Stage 3.8）

插件贡献用户在输入框里用斜杠调用的命令。命令是纯声明的：一段提示词模板，不执行任何插件代码。这也是目前"声明式 UI"的全部范围：Studio 渲染插件给出的数据，没有插件的渲染代码进入浏览器。

```ts
interface PluginCommand {
  name: string;          // 斜杠后输入的名字：小写字母数字加连字符
  title: string;         // 选择器里显示的名称，1–80 字
  description?: string;  // 一句话说明，1–300 字
  prompt: string;        // 提示词模板，1–20000 字；`$ARGUMENTS` 标出用户在命令后输入的内容放哪里
}
```

**内核。** 能力 `command`；`contributes.commands` 列命令名；受治理的扩展点 `weave.commands`（`env.contribute(commandsExtensionPoint, (api) => api.addCommand({...}))`）。贡献时校验形状，不合格报 `plugin-invalid-definition`，名字不在 `contributes.commands` 内报 `plugin-contributes-exceeds-manifest`。

**server。** 装配 kernel 时由宿主直接收集（与提示词片段一样，宿主持有，没有单独的 owner 服务）。命令名在整个 Server 内唯一：两个插件贡献同一个名字，装配失败并报 `plugin-registration-conflict`，信息里列出两个插件的 id。`GET /commands` 只读，响应 `{ commands: CommandListItem[] }`，`CommandListItem` 是 `PluginCommand` 加上贡献它的 `pluginId`，按注册顺序排列，指最近一个 Agent Runner 装配时的命令，没有 Agent Runner 时为空。

**Studio。** 草稿以 `/` 开头且还没有空白时弹出选择器，按名字前缀或标题包含过滤，最多列 8 条。↑ ↓ 选择，Enter 或 Tab 采用，Esc 关闭，继续输入会重新打开。

- 采用一个命令，是把模板展开进输入框：`$ARGUMENTS` 被去掉，光标停在它原来的位置，用户可以先改再发送。
- 直接键入 `/名字 参数` 并发送，发送前按同一规则展开：参数替换 `$ARGUMENTS`；模板里没有 `$ARGUMENTS` 时，参数接在模板后面，隔一个空行。
- 不认识的 `/xxx` 原样发送。
- 展开后的文本就是发出去的用户消息，所以用户看到的就是发给模型的内容，也是会话里记下的内容。
- 选择器在草稿第一次以 `/` 开头时才请求命令列表，每次重新打开都会刷新。

**已知限制**

- 命令只能展开成文本，不能执行代码、调用工具或写会话事件。需要处理函数的命令要等 Stage 4 的信任模型。
- 没有参数结构与补全。
- 命令名全局唯一，没有 `/插件:命令` 的限定写法。
- 复杂的面板（插件自带组件）仍留后，需要沙箱 iframe（第 14 节）。
