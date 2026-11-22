# Official plugin and Skills references

The following read-only audits pin official source revisions checked on 2026-11-22. They inform Weave choices; no third-party source or content is copied into the implementation. They do not grant Weave another product's runtime or security guarantees.

# Weave 官方 Codex Skills / Plugins 机制审计

日期：2026-11-22

范围：OpenAI Codex 官方插件与 Skills 目录、Codex 技能加载语义，以及 Weave 当前 Studio/Server/Runtime 合约。

目的：为 Weave 的插件市场、Skills Studio 和后续官方/第三方插件接入提供可验证的实现边界。

## 结论先行

Weave 应借鉴当前 Codex 的“插件是可安装发行单元、Skills 是插件内的声明式指令包、目录只展示摘要、正文按需加载、安装和使用分开”这条主线。不能把旧的 `openai/skills` curated 仓库当作当前产品架构，也不能把精选目录里的插件统称为 OpenAI 官方插件。

当前官方的主要样本仓库是 `openai/plugins`，固定审计版本为：

- `openai/plugins`：`981b02c0c44058b595f3b4180002c3ae3c806d40`，2026-11-18。
- `openai/skills`：`49f948faa9258a0c61caceaf225e179651397431`，2026-06-24。该仓库 README 明确标注 **deprecated**，并把当前插件/Skill 示例指向 `openai/plugins`。
- `openai/codex`：`cf3ff1530d821ec2d26452da4971d8e3e7d18d25`，2026-11-22。Skills catalog prompt 源码用于核对发现、选择和按需读取语义。

官方开发者站点的 Skills、Plugins 和 App Features 页面在当前环境返回 403，因此本文不把这些页面当作已读取证据。行为判断来自上面的固定 GitHub 源码/清单和插件作者自己的安装说明；页面可访问性恢复后应再做一次版本核对。

对 Weave 的直接决定：

1. 插件市场可以提供官方精选索引、GitHub/URL 来源和本地来源，但要单独显示 `publisher/developer`、来源、审核/信任状态、版本和安装状态。
2. “精选目录中有”只能表示“被目录收录/可安装”，不能表示“预装、自动启用、由 OpenAI/Weave 维护”。
3. Marketplace 的安装对象是插件包；纯 Skills 插件不应被迫伪造 ESM 运行时代码。
4. Skills discovery 只读元数据，正文和 references 按需通过受治理的工具加载；加载 Skills 不会授予新的文件、进程、网络、审批或 MCP 权限。
5. Studio 需要把 Skills 选择作为结构化的本轮请求字段和耐久审计事实保存；不能只把 `$skill` 或命令文本展开后发送给模型。
6. 选中的 Skill 必须绑定完整 ID 和指令 SHA-256。插件/文件发生变化时，旧选择应明确变为 stale 并要求重新选择，不能静默换成同名新内容。

## 官方插件目录的实际形态

`openai/plugins` README 将仓库描述为“curated collection of Codex plugin examples”。每个 `plugins/<name>/` 通常有 `.codex-plugin/plugin.json`，可选内容包括：

- `skills/`：一个或多个声明式 Skill 目录；
- `.app.json`、`.mcp.json`：应用/远程工具配置；
- 插件级 `agents/`、`commands/`、`hooks.json`；
- 图标、Logo、截图等界面资源。

默认目录文件是 `.agents/plugins/marketplace.json`，API-key 登录场景使用 `.agents/plugins/api_marketplace.json`。两份目录并不完全相同，因而 Weave 不能假设所有账户、登录方式或客户端看到同一批插件。

截至固定版本，默认目录有 65 个条目，API 目录有 51 个条目。条目主要使用以下几类来源：

| 来源               | 示例                                                | Weave 含义                                                        |
| ------------------ | --------------------------------------------------- | ----------------------------------------------------------------- |
| `local` + 相对路径 | `./plugins/superpowers`、`./plugins/build-web-apps` | 目录仓库内置/随索引仓库发布的插件；不能简单等同于用户本机安装完成 |
| `url`              | CrowdStrike Falcon Foundry/Fusion Git 仓库          | 外部 Git 发行源，需要来源固定、下载、内容校验和信任流程           |
| `git-subdir`       | Qodo、AWS Core                                      | Git 仓库中的指定子目录，安装时必须保留子目录边界                  |

多数条目的 policy 是：

```json
{
  "installation": "AVAILABLE",
  "authentication": "ON_INSTALL" | "ON_USE"
}
```

`AVAILABLE` 是“目录提供安装入口”的状态，不是已安装或自动启用。`ON_INSTALL` 与 `ON_USE` 只描述认证时机，也不代表插件拥有额外权限。部分条目有 `products: ["CODEX"]`，表示产品过滤条件；不能把它解释为所有 Codex 表面都必然提供。

官方默认目录和 API 目录中都有 `superpowers`、`build-web-apps` 等条目；默认目录还包含更多连接器和研究/创作类插件。目录项可以通过 `interface.displayName`、`category`、`developerName`、短/长描述、关键词和默认提示词呈现到市场页。市场详情页应把这些展示元数据与信任/安装状态分开存储。

## 作者归属与精选关系

固定版本的 `superpowers` manifest：

- name/version：`superpowers` / `6.3.0`；
- author/developer：Jesse Vincent / Jesse Vincent；
- repository/homepage：`https://github.com/obra/superpowers`；
- license：MIT；
- skills：`./skills/`；
- category：Developer Tools。

它被 OpenAI 精选目录收录，但作者是 Jesse Vincent，不是 OpenAI。Weave 的 UI 和文档必须同时显示“目录收录方”和“插件作者/发行者”。

