# Weave Desktop Shell Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 创建一个 macOS 优先的 Electron Desktop 基础壳，由主进程管理本地 Weave Server，并把 SQLite 默认位置迁移到操作系统应用数据目录。

**Architecture:** Desktop 作为新的组合根，直接依赖 `@weave/server` 的 `startServer()`，通过 `contextBridge` 向 Studio Renderer 暴露本地 Server 地址。Studio 的 Workspace、Provider 和 Agent SSE 客户端统一使用可选的 API 基础地址，浏览器模式继续使用相对路径，桌面模式使用 Preload 提供的 `http://127.0.0.1:<port>`。Server 允许端口 `0` 并返回实际端口，同时通过环境变量和操作系统规则解析默认 SQLite 路径。

**Tech Stack:** TypeScript、ESM、Electron、React、Vite、Hono Server、Node.js `node:sqlite`、Vitest、pnpm、Zod。

**Spec:** `docs/superpowers/specs/2026-11-16-desktop-shell-design.md`

## Global Constraints

- 保持 `protocol -> llm -> runtime -> server` 依赖方向；`desktop` 只能作为组合根依赖 `@weave/server`。
- `@weave/runtime` 不得依赖 Electron、React、Hono 或 Node HTTP Server。
- 所有外部输入继续使用 Zod 校验，包括端口、数据目录、数据库路径和桌面环境变量。
- Server 只绑定 `127.0.0.1`，Preload 使用 `contextIsolation: true` 和 `nodeIntegration: false`。
- Renderer 不得直接访问 SQLite、Node.js 模块、任意文件系统 API 或 API Key。
- 默认 SQLite 不得写入 `apps/server/.weave/`；旧目录不自动删除、不自动迁移。
- 新依赖必须写明原因；Electron 只加入 `apps/desktop`，不加入 Runtime 或 Studio。
- 测试放在对应包的 `test/` 目录，不放入 `src/`。
- 每个任务完成后运行该任务列出的最小验证；最终运行根级 `pnpm check`。
- 提交信息使用中文 Conventional Commits，例如 `feat: 增加桌面端基础壳`、`fix: 修复默认数据目录`。

---

### Task 1: Server 默认数据目录与随机端口

**Files:**

- Create: `apps/server/src/persistence-path.ts`
- Create: `apps/server/test/persistence-path.test.ts`
- Modify: `apps/server/src/main.ts`
- Modify: `apps/server/test/health.test.ts`
- Modify: `apps/server/package.json`

**Interfaces:**

- `resolveDefaultDataDirectory(environment: NodeJS.ProcessEnv, platform?: NodeJS.Platform, homeDirectory?: string): string`
- `resolveDatabaseFile(options: { databaseFile?: string; dataDirectory?: string; environment?: NodeJS.ProcessEnv; platform?: NodeJS.Platform; homeDirectory?: string }): string`
- `startServer(0, options).port: number` 返回实际监听端口。
- `@weave/server/main` 导出 `startServer` 和 `StartServerOptions`，供 Desktop 组合根调用。

- [ ] **Step 1: 写默认路径和优先级测试**

在 `apps/server/test/persistence-path.test.ts` 中覆盖以下行为：

```ts
expect(
  resolveDefaultDataDirectory(
    { HOME: '/Users/tester' },
    'darwin',
    '/Users/tester',
  ),
).toBe('/Users/tester/Library/Application Support/Weave');

expect(
  resolveDefaultDataDirectory(
    { APPDATA: 'C:\\Users\\tester\\AppData\\Roaming' },
    'win32',
    'C:\\Users\\tester',
  ),
).toBe('C:\\Users\\tester\\AppData\\Roaming/Weave');

expect(
  resolveDefaultDataDirectory(
    { XDG_DATA_HOME: '/tmp/data', HOME: '/home/tester' },
    'linux',
    '/home/tester',
  ),
).toBe('/tmp/data/weave');

expect(
  resolveDatabaseFile({
    databaseFile: '/tmp/custom.sqlite',
    dataDirectory: '/tmp/ignored',
    environment: { WEAVE_DATABASE_FILE: '/tmp/env.sqlite' },
    platform: 'darwin',
    homeDirectory: '/Users/tester',
  }),
).toBe('/tmp/custom.sqlite');
```

