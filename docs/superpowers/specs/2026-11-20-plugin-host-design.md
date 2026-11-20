# Weave 本地插件加载与信任确认设计（Stage 4）

- 日期：2026-11-20
- 状态：决策 D1 到 D10 已按推荐全部确认（2026-11-20），记录在 ADR 0003。实现从 4.1 开始。
- 基线：`main@14708f1`（Stage 3 与 2c 收尾已合入）。
- 配套：ADR 0002《Typed Plugin Kernel》、ADR 0003《Local Plugin Loading and Trust》、《Weave 插件内核接口设计》（`2026-11-19-plugin-kernel-design.md`）。
- 范围：ADR 0002 的 Stage 4。用户把进程内插件放进插件目录，在 Studio 里审阅它声明了什么，确认信任后从下一回合起生效。撤销信任、停用同理。

## 0. 已确认的决策

D1 到 D10 已按推荐全部确认。下表保留为记录。对照 DeepSeek Harness 之后新增的五条调整（B1 到 B5）见第 17 节，也记录在 ADR 0003。

| # | 问题 | 推荐 | 备选与代价 |
|---|---|---|---|
| D1 | 插件放在哪 | `<数据目录>/plugins/`，macOS 是 `~/Library/Application Support/Weave/plugins`。`WEAVE_PLUGINS_DIR` 可覆盖，解析规则与 `weave.sqlite` 一致 | ADR 写的是 `~/.weave/plugins/`。现有数据目录不在那里，沿用会多出一个要解释的目录 |
| D2 | 插件长什么样 | 目录 + `weave-plugin.json` + 一个打包好的 ESM 入口。宿主把 SDK 传给入口导出的工厂函数，插件不 `import '@weave/plugin'` | 用 Node 模块解析钩子，让 `import '@weave/plugin'` 指向宿主实例。写法自然，但钩子在 Electron 和 vitest 里都没验证过 |
| D3 | 声明是否必须封闭 | 本地插件必须写 `contributes` 和 `permissions`（可以为空），并新增 `contributes.hooks`。没写就是 `invalid` | 允许开放清单，信任对话框就说不清插件最多能做什么 |
| D4 | 信任绑定什么 | 插件 id + 整个目录的 SHA-256。任何字节变化都回到「已变更」，要重新确认，对话框展示声明差异 | 只绑 id + version。简单，但同版本号下的改动发现不了 |
| D5 | 本阶段范围 | 只做用户级：信任、启用、停用。项目级 `.weave/plugins.json` 和项目自带插件代码放到 4b | 现在就做项目级，要让多个 generation 同时存在，改动面大一倍 |
| D6 | 加载失败怎么办 | 单个插件失败只跳过它并报告。装配错误能归因到某个插件时同样处理。归因不了就保留旧 generation，启动时退回只有宿主插件 | 任何错误都整体失败，一个坏插件会让 Agent 起不来 |
| D7 | 何时生效 | 默认下一回合。信任、启用、停用之后自动重载，另有手动「重新加载」，不监听文件。撤销信任和停用可以勾「立即生效」，取消进行中的回合 | 监听文件热重载，开发方便，但会在用户不知情时换掉插件 |
| D8 | 信任记录怎么存 | SQLite 里的追加式事件表，当前状态由事件折叠得到，可审计 | 可变的 `plugin_trust` 表。更简单，但没有历史，也不符合"持久事实只追加" |
| D9 | 本地接口要不要加固 | 插件写接口要求 `application/json`、回环 `Host`、匹配的 `Origin`，信任请求必须带用户看到的摘要 | 和现有接口一样不加固。信任接口就成了"本机任意网页都能触发运行代码"的入口 |
| D10 | 给第三方插件什么服务视图 | 审批 broker 只给 `request`、`get`、`list`、`subscribe`，不给 `approve`、`reject`、`cancel`、`expire` | 只靠对话框提示。现状是整个 broker 都交出去，插件能自己批准自己的工具调用 |

设计还牵出四处与现有代码的出入，不需要决策，但决定实现量：工具与 provider 注册表不是按 generation 的、会话串行队列是每个 Runner 一份、工具重名现在被静默跳过、Studio 开发代理缺 `/plugins` 和 `/commands`。分别见第 8.3 节和第 11.4 节。

## 1. 范围

**做**

- 发现磁盘上的本地插件。不执行任何插件代码，就能展示它的声明。
- 用户信任（按内容摘要）、撤销、启用、停用，记录可审计。
- 加载：校验摘要，导入入口，注入 SDK，交给内核装配。
- Generation 切换：下一回合生效，进行中的回合不受影响，旧 generation 在最后一个回合结束后销毁。
- 对内核补齐第三方插件需要的东西：`contributes.hooks`、可归因的错误、SDK、受限审批视图。
- Studio：插件面板显示状态，信任对话框，重新加载。

**不做**

- 安装器、市场、签名（Stage 6）。MCP 和进程外插件（Stage 5、6）。
- 强制权限。进程内插件不是安全边界，`permissions` 只是声明。
- 项目级启用/停用，项目自带插件代码（4b，见第 15 节）。
- 文件监听热重载，插件开发模式（按目录信任）。
- 复用未变化插件的实例（内核设计文档 §7）。本阶段每次重载整体重建。
- 插件配置表单（`env.config`），插件私有数据目录。

## 2. 威胁模型

| 场景 | 应对 | 残余风险 |
|---|---|---|
| 插件被放进目录，用户不知情（解压、同步盘、别的工具写入） | 发现阶段只读 JSON，永不 `import`。未信任的插件不执行 | 无 |
| 已信任的插件被改动（升级或篡改） | 摘要变了就回到「已变更」，要重新确认。加载前再算一次摘要 | 校验到 `import` 之间有极小的竞态。能写用户文件的本机攻击者本来就能改 Weave 自己，不在范围内 |
| 网页触发信任（CSRF、DNS rebinding） | 写接口加固（第 10.3 节），信任请求必须带摘要 | 开发模式没有配置 `studioOrigin` 时，回环上的其他本机网页仍能发请求 |
| 声明与行为不符 | 对话框明说声明不是限制，同时展示来源路径和摘要。进程内无法强制 | 信任一个说谎的作者，代价是完整权限。强制要等 Stage 5、6 |
| 插件借内核服务越权：批准自己的审批、注册声明之外的工具、读写别人的会话 | 封闭清单、现有的服务权限检查、受限审批视图（D10）、受限会话 Store（已有） | 进程内插件可以直接 `import` 任何东西，这些只防"按内核 API 写的越权" |
| 克隆来的仓库自带插件 | Stage 4 不加载项目目录里的任何插件代码 | 无。4b 再设计工作区信任 |

