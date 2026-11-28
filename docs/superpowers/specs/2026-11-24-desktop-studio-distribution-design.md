# Desktop 加载 Studio 与分发方式设计提案

状态：已评审（2026-11-24）。结论见下方「评审结论」；正文其余部分保留为评审时的分析，与结论冲突处以结论为准。

## 评审结论（2026-11-24）

不采用自定义协议（方案 A、C）。采用方案 B 中"由 Desktop 自己的服务提供页面"的变体，参考 Kiro 的做法：

1. **Server 直接托管 Studio 构建产物**。页面与 HTTP API 同源，Desktop 窗口加载内置 Server 的地址（随机端口，由 Server 先完成绑定再加载，不存在端口被别的进程预先占用的问题）。Studio 对 Server 的请求不再跨源。
2. **地址可配置**。`WEAVE_STUDIO_URL` 保留，用于开发时指向 Vite。
3. **局域网访问**。Server 默认只监听 `127.0.0.1`；启动参数 `--host <地址>` 才对局域网开放。非回环监听时**必须使用访问令牌**：启动时输出带令牌的访问地址，没有有效令牌的请求一律拒绝；全局本地准入守卫相应放行已配置的主机名。
4. **预加载桥**（终端、文件夹选择器）只在窗口加载的是 Desktop 内置 Server 的地址时开放；配置成其他地址时不开放。
5. 分发工具（electron-builder 或 Forge）、目标平台和自动更新本轮不定，另行评审。

实现前需要补充的设计：Server 托管静态文件的路由与 SPA 回退、令牌的生成、传递与存储方式（例如首次访问后写入 Cookie）、`--host` 在 CLI 与 Desktop 两种启动方式下的配置入口。

对应观察编号：E1、E9。

## 实现细节（Server 托管 Studio、`--host` 与访问令牌）

以下是评审结论 1 到 4 的落地细节，对应实现 PR「Server 托管 Studio 并支持局域网访问」。

### 静态托管

- `startServer` 新增可选 `studioDirectory`（Studio `vite build` 产物目录，默认 `apps/studio/dist`；Vite `base` 为默认的 `/`，产物内资源均为绝对根路径 `/assets/...`，同源加载可直接使用）。CLI 入口可用环境变量 `WEAVE_STUDIO_DIRECTORY` 设置。
- 路由顺序：所有 API 路由先注册，静态处理器最后注册，只处理 `GET`/`HEAD`。未被 API 命中的路径：存在对应文件则返回文件；没有扩展名的未知路径回退到 `index.html`（SPA 路由刷新）；带扩展名但不存在的路径返回 404，避免把脚本请求错误地回成 HTML。
- 路径解析先 `resolve` 再校验位于目录内，并对 `realpath` 再校验一次，符号链接不能指向目录之外。非法转义返回 400。
- 响应头：`Content-Security-Policy`（`default-src 'self'`，脚本允许 `'wasm-unsafe-eval'` 供语法高亮的 WebAssembly 使用，样式允许 `'unsafe-inline'` 供 React `style` 属性使用，`connect-src 'self'`，`object-src 'none'`，`frame-ancestors 'none'`）、`X-Content-Type-Options: nosniff`、`Referrer-Policy: no-referrer`。`assets/` 下带哈希的文件使用长期缓存，其余使用 `no-cache`。
- `runtime-bridge.ts` 在浏览器模式下使用相对地址，托管后页面与 API 同源，无需 CORS。

### Desktop

- Desktop 把 `apps/studio/dist` 传给 `startServer`，窗口加载 `http://127.0.0.1:<Server 端口>/`；信任 origin 是 Server 自己的 origin，不再向 Server 传 `studioOrigin`（页面同源，Server 按回环 Origin 规则放行）。
- `WEAVE_STUDIO_URL` 保留：设置后窗口加载该地址（开发用 Vite），信任 origin 为该地址的 origin，行为与之前一致。`pnpm desktop:dev` 自行启动 Vite，并把 `WEAVE_STUDIO_URL` 传给 Electron。
- 未设置 `WEAVE_STUDIO_URL` 且找不到 `index.html` 时，窗口显示启动错误页，说明缺少的路径和构建命令；不加载任何页面。
- 预加载桥（终端与文件夹选择器）：`isTrustedSender` 要求同时满足：`senderFrame.origin` 与其 URL 的 origin 等于信任 origin；`senderFrame` 就是 `event.sender.mainFrame`（拒绝子 frame）；`event.sender.getURL()` 的 origin 也等于信任 origin。缺少 `sender` 时拒绝。

