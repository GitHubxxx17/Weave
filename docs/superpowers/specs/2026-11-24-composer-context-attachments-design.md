# 输入区“添加上下文”随消息发送设计

日期：2026-11-24。状态：第一阶段实施中（只含“当前文件”）。对应观察 U6。

## 问题

Studio 输入区 `+` 菜单有“当前文件 / Git 变更 / 项目目录”三项。点击后只出现标签，`selectedContexts` 从未进入请求，用户看到的“已添加上下文”与模型实际收到的内容不一致。已决定实现发送，不隐藏菜单。

## 三种上下文的含义

### 当前文件（第一阶段实现）

指文件面板（Explorer）当前打开/预览的项目文件。直接复用“项目文件引用与上下文快照”（见 `2026-11-23-file-context-design.md`）：

- 点击菜单项时，把当前预览文件的相对路径加入 Composer 草稿的 `files`，等同于文件树中的“添加到消息”。
- 因此不新增协议字段、事件类型或错误码。快照在 acceptance 时冻结、限制 8 个文件 / 单文件 64 KiB / 合计 256 KiB、整批拒绝、渲染为“不可信数据”、旧会话与旧客户端兼容，全部沿用原契约。
- 没有预览文件（文件面板未打开、未选文件、切换项目后）时菜单项禁用，副文案“先在文件面板打开文件”。草稿已含该路径时显示已选中且不可重复添加；已满 8 个时禁用。
- 草稿 owner（Session/Project/rootKey/epoch）检查沿用 `composerDraft.addFile(owner, path)`，不会因 A→B→A 切换误插。
- 添加后的标签是原有“待发送文件”标签，可移除；发送成功后随草稿清空；排队、重试沿用已冻结的 pending admission，`requestId` 幂等不变。

### Git 变更（后续阶段，本 PR 禁用）

计划含义：项目文件夹 `git status --porcelain` 摘要与相对 HEAD 的 `git diff`，在接纳时由 Server 冻结。需要新的协议字段（如 `contexts: [{kind:'git-diff'}]`）、`execution.accepted` 的新可选持久化字段、字节上限（建议 128 KiB，超出带截断标记）、非 Git 仓库的稳定错误码、子进程执行与超时，以及渲染为不可信数据的 renderer。它引入新的子进程权限边界（Server 在项目根执行 git），与“读文件”的安全模型不同，需单独设计与评审，不在本 PR 范围。

### 项目目录（后续阶段，本 PR 禁用）

计划含义：项目文件列表（复用文件索引，遵守 .gitignore 与默认忽略名），带条数与字节上限和截断标记，不读取 `.env`、密钥文件（与检索排除规则一致）。同样需要新协议字段、接纳时冻结、事件持久化和 renderer，按 Git 变更同一方案一并设计。

## 本 PR 的菜单行为

- “当前文件”：按上文可用/禁用。
- “Git 变更”“项目目录”：禁用并标注“即将推出”。不再有“可勾选但不发送”的状态。
- 移除只在界面上存在的 `selectedContexts` 状态与 `context-chip` 标签。

## 实现范围（第一阶段）

- `apps/studio/src/features/files-tree/file-tree-panel.tsx`：新增可选回调 `onViewerFileChange(path | null)`，在预览文件变化、项目切换和卸载时通知。
- `apps/studio/src/features/panel/panel-data.ts`、`panel-registry.tsx`：透传该回调。
- `apps/studio/src/app/App.tsx`：保存当前预览路径；菜单项改为添加该路径到草稿；移除 `selectedContexts`。
- 不改 protocol / runtime / server / session。`docs/architecture/foundation.md` 在文件上下文相关段落补一句。

## 测试

- Studio：未打开文件时“当前文件”禁用；打开文件后点击，发送请求体 `files` 含该路径；未点击时请求体不含 `files`；发送成功后标签清空；“Git 变更”“项目目录”禁用并显示“即将推出”。
- 文件面板：预览文件变化、卸载时回调通知。