不在范围内：本机已被入侵，插件把事件循环卡死（进程内防不住，只能超时后报告），插件依赖链的供应链风险（要求打包，摘要覆盖目录里的所有文件）。

## 3. 总览

```text
<插件目录>/<插件>/weave-plugin.json + 入口 .js
        │  发现：读 JSON，算摘要，不执行任何插件代码
        ▼
候选：ready / invalid / incompatible
        │  与信任记录合并
        ▼
状态：pending-trust / changed / disabled / 待加载
        │  用户在 Studio 确认信任（POST /plugins/:id/trust，带摘要）
        ▼
加载器：再算一次摘要 → import(入口) → 工厂(sdk) → KernelPlugin
        ▼
装配：宿主插件 + 本地插件 → 候选 generation（失败的插件被隔离）
        ▼
切换：新回合用新 generation，进行中的回合留在旧的，旧的在最后一个回合结束后销毁
```

新增 `@weave/plugin-host` 包放发现、摘要、信任、加载、装配编排和切换门面。HTTP 路由、SQLite 信任库和装配的具体内容（`assembleAgentKernel`、`createAgentRunner`）留在 `apps/server`。

## 4. 插件包格式

### 4.1 目录与清单

```text
<插件目录>/
  hello-commands/          目录名随意，插件 id 以清单为准
    weave-plugin.json
    index.js
```

`weave-plugin.json`：

```json
{
  "schemaVersion": 1,
  "entry": "index.js",
  "manifest": {
    "id": "hello-commands",
    "name": "Hello Commands",
    "version": "1.0.0",
    "apiVersion": "1.0.0",
    "capabilities": ["command"],
    "contributes": { "commands": ["hello"] },
    "permissions": []
  }
}
```

规则：

- 清单文件不超过 64 KB，必须是合法 JSON，`schemaVersion` 目前只有 1。
- `manifest` 由现有的 `pluginManifestSchema` 校验，另加三条本地插件规则：`host` 缺省或为 `in-process`（其它值算 `incompatible`，留给 Stage 5、6）；`contributes` 和 `permissions` 必须声明（可以为空）；id 不得与宿主已占用的插件 id 相同（内置、已注册、`kernelPlugins`）。
- `entry` 是相对路径，扩展名 `.js` 或 `.mjs`，`realpath` 之后必须仍在插件目录内。不允许绝对路径、`..` 和跨目录的符号链接。
- 目录里出现任何符号链接（`.git` 不计），整个插件 `invalid`，因为摘要无法保证内容稳定。
- 同一个 id 出现在两个目录里，两个都 `invalid`（`duplicate-id`），不去猜哪个对。
- 清单是独立的 JSON，因为展示声明不能靠执行代码。

### 4.2 入口模块与 SDK

```ts
export type PluginFactory = (sdk: PluginSdk) => PluginModule | Promise<PluginModule>;

export interface PluginModule {
  setup(env: PluginEnv): void | Promise<void>;
  dispose?(): void | Promise<void>;
}
```

- 入口默认导出一个工厂。工厂在信任之后、重载的加载这一步才被调用（早于装配），返回 `setup` 和 `dispose`。`manifest` 永远取自清单 JSON，也就是用户批准的那一份。模块如果自带 `manifest`，必须与清单逐字段相等，否则报 `plugin-manifest-mismatch`。
- `PluginSdk` 是创作词汇表，不是内核。它是一个冻结的对象，内容正好是下面这些，多一个少一个都是 API 变更（测试里有一份清单）：
  - 创作工具：`defineServiceRef`、`defineExtensionPoint`、`defineHook`，与宿主同一份的 `z`（zod），`apiVersion`。
  - 服务引用：`approvalBrokerRef`（受限视图，见 9.4）、`pluginEventsRef`、`sessionStoreRef`（只接受插件注册过的事件）。
  - 扩展点：`toolsExtensionPoint`、`commandsExtensionPoint`、`llmProvidersExtensionPoint`、`promptSectionsExtensionPoint`。
  - 钩子：`toolPolicyHook`、`toolAroundHook`、`toolResultHook`、`llmRequestHook`、`turnStartHook`、`turnEndHook`。
  - 刻意不给：`toolRegistryRef`、`toolPipelineRef`、`agentRunnerRef`、`llmProviderRegistryRef`（拿到它们的插件可以绕过贡献流程，直接改注册表、直接执行工具或起一轮 Agent）和 `eventsExtensionPoint`（事件走 `env.defineEvent`）。也不含 `createPluginKernel`、`ServiceContainer`、`createPluginEnv`、`createPluginSessionStore`、`createRestrictedApprovalBroker`、旧注册表等宿主专用 API。需要时再按用例逐个加，加一个不破坏已有插件，收回一个会。
- 为什么注入，而不是让插件 `import '@weave/plugin'`：插件目录在仓库之外，Node 解析不到这个包。让插件自带一份副本，会出现两份内核词汇表。内核按 id 匹配，所以还能工作，但 `instanceof PluginError` 之类会失效，版本也会漂移。注入保证只有一份，也让"SDK 就是插件能拿到的全部宿主 API"成为一条清晰的边界。类型照常用仅类型导入从 `@weave/plugin` 取。
- 插件自己的依赖由作者打包进入口文件。摘要覆盖整个目录，所以打包成单文件最简单。

### 4.3 示例

```js
// hello-commands/index.js
export default (sdk) => ({
  setup(env) {
    env.contribute(sdk.commandsExtensionPoint, (api) => {
      api.addCommand({
        name: 'hello',
        title: '打招呼',
        prompt: '请用一句话向我打招呼：$ARGUMENTS',
      });
    });
  },
});
```

