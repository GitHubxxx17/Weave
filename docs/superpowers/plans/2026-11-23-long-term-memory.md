# Weave 长期记忆实施计划

> **For agentic workers:** 按已授权工作流，使用 `superpowers:subagent-driven-development` 或 `superpowers:executing-plans` 逐项执行。Multi Agent 合并后，从最新 `origin/main` 创建独立 `feat/long-term-memory`。当前进入实施。

**目标**　在 Studio 管理可跨 Session 显式读取的项目与个人记忆，支持可审阅修订、历史、tombstone 和本地搜索。

**架构**　具体 SQLite sidecar 只由 Server 组合。Runtime 持有 Tool Pipeline、调用凭据、作用域和检索许可边界。Studio 通过 guarded HTTP 使用同一服务。

**技术栈**　TypeScript strict ESM、Zod、Node 内置 SQLite/WAL、read-only worker、Vitest。

**设计**　`docs/superpowers/specs/2026-11-23-long-term-memory-design.md`，以及 ADR 0012 和 Foundation 的增量合同。

## 全局约束

依赖增量 `protocol -> memory -> server`。Runtime 仅定义端口，Studio 仅用 HTTP。无新第三方依赖，无自动学习、FTS、embedding 或检索 job。所有测试位于本工作区单元的 `test/`。以 exact authority 和真实 SQLite 回归为验收依据。

## Task 1 — 固定设计与依赖边界（任何实现之前）

读取 `AGENTS.md`、foundation、ADR0001、2026-11-14 foundation spec 与最新 multi-agent 契约。核对工作区状态和 main 差异，不携入另一个主题未提交改动。遵循用户已授权的 task workflow；已有完整流程授权时完成设计/实现/验证后依序commit/PR/CI；只有超出既定范围才另作判断。

写入：

- `docs/superpowers/specs/2026-11-23-long-term-memory-design.md`（日期随实际实施调整）。
- `docs/superpowers/plans/2026-11-23-long-term-memory.md`。
- `docs/adr/00xx-memory-authority-store.md`，使用当时未占用编号。
- `docs/architecture/foundation.md` Product references、存储/作用域/Runtime 端口图；`AGENTS.md` 增量 DAG。

固定设计中的 `bindMemoryWritePreview` / `consumeMemoryWriteAttempt`、exact registry visibility、`MemoryStoreWritePort`、`ReviewedMemorySource` 和 `BeforeMemoryCommit`。记录按 project UUID 绑定，record 与 access facts 分开，current/access/receipt/head 可重建；agent-authored 与用户编辑/确认语义分别固化。记录 sidecar 单 owner、pending-write/retry drain、独立的 durable cursor head 和 live epoch。核对本计划的具体签名与合并后源码接线后，在任何跨包实现前落地文档。

验证：设计评审没有未知关键选择，文档引用与实际官方来源一致；不把 failed web reads 当证据。

## Task 2 — Protocol schemas 与包骨架

新增 `packages/protocol/src/memory.ts` 并从 index 导出 DTO/schema。新增 `packages/memory/package.json`、`tsconfig.json`、`src/index.ts`、`src/types.ts`、`test/`；脚本沿用现有 strict ESM package convention。

更新 `eslint.config.js` workspacePackageNames/packageLayers 与 Server manifest 声明；不让 Runtime 导入 memory。不新增 npm 依赖，既有 zod 版本保持一致；pnpm lock 只反映新内部包。

先写 `packages/protocol/test/memory.test.ts`：strict schema、UUID/ref/digest、Unicode codepoint+UTF-8上限、unpaired surrogate/正文controls、tag NFKC+toLowerCase去重、discriminated scope/record-vs-scope-access subject、actor/review由host赋值、current ref与terminal tombstone receipt分开、分页/query边界、实际JSON escaping预算。再实现 schema。不要把数据库 row 的未知 JSON直接断言为 DTO。

验证：`pnpm --filter @weave/protocol test`、新包 lint/typecheck；新增边界的 positive/negative lint fixture（沿用 root 已有测试机制）。

## Task 3 — 追加式 Store、投影、冲突与请求幂等

