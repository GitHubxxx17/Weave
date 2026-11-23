# Weave 长期记忆设计

日期：2026-11-23。状态：沿既有连续实施授权采用，实施中。Multi Agent 已以 PR #108 合并为 `8ef1bb1`；本主题从该最新 `origin/main` 创建独立 `feat/long-term-memory`，对应一个 PR。

## 1. 结果与范围

用户可以在新的 Memory 页面保存、修订、查看历史、确认 Agent 保存的记忆及删除记忆。记忆可跨 Session 使用，以项目 UUID 或当前本地用户为作用域，具有明确来源和稳定引用。Agent 通过 Runtime 工具读取或提出持久保存操作，所有工具仍经共享 Tool Pipeline，写操作声明 Approval；UI 的明确人工操作直接调用同一 Runtime 服务。

本轮不自动总结聊天、不后台学习、不调用模型提炼、不把整个聊天记录或附件复制到记忆库、不把记忆自动拼入 system prompt。记忆是用户或 Agent 保存的陈述，不是已经验证的客观事实。`recall` 继续只精确取回当前 Session 中的工具结果，不改名、不扩展成语义记忆。

后续混合检索以当前已由用户审阅的记忆版本为语料之一；这份 PR 独立提供有界的本地记忆搜索与管理，不依赖检索 PR 或 embedding。

## 2. 已核对的现有边界

- `packages/session/src/memory-store.ts` 是 Session Event Store 的内存实现，不是长期记忆。`sqlite-store.ts` 的 Session 事件 append-only，使用自己的 `PRAGMA user_version=1`。长期记忆不得伪造 Session、扩充插件事件以藏入跨 Session 权威数据，或独立改动该数据库版本。
- `packages/runtime/src/context/recall-tool.ts` 从当前 Session 投影精确取回工具结果；没有 FTS、embedding 或长期记忆存储。
- `packages/workspace` 无内部依赖，仅被 Server 消费。项目 UUID 稳定，而 `folderPath` 可以修改；相同 Session 当前可以关联多个项目，因此 Server 不能沿用“找到第一个项目”的策略来授予记忆作用域。
- `ToolDefinition.readOnly` 控制只读运行的工具暴露，不代替 `approval`。`ask` 对 protected operation 要审批，`trust` 对未知 protected operation 保守审批，`yolo` 按现有契约自动执行；策略 `ask` 可以比 mode 更严格。现有执行上下文没有“确由人点击审批”的凭据。
- Studio 不可导入 `@weave/*`、Node 或 Electron。Server HTTP handler 应只做校验、授权与 DTO 映射，行为由 Runtime 服务承载。

## 3. 模块与依赖决定

增加 `@weave/memory` 叶子包：只依赖 `@weave/protocol` 和已有 Zod，使用 Node 内置 SQLite，实现记忆事实日志、当前投影、修订冲突和本地列表/搜索。它不导入 Runtime、Session、Workspace、HTTP 或 Plugin；没有 Agent 行为或授权决定。

Runtime 新增 `MemoryService` 与 `MemoryStorePort`、`MemoryScopeResolver`，仅使用 protocol DTO。Server 组合具体 SQLite store 与可信项目/用户作用域解析；Runtime 不导入 `@weave/memory`。Server 是该叶子包的唯一初始消费者。不是把知识领域塞进仅负责项目注册的 `workspace`，也不把它作为 `session` 的杂项表。

实施前必须更新 `AGENTS.md`、`docs/architecture/foundation.md`、新增 ADR、`eslint.config.js` 的工作区名称/允许依赖及 Server manifest。增量 DAG：`protocol -> memory -> server`，另有 `protocol -> runtime -> ... -> server`；这两条路径通过 Runtime 定义的端口组合。`memory` 无向上导入；Studio 仍只用 HTTP。

数据库采用单独 `${databaseFile}.memory.sqlite`，包含自己的版本元数据和迁移，WAL、busy timeout、foreign keys。Server 从规范化后的 Session 文件路径派生唯一 sidecar 路径；解析父目录别名，拒绝 sidecar 和所有权文件的 symlink、非普通文件及多重硬链接。每个 sidecar 只支持一个 Server 写入者。`@weave/memory` 在打开或迁移 WAL 前，先在 sibling `${memoryDatabaseFile}.owner.sqlite` 的 rollback-journal 连接上以短 busy timeout 获取并持有 `BEGIN EXCLUSIVE`，复用当前 managed store 的 SQLite 事务租约思路，不导入其插件权威。第二个进程或连接获取失败时启动明确报 `memory-busy`。进程退出由 SQLite 释放锁，正常退出在 Store、所有 read-only worker 和待确认写入关闭后才释放所有权连接。租约关闭前不删除所有权文件。所有权和数据文件丢失或身份变化令该 Memory owner 拒绝新操作。直接修改文件、访问同一 SQLite 的非合作写入者及非本地文件系统不在受支持模型内。不与 Session 的 `user_version` 竞争；本轮无新第三方依赖。