这是一个纯声明的插件，信任后输入框里的 `/hello` 就可用了。

## 5. 发现与状态

### 5.1 发现

时机：服务启动、`POST /plugins/reload`、信任或启用或停用之后。

只扫描插件目录的一级子目录，跳过隐藏目录和没有 `weave-plugin.json` 的目录，最多 200 个（超出的忽略，结果带 `truncated`）。目录本身不存在不算错误，结果带 `exists: false`。一级子目录本身是指向目录的符号链接时报 `invalid`，不跟随，因为摘要无法保证它的内容稳定。目录按名字的 UTF-8 字节序排列，结果的顺序因此确定。每个目录产出一个候选：

- `ready`：清单合法，附摘要。
- `invalid`：JSON 坏了、schema 不过、入口缺失或逃逸、目录过大、含符号链接或特殊文件、读取出错、id 重复或被占用。附错误码和说明。
- `incompatible`：`apiVersion` 或 `engines.weave` 不满足，或 `host` 不是进程内。提前给出友好的状态，不留到装配时才报错。兼容性在入口与摘要之前检查，所以不兼容的插件不读取它的内容，也不会因为别的毛病被报成 `invalid`。

同一个 id 出现在两个目录里，两个都 `invalid`（`plugin-duplicate-id`）；id 与宿主占用的 id 相同，`invalid`（`plugin-id-reserved`）。只有清单合法的候选（`ready`、`incompatible`）参与这两项判断，已经 `invalid` 的不会连累别人。

### 5.2 状态

| 状态 | 含义 | 用户可做 |
|---|---|---|
| `pending-trust` | 新插件，从未被信任 | 审阅并信任 |
| `changed` | 曾被信任，但摘要变了 | 审阅差异并重新信任，或撤销 |
| `disabled` | 已信任，用户停用了 | 启用，或撤销 |
| `loaded` | 已信任、已启用，在当前 generation 里 | 停用，或撤销 |
| `failed` | 已信任、已启用，但加载或装配出错，附错误 | 查看错误，停用，或撤销 |
| `invalid` | 清单或目录有问题，附原因 | 只读 |
| `incompatible` | 与当前 Weave 版本或运行方式不兼容 | 只读 |

由候选和信任记录合并得到：

```text
invalid / incompatible        → 同名状态
没有信任记录                    → pending-trust
信任的摘要 ≠ 当前摘要           → changed
已停用                         → disabled
其余                           → loaded 或 failed，取决于最近一次重载的结果
```

`failed` 不持久化。下次启动或重载时重新尝试。`@weave/plugin-host` 的 `resolveLocalPlugins` 只做上面这张图的前半：它给出 `invalid`、`incompatible`、`pending-trust`、`changed`、`disabled`，以及"可以加载"的 `eligible`。`eligible` 变成 `loaded` 还是 `failed`，由重载（4.4）按装配结果决定，因为只有宿主知道装配成没成。

状态转移：

- `pending-trust` → `loaded`：信任，装配成功。→ `failed`：信任，装配出错。
- `loaded` → `disabled`：停用。→ `pending-trust`：撤销信任。→ `changed`：重新发现时摘要变了。
- `disabled` → `loaded`：启用。→ `pending-trust`：撤销信任。
- `changed` → `loaded`：重新信任。→ `pending-trust`：撤销信任。
- `failed` → `loaded`：下次重载成功。→ `disabled` 或 `pending-trust`：停用或撤销。

### 5.3 摘要

```text
文件   = 目录下所有常规文件，不含 .git、.DS_Store、Thumbs.db（任意深度）
条目   = 相对路径（POSIX 分隔，按 UTF-8 字节序排序）
digest = sha256( 对每个条目：utf8(路径) 0x00 十进制(大小) 0x00 内容的 sha256（64 位小写十六进制）0x0a )，结果同样是 64 位小写十六进制
```

- 上限 1000 个文件、总计 20 MB，超出就 `invalid`（`plugin-too-large`），提示"请打包成单文件"。
- 只允许常规文件和目录。符号链接、套接字、设备文件一律 `invalid`（`plugin-unsupported-file`）。
- 清单文件也在摘要里，所以声明变了摘要就变。
- 摘要在发现时计算，加载前再算一次，与信任记录比对。

## 6. 信任

### 6.1 信任的含义

进程内插件与 Weave 同权限：它能读写你能访问的任何文件、联网、执行命令，也能读到所有会话和 provider 密钥所在的内存。`permissions` 是插件对自己的说明，进程内无法强制。所以**信任一个本地插件，就是信任它的作者**。信任对话框的文案按这个事实写（第 11.2 节），不暗示沙箱。

ADR 0002 的决策 4 是第三方插件先走 MCP。进程内插件是给你自己写的，或你读过源码的插件用的。

### 6.2 信任记录

```ts
type PluginTrustEvent =
  | { kind: 'trusted'; pluginId: string; digest: string; manifest: PluginManifest }
  | { kind: 'revoked'; pluginId: string }
  | { kind: 'enabled'; pluginId: string }
  | { kind: 'disabled'; pluginId: string };
// 每个事件另带 sequence、occurredAt、scope（现在恒为 'user'，为 4b 预留）
```

- 追加式。当前状态由折叠得到：最近一次 `trusted`（其后没有 `revoked`）给出信任的摘要与声明快照，其后最近的 `enabled` 或 `disabled` 给出开关，默认启用。
- `PluginTrustStore` 是接口：`append(event)`、`events()`。`@weave/plugin-host` 提供接口、折叠函数和内存实现；SQLite 实现放在 `apps/server`，与 `provider-settings-store.ts` 同一模式，表名 `plugin_trust_events`，在 `weave.sqlite` 里。
- 记录在用户数据目录里，不在任何项目目录内，所以仓库没有办法"自带信任"。

### 6.3 确认流程