新增 `packages/memory/src/{ownership,sqlite-store,projection,errors}.ts`。先获取 `${memoryDatabaseFile}.owner.sqlite` 的 rollback-journal `BEGIN EXCLUSIVE`，再打开 WAL 数据文件并迁移；在当前支持的本地规则内确认文件对象身份。Store 以结构等价的 `lookupReceipt(key)`/`commit(mutation, guard)` 实现设计中的 `MemoryStoreWritePort`，不导入 Runtime。事务先授权，再 exact receipt，再新写 CAS，最后同步 invalidation 和 append/投影/COMMIT。事实包含 stable receipt，派生 current/request/access/scope heads 同事务更新。Agent 全局 invocation+operation receipt 唯一键覆盖跨 scope retry，create logical digest 排除事务内生成 ID。

先写 `packages/memory/test/sqlite-store.test.ts` 与 `projection.test.ts`：

1. create→revise→review→delete，关闭重开；仅靠权威事件重建current、access和request receipts，与原结果相同；review产生新revision、内容hash相同，tombstone无可读MemoryRef。
2. deleted 读取当前为 not-found，显式 history 仍可读；普通 revise/review 不复活。
3. expectedRevision冲突；并发两个写入只有一个成功；同requestId+host caller/invocation+payload返回原结果，不同payload/caller拒绝；Agent requestId由host产生不能模型自报，UI重试保留UUID。
4. 事务中途故障回滚事件/current/receipt；COMMIT-then-throw重读认领原结果；readback也失败返回uncertain并fence该scope写入，reconcile前不重试新effect；lost-response不重复，取消后已提交仍可确认receipt。
5. invalid persisted JSON/unknown version明确失败，不能当空库；不同 scope不混；append-only trigger有效。
6. Agent revise 后 reviewed状态降为 agent-authored；review必须绑定精确 revision+digest。
7. 索引/查询参数绑定，文本内SQL不执行；记录数量和UTF-8上限；title/tags改变必须改完整content sha256；unknown event/receipt schema不能当空库。
8. 独立scope-access subject不要求memoryId，设置重设同值递增settingRevision，requestId不同operation冲突，scope内唯一且不能泄露其他scope receipts。
9. 本进程第二连接和第二个真实 Node 进程都无法打开同一 owner（包括父目录 alias）；原 owner 正常退出、异常 kill 后可重新打开并读到同一 receipt。锁失效后旧 owner 立即拒绝新 mutation，read-only worker 在 owner 持锁期间仍可读数据 WAL。将硬链接/symlink 拒绝与受支持的路径情形分开测试。
10. 在真实 SQLite 事务适配器注入 `COMMIT → throw → temporarily fail exact readback`，断言只追加一条事实、原请求标记 pending、新写与跨作用域同 invocation 拒绝、解除读故障后仅 lookup 就返回原 receipt。对真实 rollback 分支反向断言没有已提交事件，只能在确认为 absent 后允许新 attempt。验证 guard 顺序 `authorized -> receipt miss -> CAS -> beforeCommit -> write`。

实现最小 store API和可重建 projection，包内只保存事实，不检查 Session、项目路径、HTTP Origin或审批。Store close幂等，不在 close后接受操作。

新增 `packages/memory/src/{search,search-worker}.ts` 及 `test/search-worker.test.ts`。用同一 read-only snapshot 读 scope heads 和 keyset 排序结果，传回有界行和游标键。RED 构造多个 scope 的 title/updatedAt 并列、在两次分页之间插入高排序项、一个已取消但仍未 exit 的 worker、扫描超 10,000 条。断言合并稳定顺序、回传快照 head、满额返回 busy、实际 exit 后释放 slot、双 scope 超界要求分别查询。5 秒 deadline 后追踪 terminate/exit。用构建出的 `dist/` 入口在 Node 子进程执行一次 worker 搜索；读线程遇到失败清退有独立状态，不让退出中的线程被提前复用。

验证：`pnpm --filter @weave/memory test`、typecheck、lint与dist smoke。

## Task 4 — Runtime MemoryService 与工具

