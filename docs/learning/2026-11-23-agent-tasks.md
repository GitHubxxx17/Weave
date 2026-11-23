# 原生子任务：使用与验证

Weave 的父 Agent 可通过 `agent_spawn` 委派独立工作，并继续当前会话。每个任务拥有原生子 Session、最多一次执行和一轮 Turn。`agent_status` 读取状态，`agent_wait` 有界等待结果或待审批操作，`agent_cancel` 明确停止任务。等待超时和浏览器断连只结束观察。子任务没有这些任务工具，深度固定为一层。

## 访问与运行边界

`agent_spawn` 默认 `access: "read-only"`；显式 `"workspace"` 可以使用父本轮已拥有的写工具。两者都只能获得父实际工具 authority 的子集。模型请求、instructions、LLM middleware 的最终请求和 Tool Pipeline 使用相同集合。工具本身仍经过既有 ask/trust/yolo 策略；工作区访问不会替用户批准工具。

任务共享 Project 文件夹，没有自动 Git worktree 或 OS 隔离。同时写相同文件仍可能冲突。可信 ESM、shell、MCP 与外部进程的行为也不因此获得新的沙箱保证。Project folderRevision 和目录身份检查可以关闭旧任务后续准入与受管理文件操作，但无法回滚已进入真实文件系统的操作，也不提供 OS 级原子比较交换。

父会话自然完成或失败后，已经接纳的子任务独立继续。父运行的 Stop 关闭该轮后续 spawn 并停止该轮派生任务；“停止全部子任务”只选择该根当前未结算任务。单任务 Stop 不影响兄弟任务。全停先持久化包含空集合的原始目标批次，重试同一操作不会加入后来创建的任务。

每个根最多四个未结算任务，全局最多十六个，每轮最多接纳十六个。每个子 Turn 最多五十步，接纳后十分钟为合作式执行时限。不合作的 Provider 或工具可能延迟清理；任务不会在真实清理完成前宣称结算。这些上限不是 token 或费用硬限制。

## Studio

父会话的“并行子任务”显示真实任务、访问权限、状态、耗时、待审批数量和结果入口。委派说明和访问选择只会准备普通父会话草稿，需要通过原有 Send 提交，由模型决定是否调用任务工具。

子会话使用已有 transcript、执行恢复和工具检查界面，Composer 只读。父草稿在父子切换时保留。全文入口指向已验证的子消息与 Turn。准备失败可能没有子执行或子 Session；界面会显示安全原因，没有可用的全文。

父子界面沿用相同 Approval Broker 与 approvalId。父界面只聚合 exact child Session、execution 和 Turn 匹配的请求。“拒绝工具调用”结束该次工具请求；Stop 停止整个子任务。

## Generation、恢复与关闭

子任务保留实际运行父 Generation 的不透明 lease，普通 reload 不替换它的插件工具或插件 Provider。主机 Provider 只继承公开 ID、模型和采样值，连接在子实际启动时解析；启动后本轮使用同一 client。删除主机 Provider 会让未启动子执行失败，重新添加同 ID 后新启动按当前连接解析。凭据不写入任务事实。

显式 Generation 撤销在同步通知前批量关闭受影响启动权。普通 withdrawal 在子 Turn 原子追加发出前取消尚未完成准入的子任务，追加发出后保留本轮，即使持久化回执仍在等待；immediate 撤销合作式取消受影响工作，managed ownership loss 保留准确 `ownership-lost` 原因。实际 Provider、iterator 和工具清理完成后才释放运行资源。取消意图和清理证据分别记录。

冷启动从 Project refs 与父 accepted 事实发现预分配子 ID，包括尚未 attach 的子 Session。缺失或尚未接纳执行的任务记准备中断；未完成执行修复为 interrupted，保留可确认的部分文本；已有终态补父结算。不会自动重新调用模型、工具或恢复旧审批。不确定读写与身份冲突保守阻塞。

关闭先关闭任务和执行准入，再清理 materializer、执行和持久化写者。结算无法确认时 shutdown 返回失败，Store 保持打开，下一次 stop 重试同一事实。不会用超时丢弃仍可能写入的工作。

## 观察与接口

HTTP 只提供列表、详情、SSE 和停止控制，没有 HTTP spawn。Studio 不导入 Runtime 或 Node。公开 DTO 不包含任务 prompt、设置、凭据或工具 authority。默认工具与树 JSON 按实际序列化 UTF-8 计量，最多 24,576 字节，并保留完整身份与全文指针。自定义更小的 Pipeline 输出上限仍可能截断。

任务树按未结算优先、最新接纳优先排序，默认首页十六条。SSE 最多排队六十四帧或 256 KiB，慢观察者断连后重连。活动 wait 与树订阅保留 root epoch；最近六十四个无订阅根有缓存，驱逐后使用新 epoch。旧 wait/tree cursor 会刷新，旧分页 cursor 需要重新读取首页。wait cursor 另绑定目标集合，已消费终态或同一待审批不会反复返回大正文。

## 实际验证

测试使用真实 Server、SQLite、临时 Project 文件夹和受控 OpenAI-compatible transport，覆盖默认只读零写入、工作区审批拒绝、同一个 approvalId 在 HTTP/tree/SSE 中出现、目录 A→空→A 后旧审批返回冲突与零文件操作。主机 Provider update/delete/readd 测试验证实际子启动解析和继承采样值。

生产 Studio 构建在 Chrome 验收了父任务完成后子任务继续、三个真实任务行、父界面审批、子 Composer 只读、单停保留兄弟、父草稿保留、审批拒绝及全文导航。刷新继续保持子会话一次性约束。SQLite 连续两次重启没有 Provider 重放；第二次日志与第一次修复后的前缀一致。真实持久化注入故障验证了 shutdown 失败后 Store 可读，并在恢复写入后只追加一次结算。

这些受控测试没有使用外部真实模型或提供方密钥。完整检查与独立审查结果见本主题实施记录；源码合同以 [设计](../superpowers/specs/2026-11-23-agent-tasks-design.md)、[ADR 0011](../adr/0011-one-shot-agent-tasks.md) 和各包行为测试为准。

最终本地 `pnpm check` 已通过，覆盖格式、Lint、类型检查、全部测试与构建；测试共 5080 项，其中 Server 1837、Runtime 601、Studio 833。`pnpm marketplace:check` 确认两个官方目录条目最新，`pnpm web-plugin:verify` 通过实际 CLI 产物、真实本地 HTTP/SSE 与 SQLite 重启验收。Generation 撤销测试另覆盖 Project 准入、Session 读取、最终 guard 同步撤销、已提交追加等待回执及已开始子任务保留。生产构建仍报告既有大 chunk 提示；浏览器 fixture 有禁用插件路由和 favicon 的 404，未将这些记录成无错误控制台。
