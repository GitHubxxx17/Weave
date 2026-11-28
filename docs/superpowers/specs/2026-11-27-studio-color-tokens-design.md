# Studio 颜色变量化设计

日期：2026-11-27

## 目的

“界面外观”设置（浅色 / 深色 / 跟随系统）要求所有颜色都经过变量。变量化阶段（#167）只做变量化，浅色外观与改动前逐像素一致，不新增配色，不新增设置项。深色主题与界面外观设置见文末“深色主题（已实现）”。

## 命名规则

- 按用途命名，不按色值命名：`--surface-hover`、`--text-on-accent`、`--overlay-backdrop`、`--danger-soft`。
- 同一用途的变体用后缀区分：`-soft`（浅底）、`-text`、`-border`、`-bg`、`-hover`。
- 阴影只把颜色做成变量，命名为 `--shadow-color-*`；偏移、模糊半径仍写在规则里。聚焦环同理，命名为 `--focus-ring-*-color`。
- 记忆页、检索页、任务面板、技能选择器等功能样式使用带功能前缀的变量（`--memory-*`、`--retrieval-*`、`--task-*`、`--skill-*`），浅色值沿用各自原来的配色。
- 所有变量集中定义在 `apps/studio/src/app/app.css` 的 `:root`。功能 CSS 只引用变量，不定义颜色。

## 合并与拆分原则

- 原值相同且用途相同的合并为一个变量，例如 `--danger-soft`（预览错误、概览错误、状态徽标、工具步骤失败共用 `#fdf0f2`）。
- 原值相同但用途不同的拆开，方便深色主题分别取值。例如白色拆成 `--text-on-accent`（强调色按钮上的文字）、`--text-on-overlay`（深色浮层上的文字）、`--preview-frame-bg`（预览 iframe 的画布，应保持白色）、`--surface`（卡片底）。`rgb(99 91 255 / 10%)` 同时用于输入框聚焦环和上下文标签按钮悬停底色，拆成 `--focus-ring-composer-color` 和 `--accent-hover-bg`。`#e86a6a` 在图表中是系列色 `--chart-red`，在告警文字与进度条上是 `--danger-vivid`。
- 原值只差一点点的不合并，避免改变外观。可在后续统一的候选：
  - 聚焦边框 `--field-focus-border-strong`（`#a9a4ff`）与 `--field-focus-border`、`--field-hover-border`（`#aaa6ff`）。
  - `--accent-border-soft`（`#cfcdfc`）、`--folder-hover-border`（`#b8b5ff`）、`--search-border`（`#bbb8ff`）、`--chip-border`（`#d8d6ff`）、`--provider-focus-border`（`#d8d5ff`）。
  - `--rail-bg`（`#fbfbfd`）、`--panel-bg`（`#fafbfe`）、`--field-hover-bg`（`#fbfbff`）、`--provider-focus-bg`（`#fdfdff`）与已有的 `--surface-soft`（`#f8f9fc`）。
  - `--danger-text`（`#b94352`）、`--plugin-danger-text`（`#9b3547`）、`--diff-removed-text`（`#b23a4a`）。
  - 记忆页与检索页各自的绿灰色阶，以及 `--task-*` 使用的 Tailwind 灰色阶。
  - `--shadow-color-*` 中色相只差几个单位的几个深蓝灰阴影色。
- 功能样式里原来写成 `var(--surface-primary, #fff)` 这类“变量加字面量回退”的写法：变量在 `:root` 中已定义的（如 `--surface`、`--accent`、`--line`），直接去掉回退，渲染结果不变；变量从未定义的（`--text-primary`、`--border-subtle` 等，实际一直在用回退值），改为引用新增的具体变量。

## 守护测试

`apps/studio/test/color-tokens.test.ts` 通过 `import.meta.glob(..., { query: '?raw' })` 读取 Studio 的 CSS、TS、TSX 与 `index.html`（Studio 的 lint 规则不允许测试引入 `node:fs`）：

- CSS：除 `app.css` 的 `:root` 定义块外，出现十六进制色、`rgb()`/`rgba()`/`hsl()`/`hsla()`/`hwb()`/`lab()`/`lch()`/`oklab()`/`oklch()`/`color()`，或具名颜色（`white`、`black` 等，`transparent`、`currentColor`、`inherit` 除外）即失败，报告文件与行号。注释、引号内字符串、`var(--name)` 里的变量名、`url(...)` 不参与判断。
- TS/TSX 与 `index.html`：带引号的十六进制色、颜色函数、`fill`/`stroke` 等属性里的非 `none`/`currentColor` 值。
- 功能 CSS 不得自己定义 `--*` 变量。
- 白名单 `allowedLiterals` 写明文件、字面量与原因；白名单项不再被使用时测试同样失败，避免白名单只增不减。目前只有终端面板的两项：`apps/studio/src/features/panel/terminal-panel.tsx` 中 xterm.js 的 `theme.background`/`theme.foreground` 需要具体颜色值，不能传 CSS 变量。深色主题接入时改为用 `getComputedStyle` 读取 `--terminal-bg` 等变量。

## 验证