同时验证 `WEAVE_DATABASE_FILE` 优先于 `WEAVE_DATA_DIR`，`WEAVE_DATA_DIR`
优先于操作系统默认目录，缺少 Home 目录时抛出稳定错误。

- [ ] **Step 2: 运行路径测试确认失败**

运行：

```bash
pnpm --filter @weave/server test -- persistence-path.test.ts
```

预期：FAIL，因为路径解析模块尚未创建。

- [ ] **Step 3: 实现路径解析模块**

在 `persistence-path.ts` 中：

1. 使用 `node:path.join` 组合目录；
2. macOS 使用 `<HOME>/Library/Application Support/Weave`；
3. Windows 优先使用 `APPDATA`，否则使用 `<HOME>/AppData/Roaming/Weave`；
4. Linux 优先使用 `XDG_DATA_HOME/weave`，否则使用
   `<HOME>/.local/share/weave`；
5. `WEAVE_DATABASE_FILE` 作为完整文件路径；
6. `WEAVE_DATA_DIR` 作为目录并拼接 `weave.sqlite`；
7. 所有结果通过 Zod 校验为非空字符串。

- [ ] **Step 4: 修改 `startServer()` 使用解析后的路径**

将 `persistenceOptionsSchema` 的 `.default('.weave')` 改为由
`resolveDatabaseFile()` 统一解析。保留显式的 `databaseFile` 和
`dataDirectory` 选项，测试传入临时数据库时不读取真实用户目录。

把端口 Schema 改为允许 `0`：

```ts
const portSchema = z.coerce.number().int().min(0).max(65535);
```

监听完成后从 `createdServer.address()` 读取实际端口，并让返回对象的
`port` 使用实际值。端口输入为 `0` 时，不能返回字面量 `0`。

- [ ] **Step 5: 添加端口 0 和默认路径集成测试**

在 `health.test.ts` 增加：

```ts
const result = await startServer(0, {
  databaseFile: database.filename,
});

expect(result.port).toBeGreaterThan(0);
expect(result.server.listening).toBe(true);
await result.stop();
```

使用 `environment: { WEAVE_DATA_DIR: temporaryDirectory }` 的测试验证
环境变量只在未传入显式数据库路径时生效，并在测试结束清理临时目录。

- [ ] **Step 6: 导出 Server 主入口**

在 `apps/server/package.json` 增加：

```json
"./main": {
  "types": "./dist/main.d.ts",
  "import": "./dist/main.js"
}
```

保持现有 `"."` 和 `"./runtime"` 导出不变。

- [ ] **Step 7: 运行 Server 测试和类型检查**

运行：

```bash
pnpm --filter @weave/server test
pnpm --filter @weave/server typecheck
pnpm --filter @weave/server build
```

预期：全部通过，且默认启动不再在 `apps/server/.weave/` 创建数据库。

- [ ] **Step 8: 提交**

```bash
git add apps/server/src/persistence-path.ts apps/server/src/main.ts \
  apps/server/test/persistence-path.test.ts apps/server/test/health.test.ts \
  apps/server/package.json
git commit -m "feat: 支持应用数据目录与随机端口"
```

### Task 2: Studio 统一 API 基础地址

**Files:**

- Create: `apps/studio/src/features/runtime/runtime-bridge.ts`
- Create: `apps/studio/src/features/runtime/runtime-bridge.test.ts`
- Modify: `apps/studio/src/features/workspace/workspace-api.ts`
- Modify: `apps/studio/src/features/providers/provider-api.ts`
- Modify: `apps/studio/src/features/agent/agent-stream.ts`
- Modify: `apps/studio/src/vite-env.d.ts`
- Modify: `apps/studio/test/workspace-api.test.ts`
- Modify: `apps/studio/test/provider-api.test.ts`
- Modify: `apps/studio/test/agent-stream.test.ts`

**Interfaces:**

- `getRuntimeServerUrl(): string`
- `runtimeApiUrl(path: string): string`
- `window.weaveDesktop?: { readonly isDesktop: true; readonly serverUrl: string }`

- [ ] **Step 1: 写浏览器和桌面地址解析测试**

测试浏览器模式返回相对路径：

```ts
expect(runtimeApiUrl('/projects')).toBe('/projects');
```

测试桌面模式返回绝对本地地址：

```ts
window.weaveDesktop = {
  isDesktop: true,
  serverUrl: 'http://127.0.0.1:46321',
};

expect(runtimeApiUrl('/projects')).toBe('http://127.0.0.1:46321/projects');
```

