# Weave Desktop Shell 与本地数据目录设计

**日期：** 2026-11-16
**状态：** 待评审
**目标阶段：** Weave Studio 桌面端基础能力

## 1. 背景

当前 Weave Studio 通过浏览器访问 Vite 页面，Server 作为独立的 Node
进程运行。Server 默认使用相对当前进程工作目录的 `.weave/weave.sqlite`
保存 Project 和 Session 数据，因此从 `apps/server` 启动开发命令时，会在
代码仓库中生成 `apps/server/.weave/`。

这个目录适合早期验证 SQLite，但不适合作为桌面应用的数据位置：

- 用户数据会混入源代码目录；
- 从不同目录启动 Server 时可能产生多份数据库；
- 代码仓库、应用安装目录和用户数据没有分离；
- 后续插件安装、权限配置和应用升级无法复用稳定的数据根目录。

本轮建立一个 macOS 优先的 Electron Desktop 基础壳。Electron 主进程负责
本地 Server 的生命周期和窗口创建，Studio 继续负责界面，Server 继续负责
HTTP/SSE 控制面和 Runtime 装配。

## 2. 目标与非目标

### 2.1 本轮目标

1. 新增 `apps/desktop` Electron 应用。
2. Electron 主进程启动和停止本地 Weave Server。
3. Electron 使用随机可用端口启动 Server，避免固定端口冲突。
4. 通过受控 Preload API 把本地 Server 地址提供给 Studio Renderer。
5. Studio 在浏览器模式下继续使用相对 API，在桌面模式下使用 Preload
   提供的 Server 地址。
6. SQLite 默认迁移到操作系统的应用数据目录：

   ```text
   macOS:   ~/Library/Application Support/Weave/weave.sqlite
   Windows: %APPDATA%/Weave/weave.sqlite
   Linux:   $XDG_DATA_HOME/weave/weave.sqlite
            或 ~/.local/share/weave/weave.sqlite
   ```

7. 保留 `WEAVE_DATA_DIR` 和 `WEAVE_DATABASE_FILE` 环境变量，方便测试、CI
   和高级用户覆盖默认位置。
8. 增加一键启动桌面开发模式的命令。
9. 保持 API Key 只存在于 Server 进程和本地环境，不通过 Preload 暴露给
   Renderer。

### 2.2 本轮不包含

- Windows 和 Linux 的实际安装包发布；
- macOS 签名、公证和自动更新；
- 插件市场、GitHub 插件安装和插件沙箱；
- 多窗口和系统托盘；
- 自动迁移旧仓库目录中的 `.weave` 数据；
- 云端同步和多用户认证；
- 修改 Studio 的业务交互模型；
- 将 SQLite 直接暴露给 Renderer。

旧的 `apps/server/.weave/` 数据不会在本轮自动删除。迁移策略需要单独的
备份、确认和回滚设计，避免误删用户已有会话。

## 3. 方案选择

### 3.1 方案 A：Electron 主进程管理 Server（采用）

Electron 主进程直接调用 Server 的 `startServer()`，传入应用数据目录和
端口 `0`。Server 监听成功后返回实际端口，主进程通过 Preload 只暴露本地
Server 的基础地址。

优点：

- 主进程拥有清晰的本地运行时生命周期；
- Server、Runtime、Session 和 SQLite 仍然通过现有 TypeScript 接口复用；
- Renderer 不需要知道 SQLite、Node.js 或操作系统路径；
- 后续插件安装、权限确认和本地目录访问可以继续放在主进程或 Server
  边界内；
- 可以使用随机端口，多个开发实例不会互相覆盖。

代价是 Electron 应用需要负责 Server 启动失败、窗口关闭和运行时清理。
这些都属于桌面应用必须承担的职责。

### 3.2 方案 B：Electron 只加载网页，Server 继续独立启动

Electron 只负责创建窗口，Server 仍由用户通过 `pnpm dev` 或其他命令启动。

这种方案实现最快，但桌面端无法真正管理本地运行时，SQLite 位置和窗口
生命周期仍然依赖外部命令，后续插件安装也没有可靠的主进程入口，因此不
采用。