### Studio 源的稳定性

- 原因：Studio 的本地设置（主题 `weave.studio.theme.v1`、权限模式、推理强度、面板布局与宽度、预览地址等）存在 localStorage，而 localStorage 按源（协议、主机、端口）隔离。Server 用端口 `0` 启动时每次得到不同端口，窗口的源随之变化，重启后所有设置回到默认值。
- 做法：Desktop 在 `<userData>/desktop-state.json` 记录上次实际使用的 Server 端口（`{ "version": 1, "serverPort": 1024–65535 }`，Zod 校验，临时文件加 `rename` 写入）。启动时先用记录的端口调用 `startServer`；成功后把实际端口写回。文件不存在、无法读取、JSON 非法或校验失败都当作"没有记录"，不会阻止启动；未知字段读取时忽略，下次写入不保留。
- 端口被占用：`startServer` 以 `EADDRINUSE` 失败时（从 `cause` 与 `AggregateError.errors` 链中识别；`startServer` 失败时已释放数据库等资源）改用端口 `0` 再启动一次，并记录新端口。这一次启动因源变化，设置回到默认值；之后稳定在新端口。其他错误不重试，照常抛出。
- `WEAVE_STUDIO_URL`（页面源由 Vite 决定，本就稳定）与 `--host` / `WEAVE_HOST`（访问令牌每次启动重新生成，首次加载仍通过 `?token=` 换取 Cookie）走同一逻辑，令牌与 Cookie 流程不变。
- 为什么不用固定端口：固定端口在被其他程序占用时无法启动，也会让多个用户或多个实例互相冲突；记录加回退既保持稳定，又不会因占用而失败。为什么不用自定义协议：Server 托管 Studio 并按回环 Origin 放行 API，自定义协议需要重做同源、CORS 与 Cookie 方案（见上文方案 A），改动远大于本问题。

### 窗口背景与原生外观跟随主题

- 问题：窗口 `backgroundColor` 写死浅色，深色主题下启动和刷新时先闪浅色；`nativeTheme.themeSource` 不跟随 Studio 主题，系统原生部件（标题栏、右键菜单、文件选择框）不随用户在设置页选的浅色/深色变化。
- Preload 契约：`window.weaveDesktop.setTheme(preference: 'system' | 'light' | 'dark'): void`，内部 `ipcRenderer.send('weave:set-theme', preference)`。传的是偏好而不是解析结果，所以选"跟随系统"时由 Electron 自己跟随系统。浏览器模式没有该桥。
- IPC 通道 `weave:set-theme`（单向，`ipcMain.on`）：先用 `isTrustedSender` 校验发送方，再用 Zod 校验参数（恰好一个 `system | light | dark`）；任一失败都直接丢弃，不设置任何东西。通过后：设置 `nativeTheme.themeSource`；把所有未销毁窗口的 `backgroundColor` 设为解析后主题的底色；把偏好写入 `desktop-state.json` 的 `theme` 字段（可选字段，缺失或非法时按"没有记录"处理，写入失败只记录日志）。
- 启动：先读状态文件里的 `theme`（没有则 `system`），设置 `nativeTheme.themeSource`，再按 `nativeTheme.shouldUseDarkColors` 选择新窗口的 `backgroundColor`；新窗口因此不会先闪浅色。监听 `nativeTheme` 的 `updated` 事件，更新所有窗口底色（偏好为跟随系统时，系统切换深浅色即跟随）。
- 底色常量与 Studio `--app-bg` 一致：浅色 `#f7f8fc`，深色 `#12141b`，定义在 `apps/desktop/src/theme.ts`。desktop 测试读取 `apps/studio/src/app/app.css` 文本，解析 `:root` 与 `:root[data-theme='dark']` 的 `--app-bg` 并断言一致（读文件，不做跨包 import）。
- 限制：首次启动（没有状态文件）时偏好视为"跟随系统"；若 localStorage 里是别的偏好，第一次页面加载后 Studio 会调用 `setTheme` 同步，之后启动即使用记录。

### `--host` 与访问令牌

