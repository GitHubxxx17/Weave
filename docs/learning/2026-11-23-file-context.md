# 项目文件引用：发送时快照、排队与上下文预算

用户可以从输入框的 `@` 菜单、工具栏文件搜索或文件树内容标题栏选择文件。选择产生独立标签，普通文字 `@a.txt` 不会自动授权读取。工具栏有独立搜索框，支持带空格和 Unicode 的完整相对路径。

## 为什么在接纳前读取

浏览器只提交有序相对路径。Server 查找 Session 所属的唯一 Project，确定根目录，再组合 Runtime 的核心捕获端口。Runtime 在队列容量和采样设置确认后、`execution.accepted` 持久化前，读完整批文件。正文只保存在该 fact 的 `fileContext` 中；用户消息、logical input 和后续队列投影不复制正文。

这使三种操作的含义明确：

- 相同 request ID 和相同 input 的传输重试返回原 acceptance，不重新读取文件。
- 队列开始执行时使用原快照；期间修改、删除文件都不会替换内容。
- 复制队列消息或从历史重新运行会生成新 request ID，读取当前文件。刷新后的重新运行从原用户消息的摘要恢复有序路径。

append 抛错可能发生在写入成功之后。现有调度器会重读确认 exact batch；无法确认时保留 ownership 和容量预留并阻塞，而不会重新捕获并覆盖旧输入。捕获失败发生在 append 前时则是确定拒绝，草稿可继续编辑。

## 层次与模型输入

Protocol 只定义路径和摘要；Session 定义捕获内容、完整性和 exact message/Turn 关联；Runtime 实现捕获、admission 和模型渲染；Server 持有 Project 根目录与关系的 authority；Studio 使用独立 HTTP schema。插件、Tool Pipeline、审批和 Generation 的职责不变，排队不提前选择 Generation。

Runner 在 Turn admission 的同一次 store read 中，验证关联捕获的 execution 已 claim、身份三元组和有效输入完全匹配、该 Turn 尚未创建。execution、Turn 或用户消息任一身份关联已有 capture 都会触发校验，防止省略 refs 或伪造另一 execution ID 后追加无效事件。

历史读取把已开始用户消息与保存的 capture 关联，追加确定的 v1 JSON 文本 part，再进入上下文构建。初始请求、工具返回后的循环及未来 Turn 都走同一条渲染路径。未修改的 tool message 保持对象身份，因为工具状态映射以对象为键。用户消息中的原 prose/images 与文件内容一起进入预算；窗口不足会失败，不截断用户文件，middleware 修改后的最终请求也再次计量。

文件 JSON 和说明仅表示不可信用户数据，不构成 prompt injection 防护，也不赋予工具、审批或插件权限。

## 有界捕获与实际限制

最多 8 个完整 UTF-8 文件，每个 65,536 字节，全批 262,144 字节。任一文件不满足条件则整批拒绝。严格解码保留 BOM、CRLF、空文件和尾部换行，重新编码必须与原始字节相同，拒绝 NUL 与非法 UTF-8。字节数和 SHA-256 来自原始字节。

路径按 JavaScript UTF-16 code units 限制为 1,024；当前 Zod 的字符串 max 按码点计数，所以额外检查 `path.length`。不 trim、decode 或归一化合法路径，拒绝绝对路径、上级路径、空段、反斜杠、冒号及指定控制字符类别。

捕获使用现有协作式根目录 mutation queue，逐段检查路径，末段以 no-follow/nonblock 打开，再检查实际 handle 的 regular-file、单链接与 incarnation 证据。读取有 max+1 上限，读后复查 metadata、路径和根目录；所有 handle 在 finally 关闭。Server 同时复查 Project/Session 关系与根配置。

这些 Node 路径检查只能拒绝观察到的变化。父路径仍可能在检查与打开之间被外部进程替换，root queue 也不覆盖 shell、MCP、插件或外部写入者。它没有 descriptor-relative beneath-root 原语，不是 OS sandbox，也不保证多个文件处于同一个原子时点。

捕获使用 service-owned 的合作式 5 秒截止信号；HTTP 断连不取消已接纳工作。关闭会中止捕获，但必须等待底层读取清理，不能把未结束的 I/O 用 Promise.race 脱离后台。普通文件系统调用不保证硬截止，慢根目录队列可能延迟其它 Session 的 admission/control；本次未顺便重写 scheduler 或引入 pending reservation 子系统。append 开始以后只能根据持久事实判断结果，不能把截止信号误称为未接纳。

公开 execution snapshot、Session detail 和 queue SSE 只提供路径、encoding、字节数、摘要或文件数。捕获正文和宿主 identity 不进入这些接口；完整内容仍随 append-only Session facts 保留。

## 已执行验证

Protocol/Session 独立审查检查严格 schema、旧无文件日志、summary-only 增量缓存、exact started-message join。Runtime 审查发现并修复了伪造 execution ID 但复用捕获 Turn/user-message ID 的入口，回归要求拒绝前零 append、零 provider。Studio 审查修复了工具栏完整路径搜索缺失，以及引用/替换草稿后旧 `@` token 范围误删文字的问题。

真实生产 Studio + startServer + SQLite + 可控本地 Provider 验证了：

1. 从 `@` 和文件树分别添加文件，移除后重加，发送时展示有序快照摘要。
2. B 排队后把 `a.txt` 从 `FILE-BEFORE` 改为 `FILE-AFTER`，刷新后停止 A；B 启动仍使用 BEFORE，队列中的 C 保留。
3. 复制 B 后重新发送的 C 使用 AFTER；刷新后重新运行又创建独立 execution/Turn，并恢复原路径。
4. 超大文件和非法 UTF-8 均拒绝，保留文字与标签，未创建 acceptance/Turn。
5. 修复后的工具栏支持 `src/中文 file.ts`；引用回复会关闭旧 token 菜单，保留引用文字与原 `@a`。
6. 最终四次 provider 调用为取消、完成、完成、完成；Session 四个 Turn、八条消息，队列为空，页面 warning/error 日志为空。公开历史没有文件正文。

该 fixture 验证实际 HTTP/SSE、UI 与持久化组合；不代表真实模型质量、网络吞吐或文件系统安全证明。官方参考的具体源码版本、文档日期与 Weave 取舍见 [设计](../superpowers/specs/2026-11-23-file-context-design.md) 的参考段落。