测试路径带查询字符串、重复斜杠和空 Server 地址时不会生成非法 URL。

- [ ] **Step 2: 运行测试确认失败**

运行：

```bash
pnpm --filter @weave/studio test -- runtime-bridge.test.ts
```

预期：FAIL，因为统一地址模块尚未创建。

- [ ] **Step 3: 实现 Runtime Bridge 类型和 URL 辅助函数**

使用 `globalThis.window` 安全读取可选的 `weaveDesktop`。浏览器环境和
JSDOM 测试中不存在该对象时，返回空字符串。绝对 Server URL 去掉末尾
斜杠，再与传入路径拼接。

- [ ] **Step 4: 修改三个 API 客户端**

将以下请求从相对路径改为 `runtimeApiUrl(path)`：

- `workspace-api.ts` 的 Project、Session 请求；
- `provider-api.ts` 的 Provider 请求；
- `agent-stream.ts` 的 POST SSE 请求。

不改变请求方法、请求体、Zod 响应校验、错误码或 SSE 解析逻辑。

- [ ] **Step 5: 补充 API 客户端回归测试**

在已有 Mock Fetch 测试中分别设置和清除 `window.weaveDesktop`，验证：

- 浏览器模式仍请求 `/projects`、`/settings/providers` 和
  `/agent/runs/stream`；
- 桌面模式请求带 `http://127.0.0.1:<port>` 的同一路径；
- 请求结束后测试环境清理全局 Bridge，避免测试之间相互污染。

- [ ] **Step 6: 运行 Studio 测试、Lint 和类型检查**

运行：

```bash
pnpm --filter @weave/studio test
pnpm --filter @weave/studio lint
pnpm --filter @weave/studio typecheck
```

- [ ] **Step 7: 提交**

```bash
git add apps/studio/src/features/runtime \
  apps/studio/src/features/workspace/workspace-api.ts \
  apps/studio/src/features/providers/provider-api.ts \
  apps/studio/src/features/agent/agent-stream.ts \
  apps/studio/src/vite-env.d.ts \
  apps/studio/test
git commit -m "feat: 适配桌面端本地 Server 地址"
```

### Task 3: 创建 Electron Desktop 包

**Files:**

- Create: `apps/desktop/package.json`
- Create: `apps/desktop/tsconfig.json`
- Create: `apps/desktop/src/desktop-config.ts`
- Create: `apps/desktop/src/main.ts`
- Create: `apps/desktop/src/preload.ts`
- Create: `apps/desktop/test/desktop-config.test.ts`
- Modify: `pnpm-workspace.yaml`
- Modify: `apps/server/package.json`

**Interfaces:**

- `DesktopConfig`
- `createDesktopConfig(input: { userDataDirectory: string; environment?: NodeJS.ProcessEnv }): DesktopConfig`
- `createMainWindow(config: DesktopConfig, serverUrl: string): BrowserWindow`
- `startDesktopServer(config: DesktopConfig): Promise<{ port: number; stop: () => Promise<void> }>`

- [ ] **Step 1: 写 Desktop 配置测试**

验证：

```ts
const config = createDesktopConfig({
  userDataDirectory: '/Users/tester/Library/Application Support/Weave',
  environment: {
    WEAVE_STUDIO_URL: 'http://127.0.0.1:5173',
  },
});

expect(config.databaseFile).toBe(
  '/Users/tester/Library/Application Support/Weave/weave.sqlite',
);
expect(config.studioUrl).toBe('http://127.0.0.1:5173');
```

同时验证没有 `WEAVE_STUDIO_URL` 时使用
`http://127.0.0.1:5173`，以及路径始终位于传入的用户数据目录内。

- [ ] **Step 2: 运行测试确认失败**

运行：

```bash
pnpm --filter @weave/desktop test
```

预期：FAIL，因为 Desktop 包尚未创建。

- [ ] **Step 3: 创建严格 TypeScript Electron 包**

`apps/desktop/package.json` 使用 `type: module`，脚本包括：

```json
{
  "dev": "pnpm build && electron dist/main.js",
  "build": "tsc -p tsconfig.json",
  "lint": "eslint src test",
  "typecheck": "tsc -p tsconfig.json --noEmit",
  "test": "vitest run --root ../.. --config vitest.config.ts apps/desktop/test"
}
```

依赖：

