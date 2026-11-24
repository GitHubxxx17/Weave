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