固定版本的 `build-web-apps` manifest 则声明作者为 OpenAI，包含前端测试、UI、Stripe、Supabase 等 Skills。两者可以同时出现在“官方精选”列表中，但不能用同一套“官方拥有/官方维护”标签描述。

## Codex App 与 CLI 的安装表面

`superpowers` 当前 README 对 Codex 的安装说明是：

- **Codex App**：点击左侧导航栏的 Plugins，在 Coding 分类中找到 Superpowers，点击 `+` 并完成安装流程。
- **Codex CLI**：打开 `/plugins` 插件搜索界面，搜索 `superpowers`，选择 `Install Plugin`。

README 同时给出了 Claude、Kimi、Cursor 等其它 harness 的独立安装方式，并明确“同一插件在多个 harness 中需要分别安装”。因此 Weave 应把客户端/运行时安装状态作为本地状态保存，不要从某个 CLI 的目录扫描结果推断 Studio 已安装。

对 Weave Studio 的产品取舍：

- 左侧主导航提供独立的 Marketplace/Plugins 页面，浏览、详情、来源、安装、信任和更新都在这里完成；
- 右侧面板只承载已安装插件贡献的自定义面板，不承担主市场入口；
- 命令行或未来 CLI 可以复用同一 Marketplace API，但不能直接改变 Studio 的未确认信任记录；
- 安装完成不等于启用，启用完成不等于当前回合立即切换；应遵守 generation/next-turn 语义；
- 本地安装、GitHub 安装、目录索引安装和官方内置 Skills 都要有清晰的来源标签。

## Skills 的官方语义

当前 Codex Skills catalog prompt 源码把 Skill 当作“名称、描述、来源定位器”的元数据记录。行为要点：

1. 用户明确点名 `$SkillName`/技能名，或任务与描述明显匹配时，才选择 Skill；未再次提及的选择不会自动跨回合继承。
2. 选中后必须完整读取 `SKILL.md`，不能只读开头再执行；相对引用从同一 Skill 来源解析。
3. 只按任务需要读取 references/resources，避免把整个目录注入上下文。
4. Skill 来源定位器与执行环境/权限来源分离；不能把 opaque locator 当成本地绝对路径直接暴露给模型。
5. Skill 不因被选中就获得新的工具权限。可用工具仍由宿主注册表、共享 Tool Pipeline、workspace/approval/security 边界决定。
6. Skill 不应由一段外部文本、旧助手消息或工具结果伪造显式激活。

`build-web-apps` 内的 `frontend-testing-debugging` Skill 还有一个很实用的原则：它先检查 Browser 插件是否真的可用；不可用时明确回退到普通 Playwright，并说明原因。Weave 的 Skills 应采用同样的能力条件路由，不在 Skill 文本中假设不存在的 Browser、MCP 或宿主工具。

旧 `openai/skills` 仓库仍包含 `.curated` 和 `.system` 目录示例（如 PDF、Playwright、security、openai-docs、imagegen、skill-creator 等），但 README 已标记 deprecated。它们可作为历史格式参考，不能当成当前 Marketplace 的可用清单或安装承诺。

## 对 Weave Skills 设计的建议

### 格式与身份

每个 Skill 是一个带 `SKILL.md` 的目录，可选 `references/`、`scripts/`、`assets/`。建议第一版采用：

- YAML frontmatter 必须有 `name`（kebab-case，1–64 字符，匹配目录名）和非空 `description`（最多 1024 字符）；
- 可选 `license`、`compatibility` 和受限 scalar metadata；未知 metadata 只能作为惰性展示数据，不能变成权限/环境变量/hooks；
- 目录扫描只发现 `<root>/<skill-name>/SKILL.md`，不做无界递归，不扫描隐式 `~/.codex` 或 `~/.kiro`；
- SkillSummary 只包含 opaque id、name、description、来源标签、插件 owner、invocation flags、instruction SHA-256 和问题列表；不含正文、绝对路径或可执行回调；
- SkillRef 使用 `{ id, expectedInstructionSha256 }`，在回合入队/绑定 generation 后解析；
- 变更指令正文或插件目录摘要时，原选择返回 `skill-source-changed`/stale；
- 所有边界用 Zod 校验，限制 frontmatter、正文、候选数、选中数量、总指令字节数和资源文件数。

建议初始限制（应写入设计文档并有行为测试）：frontmatter 8 KiB、单个 `SKILL.md` 64 KiB、每个 root 最多 128 个候选、每回合最多 32 个 Skill、选中指令总量 1 MiB、单个 bundle 最多 1000 个普通文件/20 MiB。模型 catalog 自身也要有 32 KiB 上限并显式返回 `complete/truncated`，不能把描述无界拼接。

### 来源和优先级

Server 根据当前 Session Project 绑定以下来源：

1. `<project>/.weave/skills`；
2. 可选兼容 `<project>/.agents/skills`；
3. 配置的数据目录 `skills/`；
4. Weave 内置 Skills；
5. 已安装、已启用、已信任且属于当前 generation 的插件 Skills。

每个来源使用稳定、可审计的 source-qualified ID。用户/模型看到的短名可以用于搜索，但多个来源冲突时应显示 shadowed/source 并要求完整 ID；已选完整 ID 不能在高优先级来源不可读时静默回退到另一个同名 Skill。

`plugin-host` 只负责受边界限制的发现、读取和摘要计算；不导入 Runtime、Session、HTTP，不执行脚本，也不决定模型是否能调用。Server 负责把 Session/Project 映射到 roots，并和插件 generation 合并。