- `@weave/server: workspace:*`：复用 Server 组合根；
- `electron`：只提供桌面主进程运行时和类型；
- `zod`：校验桌面环境变量。

在 `pnpm-workspace.yaml` 保持现有 `apps/*` 发现规则能够包含新包。

- [ ] **Step 4: 实现 Desktop 配置和 Server 启动**

`desktop-config.ts` 负责：

1. 读取 Electron `userDataDirectory`；
2. 解析 `WEAVE_STUDIO_URL`；
3. 生成 `<userDataDirectory>/weave.sqlite`；
4. 使用 Zod 校验 URL 和路径；
5. 不读取 API Key。

`main.ts` 在 `app.whenReady()` 后调用：

```ts
const server = await startServer(0, {
  databaseFile: config.databaseFile,
});
```

然后把 `http://127.0.0.1:${server.port}` 传给窗口 Preload。所有窗口关闭
后调用 `server.stop()`，避免 Server 遗留。

- [ ] **Step 5: 实现安全的 Preload**

`preload.ts` 使用 `contextBridge.exposeInMainWorld('weaveDesktop', ...)`
暴露：

```ts
{
  isDesktop: true,
  serverUrl,
}
```

不暴露 `ipcRenderer`、`process`、`fs` 或任意可执行命令接口。

`main.ts` 创建 BrowserWindow 时设置：

```ts
webPreferences: {
  contextIsolation: true,
  nodeIntegration: false,
  preload: preloadPath,
}
```

- [ ] **Step 6: 实现窗口加载和启动错误处理**

开发模式从 `WEAVE_STUDIO_URL` 加载 Studio。窗口加载失败时显示可读错误
页面或使用 `loadURL` 重试，不能静默显示空白窗口。Server 启动失败时先
调用已创建资源的清理逻辑，再退出应用。

- [ ] **Step 7: 运行 Desktop 测试和构建**

运行：

```bash
pnpm --filter @weave/desktop test
pnpm --filter @weave/desktop lint
pnpm --filter @weave/desktop typecheck
pnpm --filter @weave/desktop build
```

预期：配置测试通过，Electron 主进程和 Preload 都能生成 ESM 输出。

- [ ] **Step 8: 提交**

```bash
git add apps/desktop pnpm-workspace.yaml apps/server/package.json
git commit -m "feat: 增加 Electron 桌面端基础壳"
```

### Task 4: 一键启动桌面开发模式

**Files:**

- Modify: `package.json`
- Modify: `apps/desktop/package.json`
- Create: `apps/desktop/src/dev.ts` 或调整现有 Desktop 启动脚本
- Create: `apps/desktop/test/dev-config.test.ts`（仅在引入可测试配置时创建）
- Modify: `README.md`

**Interfaces:**

- Root command: `pnpm desktop:dev`
- Studio URL: `WEAVE_STUDIO_URL`, default `http://127.0.0.1:5173`
- Desktop Server data path: Electron `app.getPath('userData')`

- [ ] **Step 1: 写启动命令文档和最小可测试配置**

先在 README 中记录预期命令和行为，明确：

```bash
pnpm desktop:dev
```

会启动 Studio Vite 和 Electron，Server 由 Electron 主进程启动。

- [ ] **Step 2: 实现根级启动命令**

使用现有 pnpm workspace 能力并行启动 `@weave/studio` 和
`@weave/desktop`，不再额外启动 `@weave/server`。Desktop 主进程启动的
Server 使用随机端口和应用数据目录。

如果需要等待 Studio Vite，使用一个小的 Node 启动器轮询
`WEAVE_STUDIO_URL`，最多等待 30 秒；失败时输出具体 URL 和下一步检查命令。
不得使用无限重试。

- [ ] **Step 3: 运行一键启动**

运行：

```bash
pnpm desktop:dev
```

人工确认 Electron 窗口打开，Studio 项目树和会话加载正常；关闭窗口后
确认 Server 端口不再监听。不要把用户的现有 `4317` 或 `5173` 进程强制
终止，验证使用独立实例或由本命令启动的进程。

- [ ] **Step 4: 更新启动文档**

在 README 中说明：

- `pnpm dev`：浏览器开发模式，Server 使用系统默认数据目录；
- `pnpm desktop:dev`：Electron 开发模式，Server 使用 Electron 的
  `userData` 目录；