- Server CLI 支持 `--host <地址>` / `--host=<地址>`，也读环境变量 `WEAVE_HOST`，默认 `127.0.0.1`。Desktop 从 `process.argv` 和 `WEAVE_HOST` 读取同名设置并传给 `startServer({ host })`；Desktop 窗口始终通过 `127.0.0.1` 访问自己的 Server。
- 监听地址不是 `localhost`、`127.0.0.1`、`::1` 时启用访问令牌：启动时生成 32 字节随机令牌（base64url），或使用 `WEAVE_ACCESS_TOKEN`（16 到 256 个字符，限 `A-Za-z0-9._~-`，格式不符则启动失败且不回显值）。启动时通过 `announce`（默认 `console.info`）输出 `http://<地址>:<端口>/?token=<令牌>`；监听 `0.0.0.0` 或 `::` 时地址取第一个非内部 IPv4。令牌不写入日志以外的位置，也不进入会话事件。
- 令牌校验中间件最先注册，放行 `/health`，其余请求都需要凭据：`weave_access_token` Cookie 或 `Authorization: Bearer <令牌>`；比较前先做 SHA-256 再用 `timingSafeEqual`。带 `?token=` 的 `GET`/`HEAD` 校验通过后写入 `HttpOnly; SameSite=Strict; Path=/` 的 Cookie，并 302 到去掉 `token` 的同一地址；令牌错误返回 401。没有有效令牌返回 `401 access-token-required`。
- 全局本地准入守卫及各路径守卫（执行、记忆、检索、面板、撤销、插件与 MCP 写入）新增 `trustedHost`：非回环监听时，`Host` 允许回环或等于 `<监听地址>:<实际端口>`（监听通配地址时为"任意主机名加实际端口"，因为服务端无法得知客户端使用哪块网卡的地址；令牌仍然必需）。`Origin` 的主机部分按同一规则判断，即允许同源，不再要求等于固定的 `studioOrigin`。实际端口在监听完成后才确定，所以应用在监听回调里创建。`Sec-Fetch-Site`、JSON 校验等其余检查不变；回环监听时不传 `trustedHost`，行为与之前完全一致。
- 安全含义：能访问该地址并持有令牌的人可以操作这台电脑上的 Weave（包括 Agent 执行与终端以外的全部 HTTP API）。令牌通过明文 HTTP 传输，仅适用于可信局域网。终端与文件夹选择器是 Electron 预加载桥，不经 HTTP，局域网浏览器无法使用。

## 1. 背景

以下现状均已对照当前代码核实。

- `apps/desktop/src/desktop-config.ts`：`studioUrl` 取自环境变量 `WEAVE_STUDIO_URL`，缺省为 `http://127.0.0.1:5173`。校验只要求协议为 `http:` 或 `https:`，主机名属于 `localhost`、`127.0.0.1`、`[::1]`。`studioOrigin` 由该 URL 派生。
- `apps/desktop/src/main.ts`：`createMainWindow` 创建 `BrowserWindow`（`contextIsolation: true`、`nodeIntegration: false`），通过 `additionalArguments` 把本地 Server 地址传给预加载脚本，然后 `window.loadURL(config.studioUrl)`。`will-navigate` 拦截跳到其他 origin 的导航，`setWindowOpenHandler` 对所有请求返回 `deny`。
- `apps/desktop/src/preload.cts`：通过 `contextBridge` 暴露 `window.weaveDesktop`，包含 `serverUrl`、`pickDirectory`、`terminal.create/write/resize/dispose` 等。预加载脚本本身不判断当前页面来源。
- 信任判定在主进程：`handlePickDirectory`（`main.ts`）要求 `event.senderFrame.origin` 与 `senderFrame.url` 的 origin 都等于 `studioOrigin`；`terminal.ts` 的 `trusted()` 用 `new URL(event.senderFrame.url).origin === studioOrigin`。终端 IPC 按设计不经过 Agent 审批，注释写明边界只有"受信任的 Studio origin"。
- Server 侧：`startServer(0, { studioOrigin, … })` 监听随机端口。`apps/server/src/agent-execution-guard.ts` 在传入 `studioOrigin` 时只放行该 origin，并返回精确匹配的 CORS 头。
- 开发流程：`apps/desktop/src/dev.ts` 先用 `vite --strictPort` 在 `WEAVE_STUDIO_URL` 的端口启动 Studio，轮询就绪后再启动 Electron。
- 分发：`apps/desktop/package.json` 的 `main` 是 `dist/main.js`，脚本只有 `dev`、`build`（`tsc`）、`rebuild`（`electron-rebuild -f -w node-pty`）。依赖中没有 electron-builder 或 Forge；仓库根的 `package.json`、`apps/*/package.json`、`.github` 中也没有对应配置（未检索 CI 之外的其他位置）。`docs/superpowers/specs/2026-11-16-desktop-shell-design.md` 把安装包、签名、公证、自动更新明确排除在首版之外，并说明它们属于后续独立分支。
- `apps/studio` 只有 `vite build`，没有任何步骤把构建产物放入 Desktop 应用。