用 Electron 离屏截图（1280×820，关闭动画与光标闪烁，时间戳、会话 ID、耗时做固定文本替换），对比 `origin/main` 构建与本分支构建的 `apps/studio/dist`，逐像素比较。场景与结果见 PR 正文。

## 变量清单（浅色值）

### 原有变量

| 变量 | 浅色值 |
| --- | --- |
| `--ink` | `#1f2430` |
| `--ink-soft` | `#50586b` |
| `--muted` | `#778095` |
| `--subtle` | `#848da3` |
| `--line` | `#e7e9f1` |
| `--line-strong` | `#d8dce8` |
| `--surface` | `#ffffff` |
| `--surface-soft` | `#f8f9fc` |
| `--surface-muted` | `#f0f2f7` |
| `--nav` | `#f8f9fc` |
| `--nav-hover` | `#eceefe` |
| `--accent` | `#635bff` |
| `--accent-dark` | `#5148e5` |
| `--accent-soft` | `#efefff` |
| `--success` | `#179c70` |
| `--warning` | `#b87519` |
| `--danger` | `#cf5362` |
| `--shadow-popover` | `0 14px 36px rgb(35 42 72 / 14%)` |

### 页面与导航底色

| 变量 | 浅色值 |
| --- | --- |
| `--app-bg` | `#f7f8fc` |
| `--nav-text` | `#7e879a` |
| `--surface-hover` | `#f0f1f7` |
| `--rail-bg` | `#fbfbfd` |
| `--panel-bg` | `#fafbfe` |
| `--text-body` | `#343937` |
| `--user-message-bg` | `#f1f2f8` |

### 填充底色上的文字与预览画布

| 变量 | 浅色值 |
| --- | --- |
| `--text-on-accent` | `#ffffff` |
| `--text-on-overlay` | `#ffffff` |
| `--preview-frame-bg` | `#ffffff` |

### 强调色衍生（边框、聚焦环）

| 变量 | 浅色值 |
| --- | --- |
| `--accent-border-soft` | `#cfcdfc` |
| `--field-focus-border-strong` | `#a9a4ff` |
| `--field-focus-border` | `#aaa6ff` |
| `--field-hover-border` | `#aaa6ff` |
| `--field-hover-bg` | `#fbfbff` |
| `--folder-hover-border` | `#b8b5ff` |
| `--folder-selected-bg` | `#f7f8ff` |
| `--search-border` | `#bbb8ff` |
| `--chip-border` | `#d8d6ff` |
| `--chip-action-text` | `#7771d9` |
| `--provider-focus-bg` | `#fdfdff` |
| `--provider-focus-border` | `#d8d5ff` |
| `--focus-outline-color` | `rgb(99 91 255 / 28%)` |
| `--focus-ring-composer-color` | `rgb(99 91 255 / 10%)` |
| `--focus-ring-color` | `rgb(99 91 255 / 9%)` |
| `--focus-ring-search-color` | `rgb(99 91 255 / 8%)` |
| `--accent-hover-bg` | `rgb(99 91 255 / 10%)` |

### 警告与错误语义色

| 变量 | 浅色值 |
| --- | --- |
| `--warning-surface` | `#fff8ec` |
| `--warning-border` | `#f1d6a8` |
| `--warning-chip-bg` | `#fdecd0` |
| `--warning-soft` | `#fdf3e3` |
| `--success-soft` | `#e8f6f0` |
| `--danger-soft` | `#fdf0f2` |
| `--danger-faint` | `#fffafa` |
| `--danger-ghost-bg` | `#fff5f5` |
| `--danger-ghost-border` | `#ecd3d6` |
| `--danger-text` | `#b94352` |
| `--danger-button-bg` | `#fff4f5` |
| `--danger-button-border` | `#efc7cc` |
| `--danger-text-hover` | `#a93646` |
| `--danger-button-bg-hover` | `#ffe9ec` |
| `--danger-button-border-hover` | `#e8aeb6` |
| `--danger-vivid` | `#e86a6a` |
| `--plugin-danger-text` | `#9b3547` |
| `--plugin-danger-bg` | `#fff0f2` |

### 差异视图

| 变量 | 浅色值 |
| --- | --- |
| `--diff-added-text` | `#11795a` |
| `--diff-added-bg` | `rgb(24 161 116 / 10%)` |
| `--diff-removed-text` | `#b23a4a` |
| `--diff-removed-bg` | `rgb(207 83 98 / 10%)` |

### 状态标签

| 变量 | 浅色值 |
| --- | --- |
| `--status-called-text` | `#636b66` |
| `--status-called-bg` | `#e9ece8` |
| `--status-executing-text` | `#8d5e18` |
| `--status-executing-bg` | `#f8edd9` |
| `--status-completed-text` | `#176e5c` |
| `--status-completed-bg` | `#dff1eb` |
| `--status-failed-text` | `#a7434d` |
| `--status-failed-bg` | `#f7e4e6` |

### 图表与终端

| 变量 | 浅色值 |
| --- | --- |
| `--chart-orange` | `#f0a24b` |
| `--chart-gray` | `#9aa3b8` |
| `--chart-slate` | `#6b7280` |
| `--chart-violet` | `#8b5cf6` |
| `--chart-teal` | `#2dd4bf` |
| `--chart-red` | `#e86a6a` |
| `--terminal-bg` | `#10131a` |