### 加载和工具管线

建议注册两个宿主内置只读工具：`read_skill` 和 `read_skill_resource`。二者都必须经过共享 Tool Pipeline，并绑定真实 `turnId`、catalog/generation、source identity 和内容 hash：

- `read_skill` 返回完整小正文，或带 `nextCursor` 的内容绑定分页；
- cursor 绑定 turn/catalog/source/content hash/resource/offset，不包含可直接使用的文件路径；
- 只允许已激活 bundle 的相对 POSIX 路径，拒绝绝对路径、驱动器/UNC、NUL、反斜杠、`.`、`..`、URL scheme；
- 检查 symlink/special file、根目录逃逸、增长探针和 hash 变化；
- 未完成 EOF 前不能标记正文已加载；
- scripts 只是数据，只有已有的受治理 process tool 在用户/审批允许时才能执行。

ToolExecutionContext/Request 需要补充实际 `turnId`；仅凭可变的 sessionId “当前 Skill” map 无法覆盖队列等待、generation 替换和直接 Runtime 调用。

### Durable 事实与回合边界

必须区分：

- **请求事实**：用户本轮选择了哪些 SkillRef；
- **应用事实**：哪些引用通过信任、启用、项目和 hash 检查并成功加入本轮；
- **失败事实**：stale、disabled、wrong-project、non-user-invocable 等原因。

建议追加 `skill.catalog-applied`、`skill.requested`、`skill.applied`（或等价）事件，事件里只保存小型身份、版本/hash、来源和错误信息，不把整篇指令正文塞进 Session GET。Studio 从 session detail 重建用户消息上的 Skill chips/badges；应用前不要显示“已生效”。

## 当前 Studio 合约缺口

当前分支代码审计结果：

- `apps/studio/src/features/agent/agent-types.ts` 的 `AgentRunRequestInput` 没有 `skills`；浏览器 Zod request 是 strict。
- `apps/server/src/agent-api.ts` 的 HTTP request schema 没有 `skills`，需要镜像受限 SkillRef。
- `packages/runtime/src/agent-types.ts` 的 `AgentRunRequest`、instructions context 和 ToolExecutionContext/Request 没有结构化 Skill 选择/真实 turnId。
- `apps/studio/src/app/App.tsx` 的 `submitMessage` 只发送文本、图片、provider/model/reasoning/permission；retry 通过 `submitMessage(lastUserMessage.text)`，因此会丢失本轮图片和任何未来 Skill 选择。
- `toChatMessages` 没有把 WorkspaceMessage 的 turnId/provenance 映射到 user card；当前 user message 也没有保存 turnId。
- `sessionDetailSchema`/turn summary 没有 Skill request/applied/failure provenance。
- `agent-stream.ts` 使用已知 SSE event 名单；如增加 skill-status 事件，必须同步 union、schema、knownEventNames 和 handleEvent。第一版可通过完成后的 durable refresh 避免新增 SSE。
- 当前 selectedContexts 是全局且偏 UI cosmetic，切换 Session/Project 时可能把 A 项目的选择带到 B；Skills 选择必须显式绑定 session/project 和 catalog epoch。
- `/commands` picker 与 `$skill` picker 需要独立 kind/namespace，不能通过可见命令模板展开来代替结构化选择。

建议的 Studio 变更：

1. 在 App-owned store 保存 `catalogBySessionContext`、`selectedSkillRefsBySession`、refresh epoch、stale/uncertain 状态；浏览 Marketplace 不应销毁待发送选择。
2. `AgentRunRequestInput`/server/runtime 三层增加受限 `skills: SkillRef[]`，禁止发送正文和绝对路径。
3. submit 时捕获完整 request snapshot；retry 复用原 selections/images/permission/provider/model，遇到 hash stale 显示可操作错误，不静默重映射。
4. history/session detail 增加小型 Skill provenance；user card 显示 requested/applied/failed badge。
5. Skills catalog 只展示 metadata；可选 preview endpoint 必须有大小/权限/来源边界，不能为了 UI 预加载整棵插件目录。
6. 以 `read_skill` 工具 timeline 体现模型的正文读取；若以后增加 skill-status SSE，先更新浏览器 schema 和处理分支。

## 建议的 Weave 内置 Skills

第一批可由 Weave 自己维护的 Skills（不要把第三方 Superpowers 冒充 Weave authored）：

- `plan-work`：澄清目标并产出具体步骤；宿主有 `update_plan` 时使用，但不要求无意义的多轮确认；
- `review-code`：读 diff/context，按严重度和文件行号报告；未授权不编辑、提交或发布；
- `debug-issue`：复现、收集证据、缩小假设、修复并补行为回归；
- `verify-change`：按改动风险选择检查并报告实际输出；简单可逆的样式变更不强制跑整套测试；
- `write-tests`：围绕行为/不变量写有意义的测试，遵守各包 `test/` 目录；
- `document-change`：跨包合约变化先更新 ADR/架构文档，不自动发布；
- `frontend-check`：浏览器可用时走 Browser，否则说明原因并使用普通 Playwright/现有测试。

这些 Skills 只提供指导文本，继续使用 Weave 现有 workspace、approval、process、tool pipeline 边界，不新增权限。

## 推荐实现顺序

