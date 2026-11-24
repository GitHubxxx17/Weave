# 插件钩子的能力声明设计提案

状态：提案，待评审。本文不是已决定的架构，合并本文不代表方案已定。

对应观察编号：P2。

## 1. 背景

以下现状均已对照当前代码核实。

### 1.1 钩子模型

- `packages/plugin/src/hook.ts`：`Hook<I, O>` 有 `id` 与 `mode`（`observe`、`wrap`、`decide`）。`HookRegistry.on(hook, handler, pluginId)` 登记处理器；`runObserve`、`runWrap`、`runDecide` 分别执行。`decide` 的票只有 `deny`、`ask`、`abstain`，取最严格者，因此只能收紧不能放行。
- `packages/plugin/src/seams.ts` 定义的钩子：
  - `weave.tools.policy`（decide，输入 `PluginToolRequest`）；
  - `weave.tools.around`（wrap，输入 `PluginToolRequest`，输出 `ToolExecutionResult`，可改写调用与结果）；
  - `weave.tools.result`（observe，读取每次工具结果）；
  - `weave.llm.request`（wrap，输入 `LlmCall`，输出事件流 `AsyncIterable<StreamEvent>`，可改写发给模型的请求与返回的流）；
  - `weave.turn.start`、`weave.turn.end`（observe）。
- `packages/plugin/src/plugin-env.ts` 的 `env.onHook(hook, handler)` 调用 `assertNameDeclared(pluginId, manifest.contributes, 'hooks', hook.id)` 后登记，并把钩子 id 记入 `usage.hooks`；`kernel.ts` 在汇总里返回每个插件订阅的钩子 id 列表。

### 1.2 声明校验的实际行为

- `packages/plugin/src/declaration.ts` 的 `assertNameDeclared`：当 `contributes === undefined`（且 key 不是 `panels`）时直接放行；当 `contributes` 已声明时，要求 `contributes.hooks` 列出该钩子 id，否则抛 `plugin-contributes-exceeds-manifest`。`manifest.ts` 中 `contributes` 是可选字段，`PluginContributes.hooks` 也是可选字段，未列出的 key 在已声明 `contributes` 时视为空。
- `PluginCapability` 枚举（`manifest.ts`）为 `tool`、`llm-provider`、`prompt`、`event`、`command`、`skill`、`panel`，没有与钩子对应的能力项；`permissions` 的取值是 `workspace:read`、`workspace:write`、`process:spawn`、`network:request` 或 `service:<id>`，钩子订阅不需要任何权限条目。
- 因此：**未声明 `contributes` 的插件可以订阅任意钩子，不受任何校验**；已声明 `contributes` 的插件必须在 `contributes.hooks` 里列出，但这个列表不对应单独的能力或权限，也不影响其他项。
- 托管安装（制品）路径要求清单必须同时带 `contributes` 与 `permissions`：`packages/plugin-host/src/artifact-types.ts`（`pluginArtifactSourceIdentitySchema` 的 refine）与 `apps/server/src/plugin-authority-types.ts` 约第 301 行。因此通过托管安装器进入的插件一定声明了 `contributes`；未声明 `contributes` 的情形出现在其他路径（本地目录加载、旧式 `WeavePlugin` 适配等）。具体哪些路径允许省略 `contributes` 未逐一核实。
- 信任与审查展示：`packages/plugin-host/src/trust.ts` 的 `contributesKeys` 含 `hooks`，清单变更摘要会报告 `hooks` 的增删；`apps/studio/src/features/plugins/plugin-review.ts` 约第 137 到 146 行已为钩子给出影响等级与说明：`weave.llm.request` 为 high（能看到并改写发给模型的全部内容），`weave.tools.around` 为 high（能改写工具调用的参数和结果），`weave.tools.result` 为 medium，`weave.tools.policy` 为 low，`weave.turn.start/end` 为 low。也就是说，对声明了 `contributes.hooks` 的插件，审查界面已经展示了钩子及风险描述。
- 对照：`apps/server/src/agent-kernel.ts` 约第 129 到 131 行说明服务端把 `weave.tools.result` 扇出给观察者，插件可通过 `weave.tools.around` 包裹每次执行，并通过 `weave.tools.policy` 投票。
- 信任边界：ADR 0003 指出进程内 ESM 插件拥有宿主进程权限，信任是对代码的信任而非沙箱（见 `docs/architecture/foundation.md` 约第 1158 行关于"未来不可信插件模式需要独立进程"的说明）。因此本提案讨论的是"声明与可见性"，不是隔离。