### 遮罩与浮层

| 变量 | 浅色值 |
| --- | --- |
| `--overlay-chip-bg` | `rgb(35 42 72 / 82%)` |
| `--overlay-backdrop` | `rgb(28 32 43 / 34%)` |
| `--overlay-backdrop-strong` | `rgb(15 18 32 / 82%)` |
| `--overlay-control-bg` | `rgb(255 255 255 / 12%)` |
| `--overlay-control-border` | `rgb(255 255 255 / 24%)` |
| `--overlay-control-bg-hover` | `rgb(255 255 255 / 22%)` |
| `--dialog-border-glass` | `rgb(255 255 255 / 72%)` |

### 阴影颜色（只把颜色做成变量，偏移与模糊半径仍写在规则里）

| 变量 | 浅色值 |
| --- | --- |
| `--shadow-color-xs` | `rgb(35 42 72 / 4%)` |
| `--shadow-color-composer` | `rgb(35 42 72 / 7%)` |
| `--shadow-color-composer-focus` | `rgb(35 42 72 / 9%)` |
| `--shadow-color-card-hover` | `rgb(35 42 72 / 6%)` |
| `--shadow-color-toggle-active` | `rgb(35 42 72 / 10%)` |
| `--shadow-color-image` | `rgb(0 0 0 / 45%)` |
| `--shadow-color-dialog` | `rgb(21 27 48 / 24%)` |
| `--shadow-color-provider` | `rgb(39 44 84 / 5%)` |
| `--shadow-color-drawer` | `rgb(28 32 43 / 12%)` |
| `--shadow-color-file-mode` | `rgb(31 36 48 / 10%)` |

### 通用面板（记忆页、检索页共用）

| 变量 | 浅色值 |
| --- | --- |
| `--page-text` | `#24272e` |

### 任务面板

| 变量 | 浅色值 |
| --- | --- |
| `--task-border` | `#e5e7eb` |
| `--task-border-strong` | `#d1d5db` |
| `--task-text-muted` | `#6b7280` |
| `--task-warning-text` | `#b45309` |
| `--task-text-secondary` | `#4b5563` |
| `--task-stop-hover-text` | `#dc2626` |
| `--task-error-text` | `#b91c1c` |

### 记忆页

| 变量 | 浅色值 |
| --- | --- |
| `--memory-icon` | `#638272` |
| `--memory-text-muted` | `#707581` |
| `--memory-border-button` | `#e2e5e9` |
| `--memory-hover-bg` | `#f1f5f2` |
| `--memory-hover-border` | `#b6c8bd` |
| `--memory-focus-outline` | `#658772` |
| `--memory-border-field` | `#e0e3e8` |
| `--memory-alert-text` | `#9c3d39` |
| `--memory-access-bg` | `#f5f8f5` |
| `--memory-access-border` | `#e0e9e1` |
| `--memory-access-icon` | `#557a61` |
| `--memory-access-text` | `#68746a` |
| `--memory-border` | `#e4e7e9` |
| `--memory-list-bg` | `#fafbfa` |
| `--memory-search-icon` | `#7d8580` |
| `--memory-tag-filter-text` | `#717972` |
| `--memory-selected-bg` | `#eaf1eb` |
| `--memory-selected-border` | `#cbd9ce` |
| `--memory-list-text` | `#656d66` |
| `--memory-list-meta` | `#7d857e` |
| `--memory-badge-bg` | `#edf0f4` |
| `--memory-badge-text` | `#626c7c` |
| `--memory-badge-reviewed-text` | `#436e50` |
| `--memory-badge-reviewed-bg` | `#e7f0e7` |
| `--memory-detail-meta` | `#7d847e` |
| `--memory-tag-bg` | `#f3f4f4` |
| `--memory-tag-text` | `#68706a` |
| `--memory-provenance-border` | `#edf0ed` |
| `--memory-provenance-text` | `#7b847c` |
| `--memory-empty-text` | `#8a938b` |
| `--memory-history-border` | `#e6ebe6` |
| `--memory-history-rail` | `#dce6dd` |
| `--memory-history-meta` | `#879087` |
| `--memory-editor-hint` | `#7a857b` |
| `--memory-primary` | `#56765e` |
| `--memory-confirm-border` | `#d8ded9` |
| `--memory-confirm-scrim` | `#17251d66` |
| `--memory-confirm-shadow-color` | `#1b2c2833` |
| `--memory-confirm-text` | `#737b74` |
| `--memory-deleted-text` | `#7a837a` |

### 检索页

| 变量 | 浅色值 |
| --- | --- |
| `--retrieval-icon` | `#547562` |
| `--retrieval-border` | `#e1e5e3` |
| `--retrieval-text-muted` | `#656c73` |
| `--retrieval-alert-text` | `#a13934` |
| `--retrieval-border-field` | `#dce2de` |
| `--retrieval-hover-bg` | `#edf3ef` |
| `--retrieval-primary` | `#305c47` |
| `--retrieval-primary-hover` | `#244b38` |
| `--retrieval-focus-outline` | `#557e66` |
| `--retrieval-segmented-bg` | `#f0f2f1` |
| `--retrieval-egress-border` | `#b88733` |
| `--retrieval-egress-bg` | `#fffaef` |
| `--retrieval-egress-text` | `#6a4a1b` |
| `--retrieval-code-bg` | `#f3f5f4` |