## 4. 契约与可见性

protocol 新增 `memory.ts`，对所有外部输入和 SQLite 读出用 Zod 校验，schema strict。

```ts
type MemoryScope = { kind: "project"; projectId: string } | { kind: "user" };
type MemoryReview = "user-reviewed" | "agent-authored";
interface MemoryRef {
  memoryId: string;
  revision: number;
  sha256: string;
  scope: MemoryScope;
}
interface MemoryContent {
  title: string;
  content: string;
  tags: readonly string[];
}
```

- ID 为 host 分配 UUID；scope 和 creation identity 一旦创建不可变。迁移作用域使用“复制到新 ID + 删除原记录”，不改写原事实。
- title 1..160 Unicode codepoints/640 UTF-8 bytes；content 非空且 UTF-8 <=8192 bytes；tag <=12 个，每项 1..40 codepoints/160 bytes。拒绝 unpaired surrogate；title/tag 不允许 controls，正文仅允许 TAB/LF/CR 三种 C0 controls，其余 C0/DEL 拒绝。tags 按 NFKC + locale-independent `toLowerCase()` 键去重后稳定排序，但保留正文原字节与标签显示值。普通 Markdown 作为数据，不执行内容。
- 同一 scope 至多 10000 个当前记录；list/search 每页 <=50，query <=512 codepoints/2048 UTF-8 bytes；游标为 host 验证的不透明版本化 cursor，不接受任意 SQL/offset 片段。
- `MemoryCurrent` 包含 ref、完整 content、createdAt、updatedAt、host provenance、review。列表只带 <=512 bytes excerpt。管理 HTTP 的单条读取可返回完整正文，history 默认每页 <=20 个版本头，正文另读 exact ref。工具结果同时限制 `Buffer.byteLength(JSON.stringify(value)) <= min(24576, effectivePipelineMaxBytes)` 和 `estimateTokens(JSON.stringify(value)) <= effectiveRunnerMaxToolResultTokens`。Server 注入与实际 Pipeline/Runner 共用的配置及默认值；defaults 分别为 32,000 bytes 与 8,000 estimated tokens。复用 Skill page 的实际序列化、按 Unicode code point 分页做法。list/search 先缩短 excerpt、再减行，按最后实际返回的 key 产生 nextCursor；`read_memory` 在完整正文无法放入时返回带 exact ref、code point offset、`text`、`eof` 和 nextCursor 的完整 JSON 页面。写入先确认最小 receipt 可用；若 metadata、一个查询项或一字符正文加 cursor 都不能前进，返回 `memory-limit`（禁止成功空页循环或截断）。HTTP 每页 <=64KiB。一般 Runner 历史压缩和全请求溢出仍走其现有规则；这里只保证本工具成功结果无需单结果截断。
- 记忆正文作为不可信数据，工具描述及结果明确标识其来源；不升级为 system/developer 指令。UI 使用现有安全 Markdown 渲染，不执行 raw HTML、不自动加载外链图片。

作用域授权以 Server 生成的 `MemorySessionMembership = { kind: 'none' } | { kind: 'unique'; projectId: string } | { kind: 'ambiguous' }` 为准，前提是当前 Session 存在且可读。查询失败、已删除和未知 Session 直接拒绝；ambiguous 返回 `memory-project-ambiguous`，即使仅请求个人数据也相同。Agent 参数可选 `scope: 'project' | 'user'`（省略为 Project），搜索另可用 `includeUser:true` 表示把个人结果加入项目搜索，两种形式不能同时指定 user 枚举和 includeUser。只有 `scope:'user'` 明确选择单独的个人操作，无项目时必须这样选择。`includeUser:true` 要求拥有项目和个人读权限，两者任一失效则拒绝整个请求。`user` scope 初始 `disabled`，local-user 将其设置为 `read-only` 或 `read-write` 才完成个人 opt-in，具体读写还受级别限制。Root 管理页面可显式选择实际存在的项目。Agent 参数中无 projectId 或用户 ID；收到 ref 时只与 host 已解析的允许作用域比较。

所有 child 仅可读已验证 task origin 的 Project。Server 用原 child token、匹配的 lineage/父 accepted fact 和 `accepted.project.projectId` 核验来源，再要求当前 child Session 唯一归属该项目。个人 scope 与 `includeUser` 对 child 均拒绝。记忆按项目 UUID 绑定，项目文件夹变化不会让记录迁移；Multi Agent 自己的 workspace lifetime fence 仍生效。

