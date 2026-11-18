# Studio 预览面板设计（iframe 版）

## 1. 背景

右侧面板的"预览"标签之前是"即将推出"占位。本次把它做成可用的网页预览，第一版用
iframe（纯前端、浏览器与桌面模式都能用、无新依赖）。终端以及用 `WebContentsView`
加载受 `X-Frame-Options` 限制站点的增强，是后续单独的工作。

## 2. 方案

- 预览面板在右侧面板里是一个普通标签，从"+"菜单打开（不再是即将推出），非默认固定，
  可关闭。
- 面板上方是地址栏（输入框 + "打开" + 刷新），下方是填满剩余高度的 iframe。
- 地址解析 `resolvePreviewUrl`：
  - 去空白；为空则显示空状态。
  - 缺协议时，`localhost`/`127.*`/`::1` 等本地地址补 `http://`，其余补 `https://`。
  - 用 `new URL` 解析，失败提示"网址无效"。
  - 协议必须是 `http:` 或 `https:`，否则拒绝（挡掉 `file:`、`javascript:` 等），
    iframe 不会加载。
- iframe 使用 `sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals"`
  与 `referrerpolicy="no-referrer"`；不给 `allow-top-navigation`，内嵌页无法把整个
  Studio 导航走。
- 当前地址存 `localStorage`（`weave.studio.previewUrl`），刷新/重开记住。刷新按钮通过
  改 iframe 的 `key` 强制重载。

## 3. 面板保活（keepAlive）

面板注册表的 `PanelDescriptor` 新增 `keepAlive`。此前容器只渲染当前激活面板，切走即
卸载。预览的 iframe 一旦卸载就会重新加载页面，所以：

- `keepAlive` 面板（预览，以及将来的终端）在打开期间始终挂载，非激活时用 `hidden`
  隐藏（`display:none`，移出无障碍树），不卸载、不重载。
- 非 `keepAlive` 的数据面板（概览/文件/工具/用量）仍按需只渲染激活的那个，切回重算
  即可，开销很小。
- 保活面板用 `.panel-pane { height: 100% }` 容器填满面板正文，iframe `flex:1` 填满，
  不产生额外滚动条。

## 4. 限制

- iframe 受目标站点的 `X-Frame-Options`/CSP 限制，禁止被嵌入的站点（如 GitHub）会白屏；
  本地开发服务器与允许嵌入的页面正常。想加载任意站点需要后续的 `WebContentsView` 方案
  （仅桌面端、需要主进程管理原生层）。
- 不在本次范围：终端面板；外部浏览器打开（需主进程 `shell.openExternal`）。

## 5. 测试

- studio：从"+"菜单打开预览；`file://` 等非 http(s) 协议被拒且不加载 iframe；`localhost:5173`
  补成 `http://` 并加载、写入 localStorage；切到其它标签后 iframe 节点仍是同一个（保活）。
