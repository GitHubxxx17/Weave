# Task 3 完成报告：创建 Electron Desktop 包

## 状态

已完成。新增 `@weave/desktop` 严格 TypeScript/ESM Electron 包，主进程负责
启动和停止本地 Server，Renderer 通过安全 Preload Bridge 获取本地 Server
地址。没有实现后续任务的根级 `desktop:dev` 编排，也没有修改 README 或其他
后续文档。

## 实现内容

### Desktop 包

新增 `apps/desktop`：

- `package.json`
  - 使用 `"type": "module"`；
  - 提供 `dev`、`build`、`lint`、`typecheck` 和 `test` 脚本；
  - 依赖 `@weave/server: workspace:*`，消费 Task 1 的
    `@weave/server/main` 导出；
  - 只在 Desktop 包中加入 Electron 依赖；
  - 直接声明 `zod`，用于 Desktop 外部配置输入校验；
  - 直接声明 `@types/node`，用于 Electron 主进程的严格 Node 类型检查。
- `tsconfig.json`
  - 继承仓库严格 TypeScript 配置；
  - 输出 ESM JavaScript、声明文件和 source map；
  - 只包含 `src/**/*.ts`，测试由 Vitest/根配置执行。

### Desktop 配置

新增 `src/desktop-config.ts`：

- 导出 `DesktopConfig`；
- 导出 `createDesktopConfig({ userDataDirectory, environment })`；
- 通过 Zod 校验用户数据目录和 `WEAVE_STUDIO_URL`；
- 仅接受 HTTP 或 HTTPS 的 Studio URL；
- 未配置 `WEAVE_STUDIO_URL` 时使用
  `http://127.0.0.1:5173`；
- 将数据库文件固定解析为
  `<userDataDirectory>/weave.sqlite`；
- 对用户数据目录使用绝对路径解析，并检查数据库文件仍位于该目录内；
- 不读取或返回 API Key，也不把环境变量整体传给 Renderer。

### Electron 主进程

新增 `src/main.ts`：

- 在 `app.whenReady()` 后从 `app.getPath('userData')` 创建 Desktop 配置；
- 调用：

  ```ts
  startServer(0, { databaseFile: config.databaseFile })
  ```

- 使用 Server 返回的实际随机端口生成
  `http://127.0.0.1:<port>`；
- 创建 `BrowserWindow` 时启用：

  ```ts
  contextIsolation: true
  nodeIntegration: false
  preload: <dist>/preload.js
  ```

- 通过 Electron `additionalArguments` 将 Server 地址传给 Preload；
- 窗口加载 Studio 失败时加载可读的错误页面，并输出具体错误；
- Server 启动或 Electron 初始化失败时输出可读错误并退出；
- 窗口关闭或应用退出时幂等调用 `server.stop()`；
- Server 停止失败时仍记录错误并继续退出，避免留下无主的桌面进程。

### Preload Bridge

新增 `src/preload.ts`：

- 从受控的 Preload 参数读取 Server 地址；
- 仅通过 `contextBridge.exposeInMainWorld('weaveDesktop', ...)` 暴露：

  ```ts
  {
    isDesktop: true,
    serverUrl,
  }
  ```

- 没有暴露 `ipcRenderer`、`process`、`fs` 或任意命令执行接口；
- Studio 使用的字段与 Task 2 的
  `window.weaveDesktop?: { isDesktop: true; serverUrl: string }` 契约一致。

### 测试

新增 `apps/desktop/test/desktop-config.test.ts`，覆盖：

- 配置 Studio URL 时的数据库路径和 URL；
- 未配置 Studio URL 时的默认值；
- 相对用户数据目录解析为绝对路径；
- 数据库文件位于用户数据目录内；
- 非法 URL 和空目录被拒绝。

## TDD 证据

### RED

先加入配置测试，再运行：

```bash
pnpm exec vitest run --config vitest.config.ts apps/desktop/test/desktop-config.test.ts
```

结果：

```text
FAIL apps/desktop/test/desktop-config.test.ts
Error: Cannot find module '../src/desktop-config.js'
Tests no tests
```

失败原因符合预期：测试先于 `desktop-config.ts` 实现，Vitest 已正确发现测试
文件，但生产模块尚不存在。

### GREEN

实现包和配置后运行：

```bash
pnpm --filter @weave/desktop test
```

结果：

```text
Test Files  1 passed (1)
Tests       4 passed (4)
```

## 依赖和边界判断

- Electron 只加入 `apps/desktop/package.json`，原因是它只属于桌面主进程和
  Preload 运行时，不能进入 Runtime、Server 或 Studio 的公共边界。
- `@weave/server` 通过现有 workspace 包名导入，没有使用跨包相对路径。
- `pnpm-workspace.yaml` 已经使用 `apps/*` 发现规则，因此新 Desktop 包无需
  修改 workspace 配置。
- `apps/server/package.json` 已经包含 `./main` exports，Task 1 已公开
  `startServer` 和 `StartServerOptions`，因此本任务无需重复修改 Server
  manifest。
- 没有加入根级 `desktop:dev` 命令；该编排属于 Task 4。
- 没有修改 README 或其他后续文档。

## 文件

新增：

- `apps/desktop/package.json`
- `apps/desktop/tsconfig.json`
- `apps/desktop/src/desktop-config.ts`
- `apps/desktop/src/main.ts`
- `apps/desktop/src/preload.ts`
- `apps/desktop/test/desktop-config.test.ts`
- `.superpowers/sdd/2026-11-16-desktop-shell/task-3-report.md`

修改：

- `pnpm-lock.yaml`

未修改：

- `pnpm-workspace.yaml`
- `apps/server/package.json`

已有的未跟踪 `apps/server/.weave/` 数据目录保持原样，未加入暂存区。

## 验证结果

Desktop 包验证：

```bash
pnpm --filter @weave/desktop test
```

通过：1 个测试文件，4 个测试。

```bash
pnpm --filter @weave/desktop lint
pnpm --filter @weave/desktop typecheck
pnpm --filter @weave/desktop build
```

三项均通过。Build 生成了主进程、Preload 的 ESM 输出及声明文件。

额外检查：

```bash
git diff --check
```

通过，无空白错误。

仓库级完整验证：

```bash
pnpm check
```

通过。根级格式检查通过，9 个包的 lint 任务通过，16 个依赖排序后的
typecheck 任务通过，9 个 build 任务通过，测试任务全部通过。包含 Desktop
在内的最终测试任务中，Desktop 配置测试为 4/4，Server 测试为 38 个测试
文件、372 个测试。Node 在 SQLite 测试中输出了已有的实验性 API 警告，Vite
构建输出了依赖注释位置提示，均未导致命令失败。

依赖安装时 pnpm 报告 Electron 的安装脚本处于当前 pnpm 的 build-script
审批机制下；TypeScript、Vitest、lint 和 Desktop build 均不依赖该脚本执行。

## 提交

计划创建本地提交：

```text
feat: 增加 Electron 桌面端基础壳
```

不推送，不创建 Pull Request，不启动子代理。