## 2. 问题

1. **声明可绕过**：省略 `contributes` 的插件可订阅 `weave.llm.request`、`weave.tools.around`，而审查界面的钩子清单来源是 `contributes.hooks`，省略时无法展示这些高风险能力。
2. **声明与能力脱钩**：即使声明了，钩子只是 `contributes` 里的一个列表项，没有与 `permissions` 或 `capabilities` 关联，宿主无法单独对"改写模型请求"这类能力做策略控制（例如默认禁止、需要用户逐项同意）。
3. **运行时与声明不对应的可能性**：`env.onHook` 在 `setup` 期间调用，已用 `assertNameDeclared` 检查，所以声明了 `contributes` 的插件无法运行时订阅未列出的钩子。该点当前已成立，不是问题。

## 3. 可选方案

### 方案 A：对所有插件强制检查，`contributes` 缺省视为空

把 `assertNameDeclared` 对 `hooks` 的处理改为：`contributes === undefined` 时也拒绝订阅（等价于空列表）。

- 优点：改动极小，堵住绕过；与"已声明则为闭合列表"的语义一致。
- 缺点：破坏性变更：现有省略 `contributes` 的插件（含示例、测试、内部插件，未逐一统计）如果订阅了钩子会在加载时失败；`plugin-builtins` 中的内置插件是否依赖该宽松行为未核实。

### 方案 B：把钩子升级为显式能力或权限

新增权限形式，例如 `hook:weave.llm.request`、`hook:weave.tools.around`，或把高风险钩子映射到新的 `capabilities` 项（如 `llm-intercept`、`tool-intercept`）。`env.onHook` 同时校验 `contributes.hooks` 与对应权限；信任对话框把它们作为"权限"展示，并对 high 级别的钩子强调。

- 优点：与现有 `permissions` 审查路径一致，宿主可对权限做统一策略（例如禁止某来源插件使用）；影响等级可直接复用 Studio 已有的描述。
- 缺点：manifest schema 需要扩展，涉及 `packages/plugin`、`packages/plugin-host`（信任摘要、清单差异）、`apps/server`（权威数据库中清单的存储与校验，`plugin-authority-types.ts`）、`apps/studio`；对已有已信任插件的兼容需要迁移策略（见第 6 节）；多出一份"声明两处"的冗余，要决定 `contributes.hooks` 是否保留。

### 方案 C：只对高风险钩子要求显式声明，低风险保持宽松

按 Studio 已有的等级划分，`weave.llm.request`、`weave.tools.around`（high）与 `weave.tools.result`（medium）必须在 `contributes.hooks` 与权限中显式出现，`weave.tools.policy`（只能收紧）与 `weave.turn.*`（只通知）可以不声明。

- 优点：兼容面最小，打扰最少；对风险最高的两个钩子堵住绕过。
- 缺点：规则不一致，需要维护"哪些钩子算高风险"的单一事实来源，目前该分类只在 Studio 展示层（`plugin-review.ts` 的 `impacts` 表），宿主没有对应数据；`weave.tools.result` 能读取所有工具结果（可能含敏感内容），把它归为"可宽松"有争议。

### 方案 D：只改展示，不改校验

对未声明 `contributes` 的插件，在加载后根据 `kernel` 汇总的 `usage.hooks`（已存在，`kernel.ts` 约第 215 行）取得实际订阅的钩子，并在审查与信任界面展示。信任决定基于看到的实际订阅，而不是清单自述。

- 优点：不改变加载行为；展示的是事实而非自述。
- 缺点：`setup` 需要先运行才能得到订阅列表，而信任通常发生在加载之前，会出现"先运行后展示"的顺序问题（这点与 ADR 0003 的"信任先于加载"原则冲突，需要仔细评估）；仅作为补充手段更合适。

### 比较

