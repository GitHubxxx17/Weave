# trust 模式下的 shell 命令审批策略设计提案

状态：已评审（2026-11-24）。结论见下方「评审结论」；正文其余部分保留为评审时的分析，与结论冲突处以结论为准。

## 评审结论（2026-11-24）

采用评审新增的方案（不在第 3 节 A 到 D 之中）：**无法识别的命令由模型判断风险**。trust 模式下 `run_command` 的审批规则为：

1. **白名单**（只读命令和明确的构建、测试命令，按子命令精确匹配；命令中出现 `;`、`&&`、`||`、`|`、重定向、`$(`、反引号、`eval`、`sh -c` 等任一元字符即不算命中）：直接执行。
2. **黑名单**（现有危险命令正则，如 `sudo`、`rm`、`git push`）：**一定询问，模型的声明不能覆盖**。
3. **其他命令**：`run_command` 增加一个必填参数，由模型声明该命令的风险等级（例如 `low` / `high`）并给出简短理由。声明为 `high` 时弹出审批，否则直接执行。审批卡片和执行记录中保留模型的声明与理由。

已知风险：模型的判断可能被它读到的内容诱导（例如文件内容或 MCP 结果声称某命令安全），因此黑名单这道底线必须保留，且不随模型声明放宽。ask 与 yolo 模式的行为不变。

本轮不做：用户级"以后允许此前缀"、对 `.git/hooks`、`package.json` 脚本等敏感路径写入的单独处理。

实现前需要补充的设计：新参数的名称、取值与 schema；旧模型或缺少该参数时的回退（建议视为 `high`）；白名单初始清单。

对应观察编号：T1。

## 1. 背景

以下现状均已对照当前代码核实。

- `packages/runtime/src/approval-risk.ts` 的 `classifyApprovalRisk(operation, input)` 对 `shell.run_command` 读取 `input.command` 字符串，用一条正则 `dangerousCommandPattern` 判断：命中返回 `ask`，否则返回 `auto`。正则内容为：
  - 词边界匹配 `sudo`、`rm`、`rmdir`、`mkfs`、`dd`、`shutdown`、`reboot`、`kill`、`pkill`、`chmod`、`chown`、`curl`、`wget`、`nc`、`ssh`、`scp`；
  - `git` 后跟空白再接 `push`、`reset`、`clean`；
  - `npm`、`pnpm`、`yarn` 后跟空白再接 `publish`；
  - 整体大小写不敏感。
- `workspace.write_file` 与 `workspace.edit_file` 在 trust 模式下一律 `auto`；未知的受保护操作一律 `ask`；`shell.run_command` 缺少 `command` 字段时读为空串，结果是 `auto`（见 `packages/runtime/test/approval-risk.test.ts` 的"missing input"用例）。
- `approvalRequiredForMode(mode, operation, input)`：`ask` 模式总是需要审批，`yolo` 模式从不需要，`trust` 模式取决于上述分类。`packages/runtime/src/tool-pipeline.ts`（约第 595 行）在工具定义带 `approval` 元数据时调用它；策略层要求审批（`forceApproval`）时不论模式都需要审批。
- 命令由 `packages/runtime/src/command-tool.ts` 经 `spawn(shell, args, { cwd })` 在工作区内运行，使用 `$SHELL`（POSIX）或 PowerShell（Windows）。工作目录路径由工作区路径策略做词法解析，但命令本身可以访问用户权限范围内的任何文件、网络与凭据（该工具没有 OS 级沙箱，未发现相关实现；未核实 `shell-environment.ts` 对环境变量的过滤细节）。
- `docs/architecture/foundation.md` 约第 564 行说明 `permissionMode` 选择 `ask`（默认）、`trust` 或 `yolo`，不额外授予工具。

## 2. 问题

正则黑名单对"危险"的定义是关键词，不是行为，存在两类问题。

**漏报（trust 模式下直接执行）**，按正则逐项对照得出，未实际运行：