Scope resolver 产出 `MemoryScopeEvidence { membership, assertCurrentSync(): void }`。Server 使用现有 Project/Session 接线提供共享的每 Session mutation 证据：进入已有 attach 或 delete 路径时先换该 Session 的 generation 标记并增加 in-flight 计数，退出时再次换标记并清计数。捕获在异步读取前后检查 marker 一致及无 in-flight，mutation/返回前再同步检查同一个 marker；Production 的 Session 建立、task attach、`session.deleted` 共用此包装。该证据无新 detach API、无跨存储事务，且不反向取得 Execution/Project gate。测试可通过已支持的 `attachSession` 把现有 Session 关联到第二项目；普通 Session 删除继续使用既有 idle guard。只有使用同一 Server 持有的 Session/Project Store 的正式写入口有上述保证。

## 5. 事实日志、投影与审阅

权威表 `memory_events`：全局递增 `sequence INTEGER PRIMARY KEY`、唯一 eventId、kind、occurred_at、version:1、严格的 discriminated `subject_json` 与 `payload_json`。record subject 为 `{kind:'record',scope,memoryId,revision}`；access subject 为 `{kind:'scope-access',scope,settingRevision}`，不发明假的 memoryId/revision。SQLite trigger 拒绝 UPDATE/DELETE；Store/host 分配 ID 和时间，迁移不重写事实。

事件的 request envelope 包含 scope 内唯一的 `requestId`、canonical requestDigest、operation、host caller/provenance，以及稳定 committed receipt（event sequence、subject、结果 ref 或 tombstone/access revision）。`memory_current`、`memory_requests`、`memory_access_current` 全是可重建投影；request receipt 可从这些权威字段逐条重建，不能只在派生表留下幂等凭据。创建时先预分配 memoryId 并放入唯一事件/receipt，重试不生成另一个 ID。

事务 `BEGIN IMMEDIATE` 内先查 scope+requestId 的 exact receipt，再校验 expectedRevision、写事件与全部投影，一次 COMMIT。digest 使用固定版本 canonical JSON，固定字段顺序、UTF-8、显式字段存在性和既定 tags normalization。request digest 包含 operation/scope/host caller class、Agent invocation identity、目标 ID/expectedRevision 和规范化 payload。create 的 logical digest 排除事务内分配的 memoryId。request digest 也排除易变的 attempt token、审批 ID 和 access settingRevision，使同一持久意图仍可确认原 receipt。内容 digest 为 canonical `{title,content,tags}` 的 SHA256，排除 provenance/review/time。无效持久 JSON、未知版本和投影不一致明确失败或显式 rebuild。

事件载荷：

- created/revised 存完整规范化 content、content digest、前一内容 ref（创建除外）、host provenance 和 review。完整快照使历史不依赖 diff；同标题不合并。
- reviewed 只接受可信 local-user 管理调用，绑定当前 exact MemoryRef，产生下一 revision，完整内容与 sha256 保持相同、review 变为 user-reviewed。review revision 不是原 revision 的可变标记；重复相同 requestId 重放。新的精确 review 请求可再次记录用户对当前版本的确认并递增 revision，所有成功写入都有权威事件与 receipt，不产生无法重建的成功 no-op。
- deleted 产生下一 revision 的 terminal tombstone，记录 previousRef、actor 和可选有界原因，无当前内容 ref。删除 receipt 为 `{memoryId,revision,deleted:true}`；不伪称 tombstone 是可读 MemoryRef。
- access-changed 存 scope、`disabled | read-only | read-write`、expected settingRevision；初始 revision=0/disabled。每次成功写入（即使重设同一级别）递增 settingRevision；内容 revision 与设置 revision 互不混用。

UI 创建或编辑即对该版本标记 `user-reviewed`；Agent 工具保存的当前版本标记 `agent-authored`。Pipeline 审批通过代表允许操作，不伪造“人已审阅正文”的凭据，尤其不把 yolo 自动执行当人工 review。Agent 记忆可以明确搜索/读取；后续混合检索默认只收录 `user-reviewed` 的当前版本。Memory 页面提供“确认此版本”操作；没有强制重复审批保存过程，用户可以选择何时将 Agent 内容纳入 reviewed 语料。

审阅后 Agent 再修订该记忆会使新版本变成 `agent-authored`，旧版本不会自动作为当前检索语料。所有来源状态在 UI 直观展示，不用“已验证”名称。

删除是逻辑删除：管理 UI 显示当前内容会被隐藏，同时说明旧修订及曾进入 Session 的工具结果仍会保留。本轮不宣称物理擦除/加密擦除，不提供假“永久删除”。被删 ID 不接受普通 update/review，需显式复制为新 ID；历史仅由 local-user 管理页读 tombstone/旧版本。Agent search/read 不返回 deleted 或旧 revision，避免普通工具取回用户已从当前使用中删除的内容；曾写入 Session 的工具结果仍按 Session 历史存在。

## 6. 并发、重试与来源