| 方案 | 堵住省略 `contributes` | 把钩子变成可单独授权的能力 | 兼容成本 | 实现范围 |
| --- | --- | --- | --- | --- |
| A | 是 | 否 | 中（省略者会失败） | 很小 |
| B | 是 | 是 | 中到高（schema 与迁移） | 大 |
| C | 部分（仅高风险） | 部分 | 低 | 中 |
| D | 否（仅可见） | 否 | 极低 | 中，且有顺序问题 |

## 4. 推荐方案

分两步：

1. 第一步采用方案 A 加 C 的组合：`contributes` 缺省时对所有钩子视为未声明并拒绝订阅，同时在宿主里建立高风险钩子的单一事实来源（把 Studio 的 `impacts` 分类下沉为 `packages/plugin` 导出的常量或钩子元数据，Studio 复用）。这样先堵住绕过，并把风险等级放到宿主可用的位置。
2. 第二步评估方案 B：当有更多需要按能力做策略的场景（例如企业策略、来源分级）时，再把钩子升格为权限，避免过早扩展 manifest。

方案 D 作为独立的补充，不作为主要手段。

## 5. 受影响的包与契约

- `packages/plugin`：`declaration.ts`（`assertNameDeclared` 对 `hooks` 的缺省行为）、`hook.ts` 或 `seams.ts`（钩子元数据，如风险等级）、`plugin-env.ts`（`onHook`）。
- `packages/plugin-host`：`trust.ts`（清单差异与摘要，若引入新权限）、加载路径中允许省略 `contributes` 的位置（`loader.ts`、`discovery.ts`，具体入口未核实）。
- `apps/server`：`plugin-authority-types.ts`（清单校验，如引入新权限）、`plugin-catalog.ts`（目录投影中的 `contributes`）。
- `apps/studio`：`features/plugins/plugin-review.ts`（风险描述改用宿主导出的元数据）。
- `packages/plugin-builtins` 与示例插件（`examples/`、`plugins/`）：核对是否依赖省略 `contributes` 的宽松行为。
- 契约：`PluginManifest`、`PluginContributes.hooks` 的语义改为"缺省即不允许订阅"，需要在 `docs/architecture/foundation.md` 的插件内核段落与 ADR 0002 中同步，实现 PR 再改，本提案不改。

## 6. 迁移与兼容

- 方案 A 的破坏面：未声明 `contributes` 且订阅了钩子的插件。需要先枚举仓库内全部插件（`plugins/`、`examples/`、`packages/plugin-builtins`、测试夹具）确认数量，并给出明确的错误信息，指向"在 `contributes.hooks` 中列出钩子 id"。
- 已被用户信任的插件：清单未变则摘要不变，但加载会失败，需要提示用户插件需更新；不应静默降级为"信任但不加载"，要在 Studio 展示原因。
- 方案 B 若引入新权限，旧清单没有该权限，可以采用"有 `contributes.hooks` 即视为隐含授予，过渡期后废除"的兼容期，具体时长留给评审。
- 市场与已发布插件：`marketplace/` 目录中的现有条目需要核对（未核实是否有订阅钩子的条目）。

## 7. 测试计划

- `packages/plugin` 单测：`contributes` 缺省订阅钩子被拒绝；`contributes` 已声明但未列出被拒绝；列出后通过；`panels` 的既有例外保持不变。
- 钩子元数据测试：每个已定义钩子都有风险等级；Studio 的展示与宿主元数据一致（可用快照测试避免两处分叉）。
- `plugin-host` 测试：`trust.test.ts` 中的 `hooks` 差异用例保持通过；新增缺省 `contributes` 的加载失败用例。
- 内置插件与示例回归：全部能加载。
- Studio：`plugin-review` 的组件测试，高风险钩子在对话框里被突出展示。

## 8. 未决问题

1. 仓库内与已发布插件中，有多少依赖省略 `contributes`（未核实）。
2. `weave.tools.result` 是否也应归为需要显式授权的高风险钩子。
3. 是否需要把钩子升格为 `permissions`（方案 B）及其时间点。
4. 对已信任但会因新规则加载失败的插件，用户侧的提示与恢复路径。
5. 高风险钩子的分类应放在哪个包里作为单一事实来源（`packages/plugin` 还是 `packages/plugin-host`）。