新增 `packages/runtime/src/{memory-types,memory-service,memory-tools,memory-cursor,memory-tool-attempt}.ts`。`memory-types.ts` 提供 `MemoryStoreWritePort`、`MemoryScopeEvidence`、`ReviewedMemorySource` 和 `BeforeMemoryCommit`。从 Runtime index 导出 Server composition 所需的工厂与类型，`memory-tool-attempt.ts` 留在 Runtime 内部。修改 `tool-pipeline.ts`、`agent-tool-authority.ts`、`agent-runner.ts` 与 `tool-types.ts` 的必要接线，保留已验证 root missing-tool、child denied、owner/digest、checkpoints 及现有非 Memory summary 和 execute 行为。

先写 `packages/runtime/test/memory-service.test.ts`、`memory-tools.test.ts`：

- **真实 Pipeline 模式矩阵。** 持久 root Tool Call → `save_memory`；ask/trust 都等同一次 Broker 决定，reject/cancel 断言零事件；yolo 不产生 Broker request，仍为 `agent-authored`；yolo + policy `ask` 要批准，policy `deny` 连 summary 都不调用。关闭 Memory 取消其等待中的 Approval。已过期、复制、伪造、别次或 summary context 不能消费 execute intent，普通 `readAgentToolAuthority` 在 summary 仍拒绝。
- **exact attempt 与重试。** `around` 给同一 Tool Call 同时执行 `next(A)` 和 `next(B)`；各有独立正文、target ref 与 Approval。先批准 B 则只能按 B 的意图写；随后批准 A 得 `memory-request-conflict`，不能用 B 的 permit 或返回 B 的 receipt。A/B 改 scope 还要命中全局 Agent invocation 键；完全相同输入重试可取原 receipt，仍不追加第二条。验证批准后变更 target ref、禁用再启用、或在等待中增加第二 Project membership 均写入为零。若同意图已经 committed，恢复权限后 exact replay 先于新 CAS，但禁用状态仍拒绝。
- **可见性与授权。** 用真的 root Runner 派生所有 access 模式的 child，CI 断言 instructions 和最终 Provider tools 中没有 save/delete，合成同名 child call 和绕过 authority 的 Pipeline 调用均在 execute/around 前拒绝。Registry 有同名不同 definition 也不能取得 host 分类。root mint 后禁用，本轮与新 Turn 即使仍显示定义也返回稳定拒绝且无内容/写入。child read 用 pinned Project、唯一当前关联，不能读取个人 scope。root 仅在确认为无关联或唯一关联后按 `scope:'user'`/`includeUser` 和独立 opt-in 运行。歧义、查询失败、删除均拒绝，即使个人 access 允许。管理页仍能查看/审阅/启用已禁用的 scope。
- **JSON/cursor。** 收紧 Pipeline 字节限和 Runner per-result token 限后使用真实最坏 `\\`、双引号与 CJK 正文通过 Pipeline/Runner，断言接下次 Provider 的 tool message 可解析且每页前进，拼接页等于原正文。用同一 cursor 改 scope、query、排序、filter 或 limit，以及篡改 HMAC，断言 invalid；任一 scope commit 后 stale；rollback/exact replay 后 cursor 可继续。`read_memory` 中途 revise/delete 使旧 exact ref 页面失效；空预算不给成功空页。worker 返回后在同步检查前禁用并重新启用，返回零条旧数据。
- **ReviewedMemorySource。** 多 refs 必须同一 Project、当前、全部 reviewed 且 exact，任一错就失败；复制 capture 对象、旧 owner、混个人/其他 Project、agent-authored 或 tombstone 都拒绝。让 `beforeMemoryCommit` fixture 捕捉预写 epoch 和 scope/id，验证同步触发时 SQL 仍旧、write rollback 也使旧 capture 永久 invalid、replay 不追加 invalidation；下一次 capture 可按当前 facts 正常建立。禁用和 shutdown 后先前的同步校验失败，即使未进入异步 abort。

先以 `pnpm --filter @weave/runtime test` 观察上述 Authority、Pipeline 和 Store 双重保护的红例，再满足这些接线约束。