写请求均含 `requestId` UUID 和 `expectedRevision`（创建 0，access 用 expectedSettingRevision）。UI 生成 UUID 并在重试中保持。Agent requestId 从版本化 SHA256 的前 128 bits 生成 UUIDv8，输入为 `weave.memory.request.v1` 与 canonical `[sessionId, executionId, turnId, toolCallId, operation]`。每次 `around.next()` 仍属同一逻辑 invocation，有独立审批 attempt。相同 scope+requestId 必须匹配 exact digest 和 host caller identity，改 payload 返回 `memory-request-conflict`。同一 Tool Call 在不同 scopes 中也不能造成两次 effect，事实与 receipt 投影增加 Agent-only 全局 invocation+operation 唯一键，intent 选择 scope 也纳入 digest；不同 scope 复用只返回常量冲突且不泄漏原 receipt。相同意图的重放先验当前 caller 对 scope/operation 的权限，再查 exact receipt，再检查新 mutation 的版本。receipt 只含稳定操作确认及 ref、tombstone 或设置版本，无正文或当前性承诺。

每个 base Pipeline `next()` 产生新的 private opaque `MemoryWriteAttempt` token。用 `WeakMap<ToolExecutionContext, MemoryWriteAttempt>` 绑定 summary/execute 的 exact context 对象，并用独立 WeakMap 保存 token 对应的 active request、exact registered definition、operation、阶段和已准备的 intent。该绑定只允许经过 `allowHostToolContext` 的 exact Memory write 定义；在 `finally` 移除 context 和 token 绑定。现有 `readAgentToolAuthority` 继续只识别正在运行的 `execute`，避免允许从 summary 调用 spawn/批准接口。新接口仅供 Runtime host Memory 工具内部使用，没有 context schema 字段、plugin SDK export 或靠关联 ID 查找 attempt 的入口。Plugin hooks 始终持有既有公开 context，看不到 token 或 intent。

```ts
function bindMemoryWritePreview(
  context: ToolExecutionContext,
  prepare: (
    caller: AgentToolInvocationAuthority,
    operation: MemoryWriteOperation,
  ) => Promise<{ intent: MemoryWriteIntent; summary: ToolApprovalSummary }>,
): Promise<ToolApprovalSummary>;

function consumeMemoryWriteAttempt(context: ToolExecutionContext): {
  caller: AgentToolInvocationAuthority;
  assertLiveSync(): void;
} & ({ kind: "approved"; intent: MemoryWriteIntent } | { kind: "automatic" });
```

`MemoryWriteOperation` 为 `'memory.save' | 'memory.delete'`，内部 `MemoryWriteIntent` 冻结 `{caller, operation, scope, membership, accessSettingRevision, targetRef, normalizedInput, requestId, digest}`。`targetRef` 是 revise/remove 的当前 exact ref，create 无目标；已存在 exact receipt 的预览保存 receipt 而无需从历史读取目标正文。`assertLiveSync` 每次核对 exact live invocation、definition、attempt、signal 和已消费的阶段。summary 构造前以及 await 后验证同一 binding，写入只读 preview slot 一次。批准成功后才把该 attempt 切换到 `'approved'`；yolo 且 policy 无 `ask` 才进入 `'automatic'`。policy deny、缺 Broker、cancel/timeout/reject 不进入 execute。每次 execute 仅消费一次，不能用 summary context、对象副本、别次 attempt 或绕过 Pipeline 的普通 context 执行。对 approved 路径，execute 重新 canonicalize 自己的输入并确认等于 intent，服务只写冻结的规范化 payload。automatic 路径在 execute 后按同一实时授权、expectedRevision 及 exact ref 生成意图，无批准凭据。

summary 包含具体 scope、title、operation、绑定 revision/digest、完整规范化新正文或精确差异、删除目标和来源。再次使用前先校验真实 root caller、当前 Session membership、作用域和操作权限。进入 Store 后先对现有 receipt 作 exact retry 检查，再为新写检查批准 intent 的 membership、accessSettingRevision（包括 A→B→A）和 exact target ref。等待批准时不持 gate，不自动 rebase。human Approval 仅授权操作，成功的 Agent 写一律 `agent-authored`。

Runtime 服务跟踪 pending writes，具体 Store 持有单 writer admission，按下列同步方法执行事务。`MemoryMutation` 为 strict discriminated create/revise/review/remove/setAccess 请求，含 request identity、operation、provenance、CAS 目标及验证数据。Runtime 定义接口，Server 对 `@weave/memory` 的结构等价具体类型作适配。

```ts
interface MemoryStoreWritePort {
  lookupReceipt(key: MemoryRequestKey): MemoryReceipt | undefined;
  commit(
    mutation: MemoryMutation,
    guard: {
      assertAuthorized(currentAccess: MemoryAccess): void;
      assertNewMutation(
        currentAccess: MemoryAccess,
        current: MemoryCurrent | undefined,
      ): void;
      beforeCommit(change: Omit<MemoryInvalidation, "liveEpoch">): undefined;
    },
  ): MemoryReceipt;
}
```