1. Studio 打开插件面板，调用 `POST /plugins/reload`（没变化就不重建），得到列表。`pending-trust` 的项带着它的声明，这些声明来自磁盘上的清单，没有执行任何代码。
2. 用户点「审阅并信任」，看到对话框（第 11.2 节），点「信任并启用」。
3. `POST /plugins/:id/trust`，请求体 `{ digest }`，就是对话框里显示的那个摘要。服务端重新发现该插件。当前摘要与请求的不同，返回 `409 plugin-digest-mismatch`，让用户重新审阅，因为他看到的不是现在磁盘上的内容。
4. 摘要一致：追加 `trusted`，触发重载，返回新的列表。
5. 重载成功，下一回合起生效。装配失败，该插件显示 `failed` 和错误。信任记录保留，用户可以停用或撤销。

### 6.4 升级与差异

`changed` 时对话框顶部写"这个插件已更新，请重新确认"，并对照上次信任时保存的声明快照，列出：版本 a → b；`capabilities`、`contributes`、`hooks`、`permissions` 里新增和移除的项，新增的高影响项加醒目标记。声明没变而代码变了，也要明说"声明没有变化，但代码已更新"。

### 6.5 撤销与停用

- 撤销信任：追加 `revoked`，回到 `pending-trust`。
- 停用：追加 `disabled`，信任保留，再启用不需要重新确认（摘要没变的前提下）。
- 两者都重载，默认下一回合生效。进行中有回合时，对话框里出现「立即生效（取消进行中的回合）」，勾上就取消 pin 在旧 generation 上的所有回合。

### 6.6 不走信任的

内置插件、`registerServerPlugins` 注册的旧插件、`kernelPlugins` 传入的插件，本来就是宿主代码，不经过信任，也不出现在本地插件的状态机里。

### 6.7 管理入口只给人

没有任何模型能调用的工具可以信任、启用、停用、撤销或重载插件，这些操作只能从 Studio 和带加固的本地 HTTP 路由发起（B2）。DeepSeek Harness 把 `plugin_manager` 开放成 agent 工具，靠逐次审批兜底；Weave 不给提示词注入留一条通向新代码的路径。

加载什么，只由信任记录和插件目录决定。没有配置即代码，也没有别的持久化入口能让一个已撤销的插件继续加载（B3、B4）。

## 7. 加载器

`loadLocalPlugin(record, { sdk })`：

1. 重新计算摘要，与信任记录不符就报 `plugin-digest-mismatch`，状态回到 `changed`。
2. 构造 `file:` URL，加上 `?digest=<摘要>`，调用 `import()`。Node 的 ESM 模块按 URL 缓存且不能卸载，查询串让更新后的文件拿到新的模块实例。
3. `default` 必须是函数，否则 `plugin-invalid-module`。`await factory(sdk)`，结果用 zod 校验：`setup` 是函数，`dispose` 可选，`manifest` 如果有必须与清单相等。
4. 组装 `KernelPlugin`：`manifest` 取自清单 JSON，`setup` 和 `dispose` 取自模块。

错误都带 pluginId：

| 错误码 | 何时 |
|---|---|
| `plugin-digest-mismatch` | 加载前摘要与信任记录不符 |
| `plugin-load-failed` | `import()` 抛错（语法错误、顶层代码抛错）或工厂抛错 |
| `plugin-invalid-module` | 没有默认导出函数，或返回值形状不对 |
| `plugin-manifest-mismatch` | 模块自带的 `manifest` 与清单不一致 |
| `plugin-setup-timeout` | `setup` 超过时限（默认 10 秒） |

`import()` 本身会执行模块顶层代码，所以加载器只会在信任确认之后调用，发现阶段永远不碰它。

## 8. Generation 与重载

### 8.1 重载流程

`@weave/plugin-host` 对外是一个 `PluginHost`：

```ts
interface PluginHost<Runner> {
  readonly runner: Runner;                          // 稳定的门面，只创建一次，交给 HTTP 层
  list(): readonly LocalPluginRecord[];             // 最近一次发现的快照，不扫描磁盘
  reload(): Promise<ReloadResult>;
  trust(id: string, digest: string): Promise<ReloadResult>;
  revoke(id: string, options?: { immediate?: boolean }): Promise<ReloadResult>;
  setEnabled(id: string, enabled: boolean, options?: { immediate?: boolean }): Promise<ReloadResult>;
  dispose(): Promise<void>;
}
```

装配由 Server 注入：`assemble(localPlugins) → { runner, dispose, ... }`，内部就是今天的 `assembleAgentKernel` 加 `createAgentRunner`。`PluginHost` 不知道 HTTP，也不知道 Agent 的细节。

`PluginHost.reload()`，同一时刻只跑一个，排队的请求合并：

1. 重新发现，与信任记录合并，得到要加载的集合 `L`（已信任、已启用、摘要未变），按 id 排序，保证顺序确定。
2. `L`（id 加摘要）与当前 generation 尝试装配的集合相同，并且其中没有 `failed` 的插件，就直接返回 `unchanged`，不重建。有 `failed` 的会重试，所以"重新加载"能让临时故障恢复。
3. 逐个加载（第 7 节）。失败的标 `failed`，不进入装配。
4. 装配 `assemble(L)`。内核的 `register` 在 `setup` 抛错时已经回收了该插件的注册。超时内核不管：`PluginHost` 给每个 `setup` 包一层限时（默认 10 秒），超时就丢弃这次候选 kernel（插件的 `signal` 随之 abort），并把该插件标 `failed`。装配或回放贡献时抛出带 `pluginId` 的 `PluginError`，同样把该插件标 `failed`、从集合中去掉，重新装配，最多重试 `|L|` 次。
5. 成功就切换。失败且无法归因，保留当前 generation，返回错误。启动时没有当前 generation，就用空集合装配，也就是只有宿主插件，所有本地插件标 `failed`。

### 8.2 回合 pin 与销毁

`@weave/plugin-host` 提供 Runner 门面（对 `AgentRunner` 的形状是泛型的），Server 把它交给 HTTP 层，只创建一次。

- `run(request)` 返回的迭代器在第一次 `next()` 时才开始排队。轮到它时，同一会话更早的回合都已结束，它取**此刻**的当前 generation，计数加一，用该 generation 的 Runner 执行。结束、提前 `return()` 或抛错时计数减一。
- 回合只 pin 在开始那一刻的 generation。排队等待期间发生的切换，它开始时会看到，所以"重载之后的下一回合"一定用新的。
- 某个旧 generation 计数归零就销毁：`kernel.dispose()`，注销它登记的 provider。
- 立即生效：每个 generation 有一个 `AbortController`，合并进它名下回合的 `request.signal`。取消就 abort 它，回合照常记为 `cancelled`。
- 关闭服务器：取消所有回合，销毁所有 generation。

