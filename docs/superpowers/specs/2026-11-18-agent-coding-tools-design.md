# 默认 Agent 编程工具设计（找文件、分页读取、局部编辑、命令、权限模式、步数上限）

## 1. 背景

对照 Codex 与 Kiro Crew，默认 Agent 只有 `read_file`、`write_file`、`recall` 三个工具，
一轮最多 8 次模型调用，做不了真实的编程任务。本机会话记录（`session_events`，
DeepSeek deepseek-flash）里的真实调用也暴露了问题：

| 现象 | 记录 | 对应 |
|-|-|-|
| 一步里发多个调用 | 10 次带工具调用的模型步骤中，6 次一步发了 2 到 4 个调用 | 不需要单独的批量读取工具 |
| 读取被悄悄截断 | 读 34,933 字节的 `foundation.md` 只拿到前 32,000 字节，模型不知情 | A1 |
| 想读一部分却失败 | 模型传 `maxBytes: 14000` / `11000` 想读前一段，都报 `workspace-file-too-large` | A4 |
| 猜错路径 | 2 次 `workspace-file-not-found` | 缺找文件工具 |

另外两处缺陷：输入框的"权限模式"只改界面、没发给后端（A2）；超过 8 次模型调用后
整轮失败、没有最终回答（A3）。

## 2. 范围与分期

本设计分两段落地，同一个分支、同一个 PR：

- **第一段（后端）**：runtime、session、server。本段不改 Studio，与并发运行分支没有文件重叠。
- **第二段（Studio）**：等并发运行分支合入 main 后 rebase 再做，避免 `App.tsx` 冲突。

**非目标**：系统级沙箱；"本会话放行"类审批规则；diff 面板与撤销；命令输出实时流式显示；
后台常驻进程；子目录 `AGENTS.md`；用户级全局指令；审批请求携带会话 ID。最后一项原计划由
并发运行分支负责，但已合入的 #39 没有包含：并发运行时，其他会话的审批卡片仍会显示在当前
会话的输入框上方，需要在后续 PR 中补上（审批请求带 `sessionId`，Studio 按会话过滤）。

## 3. 工具清单

| 工具 | 只读 | 审批 | 用途 |
|-|:-:|-|-|
| `list_dir` | ✓ | 不需要 | 列目录，可指定深度（新增） |
| `glob` | ✓ | 不需要 | 按通配符找文件（新增） |
| `grep` | ✓ | 不需要 | 搜索文件内容（新增） |
| `read_file` | ✓ | 仅 `.env` / `.env.*`，high | 按行分页读取（改造） |
| `recall` | ✓ | 不需要 | 取回被压缩的旧结果（标记只读） |
| `edit_file` | | 每次，medium | 精确替换一段文本（新增） |
| `write_file` | | 每次，high | 新建文件或整体重写（调整） |
| `run_command` | | 每次，high | 在项目文件夹里执行命令（新增） |

工具与现有文件工具一样放在 `@weave/runtime`，由 Server 注册；路径都经过 `WorkspacePolicy`
与 realpath 检查。插件内核落地后可整体迁为内置插件。**不新增依赖**：文件匹配用 Node 24
自带的 `fs.glob` / `path.matchesGlob`，进程与线程用 `node:child_process` / `node:worker_threads`。

## 4. 契约与实现（按包）

### 4.1 `@weave/runtime`：工具定义与 Pipeline

- `ToolDefinition.readOnly?: boolean`（默认 false）。只读模式只暴露 `readOnly: true` 的工具；
  插件工具须自行声明，默认偏安全。
- `ToolApprovalRequirement.summarize(input, context)`：新增第二个参数 `ToolExecutionContext`，
  返回值可以是 Promise。Pipeline 仅在返回 thenable 时 `await`，同步写法的时序不变。
  summarize 抛出的领域错误（如 `workspace-edit-no-match`）照旧映射为
  `tool-execution-failed` 并保留 cause，于是"先校验再审批"：匹配不上时不弹审批卡片。
- `ToolExecutionRequest.permissionMode?: 'workspace' | 'read-only'`。只读模式下调用
  非只读工具，在审批之前抛 `tool-not-permitted`（新错误码，Runner 视为可恢复）。
