# Studio 设置页设计：分类切换与数据存储（只读）

状态：已实现于 `feat/studio-settings-storage`（2026-11-27）。

## 评审结论（2026-11-27）

用户已拍板：

1. 设置页四个分类（模型服务、运行权限、数据存储、界面外观）最终都要做。第一期只做"分类切换框架 + 搜索筛选 + 数据存储"；运行权限和界面外观保持禁用的"即将推出"，由后续 PR 完成。
2. 数据存储第一版只读：只查看，不做清理、删除、迁移。
3. 存储接口只允许本机访问。Server 用 `--host` 开放到局域网时，来自非回环地址的请求一律拒绝，即使带了正确的访问令牌，因为响应包含本机绝对路径。

## 1. 总体规划与分期

| 分类     | 分组 | 状态                       |
| -------- | ---- | -------------------------- |
| 模型服务 | 配置 | 已有，本 PR 接入分类切换   |
| 运行权限 | 配置 | 已实现（见 4.3）           |
| 数据存储 | 系统 | 本 PR，只读                |
| 界面外观 | 系统 | 后续 PR（含主题），本期禁用 |

分类标识：`providers`、`permissions`、`storage`、`appearance`。侧栏每个分类带名称和关键词；"搜索设置"输入框按名称与关键词（不区分大小写，子串匹配）筛选侧栏分类。数据存储的关键词包含：存储、目录、路径、数据库、插件、技能、记忆、占用、大小、文件夹。

不做：清理或删除数据、修改存储位置、迁移、运行权限页、界面外观页、主题。

## 2. Server：`GET /settings/storage`

实现在 `apps/server/src/storage-api.ts`，由 `app.ts` 注册，handler 只做本机校验、测量和 Zod 校验。

### 2.1 请求

`GET /settings/storage`，无参数。现有访问令牌与 `registerLocalRequestGuard` 照常先生效。

### 2.2 返回的位置

位置列表由 `startServer` 用与实际打开存储相同的已解析输入生成（`createStorageConfig`），只列代码中真实存在的位置：

| `id`                      | `kind`      | 路径来源                                                                                  | 说明                                              |
| ------------------------- | ----------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------- |
| `database`                | `file`      | `resolveDatabaseFile`                                                                     | 会话、项目、Provider 设置、MCP 授权、插件授权与信任、Hook 确认共用的主 SQLite |
| `memory`                  | `file`      | `resolveMemoryDatabaseFile`（`<database>.memory.sqlite`）                                  | 记忆                                              |
| `retrieval`               | `file`      | `resolveRetrievalDatabaseFile`（`<database>.retrieval.sqlite`）                            | 检索索引                                          |
| `pluginMarketplaceSources`| `file`      | `<database>.plugin-marketplace-sources.json`                                              | 插件市场来源设置                                  |
| `plugins`                 | `directory` | `resolvePluginsDirectory`（含 `.weave-store` 托管插件库）                                  | `pluginsDirectory: false` 时不返回                |
| `skills`                  | `directory` | `resolveSkillsDirectory`                                                                  | `skillsDirectory: false` 时不返回                 |

`dataDirectory` 取主数据库所在目录（Desktop 即 `userDataDirectory`）。

被关闭的位置（`pluginsDirectory: false`、`skillsDirectory: false`）**不返回**，而不是返回"未启用"标记，原因：Studio 无需区分"关闭"和"不存在"，少一个状态。

### 2.3 响应

```json
{
  "dataDirectory": "/Users/me/Library/Application Support/Weave",
  "locations": [
    {
      "id": "database",
      "kind": "file",
      "path": "/Users/me/Library/Application Support/Weave/weave.sqlite",
      "exists": true,
      "sizeBytes": 13002342,
      "truncated": false
    }
  ]
}
```

字段：

- `id`：稳定标识，Studio 用它映射显示名称。
- `kind`：`file` 或 `directory`。
- `path`：绝对路径。
- `exists`：位置是否存在。
- `sizeBytes`：字节数；不存在或出错时为 `null`。
- `truncated`：目录统计到条目上限后停止时为 `true`，此时 `sizeBytes` 是下限。
- `error`（可选）：`permission-denied`、`read-failed` 或 `kind-mismatch`（实际类型与 `kind` 不符）。出错的位置 `sizeBytes` 为 `null`，不影响其他位置，也不让请求失败。

响应经 `storageResponseSchema`（`z.strictObject`）校验后返回，带 `Cache-Control: no-store`。

### 2.4 大小统计

- SQLite 文件把 `-journal`、`-wal`、`-shm` 计入大小。
- 目录递归统计，用 `lstat`，不跟随符号链接（链接本身按其自身大小计，不进入目标）。
- 条目上限 200000（`defaultStorageEntryLimit`）：达到后停止，返回已统计的值并带 `truncated: true`。
- 统计过程中文件消失（`ENOENT`）忽略；其他错误使该位置返回 `error`。目录大小是文件内容字节数之和（`st_size`），不含目录项自身与文件系统块对齐开销，与"占用磁盘"可能有差异。

### 2.5 错误码