- `python -c "import shutil; shutil.rmtree('.')"`、`node -e "fs.rmSync('x', {recursive:true})"`：解释器内联代码，名单中无解释器。
- `find . -delete`、`find … -exec …`：`find` 不在名单。
- `git checkout .`、`git restore .`、`git stash drop`、`git branch -D`、`git rebase`、`git commit --amend`：只有 `push`、`reset`、`clean` 在名单。
- `git -C . push`、`git --no-pager push`：`git` 与 `push` 之间有选项，`\bgit\s+(push…)` 不匹配。
- `mv`、`cp`、`> file` 重定向、`tee`、`sed -i`、`truncate`：覆盖或移动文件，不在名单。
- 网络与下载：`git clone`、`git pull`、`git fetch`、`npm install`、`pip install`、`npx`、`pnpm dlx`、`brew install`。名单中的 `curl`、`wget` 只是其中两个入口，而安装类命令还会执行包的生命周期脚本。
- 间接执行：`eval`、`sh -c`、`bash -c`、`$(…)`、反引号、`xargs`、`base64 -d | sh`：关键字可被拼接或编码。
- `pnpm exec rimraf dist`：`rimraf` 不在名单。

**误报（本不需要打扰用户）**：`\brm\b` 等词边界会在 `-` 两侧成立，因此 `npm run rm-cache`、`echo "kill list"`、`grep dd file` 这类参数或字符串内容也会触发审批。

**根本性限制**：shell 是图灵完备的，字符串层面的关键词匹配不能给出"这条命令是否危险"的可靠结论；黑名单只能降低一部分明显误操作，不能当作安全边界。当前代码注释说明意图是"删除数据、联网、提权"，与实际覆盖有落差。

## 3. 可选方案

### 方案 A：扩充黑名单

继续使用正则，加入上述漏报项（`find -delete`、`git checkout`、`mv`、`>`、解释器的 `-c`/`-e` 等）。

- 优点：改动最小，用户感知变化小。
- 缺点：永远追不上；每加一项增加误报；对间接执行与编码绕过无效；维护成本持续存在。

### 方案 B：已知安全命令白名单，其余询问

trust 模式下只有命中白名单的命令自动执行，其他一律审批。白名单按"程序加子命令加参数形态"定义，例如：只读命令（`ls`、`cat`、`pwd`、`git status`、`git diff`、`git log`、`rg`、`grep`），项目内的测试与构建（`pnpm test`、`pnpm build`、`pnpm lint`、`npm test`、`vitest`、`tsc --noEmit`）。

- 优点：默认安全，未知即询问，漏报面小；规则可读。
- 缺点：打扰显著上升（任何未收录的命令都需审批）；`pnpm test` 本身会运行项目里任意脚本，"项目脚本"是否可信取决于项目，名单只能把它当作用户已接受的风险；白名单需要持续维护，不同项目的脚本名不同。

### 方案 C：按 shell 语法解析后分类

用 shell 解析器把命令拆成语法树，对每个简单命令分别查白名单或黑名单，对复合结构（管道、`&&`、`;`、子 shell、重定向、命令替换、`eval`）单独处理：出现重定向到工作区外、命令替换、`eval`、`sh -c` 等一律询问。

- 优点：能准确处理管道与链式命令，避免"白名单命令后接危险命令"的拼接；误报低于关键词匹配。
- 缺点：需要引入解析器或自写（新依赖需要在实现 PR 中单独说明理由）；bash、zsh、PowerShell 语法不同，当前 Windows 使用 PowerShell，需要另一套解析；别名、函数、环境变量展开、globbing 仍有无法静态判定的部分，只能保守地询问；实现与测试成本最高。

### 方案 D：B 与 C 的分层组合

先用语法解析判定"是否为一个简单、无展开、无重定向到工作区外的命令"，不满足就询问；满足时再用白名单判断，名单内自动执行，名单外询问。黑名单正则保留作为"一定询问"的快速前置（`sudo`、`rm -rf`、`git push` 等），不再作为放行依据。

### 对用户打扰程度的比较

| 方案 | 常见只读与测试命令 | 未收录的普通命令 | 危险命令 | 维护成本 |
| --- | --- | --- | --- | --- |
| 现状 | 不打扰 | 不打扰（可能误放行） | 部分询问 | 低 |
| A | 不打扰 | 不打扰（漏报仍存在） | 更多询问 | 持续增加 |
| B | 不打扰 | 询问 | 询问 | 中，名单持续维护 |
| C | 不打扰 | 视分类规则而定 | 询问 | 高 |
| D | 不打扰 | 询问 | 询问 | 高，但漏报最小 |

