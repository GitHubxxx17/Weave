# Studio 终端面板设计（node-pty + xterm）

## 1. 背景

右侧面板的"终端"从占位做成可用的交互式终端。终端是给**用户自己**敲命令用的（不是
Agent），因此不走 Agent 审批；边界是只有可信 Studio origin 能开/控终端，输出只发给
拥有它的渲染进程。仅桌面端可用，浏览器模式降级为提示。

## 2. 依赖（新增，附理由）

- `node-pty@1.1.0`（desktop 主进程）：真正的 pty，交互式程序、颜色、行编辑、尺寸都需要
  它；`child_process` 无 pty 不足以做终端。原生模块，ABI 与系统 Node 不同，需针对
  Electron 重编译。
- `@electron/rebuild@4.2.1`（desktop devDep）：把 node-pty 重编译到 Electron 的 ABI。
- `@xterm/xterm@6.0.0` + `@xterm/addon-fit@0.11.0`（studio）：渲染端终端组件与自适应尺寸，
  xterm 是事实标准。

构建脚本：desktop 新增 `rebuild`（`electron-rebuild -f -w node-pty`）；根 `desktop:dev`
先 `pnpm --filter @weave/desktop run rebuild` 再构建启动，另有 `desktop:rebuild` 可单独跑。
`node-pty` 加入根 `onlyBuiltDependencies`。CI 的 `pnpm check` 不跑 electron-rebuild、不加载
原生模块（desktop 测试注入假 spawner），因此不受影响；Electron-ABI 重编译只在本地跑桌面时需要。

## 3. 契约（desktop ↔ studio）

IPC 通道（`weave:terminal:*`）：

- `create`（invoke，渲染→主）：`{ cwd?: string|null, cols, rows }` → `{ id }` 或 `{ error }`。
  主进程校验 `senderFrame.origin === studioOrigin`、用 Zod 校验参数，按平台选 shell
  （`$SHELL`/`ComSpec`，默认 `/bin/bash`），cwd 取可用的绝对目录否则回退到家目录，spawn 后
  按 id 记录会话。
- `input` / `resize` / `dispose`（send，渲染→主）：按 id 写入 / 调整尺寸 / 杀进程，均校验来源。
- `data` / `exit`（send，主→渲染）：pty 输出与退出码，只发给拥有的 webContents。

Preload 暴露 `window.weaveDesktop.terminal`：`create/write/resize/dispose` 与
`onData/onExit`（返回取消订阅函数）。主进程在窗口关闭或退出时杀掉所有 pty 并移除处理器。

主进程 `registerTerminalHost` 接受注入的 `spawn`（默认懒加载 node-pty），使测试无需加载原生
模块。node-pty 仅在真正 spawn 时经 `createRequire` 懒加载。

## 4. 渲染端

- `TerminalPanel` 动态 `import('@xterm/xterm')`（不进静态依赖图，App 测试与首屏不加载 xterm，
  打包时单独分块）。挂载时建 xterm + FitAddon、`create` pty（cwd = 当前项目文件夹）、把
  `xterm.onData` 转发到 pty、把 pty `data` 写回 xterm、`ResizeObserver` + fit 同步尺寸；卸载时
  dispose pty 与 xterm。
- 终端是 `keepAlive` 面板，切换标签时隐藏不卸载，pty 不被杀、内容不丢。
- 浏览器模式 `window.weaveDesktop.terminal` 不存在，显示"终端仅在桌面端可用"。

## 5. 不在本次范围

- 多终端分屏 / 多标签终端（当前一个终端面板一个 pty）。
- 终端里对 Agent 的联动（终端是用户工具，不接 Agent 审批）。

## 6. 测试

- desktop：create 在项目目录按平台 shell spawn、输出经 data 通道回传、input/resize/dispose
  对应写入/调整/杀进程、非可信 origin 拒绝、非法参数拒绝、dispose 杀所有并移除处理器。
- studio：桌面桥接下 TerminalPanel 在项目目录起 pty 并双向转发输入输出；无桥接时显示降级提示。
- 本地无头 Electron 已验证 node-pty 在 Electron ABI 下可加载并 spawn（`echo` 正确回显）；
  xterm 真实渲染需本机实测。