- 结果截断兜底：Pipeline 截断任何工具结果时，在末尾追加
  `[结果超过 N 字节，后面的内容已截断]`（标注本身计入字节上限）。

### 4.2 `@weave/runtime`：`read_file`（修 A1、A4）

- 输入：`path`、`offset`（起始行，从 1 开始，默认 1）、`limit`（行数，默认 2000）。
  去掉模型可见的 `maxBytes`；文件大小上限仍由 `maxReadBytes`（默认 1MB）配置。
- 每页同时不超过约 28,000 字节和约 6,000 估算 token：前者保证不被 Pipeline 32KB 上限截断，
  后者低于上下文压缩的单条 8,000 token 上限，中文多的文件也不会被从中间截掉。
- 只返回部分内容时追加：`[已显示第 a–b 行，共 n 行。继续读取请传 offset: b+1]`；
  能一次读完时内容与现在一致，不加提示。
- 二进制检查：前 8KB 含 NUL 字节时报 `workspace-file-binary`。
- 密钥文件审批（X5）：输入路径的文件名，或其符号链接解析后（`realpath`，在工作区边界检查之后）的真实文件名是 `.env` 或以 `.env.` 开头（任意目录层级，区分大小写，
  与检索索引和 `grep` 共用 `isSecretFile`）时，`read_file` 需要审批：`ask`、`trust` 模式都问
  （operation `workspace.read_secret_file`，risk `high`；未知受保护操作在 `trust` 下保守地要求
  审批），`yolo` 不问。摘要为"读取可能包含密钥的文件 <路径>"，`inputSummary` 只含路径，不含内容。
  其他文件的读取不变。
- 契约新增：`ToolApprovalRequirement.appliesTo?(input, context) => boolean | Promise<boolean>`（可异步，用于检查文件系统）。返回 `false` 的调用视为该工具
  没有 `approval`（策略投 `ask` 时仍强制审批）；省略则每次调用都受保护。现有插件工具不受影响。
  `read_file` 的判断：输入名是密钥文件，或 `realpath` 后的名字是密钥文件（如 `link -> .env`）时审批；
  文件不存在、路径越界等 `execute` 本身会拒绝的情形不审批；其他解析失败按需要审批处理。
  `grep` 的目录扫描不读符号链接（worker 用 `lstat` 跳过），直接指定符号链接路径时按解析后的真实路径判断，因此链接到 `.env` 的文件同样被跳过。

### 4.3 `@weave/runtime`：`edit_file`

- 输入：`path`、`oldText`（非空）、`newText`、`replaceAll`（默认 false）。
- 规则：文件必须存在；`oldText` 逐字匹配。0 处报 `workspace-edit-no-match`；多处且未传
  `replaceAll` 报 `workspace-edit-ambiguous`（附各处行号）；`oldText === newText` 报
  `workspace-edit-noop`。文件为 CRLF、输入为 LF 时按 CRLF 匹配与写入。
- summarize 读取文件、完成匹配并生成审批摘要：`{ path, replacements, linesAdded,
  linesRemoved, diff, diffTruncated }`，diff 为带前后 3 行上下文的统一格式，最多 200 行。
- 执行时重新读取并重新匹配，审批期间文件被改动导致匹配失败时报错，不写坏文件。
- 返回：`{ path, replacements, linesAdded, linesRemoved, snippet }`，snippet 为改动处附近的
  带行号片段（最多 20 行）。

### 4.4 `@weave/runtime`：`write_file` 调整

- 去掉模型可见的 `maxBytes`；上级目录不存在时自动创建（先确认最深的已存在祖先目录
  realpath 后仍在根目录内）。
- 审批摘要异步生成：`{ path, bytes, lines, overwrite, previousBytes?, previousLines?,
  createdDirectories }`，覆盖时能看到"原文件 → 新内容"的大小和行数变化。
- 说明改为：修改已有文件用 `edit_file`，`write_file` 只用于新建或用户要求整体重写。

### 4.5 `@weave/runtime`：`list_dir`、`glob`、`grep`