1. **设计/Schema**：更新 Foundation/ADR，定义 SkillSummary、Catalog、Definition、Ref、provenance 事件和插件 `contributes.skills`/`weave.skills` extension point。
2. **Plugin/host**：实现受限 SKILL.md 解析、摘要、发现、正文/资源读取和 source/hash identity；补边界测试。
3. **Runtime**：generation-scoped catalog/resolver、`skills` request、turnId 传递、`read_skill`/`read_skill_resource` ToolDefinitions；显式选择 stale/disabled 失败。
4. **Server**：Session 项目 roots、catalog API、request forwarding、durable projections；保持 HTTP handler 薄。
5. **Studio Composer**：独立 Skills picker、session-qualified store、完整 retry request、stale UI、history badges。
6. **Marketplace integration**：先接官方精选索引/本地插件安装，再接 GitHub URL/gitsubdir；来源、作者、信任、版本、安装状态分层。
7. **Builtins/curated**：先发布 Weave authored 内置 Skills，再以“精选第三方”标签接入 Superpowers 等；不把所有官方目录条目一次性硬编码成本地插件。
8. **验证**：schema/typecheck/lint/unit；插件目录变化、symlink/path escape、stale hash、generation next-turn、queue/retry、session isolation、catalog incomplete、Browser fallback、marketplace source/auth tests。

## 不能直接复制的部分

- Codex 的云执行器、沙箱、权限保证不能自动套用到 Weave；Weave 仍以自身 Tool Pipeline 和 approval/security boundary 为准。
- DeepSeek Harness 的 Cordis scope/watcher/ranking 不能直接移植；Weave 第一版应显式 refresh、稳定 ID 和 stale fail-closed。
- Kiro 的隐式全局 `~/.kiro/skills` 发现不能直接开启；Weave 需要显式配置 roots，并显示来源/冲突。
- Superpowers 的自动方法论触发和长时间自治流程不能转成 Weave 的强制权限或自动提交规则；只取其 Skills 组织方式、计划/TDD/调试/评审的可复用指导。

## 证据文件

本次审计使用的本地快照位于 `/tmp/weave-codex-official-research/`：

- `.agents__plugins__marketplace.json`
- `.agents__plugins__api_marketplace.json`
- `plugins__superpowers__.codex-plugin__plugin.json`
- `plugins__superpowers__README.md`
- `plugins__build-web-apps__.codex-plugin__plugin.json`
- `plugins__build-web-apps__skills__frontend-testing-debugging__SKILL.md`
- `plugins__superpowers__skills__writing-plans__SKILL.md`
- `plugins__superpowers__skills__requesting-code-review__SKILL.md`

已有的 Weave Skills 详细设计审计位于 `/tmp/weave-skills-audit.md`。它包含更细的 parser、资源安全、plugin-host、runtime 以及 session event 草案；本文将官方证据和当前 Studio 缺口补充到该设计之上。

固定版本来源链接：

- https://github.com/openai/plugins/blob/981b02c0c44058b595f3b4180002c3ae3c806d40/README.md
- https://github.com/openai/plugins/blob/981b02c0c44058b595f3b4180002c3ae3c806d40/.agents/plugins/marketplace.json
- https://github.com/openai/plugins/blob/981b02c0c44058b595f3b4180002c3ae3c806d40/.agents/plugins/api_marketplace.json
- https://github.com/openai/plugins/blob/981b02c0c44058b595f3b4180002c3ae3c806d40/plugins/superpowers/.codex-plugin/plugin.json
- https://github.com/openai/plugins/blob/981b02c0c44058b595f3b4180002c3ae3c806d40/plugins/superpowers/README.md
- https://github.com/openai/plugins/blob/981b02c0c44058b595f3b4180002c3ae3c806d40/plugins/build-web-apps/.codex-plugin/plugin.json
- https://github.com/openai/plugins/blob/981b02c0c44058b595f3b4180002c3ae3c806d40/plugins/build-web-apps/skills/frontend-testing-debugging/SKILL.md
- https://github.com/openai/skills/blob/49f948faa9258a0c61caceaf225e179651397431/README.md
- https://github.com/openai/codex/blob/cf3ff1530d821ec2d26452da4971d8e3e7d18d25/codex-rs/ext/skills/src/catalog_prompt.rs

# 官方 Harness / Kimi 插件与 Skills 调研

日期：2026-11-22。只读调研；未修改 Weave 仓库，未安装或运行第三方插件，未访问任何本机账号凭据，未创建仓库、提交、推送或发布。

## 结论

可以借鉴两家的产品分层，但不应把它们的 npm 包、CLI 配置技能或账号插件直接列成 Weave 可安装插件。

- Harness 把“随应用提供”“随安装附带但默认关闭”“官方按需安装”“第三方市场索引”分开维护；其中官方按需元数据可以离线浏览，真正安装仍交给普通安装器。其 `office` 是配合工具与运行时分发的产品能力，不是下载一段 Markdown 就完整可用。
- Kimi Code 同时有真实桌面代码和 CLI。当前官方市场是产品后端提供的目录，和任意自定义 JSON 来源分开；CLI 文档与共享图形界面均区分官方、精选第三方、自定义来源。Kimi 官方插件有数据源、浏览器与桌面操作，但需要账号、扩展或原生权限，不能当作纯 Skills 首批直接移植。
- Weave 首批应做少量由自己维护、与实际已实现能力一致的官方 Skills：产品使用/排障、插件开发、技能编写。MCP 使用指南可随 MCP 能力一起加入；完整 Office、浏览器、CUA、外部产品委派留给具有实际工具链的后续插件。开发者投稿与第三方索引永远不能自授“官方”。

## 精确版本、维护者与许可证