### 技能选择器（半透明灰，叠加在任意底色上）

| 变量 | 浅色值 |
| --- | --- |
| `--skill-border` | `#8885` |
| `--skill-divider` | `#8883` |
| `--skill-source-bg` | `#8882` |
| `--skill-border-faint` | `#8884` |

## 深色主题（已实现）

### 接入方式

- `app.css` 的 `:root` 设置 `color-scheme: light`；`:root[data-theme='dark']` 设置 `color-scheme: dark`，并覆盖 `:root` 中的**全部**颜色变量（包括 `:root` 里直接写的 `color`、`background`）。`test/color-tokens.test.ts` 保证深色块与浅色块的变量集合一一对应，没有缺项或多余项。
- 选择方式不用 `@media (prefers-color-scheme: dark)`：由 `features/settings/theme.ts` 把偏好（跟随系统 / 浅色 / 深色）解析成 `light|dark`，写到 `<html data-theme>`。"跟随系统"的监听在 JS 里，不在 CSS 里，避免同一套深色值在 CSS 里写两遍。
- 首屏：`main.tsx` 在渲染 React 之前同步调用 `startThemeSync`，不需要 `index.html` 的内联脚本。
- 守护测试：`:root` 与 `:root[data-theme='dark']` 两个定义块之外仍不允许出现颜色字面量。
- 原守护测试读取 CSS 的 `?raw` 导入在 vitest 下返回空串（vitest 默认把 CSS 文件替换为空），CSS 部分此前实际没有扫描。本 PR 在根 `vitest.config.ts` 增加 `css: { include: [/\.css\?raw$/] }`，使 CSS 源码可读；修复后扫描通过，说明 #167 的变量化是完整的。
- 新增 10 个 `--theme-preview-light-*` / `--theme-preview-dark-*` 变量，供设置页的主题预览块使用，两套主题下取值相同。
- 终端（xterm）本来就是深色，保持不变，`terminal-panel.tsx` 的两项白名单仍保留。

### 设计取值

- 风格：同一紫色系，深色底（`#12141b` 页面、`#1b1e29` 卡片）略带蓝紫；强调色提亮为 `#8a84ff`，`--accent-dark` 在深色里是更亮的紫色（它在浅色里用作文字和悬停底色，深色里同样如此）。
- 强调按钮：深色下底色较亮，所以 `--text-on-accent` 取深色 `#14162b`（对比度 5.8），不用白字。`--memory-primary`、`--retrieval-primary` 同理取较亮的绿色。
- 保持不变的变量：`--text-on-overlay`、`--preview-frame-bg`（被预览页面的画布仍为白色）、`--overlay-control-*`、`--chart-orange`、`--chart-gray`、`--chart-teal`、`--terminal-bg`、`--skill-*`。
- 阴影改为纯黑加不同透明度；遮罩加深；`--dialog-border-glass` 改为 10% 白；状态色的浅底改为同色相的深底，文字提亮。

### 深色取值清单