`MemoryRequestKey` 为 `{scope, requestId, callerKey, digest}`，exact mismatch 为冲突。`commit` 顺序为 BEGIN、实时授权（本地 Store 的权威设置及 caller/membership/signal 同步证据）、receipt lookup、当前状态和 new-mutation guard、产生 event/receipt，最后在不可 `await` 的短段调用 `beforeCommit`，写 event/projections 并 COMMIT。租约有效性在 transaction 前及 callback 后重新检查。精确 replay 在 new-mutation CAS 与 invalidation 前返回。出错先证明事务已离开（需要时回滚未提交事务），随后才用同一 key 的权威 receipt 查找确定 `committed`/`absent`。隔离仍未结束或 exact readback 失败为 `memory-persistence-uncertain`，保留原 key/预期事务证据及该 scope fence，拒绝普通读、写和 capture，Agent 逻辑调用也在其他 scope 被 fence。确认路径只能读结果，明确 absent 后才允许新的尝试。exact match 直接返回原 receipt，禁止重发未知事务。其他 scope 仅在已确认 SQLite 连接无活动事务时可继续。已提交后 cancel 或响应丢失不重做写入。进程重启仍以 SQLite 原子事实与 exact receipt 为准，无内存 pending work 重发。

provenance 由 host 赋值：`{actor: 'local-user'}` 或 `{actor:'agent',sessionId,executionId,turnId,toolCallId}`；child 还带通过多 Agent origin 核验的 `{taskId,rootSessionId,parentSessionId,childSessionId}` lineage，时间由 store 分配。这些都是有界 ID，不能接受浏览器或模型自报 actor/execution/task。复用多 Agent 的 opaque host-authority/可信运行上下文，不能把 plain JSON IDs 当权限；Agent 工具必须对应实际运行的 execution、Turn 和 tool-call fact，不存在的源消息引用不能自称已核验。可选 sourceRefs 只接受 host 能在该 Session 内验证的消息/工具 ID，或标注为普通用户文本来源说明。Agent 不能设置 actor、review、occurredAt、scope owner、previous digest。

不对内容自动去重合并；同标题不是同事实。UI 可以展示相似标题提示，但写入是否冲突取决于 ID 和 revision。记忆事件保留“谁保存了什么”，不声称已核验内容的真实性。

## 7. Runtime 服务与工具

Runtime 导出 `createMemoryService({store, resolveAgentScope, resolveLocalScope, beforeMemoryCommit, budgets})`。供受信 guarded HTTP 调用的 `local` 对象拥有 `list/read/search/history/create/revise/review/remove/getAccess/setAccess`，在 Server HTTP 映射处绑定 local-user 调用资格。`agent` 对象只从 exact live Pipeline attempt 或 execute context 取得 caller，提供 `search/read/prepareWrite/executeWrite`，没有 `review` 或 `setAccess`。Server 持有两个内部入口，无 JSON 角色分派。local-user 管理合法 scope，即使 Agent access 已关闭。Agent access `disabled` 禁读取及写入、`read-only` 允许读、`read-write` 允许读写，写入仍限 root。后续检索 port 同样要求项目 access 至少 `read-only`。Store 仅执行数据一致性校验和受信同步 guard。Runtime 不依赖 Hono、浏览器或 SQLite 类型。

Agent 工具为：

| tool            | 行为                                                                                                             | Pipeline                                      |
| --------------- | ---------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| `search_memory` | 当前 scope 本地 title/content/tag 查询，默认 user-reviewed，可显式 includeAgentAuthored；root 可显式 includeUser | readOnly:true，受访问控制                     |
| `read_memory`   | 读取允许 scope 中当前 live ID，可绑定 exact ref；正文必要时分页                                                  | readOnly:true，受访问控制                     |
| `save_memory`   | 创建或修订当前记录，不做自动提炼                                                                                 | readOnly:false；`memory.save` high Approval   |
| `delete_memory` | tombstone 当前记录                                                                                               | readOnly:false；`memory.delete` high Approval |

`search_memory` 的规范化为 NFKC + locale-independent `toLowerCase()`，作为带 `normalizerVersion` 的可重建投影。单/双 scope 合并使用统一排序，先 title 命中降序、updatedAt 降序、项目优先于个人、UUID 二进制升序。list 使用同一顺序且 title 命中固定为 0，history 以 revision 降序。query、cursor 边界及 scope 通过参数绑定。worker 用一个 SQLite read-only snapshot 读取每个 scope 的 durable head 和结果，不把全量正文送入主线程；总共最多 10,000 条候选记录及约 80MiB 源正文，双 scope 超界返回 `memory-limit` 并允许显式分别查询。普通 list/read 走有界索引。全局最多两个实际存活 worker，每次 query 5 秒，超时/abort 发 terminate 并跟踪直到 exit，slot 释放以 cleanup 完成计。调用的短等待给出 `memory-cancelled` 或 `memory-busy` 时 Store 仍保留该 worker 的 cleanup，shutdown 可在有界等待后报告 incomplete 并重试。source/dist worker 路径与最高规模响应性均需实测。

