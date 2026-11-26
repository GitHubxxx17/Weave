# Studio 结构整理设计提案：App 拆分、共享 schema、统一 SSE 客户端

状态：已评审（2026-11-24）。结论见下方「评审结论」；正文其余部分保留为评审时的分析，与结论冲突处以结论为准。

## 评审结论（2026-11-24）

按第 4 节推荐的方案与顺序执行：

1. **U3 采用方案 H**：抽出底层 `readSseStream`，统一解码、切帧和帧上限，重连与游标逻辑留在各业务层。先合入。
2. **U2 采用方案 G**：保留 Studio 的手写 schema，增加契约测试让漂移暴露为测试失败。不放宽"Studio 不导入 `@weave/*`"的边界（方案 D、F 不采用）；方案 E 可另行小范围试点，不在本轮。
3. **U1 采用方案 A**：自下而上，先做区块盘点，再按领域一次抽一个 hook，每步一个 PR，执行与会话流转放到最后。

更正：第 8 节未决问题 4 已过时。本提案写于 #117 合并之前，#117 已为审批流增加 1 MiB 帧上限和指数退避重连。

对应观察编号：U1、U2、U3。

## 1. 背景

以下现状均已对照基线 `453d67d`（含 #111、#112）核实。

### 1.1 `App.tsx`（U1）

- `apps/studio/src/app/App.tsx` 共 5511 行。文件顶部到约第 673 行是辅助函数与小组件（`parseProviderNumberField`、`FormSelect`、`createId`、`formatMessageTime`、`toStudioSession` 等）；`export function App()`（约第 674 行）只是包装；`function StudioApp()` 从约第 683 行开始，一直到文件末尾，即一个约 4800 行的函数组件。对 `useState`、`useRef`、`useEffect`、`useCallback`、`useMemo` 的出现次数粗略统计为 86 行（按行匹配，不是精确的 hook 数）。
- #111（`bf7ab25`）已把会话渲染拆到 `apps/studio/src/features/conversation/`，当前目录包含 `conversation-store.ts`、`conversation-model.ts`、`conversation-timeline.tsx`、`conversation-pane.tsx`、`use-conversation.ts` 等十余个文件。目录 `apps/studio/src/features/` 下还有 `agent`、`approvals`、`commands`、`composer`、`file-context`、`file-undo`、`files-tree`、`mcp`、`memory`、`panel`、`plugins`、`providers`、`retrieval`、`runtime`、`skills`、`tasks`、`workspace` 等。因此 `App.tsx` 剩余的大部分是把这些特性接线、管理跨特性状态（项目、会话、Provider 设置、执行与队列、面板布局）的胶水代码。具体各区块占行数没有逐段统计，下文的拆分顺序需要在实施前再做一次区块盘点。
- 测试：`apps/studio/test/App.test.tsx` 等针对 `App` 的集成测试存在，拆分时是主要回归保护（用例数量未统计）。

### 1.2 schema 重复（U2）

- `apps/studio/package.json` 没有任何 `@weave/*` 依赖。`eslint.config.js` 为 `@weave/studio` 设置 `allowedDependencies: []`（层级 `studio`），并禁止导入 `node:*` 与 `electron`（`studioForbiddenImportPatterns`）。`docs/architecture/foundation.md` 约第 384 行与第 943 行写明 Studio 是浏览器端，只通过 HTTP/SSE 消费契约，不导入 `@weave/runtime`、`@weave/session` 或 Node 模块（图示为 `@weave/studio (browser, no @weave/* imports)`）。
- 结果是 Studio 手写镜像。例如 `apps/studio/src/features/tasks/task-types.ts` 以注释"Mirror the bounded Server HTTP contract; Studio imports no Runtime package"开头，重新定义 `taskIdentifierSchema`、`taskIdSchema`、`taskSequenceSchema`、`taskAccessSchema`、`taskStopReasonSchema` 等，并导出 `agentTaskViewSchema`、`agentTaskTreeSnapshotSchema`。`packages/protocol/src/agent-task-view.ts` 与 `agent-task.ts` 中有同名或同义的 schema（`agentTaskViewStatusSchema`、`agentTaskViewSchema`、`taskIdentifierSchema` 等）。
- 数量上，按 `Schema = z.` 与 `Schema: z.` 的文本匹配粗略统计，`apps/studio/src` 约 111 处，`packages/protocol/src` 约 82 处；34 个 Studio 文件导入 `zod`。这些数字只表示规模，不表示重复数量；哪些 Studio schema 与 protocol 或 runtime 中的定义完全重复、哪些是 Studio 独有（仅描述 HTTP 响应形状）没有逐项核对，需要实施前盘点。
- `@weave/protocol` 本身只依赖 `zod`，`exports` 指向 `dist/index.js`；`packages/protocol` 是层级最底的包，`@weave/llm`、`@weave/session` 已把它列入 `allowedDependencies`。Studio 目前不被允许依赖它。
- 另一些契约定义在 `packages/runtime`（例如 `agent-execution-types.ts`、`agent-task-execution.ts` 中的执行相关 schema），这些位于 Runtime 层而非 protocol，不适合直接被 Studio 引用。

### 1.3 SSE 读取循环（U3）