### 3.3 方案 C：Tauri

Tauri 可以减少应用体积和内存占用，但需要引入 Rust 主进程，并重新设计
TypeScript Server 与 Rust 生命周期之间的边界。当前 Weave 的 Runtime、
Server、Plugin 和 Studio 都是 TypeScript，第一版使用 Electron 能减少新的
语言和工具链，后续仍可在边界稳定后评估 Tauri，不作为本轮实现方案。

## 4. 总体架构

```text
┌──────────────────────────────────────────────┐
│ Electron Main Process                       │
│                                              │
│  app.getPath('userData')                     │
│          │                                   │
│          ▼                                   │
│  databaseFile = <userData>/weave.sqlite      │
│          │                                   │
│          ▼                                   │
│  startServer(0, { databaseFile })            │
│          │                                   │
│          ▼                                   │
│  http://127.0.0.1:<actual-port>              │
│          │                                   │
│          ▼                                   │
│  BrowserWindow + Preload                     │
└──────────┬───────────────────────────────────┘
           │ controlled serverUrl
           ▼
┌──────────────────────────────────────────────┐
│ Weave Studio Renderer                        │
│                                              │
│  Workspace API                                │
│  Provider API                                 │
│  Agent HTTP/SSE                               │
└──────────────────────────────────────────────┘
```

依赖方向保持为：

```text
protocol -> llm -> runtime -> server
                         ▲
                         │
                    desktop
```

`desktop` 是组合根，可以依赖 `@weave/server`，但 Server、Runtime 和
Session 不依赖 Electron 或 React。

## 5. Server 端口与数据目录

### 5.1 允许 Server 使用端口 0

`startServer()` 当前只允许 `1..65535`。本轮扩展为允许 `0`：

- `0` 表示由操作系统分配随机可用端口；
- Server 启动监听完成后，通过 `server.address()` 读取实际端口；
- 返回值中的 `port` 必须是实际监听端口，而不是输入的 `0`；
- 固定端口和现有测试行为继续保留。

这样 Electron 不需要猜测端口，也不会因为 `4317` 被占用而启动失败。

### 5.2 默认数据目录

Server 增加一个纯 Node.js 的默认路径解析函数。解析优先级如下：

1. `WEAVE_DATABASE_FILE`：直接指定 SQLite 文件；
2. `WEAVE_DATA_DIR`：指定数据目录，并拼接 `weave.sqlite`；
3. 根据操作系统环境解析默认应用数据目录。

默认目录规则：

- macOS 使用 `~/Library/Application Support/Weave`；
- Windows 使用 `%APPDATA%/Weave`；
- Linux 优先使用 `$XDG_DATA_HOME/weave`，否则使用
  `~/.local/share/weave`。

`startServer()` 仍然允许调用方通过 `databaseFile` 和 `dataDirectory`
显式覆盖。测试通过临时 SQLite 文件注入，不写入真实用户目录。

### 5.3 旧数据处理

本轮只改变新默认位置，不自动复制或删除旧的 `.weave`。Server 启动时不
扫描仓库目录，也不执行隐式迁移。未来增加迁移向导时，需要先检测旧文件、
展示路径和大小、让用户确认，再复制并校验数据库。

## 6. Electron 主进程

新增 `apps/desktop`，职责拆分如下：

- `src/main.ts`：Electron 生命周期、Server 启动、窗口创建和关闭；
- `src/preload.ts`：启用 `contextBridge`，只暴露桌面运行时元数据；
- `src/desktop-config.ts`：解析开发 URL、数据文件和环境变量；
- `test/desktop-config.test.ts`：验证纯配置和路径解析逻辑。

BrowserWindow 必须使用：

```ts
{
  contextIsolation: true,
  nodeIntegration: false,
  preload: <compiled preload path>
}
```

Preload 只暴露最小接口：

```ts
interface WeaveDesktopBridge {
  readonly isDesktop: true;
  readonly serverUrl: string;
}
```

不暴露 `process`、`fs`、SQLite、API Key 或任意 Node.js 模块。

主进程生命周期：