## 2. 问题

1. **E1：信任依据只是 origin 字符串。** 预加载桥（终端 pty、文件夹选择器、Server 地址）对任何以 `127.0.0.1:5173` 为 origin 的页面生效。生产形态下没有进程保证该端口上运行的是 Weave Studio。同机其他进程（含另一用户级进程、浏览器里运行的恶意本地服务）只要抢先监听 5173，就能成为"受信任页面"，并获得终端能力。`dev.ts` 的 `--strictPort` 只在开发启动路径中防止端口漂移，不验证端口上的服务身份；`main.ts` 本身不做任何服务校验。
2. **E9：没有可分发形态。** 应用运行需要另行启动 Studio，Desktop 不能作为独立安装包交付。`node-pty` 是原生模块，目前只有开发用的 `rebuild` 脚本，没有针对打包产物的重编、签名、公证流程。
3. 两个问题相关：一旦 Studio 随应用分发，端口信任问题可以从根上消除；反之只做端口校验，则分发问题依旧。

## 3. 可选方案

### 方案 A：自定义协议加载打包进应用的 Studio

在主进程用 `protocol.handle`（或 `protocol.registerSchemesAsPrivileged` 加 `handle`）注册如 `weave-app://studio/`，从应用资源目录（`app.asar` 或 `extraResources`）读取 `apps/studio` 的 `vite build` 产物。`studioOrigin` 变成 `weave-app://studio`，`BrowserWindow` 加载该地址。开发模式仍可通过 `WEAVE_STUDIO_URL` 指向 Vite。

- 优点：页面内容来自应用包内，端口抢占不再影响信任；origin 不再是可被他人监听的 TCP 端口；与签名和公证后的应用完整性绑定。
- 缺点：需要处理 SPA 路由回退、MIME、CSP；Server 的 CORS 与 `agent-execution-guard.ts` 目前按 `http(s)` origin 校验（`value.protocol === 'http:' || 'https:'` 且 `origin === studioOrigin`），自定义协议 origin 需要同步调整该守卫与测试；Studio 现有 `fetch` 到 `serverUrl` 的跨源行为需要在自定义协议下验证（未核实）；标准协议注册（`standard`、`secure`、`supportFetchAPI`）要在 `app.ready` 之前完成。

### 方案 B：保留外部 `studioUrl`，加载前校验端口上的服务

保持 `loadURL(http://127.0.0.1:5173)`，在加载前加一次身份校验，例如请求 Studio 提供的 `/.well-known/weave-studio` 清单并校验其内容哈希，或由 Desktop 自己在随机端口上启动内置静态服务器，并只向预加载桥传入该会话的随机令牌。

- 优点：改动小，开发和测试路径不变。
- 缺点：校验与使用之间存在竞态（TOCTOU）；固定端口仍可被抢占，校验只能降低风险；若 Desktop 自带静态服务器，实质上变成方案 A 的变体，却多一个监听端口。校验清单本身如果不签名，攻击者可复制。

### 方案 C：A 为主，B 的"随机端口加令牌"作为开发期兜底

生产使用自定义协议，开发期仍用 `WEAVE_STUDIO_URL`，并在预加载桥层面增加"仅当页面 origin 等于 `studioOrigin` 且主进程在导航完成时确认过 `webContents.getURL()`"的二次校验（对 `did-navigate`、`did-navigate-in-page` 后的 URL 重新比对），生产构建中禁止通过环境变量覆盖 `studioUrl`。

### 分发工具选择（与上述方案正交）

| 项 | electron-builder | Electron Forge |
| --- | --- | --- |
| 配置位置 | `package.json` 的 `build` 字段或 `electron-builder.yml` | `forge.config.*` |
| pnpm monorepo | 需要处理 workspace 依赖的打包与 `asarUnpack` | 同样需要处理，且插件对 pnpm 的 node_modules 布局历史上有兼容问题（未核实当前版本） |
| 原生模块 | 内置 `npmRebuild`，可对 `node-pty` 重编 | `@electron-forge/plugin-auto-unpack-natives` 加 `@electron/rebuild` |
| 签名与公证 | 内置 `mac.notarize` 等 | 通过 `osxSign`、`osxNotarize` |
| 自动更新 | `electron-updater` | 自带 `update-electron-app` 或自行实现 |