每个 Generation 通过 `registerHostTool` 安装 Memory 定义，Server 保存实际注册对象的 exact `read` / `root-write` 分类，第三方注册和同名定义不能声明它。`CreateAgentToolAuthorityOptions` 增加可选同步 host predicate `rootOnlyTool(definition): boolean`。root mint 将此值记录为该 exact captured entry 的 metadata；derive 对任意 child 先排除 root-only entries，再应用既有 readOnly/workspace 过滤。派生仍只收窄父条目。Memory composition 启用时，root 固定看到已安装的四个 Memory 工具，child 只可继承 search/read。Scope access 设置只改变实时执行能力，禁用后即使仍显示定义也不给正文或写入；同步 mint/derive 无 Project/SQLite 查询，无需 Generation refresh。工具描述说明调用以当前 scope access 为准。指令、最终 Provider 请求、Pipeline `assertAuthorizedTool` 均使用同一集合。Memory exact definitions 即使由缺 token 的 Pipeline 直接请求，也在 `around`/policy 前拒绝。Service 再拒绝无 live token、复制 context、child writes、错误 scope 和已关闭 access。现有插件定义、`readOnly`、permissionMode 与 owner/digest 检查照常。

工具与 HTTP 错误使用有限 MemoryError code：`memory-disabled`、`memory-read-only`、`memory-not-found`、`memory-stale-revision`、`memory-stale-cursor`、`memory-invalid-cursor`、`memory-request-conflict`、`memory-project-ambiguous`、`memory-scope-forbidden`、`memory-limit`、`memory-persistence-error`、`memory-persistence-uncertain`、`memory-busy`、`memory-cancelled`。Runtime 将这组显式代码映射到可恢复 `ToolExecutionError`；仅保留 host Memory 工具 summary/execute 抛出的已验证安全错误，不透传任意插件错误、SQLite SQL、文件路径、正文或 stack。异常摘要仍不能生成 Approval。

### 7.1 游标与读取一致性

cursor 使用版本化、HMAC-SHA256 签名且总长 <=2048 bytes 的 base64url payload，每个 Memory owner 启动生成 secret。编码 `{v,operation,queryDigest,scopeHeads,after}`，`queryDigest` 覆盖 canonical ordered scopes、入口类别、normalized query/tag/review filter、排序版本、请求页大小及目标 ID/exact ref（适用时），不含正文。`after` 为最后实际返回的排序键，也可为正文 code-point offset、history revision。用户可在 scope 与访问级别上重新授权后使用 cursor，cursor 本身不授予访问权。签名、shape 或 queryDigest 不符返回 `memory-invalid-cursor`，scope head 变化返回 `memory-stale-cursor`，客户端回首页。服务重启生成新 secret，客户端也回首页。read 的每页还需 exact current ref，revision 或 sha256 变化拒绝旧页。

scope head 是该 scope 最后成功追加的 event sequence（空 scope 为 0），在与事件相同的事务中维护，rebuild 可恢复。当前列举、搜索、history 在所列 scopes 中任一成功写入后重新从第一页开始，避免并发排序变化导致重复或跳项。rollback、拒绝与 exact replay 不改变 durable head。与此独立，进程内每个 scope 的 `liveEpoch` 在进入新写的 precommit 短段时递增，失败也不回退。读取 capture scope evidence、各 liveEpoch 和 durable head 后查询，worker 用同一读事务返回排序页面与 heads。Service 在输出前同步确认调用仍 live、scope evidence/current access/epoch 和 snapshot head 仍一致；epoch 失败返回安全的重读错误，未泄漏旧正文。worker abort 为合作清理，完整响应从未在退出校验前发送。

### 7.2 已审阅项目记录端口

```ts
interface MemoryInvalidation {
  readonly scope: MemoryScope;
  readonly memoryId?: string;
  readonly liveEpoch: number;
}

interface ReviewedMemoryCapture {
  readonly projectId: string;
  readonly settingRevision: number;
  readonly liveEpoch: number;
  readonly records: readonly {
    readonly ref: MemoryRef;
    readonly content: MemoryContent;
  }[];
}

interface ReviewedMemorySource {
  capture(input: {
    readonly projectId: string;
    readonly refs: readonly MemoryRef[];
    readonly signal: AbortSignal;
  }): Promise<ReviewedMemoryCapture>;
  assertCurrentSync(capture: ReviewedMemoryCapture): void;
}

type BeforeMemoryCommit = (change: MemoryInvalidation) => undefined;
```