| 状态 | `error.code`          | 条件                                                  |
| ---- | --------------------- | ----------------------------------------------------- |
| 403  | `storage-local-only`  | 对端地址不是回环地址，或无法取得对端地址             |
| 503  | `storage-unavailable` | 组合根没有提供存储配置（嵌入或测试）                 |

两者响应都带 `Cache-Control: no-store`。

### 2.6 只允许本机

判断方式：用 `@hono/node-server/conninfo` 的 `getConnInfo` 读取 TCP 对端地址（`remoteAddress`），放行 `127.0.0.0/8`、`::1`（含 `0:0:0:0:0:0:0:1`）和 IPv4 映射回环（`::ffff:127.x.x.x`，含十六进制写法 `::ffff:7f00:1`）。其他地址、读取失败（例如 `app.request()` 内存调用没有连接信息）一律拒绝。解析函数可通过 `storageRemoteAddress` 注入，供测试使用。

原因：响应含本机绝对路径（用户名、目录布局）。`--host` 把 Server 开放到局域网后，持有访问令牌的远端设备也不应看到这些信息，令牌只证明"被授权使用 Studio"，不证明"在这台电脑上"。

已知限制：若用户在本机前面放了反向代理，对端地址会是代理的回环地址而被放行。Weave 不支持也不记录这种部署，不为此信任 `X-Forwarded-For`（可伪造）。

## 3. Desktop：打开数据目录

- 通道：`weave:open-data-directory`（`openDataDirectoryChannel`）。
- 参数：无。Renderer 传入任何参数都被拒绝（`{ ok: false }`，不打开任何位置）。
- 返回：`{ ok: true }` 或 `{ ok: false, error: string }`。
- 行为：主进程在 `isTrustedSender(event, studioOrigin)` 通过后，对启动时配置的 `config.userDataDirectory` 调用 `shell.openPath`。`openPath` 返回非空字符串（系统错误信息）或抛出时，返回 `{ ok: false, error }`。
- 安全约束：路径只来自主进程配置，不接受渲染进程路径；发送方必须是受信任的 Studio 来源（与 `pickDirectory`、终端通道相同）。
- Preload 暴露 `openDataDirectory(): Promise<{ ok: boolean; error?: string }>`，Studio 的 `window.weaveDesktop` 类型同步声明为可选。

## 4. Studio

### 4.1 分类状态

`App.tsx` 持有 `settingsCategory`（默认 `providers`），传给 `SettingsSidebar`（受控：`activeCategory`、`onSelectCategory`）。当前分类按钮带 `aria-current="page"`。`providers`、`permissions`、`storage` 与 `appearance` 均可用。搜索词是侧栏内部状态；筛选只影响侧栏列表，不改变当前内容页。无匹配时显示"没有匹配的设置"。

数据存储页放在 `apps/studio/src/app/storage-settings-view.tsx`，请求封装在 `features/settings/storage-api.ts`（手写 Zod schema 镜像响应，Studio 不导入 `@weave/*`）。样式只使用 `app.css` `:root` 已有的 CSS 变量，不写新的颜色字面量。

### 4.2 页面状态与降级

- 加载中：显示"正在读取存储位置…"。
- 成功：顶部显示数据目录；每个位置显示名称、可选中复制的路径、大小（`12.4 MB`，二进制单位保留一位小数）。`truncated` 时在大小前标"至少"；`exists: false` 显示"尚未创建"；`error` 显示对应中文原因。
- 403 `storage-local-only`：显示"出于安全考虑，存储位置只能在运行 Weave 的这台电脑上查看"。
- 其他失败（网络、5xx、响应格式不符）：显示错误信息；"刷新"按钮可重新读取。
- 有 Desktop 桥（`window.weaveDesktop?.openDataDirectory` 存在）时显示"打开数据目录"；失败时显示错误信息。浏览器模式不显示该按钮，页面其余功能不变。

### 4.3 运行权限（`permissions`，已实现于 `feat/studio-settings-permissions`）

视图在 `apps/studio/src/app/permission-settings-view.tsx`，`App.tsx` 仅按 `settingsCategory === 'permissions'` 渲染。分类关键词：权限、审批、命令、信任、默认、模式、完全访问、敏感、密钥、白名单。

**新会话默认模式**

- 页面提供"常规"和"信任"两个选项；"完全访问"不能设为默认，页面用一句话说明原因：避免新会话在用户不知情时跳过所有确认。
- 存储：`localStorage` 键 `weave.studio.defaultPermissionMode.v1`，读取用 Zod（`defaultPermissionModeSchema = z.enum(['ask','trust'])`）校验；缺失、非法值、`yolo` 一律回退 `ask`。
- 生效规则（`composer-preferences.ts`）：会话自己记过模式（`weave.studio.permissionMode.v1:<sessionId>`，发送消息时写入）就用会话的；没记过的会话，包括新会话和还没有会话时的草稿，用默认值。已记过模式的会话不受修改默认值影响。
- 这改写了原约束"权限模式永不全局"：原意是新会话不会继承 `yolo`，现在由"默认值只能是 `ask`/`trust`"保证。`yolo` 仍然只能在每个会话里手动选。
- 不做：服务端保存默认模式、修改 runtime 审批规则。

