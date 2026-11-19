# Studio 项目文件树（资源管理器）设计

- 日期：2026-11-19
- 分支：`feat/studio-file-tree`
- 波次：Wave 2 · P1（L1）
- 跨包：runtime → server → studio（无 protocol 改动；studio 不 import `@weave/*`，HTTP 契约类型在 studio 侧自带）

## 目标

让 Studio 能像 Kiro / Codex 那样看到**当前项目的文件树**并只读打开文件：

- 右侧新增「资源管理器」面板，树形展示项目目录（展开 / 收起、按名筛选、刷新）。
- 点击文件在只读查看器中查看内容（行号、等宽；v1 不做语法高亮）。
- 与现有「文件」面板区分：后者只列 Agent 读写过的文件（活动视图），本面板改名为「改动文件」。

## 非目标（v1）

- 语法高亮（引第三方库，留后续，避免新依赖）。
- 文件写入 / 重命名 / 删除（只读）。
- `fs.watch` 自动刷新（先手动刷新按钮）。
- 多文件并排 tab（先单面板 master-detail：树 ↔ 文件，带返回）。
- 懒加载分目录拉取（v1 一次拉全量清单，客户端建树并懒展开 UI）。

## 契约

### Runtime（新增 `packages/runtime/src/workspace-browse.ts`，纯函数，无审批）

复用 #40 已有能力：`indexWorkspaceFiles`（git ls-files / 内置忽略，`.gitignore` 过滤、不跟随 symlink）、`createWorkspacePolicy` + `resolveRealRoot` / `resolveExistingTarget`（限制在项目目录内、拒绝越界 symlink）、`isBinaryContent`。

```ts
export interface WorkspaceFileListing {
  readonly files: readonly string[]; // posix 相对路径，已按忽略规则过滤、排序
  readonly source: 'git' | 'walk';
  readonly truncated: boolean;        // 超过文件数上限
}
export function listWorkspaceFiles(
  rootPath: string,
  options: { readonly signal: AbortSignal; readonly maxFiles?: number },
): Promise<WorkspaceFileListing>;

export interface WorkspaceFileContent {
  readonly path: string;      // posix 相对路径
  readonly content: string;   // UTF-8 文本
  readonly bytes: number;     // 文件总字节
  readonly truncated: boolean; // 超过 maxBytes 只取前缀
}
export function readWorkspaceFileContent(
  rootPath: string,
  relativePath: string,
  options: { readonly signal: AbortSignal; readonly maxBytes?: number },
): Promise<WorkspaceFileContent>; // 二进制 / 越界 / 目录 → 抛 WorkspaceFileError
```

- `maxBytes` 默认 2_000_000：超限只读前缀并标 `truncated`（查看器用，区别于给模型的分页 `read_file`，不硬失败）。
- 二进制（前 8KB 含 NUL）→ `workspace-file-binary`。
- 两个函数从 `@weave/runtime` 导出；runtime 不依赖 Hono / HTTP。

### Server（新增 `apps/server/src/file-api.ts`，在 `createApp` 挂载）

用已有 `WorkspaceAppOptions.projectStore`，经 `getProject(projectId)` 拿 `folderPath`，不接受客户端传任意绝对路径。

- `GET /projects/:projectId/tree`
  - 无 `folderPath` → 409 `project-folder-unset`；非目录 → 400 `project-folder-invalid`。
  - 返回 `{ files, source, truncated }`。
- `GET /projects/:projectId/file?path=<rel>`
  - 返回 `{ path, content, bytes, truncated }`。
  - `WorkspaceFileError` 映射：`workspace-file-binary` → 415；`workspace-file-not-found` → 404；`workspace-file-outside-root` / `-symlink-outside-root` / 非法输入 → 400；其余 → 500。
- 只读 GET，经既有 CORS（仅 Studio origin）。

### Studio（新增 `apps/studio/src/features/files-tree/`）

- `file-tree-api.ts`：`fetchFileTree(projectId)`、`fetchFileContent(projectId, path)`，用 `runtimeApiUrl` + 自带 zod 解析（不 import `@weave/*`）。
- `file-tree-panel.tsx`：由扁平 `files` 建树；目录可展开 / 收起（客户端懒展开）；顶部筛选框 + 刷新按钮；点击文件 → 拉内容 → 查看器；master-detail：选中文件时面板显示查看器 + 「← 返回目录树」。
- `panel-registry.tsx`：新增 kind `explorer`（标签「资源管理器」，`multi: false`，`keepAlive: false`）；现有 `files` 标签「文件」→「改动文件」。
- `panel-data.ts`：`PanelContext` 增 `projectId?: string`。
- `App.tsx`：构建 `PanelContext` 处追加 `projectId`（当前会话所属项目 id，仅此一处、非 composer 区，不与道1 冲突）。
- `app.css`：树 / 查看器样式。

## 安全

- 只读；不接受客户端绝对路径，只按 `projectId` 服务端解析 `folderPath`。
- 复用 workspace policy：拒绝 `..` 越界、越界 symlink、null 字节。
- 忽略规则来自 `.gitignore`（git 仓）或内置忽略表；不跟随 symlink。
- 读文件做二进制判定与大小上限；`.env` 内容虽可被 tree 列出名字，但查看属只读文本读取（不额外豁免，后续可加名单屏蔽）。

## 测试

- runtime：`listWorkspaceFiles` 过滤忽略目录；`readWorkspaceFileContent` 读文本 / 拒二进制 / 拒越界 / 超限截断。
- server：`/projects/:id/tree` 正常 / 无 folder / 非目录；`/projects/:id/file` 正常 / 404 / 二进制 415 / 越界 400。
- studio：扁平清单建树与展开 / 收起；筛选；点击文件渲染查看器与返回；无 folder 的空态。

## 分期

- v1（本 PR）：上述只读树 + 查看器。
- 后续：语法高亮、`fs.watch` 自动刷新、多文件 tab（复用面板多实例）、右键菜单（在编辑器打开等）。