| 变量 | 浅色 | 深色 |
| --- | --- | --- |
| `--ink` | `#1f2430` | `#e8eaf2` |
| `--ink-soft` | `#50586b` | `#b7bdcd` |
| `--muted` | `#778095` | `#9199ae` |
| `--subtle` | `#848da3` | `#7f879b` |
| `--line` | `#e7e9f1` | `#2b3042` |
| `--line-strong` | `#d8dce8` | `#3b4258` |
| `--surface` | `#ffffff` | `#1b1e29` |
| `--surface-soft` | `#f8f9fc` | `#171a23` |
| `--surface-muted` | `#f0f2f7` | `#232736` |
| `--nav` | `#f8f9fc` | `#161922` |
| `--nav-hover` | `#eceefe` | `#272b40` |
| `--accent` | `#635bff` | `#8a84ff` |
| `--accent-dark` | `#5148e5` | `#aaa5ff` |
| `--accent-soft` | `#efefff` | `#2a2852` |
| `--success` | `#179c70` | `#34c08f` |
| `--warning` | `#b87519` | `#e0a24a` |
| `--danger` | `#cf5362` | `#ee7482` |
| `--shadow-popover` | `0 14px 36px rgb(35 42 72 / 14%)` | `0 14px 36px rgb(0 0 0 / 50%)` |
| `--scrollbar-thumb` | `rgb(31 36 48 / 16%)` | `rgb(255 255 255 / 18%)` |
| `--scrollbar-thumb-hover` | `rgb(31 36 48 / 32%)` | `rgb(255 255 255 / 34%)` |
| `--app-bg` | `#f7f8fc` | `#12141b` |
| `--nav-text` | `#7e879a` | `#9aa2b6` |
| `--surface-hover` | `#f0f1f7` | `#252938` |
| `--rail-bg` | `#fbfbfd` | `#151820` |
| `--panel-bg` | `#fafbfe` | `#171a22` |
| `--text-body` | `#343937` | `#d5d9e3` |
| `--user-message-bg` | `#f1f2f8` | `#252a3c` |
| `--text-on-accent` | `#ffffff` | `#14162b` |
| `--accent-border-soft` | `#cfcdfc` | `#3d3a7a` |
| `--field-focus-border-strong` | `#a9a4ff` | `#6f69e8` |
| `--field-focus-border` | `#aaa6ff` | `#6c66e0` |
| `--field-hover-border` | `#aaa6ff` | `#5d58c4` |
| `--field-hover-bg` | `#fbfbff` | `#1f2233` |
| `--folder-hover-border` | `#b8b5ff` | `#5a56b8` |
| `--folder-selected-bg` | `#f7f8ff` | `#212440` |
| `--search-border` | `#bbb8ff` | `#5f5ac8` |
| `--chip-border` | `#d8d6ff` | `#3f3c80` |
| `--chip-action-text` | `#7771d9` | `#a29dff` |
| `--provider-focus-bg` | `#fdfdff` | `#1e2133` |
| `--provider-focus-border` | `#d8d5ff` | `#4a4794` |
| `--focus-outline-color` | `rgb(99 91 255 / 28%)` | `rgb(138 132 255 / 45%)` |
| `--focus-ring-composer-color` | `rgb(99 91 255 / 10%)` | `rgb(138 132 255 / 18%)` |
| `--focus-ring-color` | `rgb(99 91 255 / 9%)` | `rgb(138 132 255 / 16%)` |
| `--focus-ring-search-color` | `rgb(99 91 255 / 8%)` | `rgb(138 132 255 / 14%)` |
| `--accent-hover-bg` | `rgb(99 91 255 / 10%)` | `rgb(138 132 255 / 16%)` |
| `--warning-surface` | `#fff8ec` | `#2c2415` |
| `--warning-border` | `#f1d6a8` | `#5c4724` |
| `--warning-chip-bg` | `#fdecd0` | `#3a2d16` |
| `--warning-soft` | `#fdf3e3` | `#2a2316` |
| `--success-soft` | `#e8f6f0` | `#153027` |
| `--danger-soft` | `#fdf0f2` | `#321b21` |
| `--danger-faint` | `#fffafa` | `#261a1d` |
| `--danger-ghost-bg` | `#fff5f5` | `#2e1b20` |
| `--danger-ghost-border` | `#ecd3d6` | `#5a2f37` |
| `--danger-text` | `#b94352` | `#f08a96` |
| `--danger-button-bg` | `#fff4f5` | `#301c21` |
| `--danger-button-border` | `#efc7cc` | `#64333c` |
| `--danger-text-hover` | `#a93646` | `#ffa3ad` |
| `--danger-button-bg-hover` | `#ffe9ec` | `#3d2128` |
| `--danger-button-border-hover` | `#e8aeb6` | `#7c3f4a` |
| `--danger-vivid` | `#e86a6a` | `#f07878` |
| `--plugin-danger-text` | `#9b3547` | `#f08a96` |
| `--plugin-danger-bg` | `#fff0f2` | `#341d23` |
| `--diff-added-text` | `#11795a` | `#5ed6a8` |
| `--diff-added-bg` | `rgb(24 161 116 / 10%)` | `rgb(52 192 143 / 16%)` |
| `--diff-removed-text` | `#b23a4a` | `#f28b97` |
| `--diff-removed-bg` | `rgb(207 83 98 / 10%)` | `rgb(238 116 130 / 16%)` |
| `--status-called-text` | `#636b66` | `#aab3ae` |
| `--status-called-bg` | `#e9ece8` | `#2a2f2d` |
| `--status-executing-text` | `#8d5e18` | `#e4b366` |
| `--status-executing-bg` | `#f8edd9` | `#352b17` |
| `--status-completed-text` | `#176e5c` | `#6fd6b4` |
| `--status-completed-bg` | `#dff1eb` | `#17332c` |
| `--status-failed-text` | `#a7434d` | `#f29aa4` |
| `--status-failed-bg` | `#f7e4e6` | `#3a1f25` |
| `--chart-slate` | `#6b7280` | `#8b93a3` |
| `--chart-violet` | `#8b5cf6` | `#a78bfa` |
| `--chart-red` | `#e86a6a` | `#f07878` |
| `--overlay-chip-bg` | `rgb(35 42 72 / 82%)` | `rgb(10 12 22 / 88%)` |
| `--overlay-backdrop` | `rgb(28 32 43 / 34%)` | `rgb(0 0 0 / 55%)` |
| `--overlay-backdrop-strong` | `rgb(15 18 32 / 82%)` | `rgb(5 6 12 / 88%)` |
| `--dialog-border-glass` | `rgb(255 255 255 / 72%)` | `rgb(255 255 255 / 10%)` |
| `--shadow-color-xs` | `rgb(35 42 72 / 4%)` | `rgb(0 0 0 / 20%)` |
| `--shadow-color-composer` | `rgb(35 42 72 / 7%)` | `rgb(0 0 0 / 25%)` |
| `--shadow-color-composer-focus` | `rgb(35 42 72 / 9%)` | `rgb(0 0 0 / 32%)` |
| `--shadow-color-card-hover` | `rgb(35 42 72 / 6%)` | `rgb(0 0 0 / 28%)` |
| `--shadow-color-toggle-active` | `rgb(35 42 72 / 10%)` | `rgb(0 0 0 / 30%)` |
| `--shadow-color-image` | `rgb(0 0 0 / 45%)` | `rgb(0 0 0 / 60%)` |
| `--shadow-color-dialog` | `rgb(21 27 48 / 24%)` | `rgb(0 0 0 / 55%)` |
| `--shadow-color-provider` | `rgb(39 44 84 / 5%)` | `rgb(0 0 0 / 22%)` |
| `--shadow-color-drawer` | `rgb(28 32 43 / 12%)` | `rgb(0 0 0 / 40%)` |
| `--shadow-color-file-mode` | `rgb(31 36 48 / 10%)` | `rgb(0 0 0 / 30%)` |
| `--page-text` | `#24272e` | `#e3e6ee` |
| `--task-border` | `#e5e7eb` | `#2f3445` |
| `--task-border-strong` | `#d1d5db` | `#424a60` |
| `--task-text-muted` | `#6b7280` | `#9aa3b5` |
| `--task-warning-text` | `#b45309` | `#f0b35a` |
| `--task-text-secondary` | `#4b5563` | `#bcc3d1` |
| `--task-stop-hover-text` | `#dc2626` | `#f87171` |
| `--task-error-text` | `#b91c1c` | `#f87171` |
| `--memory-icon` | `#638272` | `#7fb095` |
| `--memory-text-muted` | `#707581` | `#9aa1ae` |
| `--memory-border-button` | `#e2e5e9` | `#343a47` |
| `--memory-hover-bg` | `#f1f5f2` | `#232c28` |
| `--memory-hover-border` | `#b6c8bd` | `#4d6a58` |
| `--memory-focus-outline` | `#658772` | `#7fb095` |
| `--memory-border-field` | `#e0e3e8` | `#353b47` |
| `--memory-alert-text` | `#9c3d39` | `#ee8a85` |
| `--memory-access-bg` | `#f5f8f5` | `#1e2823` |
| `--memory-access-border` | `#e0e9e1` | `#2f4036` |
| `--memory-access-icon` | `#557a61` | `#7fbb93` |
| `--memory-access-text` | `#68746a` | `#a2b3a7` |
| `--memory-border` | `#e4e7e9` | `#2f3542` |
| `--memory-list-bg` | `#fafbfa` | `#181c22` |
| `--memory-search-icon` | `#7d8580` | `#8f9892` |
| `--memory-tag-filter-text` | `#717972` | `#a3aba5` |
| `--memory-selected-bg` | `#eaf1eb` | `#25352b` |
| `--memory-selected-border` | `#cbd9ce` | `#3f5a49` |
| `--memory-list-text` | `#656d66` | `#a8b1aa` |
| `--memory-list-meta` | `#7d857e` | `#8f988f` |
| `--memory-badge-bg` | `#edf0f4` | `#272c38` |
| `--memory-badge-text` | `#626c7c` | `#a2adc0` |
| `--memory-badge-reviewed-text` | `#436e50` | `#86c796` |
| `--memory-badge-reviewed-bg` | `#e7f0e7` | `#1f3326` |
| `--memory-detail-meta` | `#7d847e` | `#8f9890` |
| `--memory-tag-bg` | `#f3f4f4` | `#262b33` |
| `--memory-tag-text` | `#68706a` | `#a5aea8` |
| `--memory-provenance-border` | `#edf0ed` | `#2a312d` |
| `--memory-provenance-text` | `#7b847c` | `#939c94` |
| `--memory-empty-text` | `#8a938b` | `#8f988f` |
| `--memory-history-border` | `#e6ebe6` | `#2b332e` |
| `--memory-history-rail` | `#dce6dd` | `#36443a` |
| `--memory-history-meta` | `#879087` | `#8e978f` |
| `--memory-editor-hint` | `#7a857b` | `#939e95` |
| `--memory-primary` | `#56765e` | `#6fb28a` |
| `--memory-confirm-border` | `#d8ded9` | `#3a423d` |
| `--memory-confirm-scrim` | `#17251d66` | `#000000a0` |
| `--memory-confirm-shadow-color` | `#1b2c2833` | `#00000080` |
| `--memory-confirm-text` | `#737b74` | `#a0a8a1` |
| `--memory-deleted-text` | `#7a837a` | `#939c94` |
| `--retrieval-icon` | `#547562` | `#78ad90` |
| `--retrieval-border` | `#e1e5e3` | `#2e3532` |
| `--retrieval-text-muted` | `#656c73` | `#9ba3ab` |
| `--retrieval-alert-text` | `#a13934` | `#ee8a85` |
| `--retrieval-border-field` | `#dce2de` | `#353d39` |
| `--retrieval-hover-bg` | `#edf3ef` | `#202b25` |
| `--retrieval-primary` | `#305c47` | `#6fb28a` |
| `--retrieval-primary-hover` | `#244b38` | `#84c39b` |
| `--retrieval-focus-outline` | `#557e66` | `#78ad90` |
| `--retrieval-segmented-bg` | `#f0f2f1` | `#242a28` |
| `--retrieval-egress-border` | `#b88733` | `#c9973f` |
| `--retrieval-egress-bg` | `#fffaef` | `#2b2414` |
| `--retrieval-egress-text` | `#6a4a1b` | `#ecc888` |
| `--retrieval-code-bg` | `#f3f5f4` | `#20252a` |

