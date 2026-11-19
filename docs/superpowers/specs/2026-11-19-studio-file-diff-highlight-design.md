# Studio 文件语法高亮 + 改动 diff 展示设计

- 日期：2026-11-19
- 分支：`feat/studio-file-diff-highlight`（由 `feat/studio-undo-ui` 改名；撤销按钮不做，`2026-11-19-studio-undo-ui-design.md` 作废）
- 基线 main `72f2433`

## 目标

1. **文件语法高亮**：#47 的资源管理器只读查看器当前是纯 `<pre>`。给 js/ts/tsx/html/css/json/md/py 等按语言做 VSCode 级配色高亮。
2. **改动 diff 展示**：对本会话里 Agent 改过的文件，查看器内可切到「改动」视图，显示改动前/后的行级 diff（高亮）。不做撤销。

## 依赖（新增，pin 精确版本，理由记此）

| 包 | 版本 | 用途 / 理由 |
|---|---|---|
| `shiki` | `4.6.0` | VSCode 同款 TextMate 语法+主题引擎，高亮最接近 VSCode。查看器用 `createHighlighter` + 单一 `github-light` 主题（Studio 为浅色）+ **按需 `loadLanguage`** + **动态 import 懒加载**，控制主包体积。（当前用默认 oniguruma WASM 引擎；换 JS 引擎 / 更细打包留后续优化。） |
| `@git-diff-view/react` | `0.1.8` | 直接渲染 GitHub 风格 diff（Split/Unified），省去自写 diff 渲染与行级配对。 |
| `@git-diff-view/shiki` | `0.1.8` | 让 `@git-diff-view` 用 Shiki（`getDiffViewHighlighter()` 默认高亮器，JS 引擎 + 固定常用语言集）作高亮引擎，diff 与查看器配色一致。自带 shiki@3.x（与查看器的 shiki@4 并存；本地 Electron 应用可接受）。 |
| `@git-diff-view/file` | `0.1.8` | 提供 `generateDiffFile(oldName, old, newName, new, lang, lang)`：内部用 jsdiff `createTwoFilesPatch` 把「前/后两份完整内容」算成统一 diff 再建 `DiffFile`。正是本功能所需（后端只回 old/new 两份内容），新增/修改/删除统一处理，省去后端为未跟踪文件特判 git diff。带 `diff`（jsdiff）传递依赖。 |

> 风险记录：`@git-diff-view` 处于 0.x，API 可能变动；它只在「改动」视图（懒加载分包 `file-diff-view-*.js`）内使用，影响面可控，后续可替换为 shiki+jsdiff 自绘。该分包较大（内置约 35 种语言的 Shiki 高亮器），因懒加载且为本地桌面应用可接受；后续可改用内置 lowlight 或收窄语言集瘦身。安装用「改 `apps/studio/package.json` 精确版本 + `pnpm install`」（weave 禁版本范围；`pnpm add` 曾误触安全拦截）。studio 仍不 import `@weave/*`。

## 高亮（studio 查看器）

- 新 `apps/studio/src/features/files-tree/highlight.ts`：懒加载并缓存一个 Shiki highlighter 单例（空语言集、单一 `github-light` 主题，按需 `loadLanguage`）；`languageForPath(path)` 按扩展名映射 Shiki 语言，`highlightToHtml(code, lang)` 产出 `<pre class="shiki">`，文件过大（>400KB）或失败回退纯文本（由调用方渲染）。
- `file-tree-panel.tsx` 查看器：内容就绪后异步高亮，渲染 Shiki 产出的 HTML（`dangerouslySetInnerHTML`，Shiki 已转义代码文本）；失败/未知语言回退纯 `<pre>`。保留纯文本回退与"加载中"。Studio 目前仅浅色主题，故单主题；若后续加暗色再换双主题。

## 改动 diff（单文件 git diff，对标 Codex/Kiro）