### 8.3 必须按 generation 隔离的东西

| 东西 | 现状 | 要求 |
|---|---|---|
| Tool Registry | `ServerHost` 持有的全局注册表，接口只有 `register`、`get`、`list`，没有 `remove` | 每个 generation 一个新注册表。否则被移除的插件的工具会一直留在注册表里。`serverHost.toolRegistry` 改为读当前 generation 的 |
| 工具重名 | 现在用 `existing: 'skip'` 保持重复装配无害，重名的工具被静默丢弃，用户不知道 | 每代一个新注册表之后不需要 `skip`。重名变成装配错误，经第 9.2 节归因到后到的插件，显示为该插件 `failed` |
| Provider Registry | 全局，用户在设置里配的 provider 也在其中。接口有 `remove` | 插件注册的 provider id 由其 generation 登记，销毁时只在仍属于自己时移除（比较 client 对象）。否则新旧 generation 登记同一个 id 时，旧的销毁会把新的删掉。进行中的回合开始时已取得 client，不受影响 |
| 会话串行队列 | `createAgentRunner` 内部一个 Map，每个 Runner 实例一份。两个 generation 的 Runner 互不知道 | 门面接管"同一会话的回合按序执行"，新回合等同一会话更早的回合结束，不论它在哪个 generation 上 |
| 插件事件注册表、提示词审计、回合观察者 | 已经是每个 kernel 或每个 Runner 一份 | 不变 |
| 审批 broker、会话 Store | Runtime 级单例 | 不变，所有 generation 共享 |
| 插件模块的顶层状态 | Node 按 URL 缓存模块 | 同一摘要的重载共用同一个模块实例，顶层状态被新旧 generation 共享。插件应把状态放进 `setup` 或服务里。这条写进作者文档 |

### 8.4 取舍

- 每次重载重建所有插件的 `setup`，不复用实例。简单，且服务状态不会跨 generation 泄漏。代价是 `setup` 会被执行多次（每次重载、归因重试），所以 `setup` 必须幂等，重活放进服务工厂（seal 之后才惰性执行）。
- 模块不能卸载，每个新摘要会多留一份模块在内存里。长期运行且频繁改插件的场景才有感觉。
- 回合 pin 保持了一轮内工具集、提示前缀不变，有利于 provider 的前缀缓存。插件集变了才会让缓存失效。DeepSeek Harness 的 HMR 立即作用于所有会话，它的文档也承认重载可能改变后续请求的前缀。
- 不监听文件，也不做配置即代码（B3）。Harness 的热重载让改动在几秒内生效，第三方审计把它列为投毒途径。Weave 里插件集只因用户的明确操作而变，作者改完代码要手动点一次「重新加载」。
- 重载失败保留旧 generation。Harness 的做法是替换失败的插件停在未运行状态，之前的版本不恢复。

## 9. 对内核的增补（4.1）

### 9.1 `contributes.hooks`

补上内核设计文档 §8 的已知缺口。manifest 的 `contributes` 增加 `hooks?: string[]`（钩子 id，例如 `weave.tools.policy`）。钩子不是扩展点，所以不要求某个 capability。`env.onHook` 在插件声明了 `contributes` 时核对钩子 id，不在清单内报 `plugin-contributes-exceeds-manifest`。`PluginContributed` 增 `hooks`，由 `setup` 内的注册记录。`GET /plugins` 的 `contributes` 和 `provides` 增 `hooks`，Studio 显示。信任对话框要靠它说明插件监听了什么。

### 9.2 可归因的错误

`PluginError` 增可选字段 `pluginId`。`setup` 失败、版本不兼容、重复的插件 id、能力未声明、贡献超出清单、权限被拒、定义不合法、服务工厂失败、依赖缺失、服务重复、作用域违规、`dispose` 失败，这些本来就知道是谁的错，直接带上。`ExtensionRegistry.collect` 把回放某个插件的贡献时抛出的**任何**错误归到这个插件：已带 `pluginId` 的 `PluginError` 原样抛出，没带的复制一份补上，其它错误包成 `plugin-contribution-failed`（原错误放 `cause`）。这样 owner 一侧的失败，例如工具重名，也能归因。服务工厂抛出的错误按注册该服务的插件归属，工厂里 `collect` 抛出的错误已经带着贡献者的 id，保持不变。没有单一责任人的失败不带 `pluginId`：manifest 无效（id 不可信）、环形依赖。宿主遇到这类失败时保留旧的 generation（D6）。导出的 `attributePluginError(error, pluginId, context)` 给宿主在自己的收集代码里做同样的归属。已知的限制：owner 自己 API 里的 bug 也会记到触发它的贡献者头上，内核分不出这两种情况。

### 9.3 `PluginSdk` 与 `PluginFactory`

在 `@weave/plugin` 里导出 `PluginSdk`、`PluginFactory`、`PluginModule` 类型和 `createPluginSdk()`。`createPluginSdk()` 返回冻结的对象，内容见第 4.2 节，不含宿主专用 API。

### 9.4 受限审批视图

`createRestrictedApprovalBroker(broker)` 返回只含 `request`、`get`、`list`、`subscribe` 的冻结视图，类型是 `PluginApprovalBroker`，`approvalBrokerRef` 的类型随之改为它。`hostServicesPlugin` 在内部做这层包装：宿主传进去的仍是真正的 broker，插件拿到的永远是视图，调用方不会忘记。Tool Pipeline 只调用 `request`（取消和超时通过传入的 `signal` 和 `timeoutMs` 由 broker 自己处理），所以 `@weave/runtime` 的 `ToolPipelineOptions.approvalBroker` 放宽为 `Pick<ApprovalBroker, 'request'>`。这是只放宽类型的改动，行为不变，内置的使用方不受影响。HTTP 审批接口直接用 Runtime 里真正的 broker。这只是 API 形状，不是边界，进程内插件仍然可以直接 `import` 别的东西，但它防住了按内核 API 写的越权，也是将来进程外插件会用的形状。