两者都不是仓库当前依赖，引入任一个都属于"新增依赖"，需要在实现 PR 里单独说明理由。比较结论暂不下定，评审时以团队对 pnpm 工作区打包的熟悉程度和 CI 平台为准。

### 其他需要决定的分发细节

- `node-pty` 必须针对目标 Electron ABI 重编，并放在 `asar` 之外（`asarUnpack`）。当前 `rebuild` 脚本只面向本机开发。
- Server 代码（`@weave/server`）与其原生依赖（SQLite 驱动等，具体包名未核实）同样需要进入应用包。
- macOS：需要 Apple Developer 证书、hardened runtime、公证；`node-pty` 的 `spawn-helper` 等二进制也要签名。Windows 与 Linux 的签名策略未核实，不在本提案范围内。
- 自动更新：本提案不设计，只要求方案 A 不阻碍后续接入。

## 4. 推荐方案

推荐方案 C：

1. 生产形态使用自定义协议加载打包进应用的 Studio 构建产物，消除"信任一个 TCP 端口"的前提。
2. 保留 `WEAVE_STUDIO_URL` 仅用于开发，并在打包后的应用中忽略该变量（以 `app.isPackaged` 判定）。
3. 主进程信任判定增加对导航结果的复核：IPC 到达时除比对 `senderFrame.origin` 与 `senderFrame.url` 外，还与窗口当前 `webContents.getURL()` 的 origin 比对，并拒绝来自子 frame 的调用（当前代码只看 `senderFrame`，是否拒绝子 frame 未核实）。
4. 分发工具选择放到独立评审，先用方案 A 的产物在 `electron .` 下跑通，再接入打包器。

## 5. 受影响的包与契约

- `apps/desktop`：`desktop-config.ts`（新增生产与开发两套 `studioUrl`/`studioOrigin` 取值规则）、`main.ts`（协议注册、窗口加载）、`terminal.ts` 与 `handlePickDirectory`（信任判定）。
- `apps/server`：`agent-execution-guard.ts` 及其他使用 `studioOrigin` 的 CORS 与 Origin 校验（`app.ts`、`registerRetrievalGuard` 等）需要接受自定义协议 origin。
- `apps/studio`：构建产物的 `base` 路径、是否依赖 Vite 开发代理（`vite.config.ts` 的 `/memory`、`/agent` 等代理在打包形态下不存在，Studio 需要在桌面模式下直接使用 `weaveDesktop.serverUrl`，该行为未逐项核实）。
- 契约：`window.weaveDesktop` 的形状保持不变；`studioOrigin` 的类型由"http(s) loopback origin"放宽为"受信任的应用 origin"，需在 `docs/architecture/foundation.md` 或 2026-11-16 桌面外壳设计中同步，实现 PR 再改，本提案不改。

## 6. 迁移与兼容

- 开发流程（`pnpm --filter @weave/desktop dev`）保持不变。
- `WEAVE_STUDIO_URL` 在未打包运行时继续生效，已有测试（`apps/desktop/test`）继续适用。
- 用户数据目录与 SQLite 位置不变。
- 浏览器访问 Studio 的方式不受影响。

## 7. 测试计划

- `desktop-config` 单测：打包与未打包两种模式下 `studioUrl` 的取值与对环境变量的处理。
- IPC 信任单测：来自自定义协议 origin、5173 origin、子 frame、导航后 URL 与初始 URL 不一致的场景，`pickDirectory` 与终端创建均应拒绝不可信来源。
- Server 守卫单测：自定义协议 origin 被放行，其他 origin 仍被拒绝。
- 手工验证清单：未启动 Vite 时应用可启动并显示 Studio；在 5173 上起一个假服务，不应获得终端能力；`node-pty` 在打包产物中可创建 pty；签名与公证后的应用在干净 macOS 上首启。

## 8. 未决问题

1. 自定义协议下 Studio 对 Server 的跨源请求（含 SSE）是否需要额外 CORS 或 `webSecurity` 配置，需要原型验证。
2. 是否要在生产形态彻底移除 `WEAVE_STUDIO_URL`，还是允许带显式开发标志的覆盖。
3. electron-builder 与 Forge 的选择，以及目标平台范围（仅 macOS，还是同时 Windows 与 Linux）。
4. 自动更新是否进入同一里程碑。
5. Server 在打包后的原生依赖清单与体积。
