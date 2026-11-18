# Studio 界面样式优化设计

## 1. 背景

真实使用中发现几处界面问题：思考过程里的工具列表松散、展开图标没有动画；桌面端顶部是
系统默认标题栏，与界面割裂；会话概览信息堆叠、文件列表右侧被裁切；滚动条是系统默认
样式；项目、历史、归档页内容整体垂直居中，项目列表只能点击跳转、无法编辑。本次在一个
分支内统一优化，按用户反馈迭代。

## 2. 改动项

### 2.1 工具步骤与思考过程（studio）

- `ToolStep` 改为紧凑行：左侧旋转箭头、工具类型图标、工具名、目标路径、右侧状态。
  完成只显示对勾，执行中显示转圈，失败或被拒绝显示红色标签；多个步骤放在同一个
  带细分隔线的列表容器中。
- 展开后参数（JSON 格式化）与结果分块显示，限高滚动。
- 修正选择器泄漏：`.message-process summary` 原本命中了内部每个工具步骤的
  `summary`，使所有工具步骤的三角箭头始终朝下、样式被覆盖。改为只作用于直接子元素。
- 展开/收起动画：箭头 `transform: rotate()` 过渡；内容区使用 `::details-content`
  + `interpolate-size: allow-keywords` 过渡高度（Electron 39 / Chromium 142 支持，
  不支持的浏览器直接展开）。`prefers-reduced-motion` 下关闭所有过渡和转圈动画。

### 2.2 桌面端标题栏（desktop + studio）

macOS 隐藏系统标题栏，交通灯按钮内嵌在左侧导航栏顶部，界面直接延伸到窗口顶端；
Windows / Linux 保持系统标题栏不变。

契约（desktop → studio）：

- Main 根据平台决定 `WindowChrome = 'hidden-inset' | 'native'`：macOS 为
  `hidden-inset`（`titleBarStyle: 'hidden'` + `trafficLightPosition`），其它平台为
  `native`。窗口同时设置 `backgroundColor`，避免启动白屏。
- Main 通过 `additionalArguments` 追加 `--weave-window-chrome=<值>`；Preload 解析后在
  `window.weaveDesktop.windowChrome` 暴露，未知值按 `native` 处理。
- Studio 启动时把它写到 `<html data-window-chrome>`。`hidden-inset` 时：导航栏加宽、
  顶部留出交通灯区域；各栏标题区域设置 `-webkit-app-region: drag` 以拖动窗口，
  其中的按钮、输入框设为 `no-drag`；弹层遮罩与对话框整体 `no-drag`，避免误拖动。

Preload 只多暴露一个枚举字符串，不暴露 `process`、平台信息或其它 Node 能力。

### 2.3 右侧改为标签页面板（studio）

去掉"会话概览"标题，右侧变成一个独立面板：顶部是标签栏，左边是标签、右边是"+"
按钮和收起按钮。面板较窄时标签只显示图标。

- **默认标签（固定）**：概览、文件、工具、用量。固定标签没有关闭按钮。
- **概览**：运行状态、项目文件夹、模型、轮次、工具调用、会话标识。模型名与服务名
  相同时只显示一次。运行错误也在这里。
- **文件**：本次会话读写过的文件，图标区分读/写，只在写入或失败时显示状态。
- **工具**：工具调用时间线，复用 `ToolStep`。
- **用量**：参考 DeepSeek harness 的 dsh-context 效果，分三块——统计（轮次/步数/
  工具调用/缓存命中）、当前构成（总 token、堆叠条、四类图例与占比）、历史趋势（按
  轮次或步骤的堆叠柱状图）。四类口径互不重叠，和为输入+输出：命中缓存、新输入
  （输入−缓存）、输出（输出−思考）、思考。Weave 只记录 input/cache/output/reasoning，
  不按消息类型拆解 prompt，所以构成是这四类而非 dsh-context 的系统提示/工具定义等。
- **"+" 菜单**：列出所有面板类型。已打开的点一下切过去；预览（嵌入网页）、终端显示为
  灰色"即将推出"。
- **右键标签**：固定/取消固定、关闭（固定时禁用）。
- **保存布局**：打开了哪些标签、哪个激活、面板宽度都存在本地（全局一份），用 Zod
  校验，损坏或旧版本回到默认。