- 文件清单：项目是 Git 仓库时用 `git ls-files --cached --others --exclude-standard -z`
  （固定参数、只读、不审批）；否则遍历目录并跳过内置忽略列表（`.git`、`node_modules`、
  `dist`、`build`、`coverage`、`.next`、`.turbo`、`.venv`、`__pycache__` 等）。
  明确指定的路径不受忽略规则限制；遍历不跟随符号链接。
- `list_dir`：`path`（默认 `.`）、`depth`（1–5，默认 2）；缩进树，目录带 `/`，文件带大小，
  最多 500 项，超出时注明剩余数量。
- `glob`：`pattern`、`path`；按路径排序，最多 200 条，超出时注明总数。
- `grep`：`pattern`、`path`、`include`、`regex`（默认 false 按字面量）、`ignoreCase`、
  `contextLines`（0–5）；按文件分组输出 `行号: 内容`，总计最多 100 行、每文件最多 20 行；
  跳过二进制、超过 1MB 的文件和 `.env` / `.env.*`。
- `grep` 在 worker 线程中执行：病态正则（如 `(a+)+$`）会长时间阻塞，worker 可在超时或取消时
  `terminate()`，主线程与 SSE 不受影响。worker 文件只依赖 `node:` 模块，源码态（Vitest）
  加载 `.ts`、构建产物加载 `.js`（Node 24 原生类型剥离，已实测可用）。

### 4.6 `@weave/runtime`：`run_command`

| 项 | 设计 |
|-|-|
| 输入 | `command`（必填）、`cwd`（项目内相对目录，默认根）、`timeoutMs`（默认 120,000，最大 600,000） |
| Shell | POSIX：`$SHELL -c`（缺省 `/bin/bash`）；Windows：`powershell.exe -NoProfile -NonInteractive -Command`（未实测） |
| 环境 | 首次执行时用 `$SHELL -ilc` 解析一次完整环境并缓存（5 秒超时，用标记截取输出，失败退回进程环境）。实测本机 nvm 在 `~/.zshrc` 初始化，模拟访达启动环境时 `zsh -lc` 找不到 `node`/`pnpm` |
| 过滤 | 去掉 `WEAVE_` 前缀与名字含 `KEY`、`SECRET`、`TOKEN`、`PASSWORD` 的变量；设置 `NO_COLOR=1`、`TERM=dumb`、`PAGER=cat`、`GIT_PAGER=cat`、`GIT_TERMINAL_PROMPT=0` |
| 输入输出 | stdin 关闭；stdout/stderr 按到达顺序合并、去掉 ANSI 控制符，回车重绘的进度行只保留最后状态；保留开头 4KB 与结尾 24KB，中间注明省略行数 |
| 结果 | `exit code`、耗时、是否超时与输出组成的文本；非 0 退出码仍算工具成功，只有 shell 启动失败才算失败 |
| 终止 | 独立进程组；超时或取消先 SIGTERM，2 秒后 SIGKILL；Windows 用 `taskkill /T /F`。shell 退出 1 秒后输出管道仍被后台进程占用时，结束整个进程组并在结果中注明 |
| 审批 | 每条都审批（high），摘要 `{ command, cwd, timeoutMs }`，说明"命令不在沙箱中运行" |

过滤原因：浏览器模式下 Server 以 `--env-file` 读取 `.env`，`WEAVE_LLM_PROVIDERS` 含 API Key，
不过滤时一句 `env` 就会把密钥写进工具结果、发给模型厂商并落库。

### 4.7 `@weave/runtime`：Runner

- `AgentRunRequest.permissionMode?: 'workspace' | 'read-only'`（默认 `workspace`）：只读模式下
  发给模型的工具只含只读工具，并把模式传给 Pipeline 与 `instructions({ sessionId, permissionMode })`。
- 默认 `maxSteps` 由 8 改为 50。达到上限时不再抛错：追加 `turn.completed`
  （`status: completed`，`reason: agent-step-limit`），并发出带 `reason` 的 `completed` 事件。
- `recoverableToolErrorCodes` 增加 `tool-not-permitted`。
- 上下文压缩的骨架行此前只显示工具调用的 `path`；现在没有 `path` 时显示 `grep` / `glob` 的
  `pattern`，或截断到 80 字符的 `run_command` 命令，压缩后仍能看出做过什么。

### 4.8 `@weave/session`