**来源**：**单文件 git diff**——打开某文件后，查看器内切到「改动」即显示该文件**当前内容 vs git 基线**的行级 diff（红/绿），默认基线 `HEAD`（未提交改动；基线选择器如 origin/main 留后续）。不是会话聚合列表，也不用 L6 快照。

**Runtime 新函数** `readGitBaseContent(root, relativePath, ref='HEAD')`（新 `packages/runtime/src/workspace-git.ts`）：复用工作区策略校验路径（拒越界），`git show <ref>:./<path>`（`execFile`，不走 shell；仿 `workspace-file-index` 的 git 调用）取基线内容；文件在基线中不存在 / 非 git 仓 / 出错 → `{ content: '', tracked: false }`（视为新增）。从 `@weave/runtime` 导出。

**Server 新接口**：`GET /projects/:projectId/file-diff?path=<rel>`（加到 `file-api.ts`）→ 解析项目 folder → old = `readGitBaseContent(folder, path)`、new = 当前内容（复用 `readWorkspaceFileContent`）→ `{ path, oldContent, newContent, changed, tracked }`。只读、路径受 workspace 策略约束。v1 基线固定 `HEAD`（不收客户端 ref，避免 git 选项注入）。

**Studio**：
- 新 `apps/studio/src/features/files-tree/file-diff-api.ts`：`fetchFileDiff(projectId, path)`（zod 解析 `{ path, oldContent, newContent, changed, tracked }`，复用 `FileTreeApiError`）。
- 新 `apps/studio/src/features/files-tree/file-diff-view.tsx`：静态 import `@git-diff-view/*` 与其 CSS，故被 `file-tree-panel.tsx` 用 `React.lazy` 懒加载成独立分包。内部：取 diff → `changed===false` 显「该文件无未提交改动」（新文件另给提示）→ 否则 `getDiffViewHighlighter()` + `generateDiffFile(path, old, path, new, lang, lang)` → `initTheme/initRaw/initSyntax({registerHighlighter})/buildSplit/buildUnified` → `<DiffView diffFile=… registerHighlighter=… diffViewMode=Unified diffViewTheme=light diffViewHighlight diffViewWrap />`；`tracked===false` 在 diff 上方注明「新文件」。
- 查看器加「内容 / 改动」分段切换（`viewMode` 状态，打开新文件时重置为「内容」）；用 `@git-diff-view/react/styles/diff-view-pure.css`（纯 CSS，避免 Tailwind 冲突）。
- 不需要 sessionId / PanelContext 改动。

## 不做（后续）


- 撤销（已有后端接口，UI 暂不做）。
- 多文件 tab、git 工作树 diff（vs HEAD）、右键菜单。

## 不做（后续）之外的边界

- 多文件 tab、基线选择器（如 origin/main）、右键菜单留后续。

## 测试

- studio：
  - `file-tree-panel.test.tsx`：查看器出现「内容 / 改动」切换；切到「改动」懒加载并渲染 diff 组件（mock `file-diff-view`），切回「内容」恢复高亮。
  - `file-diff-view.test.tsx`（mock `@git-diff-view/*` 与 `file-diff-api`）：改动文件渲染 Unified diff 且以 old/new 两份内容 + 解析语言调用 `generateDiffFile`；未跟踪文件在 diff 上方给「新文件」提示；无改动显示「该文件无未提交改动」且不建 diff；取数失败走 alert。
  - 既有 `highlight` 语言映射 / 高亮渲染测试保留。
- runtime：`workspace-git.test.ts`——`readGitBaseContent` 对已提交文件返回内容且 `tracked=true`；新文件 / 非 git 仓 / 越界路径分别为 `tracked=false` 或拒绝。
- server：`file-api.test.ts`——`GET .../file-diff` 对非 git 文件夹的新文件返回 `tracked=false`、`changed` 正确；越界路径 400。
- `pnpm check` 全绿；UI 未在浏览器实测。

## 验收

打开 js/html 等文件在查看器里有 VSCode 式高亮；任一文件可切「改动」看到当前内容 vs `HEAD` 的行级 diff（高亮）；不触碰 composer / 撤销逻辑。