- 有五处读取 `text/event-stream` 的实现：`features/agent/agent-execution-client.ts`（执行流）、`features/agent/agent-queue-client.ts`（队列流）、`features/approvals/approval-api.ts`（审批流 `/approvals/stream`）、`features/tasks/task-api.ts`（任务流）、`features/agent/agent-legacy-stream.ts`（旧式直连流）。另外 `plugin-panel-api.ts` 读取响应体做限长解析，不是 SSE。
- 共享部分只有帧解析：`parseSseFrame`（`agent-legacy-stream.ts` 导出，经 `agent-stream.ts` 重新导出，被任务、执行、队列、审批四处导入）。
- 重复部分是读取循环：`response.body.getReader()`、`TextDecoder`、按 `/\r?\n\r?\n/` 切帧、分发。各处的差异：
  - 帧上限不同：任务流 `maxFrameBytes = 256 * 1024`；执行流 `8 * 1024 * 1024 + 65536`；审批流的循环没有看到帧大小上限（未发现相关检查）。
  - 重连与终止语义不同：执行流有 `cursor` 续传（`?after=`）、`terminal` 终止标志、`attempt++` 加 `waitForExecutionRetry`、`onConnection('connected'|'reconnecting')` 回调；审批流是固定间隔重试 `waitFor(retryDelayMs)`，忽略所有错误。
  - 响应校验不同：执行流检查 `Content-Type` 含 `text/event-stream`，否则抛协议错误；审批流只检查 `response.ok` 与 `body !== null`。
  - 错误分类不同：执行流对 `status < 500` 抛 `AgentStreamError`，其他抛 `TypeError` 触发重连。
- 审批流的循环在 `done` 之后没有 `decoder.decode()` 的收尾调用（未发现），以及它读到流结束后只是再次重试，未区分正常结束与异常。这些差异是否有意未核实。

## 2. 问题

1. **U1**：`StudioApp` 单函数承载过多状态与副作用，改动任何一个特性都要在 4800 行里定位；hook 依赖与闭包关系难以审查；渲染粒度粗，局部状态变化可能让整个根组件重渲染（未做性能测量）。
2. **U2**：手写镜像 schema 与服务端契约存在漂移风险，没有机制保证两边同步；一个字段在 protocol 变更后，Studio 的 `strictObject` 会在运行时拒绝响应，且类型检查不会发现。
3. **U3**：同一协议的读取循环有五份，边界条件（帧上限、编码收尾、`Content-Type` 校验、终止条件、错误分类）各不相同，修一个缺陷需要改多处，并且容易出现行为分歧。

三者互相独立，可以分开推进。

## 3. 可选方案

### 3.1 U1：拆分 `App.tsx`

**拆分顺序方案 A：自下而上，先抽纯函数与小组件，再抽状态域。**
1. 把文件顶部辅助函数与小组件（`FormSelect`、`toStudioSession`、`toStudioProject`、时间格式化、错误消息映射等）移到所属 feature 目录或 `app/` 下的 `lib` 文件，无状态，风险最低，行数下降约 600 行。
2. 按领域抽自定义 hook，一次一个，每个 hook 持有自己的 state 与 effect，通过参数与返回值与 `StudioApp` 交互：项目与会话列表、Provider 设置、执行与队列（已有 `use-execution-queues.ts`）、面板布局、Composer（已有 `use-composer-draft.ts`）、文件树与上下文。
3. 最后把 `StudioApp` 的 JSX 分成布局壳（导航列、会话区、右侧面板）与各区块组件。

**拆分顺序方案 B：自上而下，先拆 JSX 布局，再往里推状态。** 先把渲染拆成多个组件，仍通过大量 props 从 `StudioApp` 传入，之后逐步把 state 下沉到子组件或 context。
- 优点：每步都能立刻缩短主函数；缺点：中间状态有巨大的 props 列表，产生短期的"prop drilling"，hook 抽取反而更晚。

**方案 C：引入状态容器（如 context 加 reducer 或外部 store）。** 仓库已有 `conversation-store.ts`、`plugin-catalog-store.ts` 等 store 模式，可沿用；但在没有明确状态边界前引入统一容器会扩大改动。

**推荐**：方案 A，每次只动一个领域，每步独立 PR；在开始前做一次区块盘点（按领域列出 state、effect、handler 与对应行范围），以此排序。优先抽取依赖最少、与会话渲染无耦合的领域（如 Provider 设置、MCP 与插件入口），把耦合最深的执行与会话流转放在最后。每步以 `App.test.tsx` 及相关 feature 测试为回归，不改变可见行为。

#### 3.1.1 区块盘点（基线 `b80976d`，`App.tsx` 共 5614 行）

行号均指 `apps/studio/src/app/App.tsx`，按基线粗略统计，后续每步合并后会漂移。

**文件结构**

| 行范围 | 内容 |
| --- | --- |
| 1–144 | 导入 |
| 145–282 | 类型：`RunStatus`、`SessionRunState`、`SessionRunHandle`、`ProductView`、`OpenMenu`、`StudioSession`、`StudioProject`、`ProviderFormState`、`FormSelect*` 等 |
| 283–447 | `parseProviderNumberField`、`FormSelect`（自带 5 个 hook 与 1 个 effect，无外部状态） |
| 448–672 | 常量表（`statusLabels`、`viewLabels`、`permissionOptions`、`reasoningEffortOptions`、`fallbackProviderSettings`）、模块级 `providerApi`/`workspaceApi`、`createId`、`getSessionLabel`、`formatModelLabel`、`createSessionTitle`、`safeErrorMessage`、`updateToolActivity`、`liveTurnIdFor`、`readImageFile`、`formatMessageTime`、`toStudioSession`、`toStudioProject`、`workspaceErrorMessage` |
| 673–681 | `App` 包装（创建 `pluginStore`） |
| 682–3375 | `StudioApp`：状态、effect 与 handler（约 2700 行） |
| 3376–3410 | 加载中与加载失败的提前返回 |
| 3412–5612 | JSX（约 2200 行）：导航列 3426–3507，主区 3767–4411，`ConnectedConversationPanels` 4754 起 |