- `SessionTurn.reason?: string`：投影保留 `turn.completed.payload.reason`，刷新后也能识别步数上限。

### 4.9 `apps/server`

- 有 `resolveWorkspaceRoot` 时注册全部 8 个工具；`maxSteps` 经 `ServerAgentRunnerOptions`
  传入，`main.ts` 读取 `WEAVE_AGENT_MAX_STEPS`（1–1000 的整数，非法值报启动错误，
  `.env.example` 已注明）。`ServerAgentRunnerOptions.commandEnvironment` 可替换命令的
  基础环境，测试用它避免启动交互式 shell。
- `/agent/runs/stream` 请求 schema 新增可选 `permissionMode`。
- 系统提示重写：工作方式、权限模式、环境（系统、shell、日期、项目文件夹、Git 分支）与
  `AGENTS.md`（项目根目录，最多 32KB，超出截断并注明）。只放不常变的信息，保持请求前缀稳定，
  以免破坏前缀缓存；Git 分支用 `git rev-parse --abbrev-ref HEAD`，2 秒超时。
- 会话详情返回 Turn 的 `reason`：属于第二段（与并发分支同改 `session-service.ts`，推迟以免冲突）。

### 4.10 `apps/studio`（第二段）

审批面板新增 `edit_file` diff 卡片与 `run_command` 命令卡片、`write_file` 覆盖前后对比；
工具步骤新图标与名称；文件面板计入 `edit_file`；请求携带 `permissionMode`；隐藏未实现的
"添加上下文"菜单；步数上限提示与"继续"按钮。

## 5. 影响的跨包契约

- runtime：`ToolApprovalRequirement.appliesTo`（可选，按输入决定是否审批）；`ToolDefinition.readOnly`；异步 `summarize(input, context)`；
  `ToolExecutionRequest.permissionMode`、`AgentRunRequest.permissionMode`；错误码
  `tool-not-permitted`；`completed` 事件可选 `reason`；默认 `maxSteps` 50；新工具工厂
  `createWorkspaceSearchTools`、`createCommandTool` 与 `WorkspaceFileTools.editFile`。
- session：`SessionTurn.reason`。
- server：工具注册、`WEAVE_AGENT_MAX_STEPS`、请求 `permissionMode`、系统提示。
- protocol、llm、workspace、plugin、desktop：不变。层次依赖不变。
- 以上均向后兼容：未声明 `readOnly` 的插件工具在"工作区访问"下照常可用，同步 `summarize` 照常可用。

## 6. 测试计划

- runtime：找文件三工具（Git 与非 Git 两种忽略规则、数量上限、跳过二进制与符号链接、病态正则
  超时后结束而进程不阻塞）；`read_file` 分页、提示、双上限、二进制；`edit_file` 单处/多处/
  未匹配/CRLF/相同内容/外部符号链接/审批期间被修改；`write_file` 自动建目录与覆盖摘要；
  `run_command` 退出码、超时终止进程组、取消、首尾截断、环境过滤、`cwd` 越界；Pipeline 截断
  标注、只读拦截、异步摘要；Runner 只读过滤、到上限正常结束。
- session：Turn 投影带出 `reason`。
- server：工具注册与顺序；系统提示含 `AGENTS.md`、环境与权限模式，`AGENTS.md` 缺失或过大；
  请求接受 `permissionMode` 并拒绝非法值；`WEAVE_AGENT_MAX_STEPS` 解析。

## 7. 已知限制

- 命令不在沙箱中运行，安全只靠逐条审批；逐条审批会带来审批疲劳（后续"本会话放行"解决）。
- 工具 10 分钟总超时包含等待审批的时间。
- 解析 shell 环境会执行一次 `~/.zshrc`；有交互提示或很慢时超时并退回进程环境。
- `read_file` 读取项目内的 `.env` / `.env.*` 需要审批（`yolo` 除外）；新搜索工具不读取 `.env` 类文件内容。输入名与符号链接解析后的真实文件名都会判断。
- 到达步数上限后历史以工具结果结尾，下一条为用户消息；DeepSeek 是否接受此顺序待实测。
- Windows 未实测；desktop 目前只有 `tsc` 构建，将来打包时需确认 worker 文件被包含。