Server 只向未来受信 retrieval compositor 注入 `ReviewedMemorySource` 对象；不向插件、Agent 或 HTTP DTO 暴露。其调用方先核验同一 pinned Project authority。`capture` 要求 1..48 个显式互异 refs，全部是该 Project scope，在同一次短 read snapshot 中校验 access 至少 `read-only`、当前 live ref 全等、`user-reviewed`。任一不符则整体拒绝。已成功捕获的对象冻结，并由私有 WeakMap 核验 exact 对象及本 owner 身份。`assertCurrentSync` 检查 Memory open、project scope liveEpoch、settingRevision，每次调用可在最终 effect admission 同一同步段运行。capture 是同一进程内的权限证据，不作为索引持久权限；重启、已存索引或历史 ref 必须按当前权限重新 capture。Memory 无跨源检索或任何外发。

`beforeMemoryCommit` 仅在 live authorization、exact receipt miss 和新写 CAS 通过后同步调用。Runtime 先递增 scope liveEpoch，再通知 `{scope, memoryId?, liveEpoch}`，仅 record 事件含 ID。首版 capture 按 scope epoch 保守失效，即使新写只改项目内另一个 record；后续消费者可用 ID 确定受影响的记录，但验证收敛到同一 scope epoch。同步回调只设置消费者 fence，不反向进入 Memory、跨 gate 或立即执行 abort listener，在 gate 外安排 abort。callback 非同步返回或抛错时不继续写入，epoch 保持递增。SQL 回滚、重试和已完成 receipt replay 都不让失效的 capture 恢复。Memory PR 组合空回调并用 fixture 验证此端口；retrieval 另行组合实际调用。

成功搜索/读取结果走普通 tool result，由现有 Runner 在下一模型请求前持久记录；不新增自动 prompt section，不新增 memory Session event union。修改失败不返回虚假的成功事实。

## 8. Server HTTP 与 Studio

新增 `/memory/scopes`、`/memory/records`、`/memory/records/:memoryId`、`/memory/records/:memoryId/history`、`/memory/records/:memoryId/review`、`/memory/records/:memoryId/delete`、`/memory/access`。写入统一 POST JSON，`/memory/records` 使用 `operation: 'create' | 'revise'` 判别。读取历史必须指定 scope 和 memoryId。

所有端点（包含敏感 GET）在全局 CORS 前用 `registerAgentExecutionGuards` 已有 prefixes 参数保护 `/memory` 与 `/memory/*`，并复用 `readExecutionJson` 和 `Cache-Control:no-store`。请求体 <=65536 bytes，覆盖最坏 JSON escaping 后的合法内容，schema 字段限制另行执行。HTTP 只做 guard/Zod/映射调用服务，409 表示 stale revision、stale cursor 或 request conflict，invalid cursor 为 400，404 不泄漏其他 scope，503 为存储不可用。

Server composition 创建 store、唯一项目 scope resolver 和 MemoryService，并把工具工厂接入 host 工具注册。Memory owned resource 提供 `{ closeSync(): void; drain(): Promise<void>; close(): Promise<void> }`。`closeSync` 在 `stop()` 第一个同步段 fence 全部入站请求、工具和 capture，再取消等候 Approval 的 Memory attempts 与 reader worker。使用 Server 关闭信号与 attempt 信号的组合去阻止未开始 effect；若在 `drain` 前仍有 Runtime handler 在途，所有 Store promise 和 cleanup 均跟踪到真实完成。`drain` 随现有 task/execution writer barrier 在关闭任何依赖之前等待在途写、只读 reconciliation 和 worker exit，内部有界等待最多 5 秒（单调 deadline）。未确认提交或实际 cleanup 失败返回 incomplete，注册当前 close attempt 可重试，保留 Memory Store、owner connection、Project/Session Stores 及仍在清理的 Generation。第二次 stop 处理同一个 pending entry 和 terminate promise，只重读 receipt/等待清理，从不重新发出写。成功后先关闭 Memory 数据连接再释放 ownership 连接，任何关闭失败仍保留 retry ownership 与依赖。`failStartup` 同样经 writer barrier 后走这一序列。Memory close 成功才继续关闭依赖或收尾。若 Store 构造在获取 owner 或 data 后失败，先按 data→owner 顺序尝试同步清理；data close 抛错时不能释放 owner，即使 data 已关闭但 close 确认丢失也保留 owner 至下一次清理。清理未完成时，叶子包抛出带私有品牌的 `MemoryStoreStartupError`（安全 code 为 `memory-persistence-error`），携带同一已获取资源的受信 `{closeSync, drain, close}` 清理端口。重试依据真实 `database.isOpen` 继续关闭，不重新打开数据库或释放租约，不重做迁移或写入；任一步失败仍保留同一端口。Server composition 仅捕获该叶子导出的确切错误类，在 rethrow 前经 `registerResource` 注册其 cleanup，使 Main 的 `failStartup` 和 `retryFailedServerStartupCleanup` 继续保留 Session/Project 等依赖并重试原资源。普通持久化错误无清理权威，也不接受 JSON 形似 cleanup 的错误。测试使用临时路径。