两套主题取值相同的变量（23 个）：`--text-on-overlay`、`--preview-frame-bg`、`--chart-orange`、`--chart-gray`、`--chart-teal`、`--terminal-bg`、`--overlay-control-bg`、`--overlay-control-border`、`--overlay-control-bg-hover`、`--skill-border`、`--skill-divider`、`--skill-source-bg`、`--skill-border-faint`、`--theme-preview-light-bg`、`--theme-preview-light-surface`、`--theme-preview-light-line`、`--theme-preview-light-text`、`--theme-preview-light-accent`、`--theme-preview-dark-bg`、`--theme-preview-dark-surface`、`--theme-preview-dark-line`、`--theme-preview-dark-text`、`--theme-preview-dark-accent`。

### 对比度

测试 `apps/studio/test/theme-contrast.test.ts` 解析 `app.css` 的两组变量，按 WCAG 2.x 相对亮度公式计算下列配对。要求：正文类 ≥4.5，次要文字（`--muted`、`--subtle` 及各页面的弱化文字）≥3，强调按钮文字与底色 ≥4.5。半透明底色（差异高亮、浮层）先叠到 `--surface` 上再计算。深色和浅色任一配对不达标都会使测试失败。


| 文字 | 底色 | 要求 | 浅色 | 深色 |
| --- | --- | --- | --- | --- |
| `--ink` | `--app-bg` | 正文 ≥4.5 | 14.62 | 15.31 |
| `--ink` | `--surface` | 正文 ≥4.5 | 15.52 | 13.83 |
| `--ink` | `--surface-soft` | 正文 ≥4.5 | 14.74 | 14.47 |
| `--ink` | `--surface-muted` | 正文 ≥4.5 | 13.85 | 12.36 |
| `--ink` | `--surface-hover` | 正文 ≥4.5 | 13.77 | 12.03 |
| `--ink` | `--user-message-bg` | 正文 ≥4.5 | 13.89 | 11.85 |
| `--ink-soft` | `--surface` | 正文 ≥4.5 | 7.12 | 8.84 |
| `--ink-soft` | `--app-bg` | 正文 ≥4.5 | 6.71 | 9.79 |
| `--text-body` | `--surface` | 正文 ≥4.5 | 11.76 | 11.76 |
| `--page-text` | `--surface` | 正文 ≥4.5 | 14.95 | 13.30 |
| `--nav-text` | `--nav` | 次要 ≥3 | 3.43 | 6.87 |
| `--ink-soft` | `--nav-hover` | 正文 ≥4.5 | 6.18 | 7.42 |
| `--muted` | `--surface` | 次要 ≥3 | 3.96 | 5.83 |
| `--muted` | `--app-bg` | 次要 ≥3 | 3.73 | 6.46 |
| `--muted` | `--surface-soft` | 次要 ≥3 | 3.76 | 6.10 |
| `--subtle` | `--surface` | 次要 ≥3 | 3.32 | 4.62 |
| `--subtle` | `--app-bg` | 次要 ≥3 | 3.13 | 5.12 |
| `--text-on-accent` | `--accent` | 按钮 ≥4.5 | 4.70 | 5.79 |
| `--text-on-accent` | `--accent-dark` | 按钮 ≥4.5 | 6.16 | 8.08 |
| `--text-on-accent` | `--retrieval-primary` | 按钮 ≥4.5 | 7.64 | 7.13 |
| `--text-on-accent` | `--memory-primary` | 按钮 ≥4.5 | 5.06 | 7.13 |
| `--accent` | `--surface` | 正文 ≥4.5 | 4.70 | 5.40 |
| `--accent-dark` | `--surface` | 正文 ≥4.5 | 6.16 | 7.54 |
| `--accent-dark` | `--accent-soft` | 正文 ≥4.5 | 5.42 | 6.26 |
| `--chip-action-text` | `--surface` | 次要 ≥3 | 4.08 | 6.96 |
| `--text-on-overlay` | `--overlay-chip-bg` | 正文 ≥4.5 | 7.90 | 19.22 |
| `--text-on-overlay` | `--overlay-backdrop-strong` | 正文 ≥4.5 | 10.85 | 19.89 |
| `--danger-text` | `--danger-soft` | 正文 ≥4.5 | 4.75 | 6.68 |
| `--danger-text` | `--surface` | 正文 ≥4.5 | 5.27 | 6.95 |
| `--danger-text` | `--danger-button-bg` | 正文 ≥4.5 | 4.89 | 6.68 |
| `--danger-text-hover` | `--danger-button-bg-hover` | 正文 ≥4.5 | 5.49 | 7.67 |
| `--plugin-danger-text` | `--plugin-danger-bg` | 正文 ≥4.5 | 6.35 | 6.52 |
| `--danger` | `--surface` | 次要 ≥3 | 4.14 | 5.90 |
| `--warning` | `--warning-surface` | 次要 ≥3 | 3.55 | 6.89 |
| `--warning` | `--surface` | 次要 ≥3 | 3.75 | 7.46 |
| `--success` | `--surface` | 次要 ≥3 | 3.49 | 7.18 |
| `--success` | `--success-soft` | 次要 ≥3 | 3.13 | 6.12 |
| `--diff-added-text` | `--diff-added-bg` | 正文 ≥4.5 | 4.82 | 6.93 |
| `--diff-removed-text` | `--diff-removed-bg` | 正文 ≥4.5 | 5.15 | 5.54 |
| `--status-called-text` | `--status-called-bg` | 正文 ≥4.5 | 4.61 | 6.33 |
| `--status-executing-text` | `--status-executing-bg` | 正文 ≥4.5 | 4.83 | 7.25 |
| `--status-completed-text` | `--status-completed-bg` | 正文 ≥4.5 | 5.24 | 7.73 |
| `--status-failed-text` | `--status-failed-bg` | 正文 ≥4.5 | 4.84 | 7.08 |
| `--task-text-secondary` | `--surface` | 正文 ≥4.5 | 7.56 | 9.38 |
| `--task-text-muted` | `--surface` | 次要 ≥3 | 4.83 | 6.55 |
| `--task-warning-text` | `--surface` | 正文 ≥4.5 | 5.02 | 8.94 |
| `--task-error-text` | `--surface` | 正文 ≥4.5 | 6.47 | 6.00 |
| `--memory-text-muted` | `--surface` | 次要 ≥3 | 4.61 | 6.39 |
| `--memory-list-text` | `--memory-list-bg` | 正文 ≥4.5 | 5.15 | 7.76 |
| `--memory-list-meta` | `--memory-list-bg` | 次要 ≥3 | 3.66 | 5.75 |
| `--memory-list-text` | `--memory-selected-bg` | 正文 ≥4.5 | 4.65 | 5.88 |
| `--memory-badge-text` | `--memory-badge-bg` | 正文 ≥4.5 | 4.64 | 6.17 |
| `--memory-badge-reviewed-text` | `--memory-badge-reviewed-bg` | 正文 ≥4.5 | 5.03 | 6.81 |
| `--memory-tag-text` | `--memory-tag-bg` | 正文 ≥4.5 | 4.63 | 6.25 |
| `--memory-access-text` | `--memory-access-bg` | 正文 ≥4.5 | 4.57 | 6.90 |
| `--memory-detail-meta` | `--surface` | 次要 ≥3 | 3.84 | 5.59 |
| `--memory-empty-text` | `--surface` | 次要 ≥3 | 3.17 | 5.58 |
| `--memory-history-meta` | `--surface` | 次要 ≥3 | 3.30 | 5.52 |
| `--memory-editor-hint` | `--surface` | 次要 ≥3 | 3.84 | 5.98 |
| `--memory-alert-text` | `--surface` | 正文 ≥4.5 | 6.69 | 6.81 |
| `--retrieval-text-muted` | `--surface` | 次要 ≥3 | 5.32 | 6.50 |
| `--retrieval-alert-text` | `--surface` | 正文 ≥4.5 | 6.67 | 6.81 |
| `--retrieval-egress-text` | `--retrieval-egress-bg` | 正文 ≥4.5 | 7.73 | 9.66 |
| `--page-text` | `--retrieval-code-bg` | 正文 ≥4.5 | 13.65 | 12.37 |