`sessionStoreRef` 已经是受限的：宿主传给 `hostServicesPlugin` 的是 `createPluginSessionStore(store, pluginEvents)`，只接受插件注册过的事件，核心事件写不进去。这一层由宿主装配（`apps/server/src/agent-kernel.ts`），因为它需要宿主的事件注册表；4.4 把装配搬进宿主时保持不变。

## 10. Server

### 10.1 数据形状

`PluginListItem` 在现有字段上增加：

```ts
{
  origin: 'builtin' | 'registered' | 'kernel' | 'local';
  state: 'loaded' | 'pending-trust' | 'changed' | 'disabled' | 'failed' | 'invalid' | 'incompatible';
  error?: { code: string; message: string };       // failed、invalid、incompatible
  local?: {                                        // 仅 origin = 'local'
    directory: string;                             // 插件目录的绝对路径
    digest?: string;                               // invalid 时没有
    enabled: boolean;
    trusted?: { digest: string; trustedAt: string; manifest: PluginManifest };  // 上次信任的内容，changed 时用来做差异
  };
}
```

非本地插件的 `state` 恒为 `loaded`。没有加载的本地插件，`provides` 全是空数组，`contributes` 和 `permissions` 来自清单。`id` 取清单里的 id，清单读不出来时取目录名。`GET /plugins` 不扫描磁盘，返回最近一次发现的快照。

### 10.2 路由

处理函数保持很薄，行为在 `@weave/plugin-host`。

| 方法与路径 | 请求 | 作用 |
|---|---|---|
| `GET /plugins` | | 现有。列出所有插件，含本地插件的各种状态 |
| `POST /plugins/reload` | | 重新发现并重载，没变化就不重建。返回 `{ plugins, result }` |
| `POST /plugins/:id/trust` | `{ digest }` | 信任并启用。摘要与磁盘不符返回 409 `plugin-digest-mismatch` |
| `DELETE /plugins/:id/trust` | `?immediate=true` 可选 | 撤销信任 |
| `POST /plugins/:id/enable` | | 启用。未信任返回 409 `plugin-not-trusted` |
| `POST /plugins/:id/disable` | `?immediate=true` 可选 | 停用 |

写操作的响应都是 `{ plugins, result }`，`result` 含 `generation`、`unchanged`、`failed`（id 与错误）。错误体沿用现有的 `{ error: { code, message } }`：404 `plugin-not-found`，409 上面两个，415 `unsupported-media-type`，403 `forbidden-origin`。

### 10.3 加固

信任、启用、停用、撤销、重载是"让本机运行代码"的入口，所以比其它接口多几道门：

- 只接受 `Content-Type: application/json`。跨站的简单请求（表单、`text/plain`）带不了它，而带上它就要先过预检。
- `Host` 必须是回环（`127.0.0.1`、`localhost`、`[::1]`，任意端口），防 DNS rebinding。
- `Origin` 存在时必须等于配置的 `studioOrigin`。没配置（开发模式）就只接受回环来源。没有 `Origin` 的请求（非浏览器客户端）放行。
- 带 `Sec-Fetch-Site: cross-site` 的请求一律拒绝（B1）。浏览器会自动加这个头，网页改不了，是 `Origin` 之外的第二道。
- `trust` 必须带摘要，且与磁盘上当前的一致。
- 所有插件写接口都通过同一个守卫注册，不允许逐个路由自己选择要不要加。DeepSeek Harness 的审计里，`/plugins/*` 路由落在了围栏之外，这是按路由加围栏会出现的漏洞。

现状是整个服务除了在设置了 `studioOrigin` 时加 CORS，没有任何 Host 或 Origin 检查。这里只给插件写接口加，不改动其它接口。给整个本地 API 加同样的围栏是单独的后续 PR（第 15 节）。

### 10.4 配置

`startServer` 增 `pluginsDirectory?: string | false`。默认值：显式配置 > `WEAVE_PLUGINS_DIR` > `<数据目录>/plugins`；但调用方显式给了 `databaseFile`（测试的常见做法）而没给数据目录时默认不加载本地插件，避免测试碰到真实的用户目录。`false` 明确关闭。目录不存在不报错，也不自动创建，面板上显示它的路径。

## 11. Studio

### 11.1 插件面板

- 现有分组「内置、已注册、扩展」之外增加「本地」。本地插件按状态排序：待信任和已变更在最前，然后已加载、已停用、失败、无效、不兼容。
- 每项显示状态标签，按状态给操作按钮：「审阅并信任」、「停用」、「启用」、「撤销信任」。失败项显示错误。
- 标题行的刷新按钮改为调用 `POST /plugins/reload`。面板打开时也调用一次。重载期间按钮转圈。
- 有待处理项（待信任、已变更）时，面板入口显示数量徽标。不在启动时自动弹窗。
- 面板底部显示插件目录路径，目录不存在时给出提示。

### 11.2 信任对话框

标题：「信任插件「{名称}」？」，升级时是「插件「{名称}」已更新，请重新确认」。内容从上到下：

1. 基本信息：id、版本、说明、来源目录、摘要前 12 位（悬停显示完整摘要）。
2. 风险提示，醒目，不折叠：「信任后，这个插件的代码会以和 Weave 相同的权限在你的电脑上运行。它可以读写你能访问的文件、联网、读取所有会话内容。下面是插件自己的声明，Weave 无法限制进程内插件的实际行为。只信任你了解其来源的插件。」
3. 它声明了：能力，添加的内容（工具、命令、提示词片段、会话事件、服务，各列名字），监听的钩子，需要的权限。高影响项排前面并加标记。
4. 升级时增加一栏差异（第 6.4 节）。
5. 按钮「取消」和「信任并启用」。**默认焦点在「取消」**，Enter 不会误触信任。

内置的影响表，Studio 自己维护，未知项按高影响显示：