- `WEAVE_DATA_DIR` 和 `WEAVE_DATABASE_FILE` 的覆盖关系；
- 旧的 `apps/server/.weave/` 不会自动删除和迁移。

- [ ] **Step 5: 提交**

```bash
git add package.json apps/desktop/package.json apps/desktop/src apps/desktop/test README.md
git commit -m "chore: 增加桌面端一键启动命令"
```

### Task 5: 学习文档和架构文档同步

**Files:**

- Create: `docs/learning/2026-11-16-desktop-shell.md`
- Modify: `docs/architecture/foundation.md`
- Modify: `docs/superpowers/specs/2026-11-16-desktop-shell-design.md`
- Modify: `README.md`

**Interfaces:**

- 学习文档必须解释 Electron Main、Preload、Renderer、Server、SQLite
  的职责；
- 文档必须包含一张 Mermaid 数据流图；
- 文档必须解释为什么 API Key 不经过 Renderer；
- 文档必须解释为什么 SQLite 不放在 `apps/server`；
- 文档必须给出浏览器和桌面两种启动命令。

- [ ] **Step 1: 写学习文档**

内容按“现象、问题、方案、代码边界、请求链路、关闭流程、测试方式”
组织，不复制完整源码。用一个完整请求说明：

```text
用户发送消息
  -> Studio Renderer
  -> 本地 Server HTTP/SSE
  -> Runtime
  -> Provider
  -> SSE 返回 Studio
  -> Session Event Store 写入 SQLite
```

- [ ] **Step 2: 更新架构文档**

在 `foundation.md` 中补充：

- Desktop 是组合根；
- Server 数据目录解析优先级；
- Preload 的最小桥接边界；
- 浏览器和桌面 Renderer 共用 API Client；
- 旧 `.weave` 不自动迁移。

- [ ] **Step 3: 运行文档格式和链接检查**

运行：

```bash
pnpm exec prettier --check \
  docs/learning/2026-11-16-desktop-shell.md \
  docs/architecture/foundation.md \
  docs/superpowers/specs/2026-11-16-desktop-shell-design.md \
  README.md
git diff --check
```

- [ ] **Step 4: 提交**

```bash
git add docs/learning/2026-11-16-desktop-shell.md \
  docs/architecture/foundation.md \
  docs/superpowers/specs/2026-11-16-desktop-shell-design.md \
  README.md
git commit -m "docs: 补充桌面端与本地数据目录说明"
```

### Task 6: 全量验证和交付

**Files:**

- Verify: all files changed by Tasks 1-5
- Verify: `apps/server/.weave/` remains untracked and is not staged

**Interfaces:**

- `pnpm format:check`
- `pnpm lint`
- `pnpm typecheck`
- `pnpm test`
- `pnpm build`
- `pnpm check`
- `pnpm desktop:dev`

- [ ] **Step 1: 检查暂存和未跟踪文件**

运行：

```bash
git status --short --branch
git diff --cached --check
git diff --check
```

确认所有源码、测试和文档属于当前 Desktop 主题，`apps/server/.weave/`
不在暂存区。

- [ ] **Step 2: 运行根级验证**

运行：

```bash
pnpm check
```

预期：格式、Lint、类型检查、全部测试和构建都通过。

- [ ] **Step 3: 手动验证桌面生命周期**

运行：

```bash
pnpm desktop:dev
```

验证：

1. Electron 窗口打开；
2. Studio 能加载 Project 和 Session；
3. 发送一条消息后，SSE 和真实模型流程仍正常；
4. `weave.sqlite` 出现在系统应用数据目录；
5. 关闭窗口后 Server 停止；
6. 浏览器模式仍可单独运行。

- [ ] **Step 4: 检查最终 diff**

运行：

```bash
git diff origin/main...HEAD --stat
git diff origin/main...HEAD --check
git status --short --branch
```

确认没有提交 API Key、SQLite 数据库、构建产物或 `.playwright-cli/`
临时文件。

- [ ] **Step 5: 创建提交和 PR**

如果前面任务已经按小步提交，本步骤只检查提交历史，不重写已有提交：

```bash
git log --oneline origin/main..HEAD
git push -u origin HEAD:refs/heads/feat/desktop-shell
gh pr create --base main --head feat/desktop-shell
```

PR 描述包含桌面端边界、SQLite 路径变化、测试结果和已知限制。CI 通过后
使用仓库配置的 squash 自动合并，保留功能分支，不直接推送 `main`。