1. 在 base `next()` 创建独立 opaque `MemoryWriteAttempt`，关联 summary 和 execute exact contexts，用 `finally` 清理 token 状态。批准后或 yolo 自动路径由 execute 调用 `consumeMemoryWriteAttempt`。读取和写入必须用原 invocation。Server 只通过 exact definition 绑定 Memory 的 shutdown signal，插件 context 和其他工具信号照常。
2. 实现 `MemoryService` 的实时 read 与 prepare/execute。Store guard 执行 `assertAuthorized`、`assertNewMutation`、`beforeCommit`，从 live scope evidence 到 effect 前没有 `await`。未获批准的自动 yolo 分支在 execute 内生成意图，应用同样的权威 guard。track 每个 admitted Store 操作与 uncertain receipt 到最终清理。
3. 用实际 stringify + 共享 estimator 实现 `memory-cursor.ts` 和返回页预算，按最后输出行或正文字节对应的 code-point offset 续页。将 `MemoryInvalidation` 的 live epoch 与已提交 scope heads 分开存储。单个异常投影/坏 HMAC 不返回相关内容。

仅实现有界本地记忆搜索，不引入embedding/FTS，不改变`recall`。不自动构建prompt section或扩张Session event union。

验证：Runtime定向test、typecheck、lint；现有recall/context/pipeline测试通过。

## Task 5 — Server composition、唯一 scope resolver 与生命周期

新增 `apps/server/src/memory-composition.ts`、`memory-scope.ts`。从 canonical databaseFile 派生 sidecar。`captureMemorySessionScope(sessionId)` 返回 `Promise<MemoryScopeEvidence>`，核验 Session 状态、所有 Project 关联和 per-Session 标记。现有普通 Session 创建、task attach 和 Session delete 复用 `withMemoryMembershipMutation<T>(sessionId, operation): Promise<T>`，在写前、settle 时同步变更标记。各路径保留现有编排、权限和持久行为。child resolver 辅以真实 child token 和原 origin/accepted lineage，将当前唯一项目与 pinned ID 对比。通过现有 `registerHostTool` 注册定义，用同步 `rootOnlyTool(definition): boolean` 将 write metadata 固定在 root capture 中，child derive 排除。Capture 无异步权限查询，Service 独立检查实时 access。

修改 `apps/server/src/{main,runtime,agent-kernel,server-shutdown,persistence-path,session-service,agent-task-composition}.ts` 所需部分。用相同有效数值配置 Memory page、Tool Pipeline 和 Runner，带默认设置启动时仍可使用管理页。`ServerShutdownResources` 接受 `memory?: { closeSync(): void; drain(): Promise<void>; close(): Promise<void> }`。先同步 fence Memory，再让现有执行与 Memory 停止、等待所有 writer barriers，随后 close Memory 数据连接、最后 release owner。把 Memory drain/close 纳入 `hasUnfinishedResources()` 与 failed-startup 重试状态。任何 incomplete 保留 Stores 和 consumers，重试 drain 同一 entry/worker、继续尚未完成的 cleanup。

测试 `apps/server/test/memory-composition.test.ts`、`memory-scope.test.ts`、现有 shutdown 文件。RED 在真实 `startServer` 注入 `COMMIT-then-throw` 和不可用 readback，第一次 stop 必须 incomplete，记录顺序只有 closeSync/drain，没有 close Store/释放 ownership/Project 与 Session close。另一个 Server 同一路径仍 busy。恢复 readback 后原 Server 第二次 stop 完成，重启只见一次 receipt；同样覆盖 delayed worker exit、startup 中途失败可重试回收、stop callback 重入。真实支持的 attach 到第二 Project 和 Session delete 复核 scope evidence；用户目录无 test 文件；项目 folder 改名保留记忆 scope，Session user_version 未被 Memory 改写。

## Task 6 — Guarded HTTP management contract

新增 `apps/server/src/memory-api.ts`；`app.ts` 在 CORS 前调用 `registerAgentExecutionGuards(app, studioOrigin, ['/memory', '/memory/*'])`。复用 `readExecutionJson(request, 65536)`，字段 schema 独立校验原始内容。沿用 no-store、Origin 与 Sec-Fetch-Site 约束。

端点至少覆盖：scopes/access、bounded current list/search、read exact record、paged history、create/revise/review/delete。采用explicit POST mutation与requestId，不用GET副作用。HTTP handler调用MemoryService，不直接写SQLite或操作ApprovalBroker。

先写 `apps/server/test/memory-api.test.ts`（真实临时SQLite+app.request或已有loopback模式）：