1. `app.whenReady()` 后解析 `userData` 和数据库文件；
2. 调用 `startServer(0, { databaseFile })`；
3. 组装 `serverUrl`；
4. 创建 BrowserWindow；
5. 开发模式加载 Studio Vite URL；
6. 窗口全部关闭后调用 Server 的 `stop()`；
7. Server 停止完成后退出 Electron。

如果 Server 启动失败，窗口不应加载空白页面，而是显示可读的启动错误，
并在日志中保留原始错误用于诊断。

## 7. Studio Renderer 适配

Studio 的 HTTP 和 SSE 客户端增加统一的 API 地址解析：

- 浏览器模式：API 基础地址为空，继续使用 `/projects`、`/agent/runs/stream`
  等相对路径，由 Vite 代理转发到 Server；
- 桌面模式：检测 `window.weaveDesktop.serverUrl`，将相对路径拼接到本地
  Server 地址；
- 所有请求都通过同一个辅助函数构造，避免 Workspace、Provider 和 Agent
  三套地址判断逻辑不一致；
- Renderer 不直接读取 Electron API，只依赖一个可选的全局类型声明。

这能让同一份 Studio 页面同时运行在浏览器和 Electron 中，桌面端不会为
了访问本地 Server 而复制一套业务 API。

## 8. 开发启动方式

保留现有浏览器启动命令：

```bash
pnpm dev
```

新增桌面开发命令：

```bash
pnpm desktop:dev
```

桌面开发模式启动 Studio Vite 和 Electron。Electron 自己启动 Server，
使用系统应用数据目录保存 SQLite。开发 URL 通过环境变量传入，默认使用
`http://127.0.0.1:5173`。

桌面命令退出时必须清理 Electron 启动的 Server。Server 进程不能因为窗口
关闭而遗留在后台。

## 9. 错误处理与安全边界

- Server 启动失败：主进程显示启动失败页面或系统错误提示，并退出；
- Server 关闭失败：记录错误，继续释放 BrowserWindow，避免 Electron 无法
  退出；
- Renderer 请求失败：沿用现有 HTTP/SSE 错误码，不把 Node 或 SQLite 原始
  错误返回给页面；
- Server 只绑定 `127.0.0.1`；
- API Key 只在 Server 环境变量和 Provider Registry 内部流转；
- Preload 不提供任意命令执行、文件读写或插件加载接口；
- 插件安装不属于本轮，不能借桌面壳提前绕过 Workspace、Approval 和
  Security 边界。

## 10. 测试策略

### Server

- 默认数据目录在 macOS、Windows 和 Linux 环境变量组合下解析正确；
- `WEAVE_DATABASE_FILE` 优先级高于 `WEAVE_DATA_DIR`；
- `startServer(0)` 返回实际监听端口；
- Server 停止后关闭 SQLite Store；
- 现有临时数据库持久化测试继续通过。

### Studio

- 浏览器模式仍请求相对路径；
- 桌面模式使用 Preload 提供的 Server URL；
- Workspace、Provider 和 Agent SSE 使用同一地址解析规则；
- 现有 Studio 测试不需要启动 Electron。

### Desktop

- 配置解析测试不依赖真实 Electron Window；
- 主进程启动失败时会停止已启动的 Server；
- 主进程关闭时调用 Server `stop()`；
- `pnpm desktop:dev` 能启动窗口并访问 Studio 页面；
- `pnpm check` 继续通过。

## 11. 本轮交付边界

本轮完成后，用户应该能执行：

```bash
pnpm desktop:dev
```

看到现有 Weave Studio 界面，并确认：

1. 页面运行在 Electron 窗口中；
2. Project 和 Session API 仍然正常；
3. SQLite 文件位于操作系统应用数据目录；
4. 关闭桌面窗口后本地 Server 不继续占用端口；
5. 浏览器启动方式和桌面启动方式可以并存；
6. 后续插件安装可以在 Electron 主进程和 Server 边界上继续设计。

本轮不以“可以生成安装包”为完成标准。安装包、签名、公证和自动更新
属于桌面端基础壳验证后的独立功能分支。