结果：深色、浅色全部配对达标。

浅色对比度修正（已处理）：原先不达标的 8 个配对通过调深文字色的明度（保持色相）解决，不改底色、不改深色块。

| 变量 | 旧值 | 新值 | 原对比度 → 现对比度 |
| --- | --- | --- | --- |
| `--subtle` | `#a0a7b8` | `#848da3` | 2.41 → 3.32（`--surface`），2.27 → 3.13（`--app-bg`） |
| `--success` | `#18a174` | `#179c70` | 2.95 → 3.13（`--success-soft`） |
| `--status-called-text` | `#68716c` | `#636b66` | 4.23 → 4.61 |
| `--memory-list-text` | `#6e776f` | `#656d66` | 4.47 → 5.15（`--memory-list-bg`），4.03 → 4.65（`--memory-selected-bg`） |
| `--memory-badge-text` | `#687384` | `#626c7c` | 4.20 → 4.64 |
| `--memory-tag-text` | `#6c756f` | `#68706a` | 4.32 → 4.63 |

`--subtle` 和 `--success` 除文字外也用于少量图标、状态点和图表色块，一并变深，幅度小，不拆分变量。

### 后续项

- Desktop：已处理。窗口底色与 `nativeTheme` 跟随主题偏好，契约见 `2026-11-24-desktop-studio-distribution-design.md` 的「窗口背景与原生外观跟随主题」。窗口底色常量取自本文的 `--app-bg`（浅色 `#f7f8fc`，深色 `#12141b`），desktop 测试读取 `app.css` 校验两者一致，修改 `--app-bg` 时必须同步 `apps/desktop/src/theme.ts`。
- 终端主题仍是写死的深色，没有随主题变化。