**领域盘点**（state、effect、handler；行号为定义位置）

| 领域 | state / ref | effect | handler | 说明 |
| --- | --- | --- | --- | --- |
| A. 模型服务设置 | `providerSettings`(729)、`selectedProviderId`、`selectedModel`(731–736)、`providerForm`、`providerFormError`、`providerMutation`、`providerToDelete`(744–749)、`reasoningEffort`(728) | 1167–1203 加载 Provider 列表 | `applyProviderSettings`(1072)、`refreshProviderSettings`(1084)、`openProviderForm`(2935)、`closeProviderForm`、`updateProviderForm`、`chooseProviderPreset`、`chooseModelPreset`、`providerErrorMessage`(3042)、`saveProvider`(3064)、`setDefaultProvider`(3130)、`deleteProvider`(3144)、`chooseProvider`(3204) | 依赖最少。向外读：`showNotice`；被外部读：`selectedProvider`/`selectedModel`/`reasoningEffort`（`submitMessage`、Composer、设置页）。 |
| B. 项目与会话列表 | `projects`(688)、`activeProjectId`、`expandedProjectIds`、`activeSessionId`(706–708)、`isLoadingWorkspace`、`workspaceError`、`workspaceLoadKey`(709–711)、项目弹窗与文件夹弹窗（714–720）、搜索（721–722）、会话改名与删除（750–761）、`activeSessionIdRef`、`navigationTicket`、`deletedSessionIds` | 1090–1166 加载工作区 | `activateSession`(1939)、`createSessionForProject`(2022)、`selectProjectSession`(2526)、`toggleProjectExpanded`、`openSessionEditor`、`saveSessionTitle`、`archiveSession`、`restoreSession`、`permanentlyDeleteSession`(2623)、`createSession`、`selectProject`、`openProject`、`openProjectRename`、`saveProjectName`、`openProjectDialog`、`applySelectedFolder`、`chooseProjectFolder`、`chooseFallbackFolder`、`createProject`、`openFolderDialog`、`pickFolderForDialog`、`saveProjectFolder`(2906) | 与 C 强耦合：`permanentlyDeleteSession`、`archiveSession` 读写 `runHandles`、`runStateBySession`、`sessionActivityVersions`；`selectProjectSession` 调 `loadSessionDetail`、`resetTransientState`。 |
| C. 执行与会话流转 | `runStateBySession`(763)、`runHandles`、`observationEpoch`、`sessionActivityVersions`、`appliedDurableSequences`、`settledExecutionSequences`(764–771)、`admitting`(772)、`copyRequest`(773)、`expandedMessageIds`(762)、`mounted` | 786–822 卸载清理（中止 handle、销毁 store）、827–835 切换会话时分离非活动 handle | `updateSessionMessages`(1226)、`updateSessionTurns`、`finishLiveTurn`、`applySessionDetail`(1307)、`loadSessionDetail`(1334)、`attachExecution`(1412)、`executionHandlers`(1500)、`requestExecutionCancel`(1562)、`reconcileExecution`(1611)、`resumeExecution`(1700)、`recoverSessionExecution`(1748)、`handleEvent`(1782)、`ensureSessionForMessage`(2081)、`submitMessage`(2114–2525，约 410 行)、`copyQueuedMessage`(3216)、`applyQueuedCopy`、`cancelRun`(3359) | 耦合最深：读写 B 的 `projects`、`activeSessionId`，读 A 的 `selectedProvider`，读 D 的 Composer 草稿，调用 `useExecutionQueues`(777)。 |
| D. Composer 与上下文 | `messageInputRef`、`composerIsComposing`、`directoryInputRef`、`imageInputRef`(836–839)、`pendingImages`、`permissionMode`(727)、`viewerFilePath`(737)、`gitChangesAvailability`(739) | 889–891 命令面板与技能互斥、908–910 根目录变化提示、3167–3183 上下文菜单可用性 | `addComposerContext`(3184)、`addViewerFileContext`、`fillSuggestion`、`handleSubmit`(3297)、`handleMessageKeyDown`、`addImageFiles`(3323)、`removePendingImage`、`handleComposerPaste`；已有 hook：`useComposerDraft`(868)、`useCommandPicker`(878)、`useSessionSkills`(885)、`useFilePicker`(894) | 与 C 交叉：`submitMessage` 读草稿并清空，`handleSubmit` 调 C。 |
| E. 面板布局与全局 UI | `activeView`(712)、`openMenu`(713)、`isActivityPanelOpen`(723)、`panelWidth`(`useSidePanelWidth`，724)、`shellRef`、`chatColumnRef`、`previewImage`(684)、`notice`(743)、`timelineRef`(691) | 1204–1224 全局键盘（Esc、Cmd/Ctrl+K） | `selectProductView`(2926)、`toggleMenu`(3162)、`showNotice`(3211) | 全局 Esc 同时重置 B 的弹窗与 `previewImage`。`selectProductView` 递增 `navigationTicket`、清 `taskTranscriptTarget`。 |
| F. 插件、MCP、市场、记忆入口与任务 | `pluginStore`(674/683)、`taskTranscriptTarget`(826)、`lastVerifiedTaskRoot`(825) | 无独立 effect | `prepareTaskDraft`(1953)、`openAgentTask`(1962)、`inspectApproval`(2008)；已有 hook：`usePluginCatalogStore`、`usePluginPanels`(884)、`useAgentTasks`(858)、`useApprovals`(915) | App 级状态很少，大部分在已有 hook 内；`openAgentTask` 调 B 的 `activateSession` 与 C 的 `loadSessionDetail`。 |
| G. 会话存储接线 | `conversationStore`(689)、`fileReviewStore`(690) | 692–705 把 `projects` 灌入 `conversationStore`（layout effect） | `onConversationAction`(995)、`emptyConversation`、`pendingConversationTarget` | 依赖 B 的 `projects`；销毁逻辑在 C 的 786 effect 中。 |