Studio 新建 `features/memory/`：client+runtime validators、MemoryPage、MemoryEditor、MemoryHistory；`App.tsx` 仅新增导航与已选项目/Session 的接线。左侧 Memory 入口显示项目/个人 scope、访问级别、title/tag/query filter、当前来源状态、分页；详情展示正文、provenance、revision、history。

人工创建/编辑点击保存就是对具体内容的授权，直接走同一 Runtime 服务，不为 UI 自己制造 Agent Approval。删除确认展示 title/scope/保留历史语义；review 显示准确版本，409 保留草稿并让用户重新加载。切换 scope/project 后旧请求不能覆盖新页面；AbortController + request identity，禁用使用权限立即清空 Agent/检索缓存并阻止新读取；本地用户管理视图保留并展示“已停用使用”。UI 不从 arbitrary file:// 或 memory:// 自动打开来源，源 Session 使用已验证 Session ID 导航。

## 9. 验收与风险边界

- Session A 经批准保存，重启 Server，Session B 同项目可以明确找到；另一个项目不可见，user scope 需 opt-in。
- revisions/tombstone/request receipts 可重建；禁用、read-only、并发编辑、审批等待时变更都 fail closed。
- 关闭页面/断连不重复写；已写成功响应丢失可幂等重试；进程失败不出现半条事件或投影。
- 历史内容不会因删除被声称抹除；检索仅消费当前已审阅版本，review 后再改会失去 reviewed 状态。
- 不自动发送记忆给任何模型/embedding，不自动注入 prompt。只有明确工具读取产生正常的模型上下文数据。

限制：当前是单用户本机服务，不提供多租户鉴权；本地 Origin guard 不等于 OS 权限隔离。SQLite append-only trigger 是应用/普通连接约束，不防持有数据库文件写权限的人。持久内容及历史是本地敏感数据，沿用现有本机存储权限，不承诺未实现的加密。

作为前端 AI 简历作品，本 PR 的展示范围集中在可管理的持久状态：Memory 编辑/历史/审阅/冲突恢复和跨 Session 使用，不增加自动学习、知识图谱或后台总结平台。验收固定六条实际 Studio 路径：用户创建→重启读回、Agent 保存→精确审阅、两窗口冲突→保留草稿、review 后 Agent 修订→降级、删除→历史可见且当前不命中、disabled→用户仍可管理而 Agent/检索拒绝。记录每条步骤、浏览器证据和对应行为测试，不能只用静态截图证明完成。

规模测量使用 10000 条既定 UTF-8 fixture，报告硬件/Node、冷/暖查询 p50/p95、主线程可响应性与取消清理时长，不提前填造指标。跨 scope 泄漏、重复写入、错误 review 来源均必须为 0；构造至少 100 次乱序 UI 响应，旧 scope/版本不得覆盖新状态。

## 10. 实际核对的官方参考

以下为 2026-11-23 实际读取内容，实施时复制来源到 foundation Product references：

1. Codex 固定 `a0995c2b2b68248960c69cb812b5f4898dac7e4c`：[memory protocol](https://github.com/openai/codex/blob/a0995c2b2b68248960c69cb812b5f4898dac7e4c/codex-rs/app-server-protocol/src/protocol/v2/memory.rs)、[thread memory reader](https://github.com/openai/codex/blob/a0995c2b2b68248960c69cb812b5f4898dac7e4c/codex-rs/app-server/src/request_processors/thread_memory.rs)、[memory migration](https://github.com/openai/codex/blob/a0995c2b2b68248960c69cb812b5f4898dac7e4c/codex-rs/state/memory_migrations/0001_memories.sql)。采用明确版本和 unavailable 不悄悄回退、来源和作业状态分离；不复制自动 consolidation、阈值或作业租约系统。
2. Harness 固定 `4b399c39a6d1479cd84ca591b4d7c88e24d38a96`：[MCP memory guide](https://github.com/deepseek-ai/deepseek-harness/blob/4b399c39a6d1479cd84ca591b4d7c88e24d38a96/docs/user/guide/mcp-memory.md)。它的示例默认关闭，明确子串检索不等于语义搜索、安装不等于迁移/质量保证。采用新 Session 同 scope 的可观察验收，不安装第三方 memory server。
3. Kiro 官方 [Memory](https://kiro.dev/docs/memory/)（文档含 1.4.236/1.4.215/1.4.121 版本说明）及 [CLI context](https://kiro.dev/docs/cli/chat/context/)。采用 title/content、全局/仓库 scope、可检查/编辑/删除和 read-only 控制、按需上下文。Weave 使用项目 UUID，首轮不采用自动学习；subagent 不自行写父记忆。

没有把 Codex/Kiro/Harness 的沙箱、权限保证或内部迁移权威套给 Weave。所有上述访问授权、append-only 与 Pipeline 行为以本设计和自己的测试为准。