| 钩子或权限 | 影响 | 说明文字 |
|---|---|---|
| `weave.llm.request` | 高 | 能看到并改写发给模型的全部内容 |
| `weave.tools.around` | 高 | 能改写工具调用的参数和结果 |
| `weave.tools.result` | 中 | 能读到每次工具调用的结果 |
| `weave.tools.policy` | 低 | 只能拒绝或要求确认工具调用，不能放行 |
| `weave.turn.start`、`weave.turn.end` | 低 | 知道回合何时开始和结束 |
| `process:spawn`、`workspace:write`、`network:request` | 高 | 运行进程、写入工作区、访问网络 |
| `workspace:read` | 中 | 读取工作区 |
| `service:weave.session.store` | 高 | 读取全部会话内容 |
| 其它 `service:*` | 中 | 使用宿主服务 |

### 11.3 撤销与停用的对话框

确认后提示"下一回合起生效"。有会话正在运行时，增加复选框「立即生效（取消进行中的回合）」。

### 11.4 开发代理

Vite 开发代理现在只转发 `/agent`、`/approvals`、`/projects`、`/sessions`、`/settings`。`/plugins` 和 `/commands` 没在其中，所以浏览器开发模式下现有的插件面板和斜杠命令都取不到数据（桌面端用绝对地址，不受影响）。这是 #62 和 #68 的遗漏。4.5 会补上，之前也可以单独先修。

## 12. 包与边界

- 新包 `packages/plugin-host`（`@weave/plugin-host`），依赖 `@weave/plugin`、`zod`，用到 `node:fs/promises`、`node:crypto`、`node:path`、`node:url`。不引入新的第三方依赖，`zod` 已被其它包使用。不依赖 `@weave/runtime`：切换门面对 Runner 的形状是泛型的（需要 `run(request)` 和 `request.signal`）。
- 依赖方向：`protocol -> {llm, session} -> runtime -> plugin -> {plugin-builtins, plugin-host} -> server -> desktop`。
- `eslint.config.js` 登记新包，`allowedDependencies: ['@weave/plugin']`；`@weave/server` 的允许列表加入它。
- `AGENTS.md` 的"Package boundaries"一段随 4.2 更新。
- SQLite 信任库放 `apps/server/src/plugin-trust-store.ts`，与 `provider-settings-store.ts` 同一模式。
- 测试放各包自己的 `test/`。

### 12.1 4.2 的公开面

`@weave/plugin` 增导出 `assertEngineSupported` 和 `assertHostVersion`（原本只在包内），发现阶段用它们判断 `incompatible`，与内核注册时的判断是同一份代码。没有别的改动。

`@weave/plugin-host` 导出：

| 模块 | 导出 | 作用 |
|---|---|---|
| 错误 | `PluginHostError`（`code`、`pluginId?`、`cause`） | 本包的错误。错误码：`plugin-invalid-descriptor`、`plugin-entry-invalid`、`plugin-unsupported-file`、`plugin-too-large`、`plugin-unreadable`、`plugin-duplicate-id`、`plugin-id-reserved`、`plugin-host-unsupported`、`plugin-digest-mismatch`、`plugin-load-failed`、`plugin-invalid-module`、`plugin-manifest-mismatch`。不兼容候选的错误码还会是内核的 `plugin-api-version-unsupported` 和 `plugin-engine-unsupported`，与内核一致。`plugin-setup-timeout` 属于 4.4 的重载，不在本包 |
| 清单文件 | `descriptorFileName`、`parseDescriptor(text)`、`PluginDescriptor` | 解析 `weave-plugin.json`，含第 4.1 节的本地插件规则 |
| 摘要 | `computeDirectoryDigest(directory, options?)`、`defaultDigestLimits` | 第 5.3 节 |
| 发现 | `discoverLocalPlugins(options)`、`LocalPluginCandidate`（`ready`、`incompatible`、`invalid`）、`DiscoveryResult` | 第 5.1 节。只读磁盘，不执行任何插件代码 |
| 信任 | `PluginTrustEvent`、`PluginTrustStore`、`createMemoryTrustStore()`、`pluginTrustEventSchema`、`foldTrust(events)`、`resolveLocalPlugins(candidates, trust)`、`diffManifests(previous, next)` | 第 5.2、6.2、6.4 节 |
| 加载器 | `loadLocalPlugin(plugin, options)` | 第 7 节。只在信任确认之后调用 |

信任存储接口是异步的（`append`、`events`），SQLite 实现在 4.4 里同步实现也能满足。`pluginTrustEventSchema` 供存储层在读回持久化行时校验。`diffManifests` 只比较版本、`capabilities`、`contributes` 各键和 `permissions`；名字、说明和 `engines` 的变化不算声明变化，因为它们不改变插件能做什么。

## 13. 测试策略

- **发现与摘要**：临时目录夹具。清单损坏、schema 不过、入口逃逸、符号链接、过大、重复 id、被占用的 id、`incompatible`。摘要对内容敏感、对遍历顺序不敏感、对 `.DS_Store` 不敏感。
- **信任**：折叠表驱动（信任、撤销、启用、停用的各种顺序）。状态解析表驱动。声明差异。
- **加载器**：真实 `import()` 夹具。默认导出不是函数、工厂抛错、顶层代码抛错、`manifest` 不一致、同一文件改动后拿到新实例、摘要在加载前被改。
- **重载**：成功；一个插件 `setup` 抛错或超时，其余照常；归因的装配错误被隔离并重试；无法归因时保留旧 generation；启动时退回只有宿主插件；集合没变就不重建；并发重载合并。
- **切换门面**：回合 pin 在开始时的 generation；排队的回合在重载后用新的；同一会话跨 generation 仍按序；旧 generation 在最后一个回合结束后才销毁；提前 `return()` 也减计数；立即生效取消旧回合；关闭时全部取消。
- **注册表隔离**：被移除的插件的工具和 provider 消失；新旧 generation 登记同一个 provider id，旧的销毁不删新的。
- **HTTP**：状态码矩阵，包括错误的 `Content-Type`、`Host`、`Origin`、摘要不符、未信任就启用。
- **Studio**：对话框内容、差异、默认焦点在取消、「立即生效」只在有运行中会话时出现、状态排序、徽标。
- **端到端**：夹具插件目录 → 面板里信任 → 下一回合起它的命令、工具、提示词片段生效 → 撤销 → 再下一回合消失。

