# Studio 颜色变量化设计

日期：2026-11-27

## 目的

后续要提供“界面外观”设置（浅色 / 深色 / 跟随系统）。深色主题只能在所有颜色都经过变量之后才能实现。本次只做变量化，浅色外观与改动前逐像素一致，不新增配色，不新增设置项。

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

## 后续：深色主题如何接入

1. 在 `app.css` 增加 `[data-theme='dark'] { ... }` 块，覆盖同一组变量，并设置 `color-scheme: dark`。`:root` 设置 `color-scheme: light`，使滚动条、表单控件等浏览器内置部件随主题变化。
2. “跟随系统”用 `@media (prefers-color-scheme: dark)` 加 `:root:not([data-theme='light'])` 复用同一组覆盖值。
3. 由设置页写入 `document.documentElement.dataset.theme`；首屏在 `index.html` 内联一小段脚本，避免首次绘制闪白。
4. 守护测试的扫描范围需放宽到允许 `[data-theme='dark']` 定义块，规则同 `:root`。
5. 一些变量应在深色主题下保持不变或单独取值：`--preview-frame-bg`（被预览页面的画布）、`--text-on-accent`、`--overlay-*`、`--chart-*`。
6. 插件对话框里 `color-mix(in srgb, var(--warning) 9%, var(--surface))` 这类由变量混合出的颜色会自动跟随变量，无需处理。

## 验证

用 Electron 离屏截图（1280×820，关闭动画与光标闪烁，时间戳、会话 ID、耗时做固定文本替换），对比 `origin/main` 构建与本分支构建的 `apps/studio/dist`，逐像素比较。场景与结果见 PR 正文。

## 变量清单（浅色值）

### 原有变量

| 变量 | 浅色值 |
| --- | --- |
| `--ink` | `#1f2430` |
| `--ink-soft` | `#50586b` |
| `--muted` | `#778095` |
| `--subtle` | `#a0a7b8` |
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
| `--success` | `#18a174` |
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
| `--status-called-text` | `#68716c` |
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
| `--memory-list-text` | `#6e776f` |
| `--memory-list-meta` | `#7d857e` |
| `--memory-badge-bg` | `#edf0f4` |
| `--memory-badge-text` | `#687384` |
| `--memory-badge-reviewed-text` | `#436e50` |
| `--memory-badge-reviewed-bg` | `#e7f0e7` |
| `--memory-detail-meta` | `#7d847e` |
| `--memory-tag-bg` | `#f3f4f4` |
| `--memory-tag-text` | `#6c756f` |
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