- cross-site/恶意Host/Origin、缺JSON、无Content-Length超大body、invalid UTF-8/unknown keys拒绝。
- 项目隔离/个人opt-in；disabled时local-user可管理/查看历史，Agent与retrieval source拒绝；not-found不揭露他scope，浏览器提交actor=agent/权限角色拒绝。
- 409保留conflict信息但不返回他人正文；requestId重试；源message必须存在。
- Session A保存→fresh Session B读取；关闭重开仍在；其他project不可见。
- Agent写入为agent-authored；只有UI精确review才变user-reviewed；删除立即从当前搜索去除。

对UI明确人工保存不再制造Agent Approval，和existing user-driven provider settings原则相同；审阅按钮是精确版本操作。

## Task 7 — Studio Memory页面

新增 `apps/studio/src/features/memory/{types,client,MemoryPage,MemoryEditor,MemoryHistory}.ts(x)`，按项目现有styles组织CSS。`App.tsx`仅导航/项目状态/源Session导航接线，不把编辑表单堆进去。

页面：项目与个人scope切换、access级别、title/tag/query filter、分页列表、empty/loading/error、正文详情、host provenance、history、review badge、create/edit/review/delete。每次返回检查scope+request identity，AbortController清理；“Agent与检索使用权限”禁用后管理视图仍在、使用侧缓存清空。安全Markdown与已验证Session导航。

先写 `apps/studio/test/memory-client.test.ts`、`memory-page.test.tsx`（沿用项目现有测试工具，不为本功能新添框架）：validation；scope切换旧响应丢弃；mutation 409 保留草稿；分页 stale/invalid cursor 重新取同 scope 第一页，旧响应不能覆盖；重复save禁用并同requestId重试；删除确认说明保留历史；review绑定正确版本；键盘焦点/label/error关联；不开raw HTML或file://。

运行实际Studio六条链路：创建→重启读回；Agent保存→精确review；两窗口冲突→草稿保留；review后Agent修订→降级；删除→当前不命中但历史可见；disabled→用户可管理而Agent拒绝。确认导航不打断chat stream，记录步骤和实际证据。另用至少100次可控乱序响应验证scope/版本不会倒退。截图可作为review artifact，禁止把临时目录中测试数据库当用户数据。

## Task 8 — 文档、完整验证与独立评审

更新使用文档：首次默认关闭、按需读、人工/Agent来源、作用域、revision冲突、删除保留历史、没有自动学习/embedding。同步foundation/ADR和PR描述，禁止夸大为“自动学习”或“已验证事实”。

验证顺序：各受影响包定向行为测试→`pnpm format:check`（必要时format限定文件）→`pnpm lint`→`pnpm typecheck`→`pnpm test`→`pnpm build`。完整`pnpm check`一次即可；无新变化不重复全套。对10000条既定UTF-8 fixture记录硬件/Node、冷暖查询p50/p95、主线程响应性与取消cleanup耗时，报告实测不预填速度；跨scope泄漏/重复写入/虚假review均为0。

请独立reviewer检查：append-only/transaction/idempotency、scope授权、实时设置、Approval/readOnly/subagent边界、UI stale response、HTTP guard、shutdown顺序。修复发现后跑相应测试，最后重新确认完整checks。沿用用户既有完整流程授权commit/push/PR；中文Conventional提交示例`feat: 增加可审阅的长期记忆`。CI通过后默认squash merge并删除远程feature branch。检索功能另起最新main分支，不混入此PR。

## Review checklist（阻止虚假完成）

- [x] 新包边界、ADR、manifest与root ESLint一致。
- [x] fresh Session/Server restart、scope隔离有真实SQLite证据。
- [x] 记忆事实只追加，current/access/receipt仅凭事件可重建，commit uncertainty有fence；删除没有承诺历史擦除。
- [x] Agent没有自行把记忆标成user-reviewed；yolo不伪造人工审批。
- [x] tools经Pipeline，薄HTTP无Agent行为，subagent不升级权限。
- [x] UI六条链路可用，conflict/empty/error/stale请求均有行为测试；disabled不锁住用户管理，100次乱序回归通过。
- [x] 完整检查实际成功，独立review发现已处理；无未经授权commit/push。