**领域依赖（谁读谁）**

- A 只向外依赖 `showNotice`（E），是最独立的领域。
- E 的 `selectProductView` 与全局 Esc 写 B、F 的状态，反向被几乎所有领域调用 `showNotice`。
- B 读写 C 的 ref 与 `runStateBySession`（删除、归档、切换会话时清理 handle 与活动版本）。
- C 读 A（所选 Provider 与模型）、B（`projects`、活动 ID）、D（草稿、图片、权限模式）。
- D 的 `handleSubmit` 调 C 的 `submitMessage`。
- F 的 `openAgentTask` 调 B、C。

**拆分顺序依据**

1. A（`useProviderSettings`）：状态自洽，只需 `showNotice` 回调，返回 `selectedProvider`、`selectedModel`、`reasoningEffort` 给 C、D。
2. B（`useWorkspaceNavigation`）：先只抽 B 自身的 state 与不触碰 C 的 handler（项目弹窗、文件夹弹窗、搜索、改名）；删除与归档要用的 C 的 ref，通过参数传入一个 `releaseSessionRuntime(sessionId)` 回调，避免 B 直接持有 C 的 ref。
3. E（面板布局）：状态很少，视盘点后并入 hook 或保持原位。
4. F：App 级状态少，可能只是把 `openAgentTask` 之类的 handler 并入 B 或 C 的 hook，不单独成 PR。
5. D：已有 `useComposerDraft`，只迁移 `handleSubmit`、图片与键盘处理、上下文可用性 effect；`submitMessage` 留在 C。
6. C：风险最高（`submitMessage` 410 行、`handleEvent`、ref 间的顺序约束、StrictMode 下的卸载清理）。放最后，是否执行视前面各步后的剩余形状再定。

每步合并后在 PR 记录 `App.tsx` 行数。

#### 3.1.2 执行与会话流转的拆分设计（领域 B 剩余部分与领域 C、D 的发送部分）

基线 `17fd308`，`App.tsx` 4693 行。#136 到 #140 已抽出 `useProviderSettings`、`useWorkspaceNavigation`、`useComposerAttachments`。本节只覆盖剩余的执行与会话流转，行号为基线定义位置，合并后会漂移。所有步骤不改变可见行为，以 `apps/studio/test/App.test.tsx` 及相关 feature 测试为回归。

**归属**

| 单元 | 持有的 state / ref | 命令与派生值 |
| --- | --- | --- |
| `useSessionExecutions`（新） | `runStateBySession`(262)、`runHandles`、`observationEpoch`、`sessionActivityVersions`、`deletedSessionIds`、`appliedDurableSequences`、`settledExecutionSequences`(263–270)、`admitting`、`mounted`(284)；卸载清理 effect 与切换会话时分离非活动 handle 的 effect | 只读：`runStateBySession`、`admitting`、`sessionRunStatus`、`isSessionStreaming`、`activeRunState`。命令：`setSessionRunState`、`clearActiveRunState`、`applySessionDetail`、`loadSessionDetail`、`attachExecution`、`requestExecutionCancel`、`reconcileExecution`、`resumeExecution`、`recoverSessionExecution`、`cancelRun`、`releaseSessionRuntime(sessionId)`（新增，见下）、`hasRunHandle(sessionId)`、`beginAdmission`/`endAdmission`、`registerRunHandle`/`removeRunHandle`（供发送逻辑使用，不暴露 `Map` 本身）。内部：`updateSessionMessages`、`updateSessionTurns`、`finishLiveTurn`、`executionHandlers`、`handleEvent` |
| `useSessionLifecycle`（新，B 的剩余部分） | `sessionToDelete`、`activeSessionIdRef`、`navigationTicket`、`activeProjectId`、`activeSessionId`、`expandedProjectIds`、`taskTranscriptTarget` 的归属留待步骤 2 确认（见风险） | `activateSession`、`selectProjectSession`、`createSessionForProject`、`createSession`、`archiveSession`、`restoreSession`、`permanentlyDeleteSession`、`selectProject`、`openProject`、`toggleProjectExpanded`、`findNextRunnableSession`；`ensureSessionForMessage` 也放在这里，因为它只创建项目与会话 |
| `useMessageSubmission`（新，D 与 C 的发送部分） | `copyRequest` | `submitMessage`、`handleSubmit`、`handleMessageKeyDown`、`copyQueuedMessage`、`applyQueuedCopy`、`retryTurn`（依赖 `submissionForTurn`） |
| 留在 `App.tsx` | `projects`/`setProjects`（`useWorkspaceNavigation` 已接收）、`activeView`、`openMenu`、`notice`、Composer 与 Provider hook 的调用 | 组合各 hook，并把回调接线 |