| 对象             | 核对版本                                   | 维护与许可证证据                                                                                                                                          | 用途                                                                             |
| ---------------- | ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| DeepSeek Harness | `d98f5d68519215da48f3002da2cb9c9d2068d81d` | `deepseek-ai/deepseek-harness`；根 LICENSE 为 MIT，Copyright (c) 2026 DeepSeek；`dsh-skill-office` 自身 package.json 也明确 MIT、公开发布、指向该官方仓库 | 当前产品组合、官方列表、Office/插件开发技能、第三方 CLI 连接器机制               |
| Kimi Code        | `83e4dde93453dd22e89da03d2c96d84999e7d0c2` | `MoonshotAI/kimi-code`；根 LICENSE 为 MIT，Copyright (c) 2026 Moonshot AI；Desktop package author 是 Moonshot AI                                          | 当前 CLI、桌面共享插件页、内置技能、市场与预览协议                               |
| 旧 Kimi CLI      | `9ab1286b8fe4e6bcd116949a27ce5e0ac3389c82` | 官方 README 明确项目已归档、不再维护，由 Kimi Code CLI 替代；旧代码仍为 Apache 2.0                                                                        | 仅用于说明历史迁移，不能再用它的发现优先级或旧 skill-creator 作为“当前 Kimi”结论 |

可重新核对的 pinned 链接：