## 14. 交付切分

每个 PR 单独一个分支，从最新 `main` 开始，`pnpm check` 全绿。

| PR | 主题 | 内容 | 验收 |
|---|---|---|---|
| 4.0 | 设计与 ADR | 本文，ADR 0003（信任模型与加载方式，含对 DeepSeek Harness 的对照），ADR 0002 与内核设计文档的交叉引用 | D1 到 D10 已确认 |
| 4.1 | 内核为第三方插件补齐 | 第 9 节：`contributes.hooks`、可归因的错误、`PluginSdk`、受限审批视图；`GET /plugins` 与 Studio 显示 hooks | 既有行为不变 |
| 4.2 | `@weave/plugin-host` | 包脚手架与边界；清单文件、发现、摘要、信任折叠与差异、加载器 | 临时目录夹具、真实动态 `import` |
| 4.3 | Generation 切换，行为不变 | 每代一个 Tool 和 Provider 注册表；Runner 门面（pin、会话串行、销毁）；`serverHost` 读当前 generation | 没有本地插件时全部既有测试通过 |
| 4.4 | 本地插件接入 Server | `PluginHost` 编排；SQLite 信任库；路由与加固；`startServer` 配置；`GET /plugins` 新字段；在真实 Electron 构建里验证动态 `import` | 端到端：夹具插件信任后下一回合生效 |
| 4.5 | Studio | 状态分组、信任对话框与差异、重新加载、立即生效、徽标；开发代理补 `/plugins`、`/commands` | jsdom 测试；浏览器里的外观没有验证，需要你看一眼 |

4.3 是风险最高的一步，它不改行为，只改装配的归属，所以单独成 PR。

## 15. 后续

- **4b 项目级**：`.weave/plugins.json` 只能在已安装的插件里启用或停用，不能添加代码。需要多个 generation 同时存在：generation 的键是（id、摘要）的有序集合，按会话所属的项目选择，相同集合共享。信任记录的键已经预留了 `scope`。项目自带插件代码要加工作区信任（按项目文件夹的 `realpath`），克隆来的仓库默认不信任。
- **Stage 5 MCP**：`host: 'mcp'` 走另一个加载器，复用同一套信任记录、对话框、generation 切换。风险文案不同（独立进程，只拿到被授予的能力），权限由代理强制。
- **Stage 6**：安装器（把压缩包或目录放进插件目录并计算摘要）、发布者对摘要签名、市场。
- **开发模式**：按目录信任，源码变化不用每次重新确认，带明显的「开发中」标记。作者每次重新打包都要重新信任，是已知的体验代价。
- **整个本地 API 的围栏**：把第 10.3 节的 `Host`、`Origin`、`Sec-Fetch-Site`、JSON-only 检查推广到所有本地路由，单独一个 PR，因为会碰到所有路由和测试。
- **纯声明插件**：没有入口文件，只带命令和提示词片段，不执行任何代码，信任门槛可以更低。但提示词片段是注入面，仍然要确认。
- **`weave plugin` 命令行**：给没有 Studio 的环境用，行为与 HTTP 路由一致，同样要带摘要。

## 16. 未决风险

1. Electron 主进程里动态 `import()` 外部 ESM 文件，要在 4.4 用真实打包验证（桌面端是 Electron 39，主进程是 ESM）。
2. 摘要上限 1000 个文件、20 MB，可能挡住带 wasm 或模板的合法插件。先按这个值，需要时再放宽。
3. 两个 Weave 进程共用一个数据目录时，一个进程里的信任变化要等另一个进程下次重载才生效。
4. 受限审批视图只是 API 形状，不是边界。
5. 设置里配置的 provider 与插件的 provider 共用一个注册表，第 8.3 节的登记与移除规则要有测试守住。
6. 第 11.4 节的开发代理缺口是现存问题，与本设计无依赖。
7. 已加载的插件在运行期间再 `import()` 目录里的其它文件，不会重新校验摘要（B5）。所以要求插件打包成单文件，让入口文件的摘要覆盖它的全部代码。

## 17. 与 DeepSeek Harness 的对照

完整的对照表在 ADR 0003。这里只记它对本设计的影响。资料是 Harness `master` 的文档，加一份对 `47f9438` 版本的第三方审计，我们没有运行 Harness，也没有复核审计。

**照着做的**：加载前先读元数据（本设计更进一步，读的是清单 JSON，什么都不执行）；兼容性检查（`apiVersion`、`engines.weave`，没有豁免文件）；注册随插件卸载而撤销（每个插件的 disposer 与 generation 销毁）；Studio 里按状态管理插件。

**有意不同的**：

- 信任门槛。Harness 里安装即信任，文档提醒用户自己审查。Weave 要摘要绑定的确认、升级差异和撤销。
- 声明。Harness 没有清单权限，Weave 要求封闭的 `contributes`、`permissions`、`hooks`。
- 重载。Harness 的 HMR 立即作用于所有会话，失败的替换不会恢复。Weave 下一回合生效，失败保留旧 generation。
- 配置即代码、文件监听热重载：不要（B3）。
- 模型可调用的插件管理工具：不要（B2）。

**对 D1 到 D10 的五条补充**：

| 编号 | 内容 | 落在 |
|---|---|---|
| B1 | 写接口守卫再加 `Sec-Fetch-Site: cross-site` 拒绝，且所有插件写接口走同一个守卫 | 第 10.3 节 |
| B2 | 没有模型可调用的工具能管理插件 | 第 6.7 节 |
| B3 | 没有配置即代码，没有文件变化触发的重载 | 第 6.7、8.4 节 |
| B4 | 撤销信任之后没有别的路径还能加载它 | 第 6.7 节 |
| B5 | 摘要不覆盖加载之后的运行期 `import()`，所以要求单文件 | 第 16 节 |

Harness 领先、Weave 有意推迟的：安装与更新体验（镜像回退、版本列表、取消、构建脚本审批）、插件作者的热重载、有目录的生态、按会话的能力预设、agent 驱动的管理。它们都不影响"运行一个用户自己放进目录并选择信任的插件"，而每一项都会增加攻击面，要先让信任模型覆盖到它。