`useExecutionQueues`（已有）继续由 `App.tsx` 创建，因为它的 `onActive` 要调用 `attachExecution`，而 `useSessionExecutions` 需要读 `queueController.states`。解法：`useSessionExecutions` 接收 `queueController` 作为参数，`onActive` 在 `App.tsx` 里写成对 `executions.attachExecution` 的转发，通过 ref 解决创建顺序（与现有 `conversationActionHandler` 的写法一致）。

**依赖方向**（只允许单向，避免循环）

`useProviderSettings`、Composer hook → `useSessionExecutions` ← `useSessionLifecycle` ← `useMessageSubmission`。

- `useSessionExecutions` 不读取项目列表，也不读取活动会话以外的导航状态。它需要的 `projects`、`activeSessionId`、`activeProjectId`、`setProjects`、`conversationStore`、`fileReviewStore`、`onNotice`、`queueController` 全部通过参数传入。
- `useSessionLifecycle` 只通过 `useSessionExecutions` 的命令操作运行：`sessionRunStatus(sessionId)`、`releaseSessionRuntime(sessionId)`、`applySessionDetail`、`loadSessionDetail`、`recoverSessionExecution`。它不直接碰 `runHandles`、`sessionActivityVersions` 等 ref。
- `useMessageSubmission` 读 Provider 与权限模式（`selectedProviderId`、`selectedModel`、`selectedProvider`、`reasoningEffort`、`permissionMode`）、Composer 草稿（`composerDraft`、`commandPicker`、`sessionSkills`、`filePicker`）、`projects`、`canCompose`，调用 `useSessionLifecycle.ensureSessionForMessage` 与 `useSessionExecutions` 的运行命令。

**生命周期 handler 与执行的交互**

- 永久删除（`permanentlyDeleteSession`）：必须按现有顺序执行：`workspaceApi.deleteSession` 成功后，才把 ID 加入 `deletedSessionIds`、递增 `sessionActivityVersions`、中止并移除该会话的全部 handle、清 `runStateBySession`、`conversationStore.removeSession`、`fileReviewStore.removeSession`、清两张序号表。这一整段移入 `useSessionExecutions.releaseSessionRuntime(sessionId, projectId)`，由 `permanentlyDeleteSession` 在 API 成功后调用一次；之后 `useSessionLifecycle` 再处理项目列表、`sessionSkills.forget`、活动会话切换与 `taskTranscriptTarget` 清理。执行前的守卫（`sessionRunStatus(...) === 'streaming'` 时直接返回）保持在生命周期侧。
- 归档（`archiveSession`）：只读 `sessionRunStatus`，不释放运行（现状即如此）。`applySessionDetail` 经 `useSessionExecutions` 调用。
- 恢复（`restoreSession`）：只调用 `applySessionDetail`，不触碰运行。
- 切换会话（`selectProjectSession`、`selectProject`）：`activateSession` 之后调用 `resetTransientState` 与 `loadSessionDetail`。切换会话时分离非活动 handle 的 effect 留在 `useSessionExecutions`，依赖 `activeSessionId`。`resetTransientState` 属于执行 hook（它只清展开的过程面板，状态 `expandedMessageIds` 一并移入），生命周期 hook 通过参数拿到它。
- 新建会话（`createSessionForProject`）：创建会话后调用 `applySessionDetail`/`setProjects` 与 `activateSession`，不涉及 handle。
- 工作区加载 effect（`workspaceLoadKey`）调用 `applySessionDetail` 与 `recoverSessionExecution`：随 `useWorkspaceNavigation` 之外的剩余导航状态一起留在 `App.tsx` 或进入 `useSessionLifecycle`，以步骤 2 时的依赖为准；不得拆开 `disposed` 标志的闭包。

**`submitMessage` 的输入与调用**

输入（均为参数，不在 hook 内新增 state）：
- 草稿：`composerDraft`（`capture`、`draft`、`clearSubmittedDraftIfCurrent`）、`messageInput`、`pendingImages`、`commandPicker.expand`、`sessionSkills`（`draft`、`clearSent`）。
- 上下文：`activeSessionId`、`activeProjectId`、`projects`、`canCompose`、`getActiveSessionContext`。
- Provider 与权限：`selectedProviderId`、`selectedModel`、`selectedProvider`、`reasoningEffort`、`permissionMode`、`rememberPermissionMode`。
- 通知：`setNotice`。

调用的执行命令：`admitting` 读取、`beginAdmission`/`endAdmission`、`hasRunHandle`、`registerRunHandle`/`removeRunHandle`（对应现有 `runHandles.current.set/get/delete`）、`bumpSessionActivity`、`setSessionRunState`、`attachExecution`、`queueController.refresh/getState`、`ensureSessionForMessage`。`submitMessage` 内约 410 行逻辑不重写，只把对 `runHandles.current`、`sessionActivityVersions.current` 的直接访问换成上述命令。命令必须与原语句一一对应、同步执行，不引入新的 `await` 点或 `setState` 批处理差异。

**拆分步骤与回归**