- **代码结构**：`features/panel/` 下有面板注册表（每种面板登记名称、图标、是否默认固定、
  是否即将推出、渲染函数）、`usePanelTabs`（带持久化的标签状态）、`PanelContainer`
  （标签栏 + 菜单 + 正文 + 左侧 Resizer + 收起）。加预览/终端只需注册新类型。

### 2.4 面板与会话拖拽调整宽度（studio）

对话列和右侧面板之间可以拖拽调整宽度。拖动时只改 shell 上的 `--panel-width` CSS 变量，
不触发 App 整树重渲染；松手时提交并存到本地。宽度限制在 260–720px，且对话区不小于
380px。双击分界线恢复默认；键盘 ← → 调整、Home/End 到最窄/最宽。macOS 桌面端拖分界线
不会拖动窗口。

### 2.5 滚动条与外层滚动条（studio）

全局统一细滚动条：Chromium / Safari 使用 `::-webkit-scrollbar`（透明轨道、圆角滑块、
悬停加深）；不支持该伪元素的浏览器（Firefox）使用 `scrollbar-width: thin` 与
`scrollbar-color`。两者不同时生效，因为 Chromium 121+ 在设置了标准属性后会忽略
`::-webkit-scrollbar`。

外层（窗口级）滚动条的根因：只给读屏软件看的 `.sr-only` 文字用 `position: absolute`，
而消息列表、面板正文等滚动容器没有定位，导致这些文字跑到文档层把页面撑高。给这些滚动
容器加 `position: relative`，让绝对定位的后代留在容器内，页面高度即与窗口一致。

### 2.6 项目、历史、归档页（studio + server + workspace）

- 页面改为顶部对齐、可滚动的管理页布局，统一页头（标题、说明、操作）。
- 项目页：每行显示名称、文件夹路径、会话数、当前项目标记，并提供"新建会话"、
  "重命名"、"设置文件夹"、"打开"操作。打开没有会话的项目时切换到该项目的空白工作台，
  首条消息会自动创建会话。
- 归档页：按项目分组，显示归档时间；历史页保持占位，改为顶部对齐的空状态。

项目重命名是新增契约：

- `ProjectStore.renameProject(projectId, name): Promise<Project>`：更新名称并刷新
  `updatedAt`；名称为空返回 `workspace-store-invalid-input`，项目不存在返回
  `workspace-project-not-found`。内存版与 SQLite 版行为一致。
- `PATCH /projects/:projectId` 的请求体从 `{ folderPath }` 扩展为
  `{ name?: string; folderPath?: string | null }`，至少包含一个字段；同时提供时先校验
  文件夹，再依次重命名和更新文件夹。只传 `folderPath` 的旧请求保持兼容。
- Studio 的 `WorkspaceApi` 新增 `renameProject(projectId, name)`。

`folderName`（文件夹名）不随重命名改变，它描述磁盘位置而不是显示名称。

## 3. 不在本次范围

- 预览（嵌入网页）与终端面板本身：预览需要 Electron 主进程管理内嵌页面并限制可打开
  的地址；终端需要主进程启动 shell 进程并接入审批。各自单独做并单独做安全评审；
- 删除 / 移除项目：涉及项目下会话的去向（一并删除、归档还是禁止删除非空项目）和
  文件夹绑定，需要先确定语义；
- 历史页真实内容（跨项目按时间排列的会话记录）；
- Windows / Linux 自定义标题栏（需要 Window Controls Overlay 适配）。

## 4. 测试

- workspace：`renameProject` 在两种 Store 中更新名称与 `updatedAt`，拒绝空名称与未知项目；
- server：`PATCH /projects/:id` 支持只改名、只改文件夹，拒绝空请求体；
- desktop：macOS 使用隐藏标题栏并传递 `hidden-inset`，其它平台保持 `native`；
- studio：`windowChrome` 写入根元素；工具步骤状态与格式化参数；拖拽/键盘调整面板宽度
  并持久化；标签页从"+"菜单打开、关闭、固定与布局持久化；用量面板趋势随轮次变化；
  项目页重命名、新建会话与打开空项目。