- [Harness LICENSE](https://github.com/deepseek-ai/deepseek-harness/blob/d98f5d68519215da48f3002da2cb9c9d2068d81d/LICENSE)
- [Harness Office package](https://github.com/deepseek-ai/deepseek-harness/blob/d98f5d68519215da48f3002da2cb9c9d2068d81d/packages/skill/skill-office/package.json)
- [Kimi Code LICENSE](https://github.com/MoonshotAI/kimi-code/blob/83e4dde93453dd22e89da03d2c96d84999e7d0c2/LICENSE)
- [Kimi Desktop package](https://github.com/MoonshotAI/kimi-code/blob/83e4dde93453dd22e89da03d2c96d84999e7d0c2/apps/desktop/package.json)
- [旧 Kimi CLI 归档声明](https://github.com/MoonshotAI/kimi-cli/blob/9ab1286b8fe4e6bcd116949a27ce5e0ac3389c82/README.md)

上述许可证允许按其条款引用或改编对应源码/文字；若实际复制须保留相应版权和许可声明。官方服务、品牌、浏览器扩展、上游 CLI 二进制、Office 引擎、第三方技能及其资源应逐项核对自己的许可和服务要求，不能用仓库根 MIT 替代所有这些审查。本次没有复制内容到 Weave。

## Harness：官方能力是产品持有的组合目录

一手依据：[官方组合目录说明](https://github.com/deepseek-ai/deepseek-harness/blob/d98f5d68519215da48f3002da2cb9c9d2068d81d/packages/util/official-bundles/README.zh.md)、[静态组合名单](https://github.com/deepseek-ai/deepseek-harness/blob/d98f5d68519215da48f3002da2cb9c9d2068d81d/packages/util/official-bundles/src/bundles.ts)、[生成的官方按需目录](https://github.com/deepseek-ai/deepseek-harness/blob/d98f5d68519215da48f3002da2cb9c9d2068d81d/packages/util/official-bundles/src/catalog.generated.ts)、[管理页排序/隐藏规则](https://github.com/deepseek-ai/deepseek-harness/blob/d98f5d68519215da48f3002da2cb9c9d2068d81d/packages/util/official-bundles/src/plugin-manager.ts)。

`PROFILE_TEMPLATES` 选择 web/headless/acp/sdk/sdk-minimal 启动时组合。`OPTIONAL_BUNDLES` 是应用依赖中已经附带、由用户开启的官方组合，包括实验性终端、会话搜索、语音、插件市场等。`ON_DEMAND_BUNDLES` 在该版本仅列出两个官方包：`dsh-subagent-claude-code` 和 `dsh-subagent-codex`。

按需目录内嵌包自己的本地化名称、说明、图标、可选平台限制。显式生成命令更新已提交目录；构建和浏览不用导入提供方代码。目录不包含安装目标；普通安装器根据实际产品版本推导目标。改官方名单需发布应用版本，用户 profile 不能扩展“官方”名单。

这和此前已核对的实验性第三方 plugin-market 静态索引是两层机制，不存在“实验市场当前没有官方在线索引，所以产品没有官方插件”的推论。Weave 适合借鉴的是产品自己持有官方名单和真实离线元数据，同时保留独立第三方来源及普通安装流程。

### 真正的官方 Skills 与工具边界

1. **产品与插件开发：`dsh-doc`。** [当前 SKILL.md](https://github.com/deepseek-ai/deepseek-harness/blob/d98f5d68519215da48f3002da2cb9c9d2068d81d/packages/preset/agent-preset/skills/dsh-doc/SKILL.md) 先检查运行版本的服务/工具/源码与本地文档，再按任务加载 references。包含插件开发、MCP、声明、配置、UI、工具、升级等分支。加载技能明确不授权更改 profile；只读问题不执行安装/启停。Weave 可采用“产品指南 + 当前版本事实 + 分支参考”组织，但应换成自身 SDK、Session/Generation/Tool Pipeline 和已实现 API，不能引用 Cordis 命令或模板。
2. **Office：单一 `office`。** [Office README](https://github.com/deepseek-ai/deepseek-harness/blob/d98f5d68519215da48f3002da2cb9c9d2068d81d/packages/skill/skill-office/README.zh.md)、[完整技能正文](https://github.com/deepseek-ai/deepseek-harness/blob/d98f5d68519215da48f3002da2cb9c9d2068d81d/packages/skill/skill-office/assets/office/SKILL.md)、[Office 工具](https://github.com/deepseek-ai/deepseek-harness/blob/d98f5d68519215da48f3002da2cb9c9d2068d81d/packages/document/tool-office/README.zh.md)。目录只放一个精简摘要；加载后给 Word/PPT/Excel 容易损失格式、文字溢出和公式未计算的要点，并在下一步开启 `office_render`、`office_convert`、`office_recalculate`。普通 Web 和 SDK profile 可挂载 Office；Desktop/带 primary runtime 的 SDK 再提供内置 Python/Node 路径查询。minimal 预设不由此获得 Office。引擎缺失会明确失败；Skill 不安装创作库，也不在加载时运行转换器。
3. **真实 CLI 连接器：飞书等。** [Feishu 官方插件](https://github.com/deepseek-ai/deepseek-harness/blob/d98f5d68519215da48f3002da2cb9c9d2068d81d/packages/connector/feishu/README.zh.md) 是固定 `@larksuite/cli` + `feishu` 索引 Skill + 账号连接 UI。子指南在 CLI 二进制内，按 `lark-cli skills read` 阅读。登录会和用户终端共用凭据；停用不退出账号。该版本 macOS/Windows x64，不能泛化成所有系统都有的文本能力。
4. **上游动态技能资源。** [upstream-skills](https://github.com/deepseek-ai/deepseek-harness/blob/d98f5d68519215da48f3002da2cb9c9d2068d81d/packages/connector/upstream-skills/README.zh.md) 为部分厂商仅在 GitHub 提供的子指南保留“插件自己的入口 + 固定仓库/commit/目录/总大小/摘要/许可证”的结构，首次下载检验后发布缓存。它在没有提供方注册时不下载，卸载撤掉注册并取消下载。Weave 可采用“资源来源和许可可追踪”，暂不需要为首批 Skills 加运行时远程下载服务；现有不可变插件制品已经能分发审核过的资源。

### Desktop / CLI 不可混为一谈

[Desktop 说明](https://github.com/deepseek-ai/deepseek-harness/blob/d98f5d68519215da48f3002da2cb9c9d2068d81d/apps/desktop/README.zh.md) 明确 Desktop 是完整 Web 应用外的 Electron 壳，启动本机 profile Host；它额外打包 pnpm 和 primary runtime。`load_workspace_dependencies` [自己的说明](https://github.com/deepseek-ai/deepseek-harness/blob/d98f5d68519215da48f3002da2cb9c9d2068d81d/packages/skill/tool-workspace-dependencies/README.zh.md) 区分 Desktop 安装复制与只读载体原位使用、平台架构与版本校验、缺失 payload 错误。Weave 现在没有相同的 Office 引擎和打包运行时，因此不能直接复制“内置 Python 已提供”“渲染工具自动出现”等承诺。可先给出使用用户已有环境的指南，只有端到端工具和渲染验收完成后才宣告完整 Office 功能。

## Kimi：当前参考应换到 Kimi Code

### 官方市场、精选与自定义来源

官方 [当前插件文档](https://github.com/MoonshotAI/kimi-code/blob/83e4dde93453dd22e89da03d2c96d84999e7d0c2/docs/zh/customization/plugins.md) 的 CLI `/plugins` 分 Installed、Official、Curated、Custom。官方三类产品能力为：Kimi Datasource、Kimi Browser Extension、Kimi Computer Use；Datasource 需要 Kimi OAuth 且消耗套餐额度，Browser 还需安装浏览器扩展，CUA 还需辅助功能/录屏等平台授权。官方维护身份不等于无需依赖、账号或权限。

同文档明确 plugin 可以携带 Skills、Agents、会话初始技能、系统指令和 MCP；支持本地目录、zip URL、GitHub。GitHub 安装策略允许最新 release、默认分支、tag、短 commit，并非 Weave 的仅完整 SHA 策略。安装/启停后现有会话不会更新，需 `/reload` 或 `/new`；Weave 应继续用自己的回合固定 Generation 和下一回合生效语义。插件用户级安装并共享托管目录；`clients` 和 `platforms` 控制产品宿主与 server OS，Remote/Web 跟随连接的 server，不按浏览器设备判断。

[CLI 市场加载源码](https://github.com/MoonshotAI/kimi-code/blob/83e4dde93453dd22e89da03d2c96d84999e7d0c2/apps/kimi-code/src/utils/plugin-marketplace.ts) 与 [常量](https://github.com/MoonshotAI/kimi-code/blob/83e4dde93453dd22e89da03d2c96d84999e7d0c2/apps/kimi-code/src/constant/app.ts) 表明：默认目录来自当前 managed runtime baseUrl 的 `/plugins/marketplace`；默认来源可附加 Kimi OAuth，显式自定义来源/环境覆盖不附加默认 OAuth。这是账号后端目录机制，不是单纯 GitHub JSON + PR 的发布服务。Weave 当前没有必要为借鉴 UI 分类先引入账号/审核/付费后台。

本次未获取登录账号下的实时市场目录、未下载这些插件、未验证它们的服务可用性。文档三项是该 pinned 版本的一手产品说明，不是实时全量插件清单或“这三个插件一定都可跨宿主安装”的保证。

### 图形界面确实存在，且通过服务契约访问插件

不能因为 CLI 文档多就说 Kimi 没有 Desktop。除 `apps/desktop/package.json` 外，已读取共享 UI：

- [PluginsPanel.vue](https://github.com/MoonshotAI/kimi-code/blob/83e4dde93453dd22e89da03d2c96d84999e7d0c2/packages/app-components/src/settings/PluginsPanel.vue)：图形界面有 Marketplace / Installed 视图，Marketplace 中按 official / curated 分区，另有自定义来源安装弹窗和搜索。
- [usePlugins.ts](https://github.com/MoonshotAI/kimi-code/blob/83e4dde93453dd22e89da03d2c96d84999e7d0c2/packages/app-client/src/composables/usePlugins.ts)：并行读取市场、已装状态与能力，按 marketplace 关联身份/版本计算详情和行为；来自市场的能力预览与已安装实际能力分开读取。
- [KAP plugin wire schema](https://github.com/MoonshotAI/kimi-code/blob/83e4dde93453dd22e89da03d2c96d84999e7d0c2/packages/kap-server/src/protocol/rest-plugin.ts)：preview/install 可携带 `marketplace_id`、`expected_version`、`expected_sha256`；插件概要有 installed SHA、skill/MCP/hook/command 数量、origin、diagnostics。
- [KAP Skill wire schema](https://github.com/MoonshotAI/kimi-code/blob/83e4dde93453dd22e89da03d2c96d84999e7d0c2/packages/kap-server/src/protocol/rest-skill.ts)：技能列表与显式激活有独立协议。

Weave 可采用“发现详情和已安装真实能力分开”“选择固定版本再预览”“共享 HTTP 协议，UI 不直接读插件目录”。本次未启动 Kimi Desktop，不能把源码存在说成已经在本机验证全部桌面交互。也不能把它的 Vue 组件直接混入 Weave React Studio。

### 内置 Skills 是产品任务引导，不是通用能力全集

[当前 Skills 文档](https://github.com/MoonshotAI/kimi-code/blob/83e4dde93453dd22e89da03d2c96d84999e7d0c2/docs/zh/customization/skills.md)、[Builtin skill source](https://github.com/MoonshotAI/kimi-code/blob/83e4dde93453dd22e89da03d2c96d84999e7d0c2/packages/agent-core-v2/src/features/skill/catalog/builtinSkillSource.ts)、[静态内置列表](https://github.com/MoonshotAI/kimi-code/blob/83e4dde93453dd22e89da03d2c96d84999e7d0c2/packages/agent-core-v2/src/features/skill/catalog/builtin/builtin.ts) 和 [斜杠说明](https://github.com/MoonshotAI/kimi-code/blob/83e4dde93453dd22e89da03d2c96d84999e7d0c2/docs/zh/reference/slash-commands.md) 已交叉核对。

源码静态数组包括 `mcp-config`、`import-from-cc-codex`、`update-config`、`custom-theme`、`write-goal`、`check-kimi-code-docs`、sub-skill parent/review/consolidate。随后叠加注册贡献并按 productSpecific / experimentalFlag 过滤。文档的可见斜杠列表略少，因此应区分源码定义、功能开关后可见和最终实际安装，不能单凭数组数量宣传“九个始终可用技能”。内置优先级最低，部分产品技能可通过配置关闭。

当前 Kimi 支持用户 `$KIMI_CODE_HOME/skills` 和 `~/.agents/skills`，项目 `.kimi-code/skills` / `.agents/skills`，还有显式额外目录；保留不同工作区同名变体，来源标签帮助选择。旧 Python Kimi CLI 的 `~/.config/agents/skills` / `~/.kimi` 等优先级不可拿来当当前策略。

两个适合 Weave 的具体参考：

- [`check-kimi-code-docs`](https://github.com/MoonshotAI/kimi-code/blob/83e4dde93453dd22e89da03d2c96d84999e7d0c2/packages/agent-core-v2/src/features/skill/catalog/builtin/check-kimi-code-docs.md) 按产品问题路由到官方文档、读取后回答，未覆盖/失败如实说明，不编造配置。Weave 可以自己维护 `weave-guide`，优先读取当前安装版本随附资料，不依赖还不存在的在线站点。
- [`mcp-config`](https://github.com/MoonshotAI/kimi-code/blob/83e4dde93453dd22e89da03d2c96d84999e7d0c2/packages/agent-core-v2/src/features/skill/catalog/builtin/mcp-config.md) 区分 OAuth 登录与配置编辑、要求按真实数据根定位，并解释启动 stdio 会运行命令。Weave 可以借用任务分流与准确配置来源，但当前模型禁止管理插件信任/启停/重载，Skill 不能通过 HTTP/配置文件编辑绕过管理页或授予管理工具。

额外的仓库级 [`use-kimi-code`](https://github.com/MoonshotAI/kimi-code/blob/83e4dde93453dd22e89da03d2c96d84999e7d0c2/skills/use-kimi-code/SKILL.md) 使用 CLI 做一次性委派，复杂协作用当前运行实例自描述 KAP API，而不把路由固定进技能。它读取本机 token、发现实例、可启动服务，适合有明确用户授权的外部集成插件；不属于无需适配即可给 Weave 内置的安全纯文本技能，也不在上述静态 BUILTIN_SKILLS 数组内。

## 首批 Weave 官方 Skills 建议

“官方”表示由 Weave 项目维护、与当前版本一起审核和验证，不表示上游作者为 Weave 背书。

| 候选                                    | 第一版真实价值                                                                                                         | 上游启发                                                         | 首批判断与依赖                                                                                         |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `weave-guide`                           | 解释已实现的会话、审批、插件候选/信任/激活、MCP 与市场来源；排查兼容/过期来源/加载失败                                 | Harness `dsh-doc`；Kimi `check-kimi-code-docs`                   | 推荐，先提供准确的当前版静态 references；不写不存在的设置/工具                                         |
| `weave-plugin-author`                   | 从 Weave SDK/manifest 边界说明 Tool/Command/Skill 插件，构建单文件 ESM、固定 SHA、准备目录投稿；核对实际开发工具能否用 | Harness `dsh-doc` 的任务路由、插件模板/审核/升级说明             | 推荐，但模板命令须跟当前真实 CLI 一致；没有 create/pack 命令时不能捏造；Panel SDK 还没做就标明尚未支持 |
| `weave-skill-author`                    | 创建/检查 SKILL.md、触发描述、渐进 references、资源相对路径、声明和分发，避免覆盖用户技能                              | 两家目录/正文/资源分层；旧 kimi skill-creator 仅作为历史结构参考 | 推荐，由 Weave 自己编写，使用自己的 parser/限制与行为测试；外部资源不自动执行                          |
| `weave-mcp-guide`                       | 解释 server 配置、连接/工具可见性、stdio 风险和失败诊断，把用户带到已有管理入口                                        | Kimi `mcp-config`；Harness MCP 开发参考                          | 有实际 MCP 管理 API/UI 后可推荐；保持解释/只读诊断，不能为模型开信任、启停、重载管理后门               |
| `office` 或分开的文档/表格/幻灯片 Skill | 正确创作、转换、渲染、重算并可验证交付                                                                                 | Harness Office 渐进技能和工具配套                                | 暂缓完整官方能力；先解决运行时、渲染/重算工具、资源、许可与真实样例验收；只装文字不算完成              |
| 飞书/浏览器/CUA/外部 Agent              | 真实工作流与工具接入                                                                                                   | Harness CLI 连接器；Kimi 官方三类插件和 KAP                      | 后续独立功能，须有实际执行/账号/系统权限与取消生命周期；不要添加不可用的占位市场卡片                   |

代码审查、调试、测试、Git 工作流可以成为 Weave 自有技能候选，但本次官方证据没有证明它们在两家是默认终端/桌面内置通用套件；如果首批加入，应按 Weave 自己的产品需求和真实评测选型，不能冠以上游“官方同款”。

## 落地时需保留的边界

1. 官方名单由宿主拥有；社区索引 `publisher` 和自述 metadata 不改变分类或信任。
2. 发现目录、读取技能、安装制品、激活运行时是不同动作。目录 GET、页面挂载、查看 Skill 均不导入未信任插件、不下载依赖、不运行脚本。
3. 保留当前 Weave 的固定完整 commit、目录摘要、不可变候选、显式审阅激活和回合 Generation 语义，不照搬 Kimi mutable Git refs 或 Harness pnpm 安装/构建授权。
4. Skill 是指令和资源；执行仍走共享 Tool Pipeline、正常工作区和审批边界。模型不能因“加载官方技能”就获得管理审批或插件信任能力。
5. 官方能力目录应显示实际提供方式和兼容性：随应用提供/需要安装、所需工具、宿主/平台/引擎、账号/扩展依赖。未实现能力不作为能点击安装的卡片。
6. 正文与资源采用完整身份和版本绑定；同名冲突显示来源，旧选择过期时明确失败，不暗中换一个提供方。
7. 首批通过真正端到端例子验收：显式选技能、自动懒加载、引用资源、无脚本副作用、正常工具执行与审批、下一回合/Generation/重启、市场和已装能力一致。不能只测试卡片字符串存在。

## 调研证据与限制

GitHub tree 的完整 commit 已保存在 `/tmp/harness-official-tree.json`、`/tmp/kimi-official-tree.json`、`/tmp/kimi-code-official-tree.json`；本报告引用的已读文本保存在 `/tmp/weave-official-reference/`，文件名以项目名和双下划线编码路径。复用缓存避免重复访问；新增许可证、Office 工具、Desktop、Kimi 市场和共享 UI 通过 pinned GitHub contents API/raw 成功取得。

部分 raw 请求超时后改用官方 contents API 得到相同固定提交的文本。曾猜测的 Kimi `packages/agent-core-v2/src/features/plugin/marketplace.ts` 返回 404，没有把该路径用作证据；市场结论来自实际存在的 CLI loader、app constants、shared UI 和 KAP schemas。未运行 Harness/Kimi 应用、未调用其账号服务、未证明二进制或第三方 SaaS 的跨产品兼容性。本报告的产品建议均为 Weave 的取舍，不能继承它们的 OS 沙箱、权限或安全保证。

## Declarative panel scope

The custom-panel slice adopts the already pinned references’ separation of
discovery, installation, activation and current execution authority. It does not
claim that Codex, Kiro, Harness or Kimi expose this exact panel SDK. Weave chooses
closed host-rendered JSON and prepare-only native forms, with no arbitrary
renderer code or inherited sandbox guarantee. Exact choices and upstream commit
evidence are retained in the [panel design](../superpowers/specs/2026-11-22-plugin-panels-design.md).

## 首批 Weave 原创内容落地

四项使用与开发 Skill 位于 `plugins/official/weave-official-skills/`。固定产品
契约依据包括已合并 Panel SDK `e7dd7ca80dfa71d46fa73b5a5b6dffbb1ae8ad49`；
资源自包含，示例使用真实 SDK/CLI，内容没有复制上游 Skill 文本。
市场官方身份采用宿主固定完整发行元组，不能从目录收录或 publisher 自述推断。
真实包验证、场景审阅与固定 SHA 发行状态见[使用说明](2026-11-22-official-skills.md)。