0. 本设计（`docs:`）。
1. 抽出 `useSessionExecutions`：先搬 state、ref 与卸载、分离 effect，再搬 `applySessionDetail` 到 `cancelRun` 之间的函数。`App.tsx` 保留对其他 hook 的组合。新增 `use-session-executions.test.tsx`（`renderHook`）：卸载时中止并清空 handle；切换活动会话时分离非活动 handle；`releaseSessionRuntime` 删除 handle、清运行状态、递增活动版本；删除后的 ID 使 `applySessionDetail` 返回 `false`；较旧的 `lastSequence` 不回滚。回归：`App.test.tsx`、`conversation-isolation.test.tsx`、`agent-execution-*.test.ts`、`execution-queue-list.test.tsx`。
2. 抽出 `useSessionLifecycle`（或并入 `useWorkspaceNavigation`，以并入后文件不超过约 700 行为准，否则新建）：搬归档、恢复、永久删除、新建、切换、`ensureSessionForMessage`。新增 hook 测试：永久删除成功后调用 `releaseSessionRuntime` 且在 API 失败时不调用；流式运行中拒绝归档与删除；删除当前会话后切换到下一个可运行会话。回归：`App.test.tsx`、`conversation-isolation.test.tsx`。
3. 抽出 `useMessageSubmission`：搬 `submitMessage`、`handleSubmit`、`handleMessageKeyDown`、`copyQueuedMessage`、`applyQueuedCopy`、`retryTurn`。新增 hook 测试：空草稿不发送、`admitting` 期间不重复发送、Enter 与 Shift+Enter 与输入法组合键的处理、重试不改草稿。回归：`App.test.tsx`、`composer-draft.test.tsx`、`file-context-flow.test.tsx`、`command-api.test.ts` 相关用例。
4. JSX 拆分，按区块分为若干 PR（每个 PR 只搬一类区块，props 用分组对象，不为减少 props 而引入 context）：(a) 导航列与会话栏；(b) 聊天列（头部、时间线、Composer、队列）；(c) 右侧面板；(d) 项目、历史、归档、设置视图；(e) 弹窗（项目、文件夹、改名、删除确认、预览图）。每个 PR 只改渲染位置，事件处理函数原样透传。回归：`App.test.tsx` 与对应区块的 feature 测试。

每步合并后在 PR 记录 `App.tsx` 行数。

**风险与停止条件**

- 依赖循环：`useExecutionQueues` 的 `onActive` 回调要调用 `attachExecution`，而执行 hook 要读队列状态。用 ref 转发解决；若出现必须改变调用时序的情况，停止并在报告中说明。
- 状态归属：`activeSessionId`、`activeProjectId`、`activeSessionIdRef`、`navigationTicket`、`taskTranscriptTarget` 同时被执行、生命周期、任务入口（`openAgentTask`）读写。步骤 1 先保持它们留在 `App.tsx`，经参数传入；步骤 2 再判断是否下沉。
- 同步语义：`submitMessage` 与 `handleEvent` 依赖 `runHandles` 的同步读写顺序和闭包内的 `runId` 校验。任何把 ref 访问改为 state、或把同步命令改为异步的做法都不允许。
- StrictMode：卸载清理使用 `queueMicrotask` 判断是否真正卸载，搬移时必须保留 `mounted` 的置位与清理次序，并保留 `App.test.tsx` 中相关用例。
- 停止条件：任何一步需要改变可见行为，或需要修改 `App.test.tsx` 的断言（不含导入路径与测试辅助函数），则停止该步，在报告中说明原因，不继续后续步骤。
- 步骤 4 的 JSX 拆分依赖步骤 1 到 3 的返回值形状；若前面任一步被停止，步骤 4 只做不依赖该领域的区块。

### 3.2 U2：共享 schema

**方案 D：Studio 直接依赖 `@weave/protocol`。**
- 优点：单一事实来源；类型与运行时校验同源。
- 缺点：违反 foundation.md 与 eslint 规则里"Studio 没有 `@weave/*` 导入"的边界；protocol 的 `exports` 指向 `dist`，Studio 构建要先构建 protocol；`@weave/protocol` 的传递依赖目前只有 `zod`，浏览器可用性需要确认（未核实包内是否含 Node 专用代码）。如果选这条，需要同时修改 eslint 层级规则与架构文档，这是架构层面的变更，应单独决策。

**方案 E：从 protocol 生成到 Studio 的无依赖副本。**
- 做法：增加一个生成脚本，读取 `packages/protocol/src` 中标注为"公共 HTTP 契约"的 schema，输出到 `apps/studio/src/contract/generated/`（只含 `zod` 与自身相对导入），产物提交入库；CI 增加"生成结果与提交内容一致"的检查（类似 `pnpm marketplace:check` 的做法）。Studio 仍无 `@weave/*` 依赖，边界不变。
- 优点：保持架构边界，消除手写漂移；缺点：需要选择生成方式（源码拷贝加改写导入，或基于 TypeScript AST，或用 zod 的 JSON Schema 导出再生成校验器）；各方式对 `strictObject`、`superRefine`、`brand` 等特性的保真度不同（未核实）；生成物进入评审会增加 diff 噪声。

**方案 F：契约抽成独立无依赖包，如 `@weave/contract`，由 Studio 与 protocol 共同依赖。**
- 优点：单一来源且无生成步骤；缺点：同样需要放宽 Studio 的依赖规则，并新增一个包，层级与现有 protocol 的职责重叠。

**方案 G：保持手写镜像，增加契约测试。**
- 做法：在服务端或集成测试里，用 Studio 的镜像 schema 解析 Server 真实响应夹具（或反向，用 protocol schema 解析 Studio 夹具），把漂移变成测试失败。
- 优点：不改依赖与架构，成本最低；缺点：只能发现漂移，不能消除重复；夹具需要维护。

