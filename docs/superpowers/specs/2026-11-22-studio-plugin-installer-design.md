# Stage 6.3 Studio 本地插件安装

本文实现 [ADR 0005](../../adr/0005-plugin-installation-and-distribution.md) 和[安装设计 §6](2026-11-21-plugin-installation-design.md#6-stage-63-studio)。本设计的已合并基线为 Stage 6.2d `39e1c2c`（PR #89）。Server HTTP 以 [Stage 6.2d API](2026-11-22-managed-plugin-installer-api-design.md) 为准，首次注册和所有权延用[受管源启动契约](2026-11-21-managed-plugin-source-design.md#startup-and-authority)。

## 交付范围

在现有 Plugins 面板导入已打包的本地 ESM 目录，查看候选历史，独立审查激活、回退、启用、停用、撤销信任和卸载。Studio 显示保存的决定和实际发布状态，并在 App 会话内恢复未确认的请求。Desktop 提供原生插件文件夹选择和默认配置的首次绑定。浏览器支持键入本机 Server 的绝对目录路径。

远程来源、构建、签名、自动更新、制品回收、跨 App 重启的请求恢复及 Server API 聚合留给各自后续设计。卸载保留候选和制品。

### 全局约束

- Node.js ≥24.4.0，pnpm ≥10.13.1，使用仓库现有 TypeScript、ESM、React 和 Zod。无新增依赖。
- Studio 保持 HTTP/SSE 客户端，禁止导入 `@weave/*`、Server 源码、Node 或 Electron。Desktop Main 仅通过既有 Server 启动接口和受控 IPC 集成。
- 所有外部输入在使用前校验。保留既有 Server 守卫、权限、工具 Pipeline、append-only authority、Generation 和 pinned turn 语义。
- Provider 首次挂载、打开面板、切换面板和程序还原只读 GET。预览和所有管理 POST 由明确的用户事件触发。
- 保持 App 内一套 ESM/MCP/managed 写入门。隐去预览令牌和服务私有路径。精确重试的数据仅保存在 App 内存。
- 使用现有 Plugins 面板和对话框样式与中文标签。按现有惯例在各包 `test/` 中为行为写测试。
- 以实际浏览器、实际 Electron 开发进程、根 `pnpm check` 及 PR CI 验证交付。

## 选择现有 App Store

扩展 App 已拥有的 `PluginCatalogStore` 和 `useSyncExternalStore` 订阅。受管独立 Store 会使 base 实际贡献与受管发布身份来自不同观测，并增加写锁和恢复同步。Server 聚合接口能加强跨目录一致性，但会扩大 HTTP 契约，且客户端仍须保留精确请求。现有三个 GET、一个客户端写入门和一个 Server coordinator 已足以提供本阶段的行为。

## Studio HTTP 客户端

使用 `runtimeApiUrl`。浏览器通过现有 Vite `/plugins` 代理，Desktop 使用 Preload 暴露的随机循环端口 Server URL。Studio 为三个受管成功 DTO 建立严格本地 Zod schema，并读现有 `{error:{code,message}}`。所有 POST 使用 JSON，无 query 参数。

| Method 与路由                                          | Body                                                                                                       |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| GET `/plugins/managed`                                 | 无                                                                                                         |
| POST `/plugins/managed/preview`                        | `{sourceDirectory}`                                                                                        |
| POST `/plugins/managed/import`                         | `{requestId, previewId, expectedInstallSequence}`                                                          |
| POST `/plugins/managed/:id/activate`                   | `{requestId, digest, manifest, previousSelection, expectedInstallSequence, expectedTrustSequence, intent}` |
| POST `/plugins/managed/:id/enable`                     | `{requestId, selectedDigest, expectedInstallSequence, expectedTrustSequence}`                              |
| POST `/plugins/managed/:id/{disable,revoke,uninstall}` | `{requestId, selectedDigest, expectedInstallSequence, expectedTrustSequence, immediate?}`                  |

路由 ID URL 编码。正安全整数用于 `files`、Generation `id`、候选 `importSequence`、`candidateImportSequence`、`activationSequence`、决定 `operationSequence` 和非 null 的 `installEventSequence`、`trustEventSequence`。非负安全整数用于 `bytes`、目录头、决定头和所有期望头。摘要为 64 位小写十六进制，ID 遵循 authority 语法。HTTP 允许 null 的前选择和破坏性动作选择，启用必须有 digest。客户端保持 Server 已复核的 manifest 完整，包括 `contributes`、`permissions`、所有可选键和各数组顺序。旧界面继续使用既有展示 schema。Server 对路径、manifest 语义、宿主兼容、授权和命令规则负责。

成功值必须来自确切的 HTTP 200。解析、schema 或关联失败使用 `plugin-invalid-response`。未识别的 HTTP 状态与机器码组合使用 `plugin-request-failed`。决定须匹配本地 request ID、插件 ID、命令、目标 digest、激活意图和 immediate。导入预览的插件 ID 来自 `candidate.manifest.id`。

每条候选的 `manifest.id` 须等于目录行 ID。`selection` 按 `candidateImportSequence` 与 digest 关联候选，`trust` 须匹配此选择。`active.pluginId` 须等于行 ID，digest 须能关联该行历史候选。实际发布的 activationSequence 可以早于选择，选择为 null 时仍可有旧 active。历史 `decision.selection`、`decision.trust` 及其头描述保存当时，独立于 `current` 中的选择、信任和头。committed 的 `application.generation` 等于同票据的 `current.generation`，`application.active` 与本票据 `current` 中决定插件的发布观测一致，活动 digest 可与目标不同；replayed 的本票据发布从 `current` 查找决定插件。

精确重试冻结原 URL 和 JSON。Browser 的相对 URL 固定 Vite 代理入口，DTO 中没有 Server 实例或数据库身份。重试结论适用于实际响应的 authority。切换 profile 时用户需重新打开 Studio，以结束原 App 的水位和请求状态。

## 整组目录发布

1. 一轮并行读取 `/plugins`、`/mcp` 和 `/plugins/managed`，最多三轮；一次发布一组快照。保留 Store 已有的读取合并和稳定快照。强制所有启用的源有全局 Generation。ESM 与 MCP 精确比较全局 `id`、`acceptingRuns`、`blocked.code` 和 `blocked.message`。受管与 ESM 比较 `id`、`acceptingRuns` 和 `blocked` 是否存在。受管 DTO 保持其固定的阻断文案。ID 相同仍须验证 admission，ID 无跨 Server 进程全局顺序。
2. 明确的 managed 404 `plugin-installer-disabled` 是功能关闭。首次启用前兼容旧版 Hono GET 404 的固定纯文本 `404 Not Found`，并单独标作旧服务。其他响应失败保持旧完整目录、显示错误、暂停普通写入。已确认过受管水位后再出现关闭或旧路由，保留快照，要求重连或重开 App。只有有效 200 空数组表示空目录。MCP 将明确的 `mcp-management-disabled` 404 当作可选能力关闭。每次显式刷新或 lag reload 重新探测三个源，包括上次关闭的 MCP。
3. `installSequence`、`trustSequence`、`operationSequence` 都不得低于 App 最后确认的完整受管头。整组 GET 或通过关联校验的受管回应 `current` 可更新这个水位。拒绝任一项下降，即使另两项推进。始终沿用同一个观测中的三个头与候选列表。导入、no-op 和信任可在同代际推进不同的头。MCP 另有 authority 序列，ESM 的 `local.trustSequence` 是地方源投影，在已保存但 adoption 失败时可以落后，二者均无跨目录相等要求。
4. 保存受管回执和不降的水位后才对账。第一轮可以用本次 HTTP `current` 作为受管种子，同新 ESM/MCP GET 配对，然后整组发布。水位下降的 `current` 仅保留在历史回执中。配对失败的后续轮次用真实 GET。ESM/MCP 写回执的一轮种子沿用相同的代际配对原则。任何写先在通知订阅者前占用门，然后等待已开始的读取。公共 `ensureLoaded()` 与 `refresh()` 等待写与对账完成再启动新读。门内的初始化、重新读取和对账使用私有读取入口，避免等待本次写自己的 promise。普通写发送前复核 ready 与依赖头，精确重试等待在途读结束但忽略其失败，显式 lag reload 依据本次三方真实 GET 判定。
5. 重放走持久查找且跳过 adoption，故受管 GET 可能在同代际持续低于已确认水位。三轮后若最新真实读的唯一问题为受管水位落后，保留旧完整目录和回执，显示目录等待同步。用户可读 GET 或在无未决请求时明确触发「重新发现并加载扩展」。该操作通过同一写入门重新取三方 GET，只在目录就绪或本次唯一问题仍是水位落后且 ESM/MCP 新鲜配对时发 POST。MCP 启用用最新 MCP authority 序列调用现有 reload，明确关闭 MCP 且 base 提供本地 ESM 管理时用 ESM reload。其他失败路径只执行 GET。POST 后对账所有源。缺少管理端或问题仍在则保留回执和旧目录，可重新连接或重开 App。任何 GET、挂载或重放都不会自行调用 reload。

## 审查、提交与重放

审查是不可变的面板局部值。App Store 保存一个发布中的或待核对的请求槽，以及最后一个已确认回执。新确认生成一次 `crypto.randomUUID()`，冻结提交目标、URL 和 JSON。关闭面板、关闭对话框或布局变化不取消已发送请求。重新挂载可看见 pending、恢复入口和回执。每次提交和精确重试各自返回有类型的已保存、未决、确认拒绝、未发送结果，包含本次回执或错误与恢复操作提示。对账不能覆盖这次调用的结果。

Store 统一派生 `sharedManagementBlocked`，纳入公共目录 ready、在途操作和未决请求。PluginsPanel、McpPanel、当前已开的确认对话框与受管操作控件都消费它。Store 在任何普通 ESM/MCP/managed 写入前硬校验，包括 MCP PUT、DELETE 和通过 Store 发起的新预览 POST。预览是签发短期令牌的准备步骤，发出前检查公共写门，发出后独立完成并使用局部取消；未决时禁用。普通写占门后只复核目录、未决请求和审查条件，不把本次 reservation 本身当成阻塞。GET、精确重试、停止跟踪和显式 lag reload 各自使用对应条件。目录 ready 但有未决请求时仍提供独立「读取目录」控件，直接调用 refresh，不将它替换为 reload。未决时，只能 GET、同请求重试或明确停止跟踪，后者先安排新 GET 再开放普通写入。

| 阶段       | Store 和用户行为                                                                                                                                                                                                                                                                                                                                 |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 未发送     | 用一致目录和审查依赖的头验证。导入用 preview 的安装头，选择操作用安装与信任头。仅操作序列变化没有影响。MCP 审查继续由已有 MCP 序列与冲突规则决定。                                                                                                                                                                                               |
| 提交中     | 占用共享写入门。对账完成前保留现有 pending 和原请求。                                                                                                                                                                                                                                                                                            |
| 结果未确认 | 网络丢失、响应正文/关联无效、含义不明确的 commit 错误或 500/503 留住原命令。暂停所有新的 ESM/MCP/managed 管理 POST，允许 GET 和原命令重试。用户确认后，用同一 URL 和 JSON 重发。写入门仍等待旧读取，但不要求 ready、当前功能标记、审查头、源路径存在或本地令牌未过期。若原命令已经持久保存，重放只读；若尚未保存且原条件仍成立，它可能现在执行。 |
| 确认保存   | 有效 committed 或 replayed 200 都关闭未决槽，先保存决定、应用状态和票据观测，再尝试目录对账。重放的应用状态始终为 unknown，当下的 published member 来自重放 `current`。                                                                                                                                                                          |
| 确认拒绝   | 按机器码更新审查、再尝试 GET。只有新决定才分配新 ID。用户可明确停止跟踪未决请求并 GET，说明原决定可能已经保存，放弃跟踪不撤销请求，也不证明结果。普通操作仍要求 ready。                                                                                                                                                                          |

### 已发送命令的封闭分类

按 status、code、命令与首次/重试一起判定。此表用于持久命令。预览只返回短期审查结果或展示对应错误。

| HTTP 与机器码                                                                                                                                       | 命令                                         | 首次发送 | 精确重试 | 用户动作                                               |
| --------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- | -------- | -------- | ------------------------------------------------------ |
| 200 且 schema 与关联合法                                                                                                                            | 全部                                         | 已保存   | 已保存   | 显示回执                                               |
| 400 `plugin-invalid-request`、403 `forbidden-origin`、404 `plugin-installer-disabled`、413 `plugin-request-too-large`、415 `unsupported-media-type` | 全部                                         | 确认拒绝 | 保持未决 | 显示本次请求被拒；重试仍可核对原决定                   |
| 409 `plugin-authority-request-conflict`                                                                                                             | 全部                                         | 确认拒绝 | 确认拒绝 | 提示 ID 已用于其他决定                                 |
| 409 `plugin-preview-stale`、409 `plugin-managed-id-conflict`                                                                                        | import                                       | 确认拒绝 | 确认拒绝 | 重新预览，ID 冲突先解决                                |
| 409 `plugin-managed-namespace-unavailable`、409 `plugin-artifact-capacity`                                                                          | import                                       | 确认拒绝 | 确认拒绝 | 条件允许时重新确认仍有效的原审查，否则使用重新预览入口 |
| 409 `plugin-authority-conflict`                                                                                                                     | import                                       | 保持未决 | 保持未决 | GET 提示审查变化，仍允许原请求核对                     |
| 409 `plugin-authority-conflict`、404 `plugin-authority-not-found`                                                                                   | activate、enable、disable、revoke、uninstall | 确认拒绝 | 确认拒绝 | 刷新并重新审查                                         |
| 409 `plugin-authority-activation-required`                                                                                                          | enable                                       | 确认拒绝 | 确认拒绝 | 引导激活审查                                           |
| 409 `plugin-artifact-unavailable`                                                                                                                   | import、activate、enable                     | 确认拒绝 | 确认拒绝 | 展示错误，导入重新预览，选择动作重新审查               |
| 网络失败、非法 200、所有 5xx、其余状态/码/命令组合                                                                                                  | 全部                                         | 保持未决 | 保持未决 | 显式重试或停止跟踪                                     |

导入的 authority conflict 可能发生在 commit 边界。GET 的头只能帮助提示原审查变化。收到未决后最终判为可恢复拒绝，而原对话框已关闭时，App 仍提供「重新预览」入口。显示范围限插件 ID 与动作，不持久保存原来源路径。重新确认是新决定，分配新的 ID，前端不自动换令牌或提交。legacy 手动 `trust/setEnabled/revoke` 收到 `plugin-managed-review-required` 时，Store 保留调用参数的插件 ID，做 GET 后指向对应受管行并提示重新审查。

## Plugins 面板

1. 「受管插件」区以三方 catalog 为准。区分有效的空历史、明确关闭、旧 Server 和目录同步失败。导入路径必须是 Server 平台的绝对路径且无 NUL，保留原值，由 Server 判定平台路径格式。路径仅在输入/预览阶段显示。仅在 bridge 提供 `pluginDirectoryPicker: true` 且 chooser 方法可用时展示「选择插件文件夹」。Renderer 使用前校验 picker 结果是 null 或严格的 `{path,name}`，其中 path 为原值的绝对路径且无 NUL，name 非空。取消保留原输入；非法结果提示错误，均不发预览。输入编辑、新选择、新预览和关闭作废迟到结果。明确点击预览只发 `{sourceDirectory}`，显示 ID、版本、digest、文件数、字节数、贡献、权限及到期提示。确认导入只增加候选。到期由 Server 最终判断。
2. 一行对应一条 sticky managed ID，内部以 digest 与 importSequence 展示候选、版本、导入时间和本地目录来源。选择、匹配信任、实际发布分别显示。比较 selection/active 时使用 digest 加 activationSequence。同一代际的 published managed ID 对应的 base `kernel` 行并入 managed 区，继承 `provides`。手动冲突行仍可见。缺少相匹配的 base 行就将实际贡献视为未知。候选 manifest 的贡献是声明。
3. 任意候选可「激活」，已选择版本可重新激活。已有选择及其他候选时提供「回退」操作，允许明确选择替代候选。候选历史仅有导入事实，文案以本次用已保存候选替换当前选择为准。两项都展示本次目标 manifest、digest 和前选择，通过不同 intent 提交。启用需要匹配的已存在信任。撤销保留选择，重新授信走激活。停用、撤销和卸载的确认提供默认关闭的立即选项，选中时取消涉及目标的当前和退役代际回合。默认让旧回合继续。
4. 显示「决定已保存」及是否实际改变。回执区显示决定 `decision`，再显示本票据的应用状态和发布身份。committed 用 `application.active`，replayed 用该票据 `current` 中的目标行 active。失败展示固定安全 issue，允许显示旧发布版本或 admission 阻断。候选保存但无需加载用 `not-required`。插件列表的最新发布独立来自后来整组发布的 catalog。读取失败仍能展示已经捕获的回执信息，后续读取也不会改写它。卸载后的候选历史仍可用于激活。
5. 复用 `PluginDialog`、声明展示和窄屏滚动方案。审查显示完整目标 manifest，包括名称、说明、API 版本以及已声明的 host 和 engines。只读审查正文可以通过 Tab 获得焦点并用键盘滚动，仍参与同一模态焦点循环。状态和按钮可用性在 render 派生。只在事件处理器发预览/写请求，effect 用于焦点或卸载作废预览。支持 Escape、焦点恢复、动态状态反馈和长摘要换行。
6. 当视口宽度不超过 960px 时，已打开的运行活动面板使用固定右侧面板，宽度不超过 420px 和视口宽度，内容在面板内滚动。折叠仍使用现有 App 状态，折叠后隐藏面板并由「显示上下文」重新打开。窄屏不展示桌面列宽拖动柄。360×640、640×420 和默认 Electron 窗口均可进入插件管理，文档没有横向溢出。

## Desktop 选择器和首次绑定

沿用 `weave:pick-directory`。无参 `pickDirectory()` 保持项目选择，允许的显式目的为 `'project'`、`'plugin-import'`。新 Preload 声明 `pluginDirectoryPicker: true`。旧 Preload 保留项目调用，新 Studio 在该壳中使用手输安装路径。Main 先检查发送 frame 的精确 Studio origin，再用 Zod 校验最多一个 IPC 参数及允许值。项目使用既有标题和 `openDirectory/createDirectory`；安装使用「选择已打包的插件文件夹」与 `openDirectory`。返回 `{path: string, name: string} | null`。插件用途在 basename 为空的卷根使用原 folderPath 作为 name；项目用途保持现有返回行为。Main 提供目录路径，所有 installer 请求通过现有 HTTP。

Desktop config 以 `z.string().optional()` 捕获 `WEAVE_PLUGINS_DIR` 的原值，并通过 `pluginsDirectory` 原样传给 Server。空字符串是显式 override，由 Server 拒绝并显示 Desktop 启动错误；非空相对路径按 Server 进程 cwd 解析。任一 override 均省略 `managedPluginStore`。仅在缺失时使用 `<userData>/plugins` 并传 `managedPluginStore: {initialBinding:'allow-unbound'}`。注册存在时 Server 按完全匹配根走 `require-bound`，未注册的默认目录可创建并绑定 `.weave-store`。未注册的自定义目录需显式 owned launcher 建立首次绑定。忙、绑定不匹配或损坏继续走 Desktop 启动错误。

Browser 用显式 `startServer(4317, {dataDirectory, databaseFile, pluginsDirectory, studioOrigin, managedPluginStore:{initialBinding:'allow-unbound'}})` 与单独运行的 Vite。三条路径均取同一隔离 profile 的绝对路径，验收时不用个人资料。默认 `pnpm dev` 可恢复位置匹配的注册。未绑定且未显式授权的 profile 返回 installer disabled。

## 验收与产品依据

浏览器和真实 Electron 开发进程均验证导入 v1 不执行、激活 v1、独立导入并激活 v2、回退 v1 和卸载保留历史。浏览器从精确 Origin `http://127.0.0.1:5173` 进入，验证应用失败、丢失响应后的精确重试、上次目录保留、legacy ESM/MCP 管理与共同 gate。另在 360×640 和 640×420 验证对话框可达和无 document 横向溢出。Electron 用临时 userData 验证原生 chooser 取消与选择、默认首次注册、保持选择退出后的同根恢复以及 ownership 启动失败。记录循环端口 HTTP trace、fixture 执行标记、本地检查与 PR CI。

沿用 [Foundation Product references](../../architecture/foundation.md#product-references) 记录于 2026-11-21 的核对。Codex 的准备身份绑定对应 Weave 的 digest 与 activationSequence 显示；Kiro 的配置和激活划分对应导入与授信的独立审查；DeepSeek Harness 的串行化和资源回收对应 Weave 的单一 coordinator 和旧回合持有旧路径。[Codex 绑定测试](https://github.com/openai/codex/blob/bfe3c825702e9235a631a1db58f291bed7a44cfe/codex-rs/codex-mcp/src/binding_tests.rs) · [Kiro MCP 配置](https://kiro.dev/docs/mcp/configuration/) · [Kiro requirements-first](https://kiro.dev/docs/specs/feature-specs/requirements-first/) · [DeepSeek Harness HMR](https://github.com/deepseek-ai/deepseek-harness/blob/2e39e70496aa02986ca6a820c5d497e816b69d7e/packages/boot/hmr/README.md)。