**模式说明（静态文案，以 runtime 代码为准）**

| 模式 | 直接执行 | 需要确认 |
| ---- | -------- | -------- |
| 常规 | 读取、搜索普通文件 | 写入/修改文件、运行命令、读取 `.env`/`.env.*` |
| 信任 | 项目内普通文件读写；白名单命令；模型声明低风险的其他命令 | 危险命令名单；非白名单命令且声明高风险或未声明；读取密钥文件；写入敏感文件（含经绝对路径或符号链接落到敏感文件） |
| 完全访问 | 全部 | 无（工作区策略强制要求的确认除外） |

与最初设想的差异：信任模式下，不在白名单的命令只有"模型声明低风险"才直接执行，声明高风险或没声明风险都要确认；白名单命令若带管道、重定向、命令串联或指向项目外的参数，同样退回到按模型声明风险判断；敏感文件判断按实际落点，经绝对路径或符号链接写入也会命中（`asksInTrust`）。项目目录以外的写入由工作区策略直接拒绝，不属于确认范围。依据：`approval-risk.ts` 的 `commandAskReason`、`isAllowListedCommand`，`workspace-file-tools.ts` 的 `readsSecretFile`、`writesSensitiveFile`。

**敏感写入路径类别**：Git 内部与钩子、CI 配置、包管理与构建脚本、自动执行的环境与编辑器配置、密钥文件。

> 同步约定：Studio 不能导入 `@weave/*`，这些文案是静态的。修改 `packages/runtime/src/sensitive-paths.ts`、`approval-risk.ts`（白名单、危险命令名单）时，要同步更新 `permission-settings-view.tsx`。`sensitive-paths.ts` 顶部注释已指向该文件。

样式只用 `app.css` `:root` 变量。

### 4.4 界面外观

`appearance` 页（`apps/studio/src/app/appearance-settings-view.tsx`）提供"跟随系统 / 浅色 / 深色"三选一，用 `role="radiogroup"` 加三个 `role="radio"` 的卡片按钮，选中项 `aria-checked="true"`。每张卡片带一个小预览块（跟随系统为左浅右深的拼合块），预览块颜色来自 `--theme-preview-*` 变量，两套主题下取值相同，因此"浅色"卡片在深色界面里仍显示浅色。选中立即生效。

偏好逻辑在 `features/settings/theme.ts`：

- 存储：`localStorage['weave.studio.theme.v1']`，取值 `system | light | dark`，Zod 校验，缺失或非法值回退 `system`。
- 应用：解析结果写到 `<html data-theme>` 与 `style.colorScheme`；配色见 `2026-11-27-studio-color-tokens-design.md`。
- `startThemeSync(root)` 在 `main.tsx` 渲染 React 之前同步调用（与 `applyWindowChrome` 同位置），避免首屏闪烁；同时监听 `matchMedia('(prefers-color-scheme: dark)')`（仅偏好为"跟随系统"时生效）与 `storage` 事件（多窗口同步），返回的函数移除全部监听。
- 设置页通过 `subscribeThemePreference` 在其他窗口修改后更新选中项。
- Desktop 同步：存在 `window.weaveDesktop?.setTheme` 时，`startThemeSync` 初次应用、`setThemePreference`、`storage` 事件同步三处都调用它，传入**偏好**（`system | light | dark`）而不是解析结果；浏览器模式没有该桥，行为不变。Desktop 据此设置 `nativeTheme.themeSource` 并更新窗口底色，契约见 `2026-11-24-desktop-studio-distribution-design.md`。

不做：Desktop 窗口 `backgroundColor`（`apps/desktop/src/main.ts` 写死 `#f7f8fc`）与 `nativeTheme` 同步。深色下启动瞬间窗口可能先闪浅色，记为后续项。字体、字号、密度等其他外观选项也不在本期。

## 5. 测试

- Server（`apps/server/test/storage-api.test.ts`）：用临时数据目录核对字段、SQLite 附属文件计入、不存在的位置、符号链接不跟随、条目上限触发 `truncated`、位置级错误不使请求失败；回环 IPv4、IPv6、IPv4 映射放行，非回环和无法取得地址返回 403。
- Desktop（`apps/desktop/test/main.test.ts`）：发送方校验、只打开配置目录、拒绝参数、错误返回、Preload 不传参数。
- Studio（`permission-settings.test.tsx`、`composer-preferences.test.ts`）：默认模式读写与校验、会话与默认值的生效规则、页面选项与文案。
- Studio（`storage-settings.test.tsx`、`App.test.tsx`）：分类切换与 `aria-current`、搜索筛选与空结果、存储页各状态、Desktop 按钮仅在有桥时出现。

## 6. 未决与后续

- 界面外观后续：Desktop 窗口背景色与 `nativeTheme` 同步（避免深色启动闪浅色）；字体、密度等选项。
- 清理、迁移、修改存储位置需要单独的备份、确认与回滚设计，不在本期。