**推荐**：先 G（立刻降低漂移风险），并评估 E 是否可行；D 与 F 因要变更架构边界，需要单独的架构评审，不在本提案内决定。E 的可行性判断要先做小范围试点（例如只生成 agent task 视图 schema），验证保真度与 CI 检查开销。

### 3.3 U3：统一 SSE 客户端

**方案 H：抽出 `readSseStream` 底层函数。**
- 位置：`apps/studio/src/lib/sse.ts` 一类的无业务模块。职责：给定 `Response` 与选项，完成 `Content-Type` 校验、`TextDecoder` 流式解码（含结束时的收尾）、切帧（沿用 `parseSseFrame`）、帧大小上限（必须显式传入）、`AbortSignal` 处理，并以异步迭代器或回调方式产出 `{ event, data, id? }`。不包含重连、游标、终止语义。
- 业务层（执行、队列、审批、任务）保留各自的重连与游标逻辑，只替换读取循环。

**方案 I：在 H 之上提供带重连的 `createSseSubscription`。** 参数化重试策略（退避、最大次数、固定间隔）、续传游标（`Last-Event-ID` 或查询参数）、终止判断与连接状态回调。优点：更彻底；缺点：执行流的语义（耐久游标、`terminal`、`onConnection`）与审批流（无游标、永不停止）差异较大，抽象过早容易变成难以理解的选项集合。

**方案 J：使用浏览器 `EventSource`。** 不推荐：`EventSource` 不能设置自定义请求头与 `Accept`（目前代码设置了 `Accept`），难以读取非 2xx 的状态并分类，不支持细粒度的帧大小控制，行为与现有测试的模拟方式也不同。

**推荐**：方案 H 先行，把五处读取循环统一到一个有测试的实现上，并借机修正差异（审批流补上帧上限与 `decoder` 收尾，是否同时校验 `Content-Type` 作为评审点）；方案 I 在 H 稳定后，视各业务层重复程度再决定。

## 4. 推荐方案汇总与顺序

1. U3 方案 H：范围小、可独立发布、测试容易，同时降低后续拆分 `App.tsx` 时的风险（执行与队列流是 `StudioApp` 最复杂的部分之一）。
2. U2 方案 G：新增契约测试，并对方案 E 做小规模试点。
3. U1 方案 A：先做区块盘点，再按"无耦合领域优先、执行与会话流转最后"的顺序逐个 PR。

三者之间没有强依赖，可由不同人并行，但 U3 与 U1 在执行与队列区块上会有文件重叠，建议 U3 先合入。

## 5. 受影响的包与契约

- `apps/studio`：`src/app/App.tsx`、新增 hook 与组件文件、`src/lib/sse.ts`（或同类位置）、`features/agent/*`、`features/approvals/approval-api.ts`、`features/tasks/task-api.ts`。
- `packages/protocol`：若走方案 E，需要标注哪些 schema 属于公共 HTTP 契约（可能新增导出清单或注释约定）。
- 构建与 CI：方案 E 需要新增生成与一致性检查脚本（根 `package.json` 与 CI 工作流），本提案不修改它们。
- 契约：Studio 与 Server 之间的 HTTP/SSE 契约保持不变；`docs/architecture/foundation.md` 关于 Studio 边界的描述在方案 E、G 下不变，方案 D、F 下需要修改（并同步 `eslint.config.js` 的 `allowedDependencies`），实现时再改，本提案不改。

## 6. 迁移与兼容

- U1 与 U3 是内部重构，不改变用户可见行为，也不改变存储或协议。要求每步 PR 保持全部 Studio 测试通过。
- U3 统一帧上限时要避免收紧到会拒绝合法大帧：执行流的 8 MiB 上限来自图片输入等较大载荷（来源未核实），统一函数必须保留每个调用方各自的上限。
- U2 方案 E 的生成物首次入库会带来一次较大的 diff，应与行为改动分开提交。

## 7. 测试计划

- U1：每步抽取之后运行 `App.test.tsx` 与相关 feature 测试；对新抽出的 hook 补充针对其状态机与 effect 清理的测试（尤其是订阅与取消）；在拆分前补充现有测试未覆盖的跨特性流程（如切换会话时执行流订阅的清理）。
- U2：契约测试用 Server 真实响应夹具逐个解析；方案 E 的一致性检查：生成后工作树无 diff。
- U3：针对 `readSseStream` 的单测：多块拼接帧、`\r\n` 与 `\n`、帧跨 chunk、UTF-8 多字节跨 chunk、超出帧上限、`Content-Type` 错误、中途 `AbortSignal`、流结束时缓冲区中残留不完整帧；业务层沿用现有 `agent-execution-client.test.ts`、`agent-queue-client.test.ts`、`agent-task-api.test.ts`、`approvals.test.tsx` 等。

## 8. 未决问题

1. `App.tsx` 区块盘点的结果（各领域状态与副作用的耦合图）。
2. 方案 E 的生成方式及对 `strictObject`、`superRefine` 等的保真度。
3. 是否接受放宽 Studio 的依赖边界（方案 D 与 F），这是架构决策。
4. 审批流缺少帧上限与 `decoder` 收尾，是否有意。
5. 统一的 SSE 读取是否要求所有调用方校验 `Content-Type`。
6. 重连策略是否也应统一（方案 I）。
7. 拆分过程中是否同步引入状态容器，还是继续沿用现有的 store 与自定义 hook 模式。

## 9. U2 契约测试的实施（方案 G）