具体打扰频率没有实测数据；评审时建议先在本地收集一段时间 trust 模式下实际执行的命令清单（未核实当前是否有可用的审计日志），据此校准白名单。

### 辅助手段（与上述方案正交）

- 审批文案：当命令因"不在白名单"而询问时，说明原因，避免用户以为是危险命令。
- 用户级允许列表：审批界面提供"以后允许此命令前缀"（类似其他 Agent 产品的做法），把名单维护的一部分交给用户。这涉及持久化与撤销，属于单独设计。
- 工作区外的路径与网络访问不由命令分类决定，仍需要 OS 级沙箱或独立策略层，不属于本提案。

## 4. 推荐方案

推荐分两步：

1. 第一步采用方案 B，把 trust 模式改为"白名单自动，其余询问"。白名单初始只含只读命令与明确的项目构建测试命令，按子命令精确匹配，且命令字符串中出现 `;`、`&&`、`||`、`|`、重定向、`$(`、反引号、`eval`、`sh -c` 等任一元字符即视为不在白名单。这样不引入解析器，能先消除最明显的漏报，代价是对复合命令一律询问。
2. 第二步在积累实际命令数据后评估方案 C 或 D 的收益，再决定是否引入解析器。

保留现有黑名单正则作为白名单之前的一道"一定询问"检查，不删除，避免行为回退。

## 5. 受影响的包与契约

- `packages/runtime`：`approval-risk.ts`（分类逻辑与导出签名）、`tool-pipeline.ts`（调用点，签名不变则无需改）、`command-tool.ts`（审批摘要文案）。
- `packages/protocol` 与 `apps/studio`：若审批请求要带"询问原因"字段，需要扩展事件载荷与 Studio 展示（可选，评审决定）。
- 契约：`ApprovalRiskDecision` 取值保持 `auto`、`ask`；`permissionMode` 的三个取值与语义不变，但 trust 的含义从"黑名单之外自动"变为"白名单之内自动"，需要同步 `docs/architecture/foundation.md` 约第 564 行附近以及 Studio 里 trust 模式的说明文案，实现 PR 再改，本提案不改。

## 6. 迁移与兼容

- 行为变化是收紧，不涉及持久化数据格式；已有会话中保存的 `permissionMode` 取值不变。
- 用户从 trust 模式感受到的变化是询问变多。可用文案提示和"允许前缀"功能缓解。
- 已有测试 `packages/runtime/test/approval-risk.test.ts` 中"routine commands"用例（`ls -la`、`npm test`、`pnpm build`、`cat README.md`、`echo hi`）在白名单里需要覆盖，否则会变成询问；`echo hi` 是否纳入白名单留给评审。

## 7. 测试计划

- 表驱动单测：白名单命令返回 `auto`；第 2 节列出的所有漏报项返回 `ask`；含元字符的复合命令返回 `ask`；误报项（`npm run rm-cache`）按新规则的预期值断言。
- 回归：`ask`、`yolo` 两种模式行为不变；缺少 `command` 字段时返回值需要重新决定（当前为 `auto`，建议改为 `ask`，评审确认）。
- 集成：`tool-pipeline` 在 trust 模式下对命中与未命中白名单的命令分别触发或跳过审批。
- Windows：PowerShell 命令的白名单与元字符集合单独测试（未核实当前对 PowerShell 的覆盖）。

## 8. 未决问题

1. 白名单的初始范围，以及项目脚本（`pnpm test` 等）是否算可信。
2. 缺少 `command` 字段时是否改为询问。
3. 是否提供用户级"允许此前缀"，以及它的持久化位置与撤销方式。
4. 是否值得引入 shell 解析依赖，Windows 与 PowerShell 如何处理。
5. `workspace.write_file` 与 `workspace.edit_file` 在 trust 模式下始终自动，是否需要对敏感路径（如 `.git/hooks`、`package.json` 的脚本字段）另行处理，本提案不覆盖。
6. 是否需要先收集真实命令数据再定白名单。