### 9.1 机制

- 夹具由 Server 测试生成：`apps/server/test/http-contract-capture.ts` 启动真实 `startServer`（HTTP、SQLite、Runtime、审批代理、Agent 任务全部是生产组合，只有 Provider 的 `fetch` 被脚本化），驱动一个固定场景并记录各接口的真实响应。每次运行都会变化的值（随机 ID、时间戳、带签名的任务游标、临时目录、受系统提示词长度影响的上下文词元数）在 `neutralizeContract` 中替换为稳定值，替换后保持原有语法与相互引用（同一个 ID 在整份夹具里映射为同一个值），因此 Studio 的校验（如游标中段等于会话 ID）仍然成立。
- 夹具位置：仓库根 `test/fixtures/http-contract/{workspace,execution,queue,approvals,tasks}.json`。放在 `apps/server/test/` 下时，Studio 的相对导入会被 `weave/package-boundaries` 规则判为跨包访问源码（lint 实测报错），因此改放在不属于任何工作区单元的仓库根目录，两侧都只通过相对路径读取 JSON 数据。SSE 帧以 `{ id?, event, data }` 保存，`data` 是解析后的 JSON。
- 一致性测试：`apps/server/test/http-contract-fixtures.test.ts` 重新捕获并与已提交的夹具比较，不一致时失败并提示重新生成的命令：`WEAVE_UPDATE_HTTP_CONTRACT=1 pnpm --filter @weave/server exec vitest run --root ../.. --config vitest.config.ts apps/server/test/http-contract-fixtures.test.ts && pnpm format`（生成的 JSON 需要再格式化）。
- Studio 测试：`apps/studio/test/http-contract.test.ts` 以相对路径导入这些 JSON（只读数据，不导入任何 TS 或 `@weave/*` 代码，边界规则不变），把它们作为桩 `fetch` 的响应，调用 Studio 真实的客户端（`createWorkspaceApi`、`listAgentExecutions`、`getAgentExecution`、`observeAgentExecution`、`getExecutionQueue`、`observeExecutionQueue`、`subscribeApprovals`、`getAgentTaskTree`、`getAgentTask`），因此同时校验手写 schema 与帧分发逻辑。另有四个漂移用例（多出字段、缺少字段、字段改名）确认解析会失败。
- 场景：父会话委派一个 workspace 任务，子任务的 `write_file` 停在待审批状态（得到审批列表、审批 SSE 快照和任务视图）；另一个会话中一个执行停在 Provider，另有两个排队项（得到队列快照、队列 SSE 帧），释放后读取该执行的事件帧与状态帧和完成态快照。

### 9.2 Studio 手写 schema 盘点

| Studio 文件 | 镜像的 Server 响应 | 本轮覆盖 |
| --- | --- | --- |
| `features/agent/agent-execution-types.ts` | 执行快照、摘要、事件帧、状态帧、队列快照 | 是 |
| `features/agent/agent-types.ts` | `agentRuntimeEventSchema`（执行事件载荷） | 部分（`context`、`text-delta`、`completed` 三类事件；其余类型未覆盖） |
| `features/approvals/approval-api.ts` | 审批列表项、`approval.snapshot` 帧 | 是（`approval.created`/`approval.resolved` 帧未覆盖） |
| `features/workspace/workspace-types.ts` | 项目与会话列表、会话详情 | 是 |
| `features/tasks/task-types.ts`、`task-api.ts` | 任务树快照、任务视图 | 是（任务 SSE 帧与停止回执未覆盖） |
| `features/panel/plugin-panel-types.ts` | 插件面板目录、数据、准备命令 | 已有 `plugin-panel-contract.json` |
| `features/memory/types.ts`、`client.ts` | 记忆列表与写入响应 | 后续 |
| `features/retrieval/types.ts` | 检索回执 | 后续 |
| `features/plugins/plugin-types.ts`、`plugin-api.ts` | 插件目录与信任操作 | 后续 |
| `features/plugins/managed-plugin-types.ts`、`managed-plugin-api.ts` | 托管插件目录、安装预览与回执 | 后续 |
| `features/plugins/plugin-marketplace-api.ts` | 插件市场源与索引 | 后续 |
| `features/mcp/mcp-types.ts`、`mcp-api.ts` | MCP 服务器状态与授权 | 后续 |
| `features/providers/provider-api.ts` | Provider 列表与设置 | 后续 |
| `features/skills/skill-types.ts`、`skill-api.ts` | Skill 列表 | 后续 |
| `features/commands/command-types.ts` | 斜杠命令列表 | 后续 |
| `features/file-context/file-context-types.ts` | 文件引用与附件摘要（嵌在执行输入内） | 部分（仅出现在执行输入中，夹具里未带文件引用） |
| `features/files-tree/file-tree-api.ts`、`file-diff-api.ts` | 文件树与文件差异 | 后续 |
| `features/file-undo/file-undo-api.ts` | 文件撤销状态与结果 | 后续 |

`features/panel/panel-layout.ts` 是 Studio 本地的布局存储格式，不镜像 Server 响应，不在范围内。

### 9.3 后续

- 补齐上表标为"后续"的接口：每增加一个接口，在 `captureHttpContract` 里增加对应请求和一个夹具文件，并在 Studio 测试里用真实客户端解析。
- 覆盖更多执行事件类型（工具调用、工具结果、推理增量、错误）和任务、审批的 SSE 增量帧。
- 方案 E 的小范围试点仍不在本轮。
