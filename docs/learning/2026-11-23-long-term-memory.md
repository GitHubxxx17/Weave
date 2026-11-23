# 可审阅的长期记忆

Weave 的长期记忆是显式保存、跨 Session 使用的本地记录。Studio 左侧的“记忆”入口
管理项目和个人两个范围；项目使用稳定 UUID，不随文件夹改名迁移。每个范围首次默认
停用 Agent 与检索使用，用户仍可查看、编辑、审阅和删除。个人范围独立启用。

## 使用与来源

人工创建或编辑表示用户确认具体内容，生成“已审阅”版本。Agent 通过
`save_memory` 保存的版本始终显示“Agent 编写”，包括人批准了工具操作及 yolo 自动
执行两种情况。审批表示允许操作，不能代替正文审阅。“审阅版本 N”绑定当前准确的
revision 和 SHA256，产生新修订；后续 Agent 编辑会使当前版本回到尚未审阅状态。

`search_memory` 默认查找当前项目的已审阅记录，可显式包含 Agent 编写记录。
`read_memory` 按需读取当前记录，较长结果提供完整 JSON 分页。个人范围需要显式选择
和单独访问设置。子任务只可读其已核验来源项目，不继承保存、删除或个人记忆权限。
停用后仍显示工具定义，实际调用实时拒绝，避免把旧工具列表当作持久授权。

编辑冲突返回 409 并保留本地草稿。未改变的重试保留 requestId；用户重新加载版本后
才开始基于新版本的编辑。标签每行一个，逗号及有效空格是标签内容。Markdown 按普通
不可信内容渲染，不执行 HTML 或自动加载外部图片。

删除写入 terminal tombstone，使当前搜索和列表不再命中。当前选中的删除详情仍可
查看历史版本；首轮没有独立的“已删除记录”目录，已知 ID 的管理 HTTP 历史仍可读。
旧修订和已进入 Session 的工具结果保留，没有物理擦除承诺。

## 权威与恢复

`@weave/memory` 是仅依赖 protocol 的独立叶子包，只由 Server 消费。Runtime 定义
结构端口和 MemoryService，拥有调用凭据、作用域、实时权限、审批意图和结果预算。
Studio 只使用 guarded HTTP。记忆不写入 Session Event Log，不改变它的数据库版本。

事实日志只追加；当前记录、访问设置、请求回执和 scope head 都能从事件重建。
内容修订与设置修订分开。事务先检查当前授权，再确认 exact receipt；仅新的 effect
检查 CAS 并同步使旧读取/capture 失效。Agent 的逻辑调用 identity 同时约束跨 scope
以及 create/revise 的 `memory.save` 重试，不能通过改变参数产生第二次 effect。

每次 Pipeline `around.next()` 绑定独立的 exact preview 和执行上下文。私有 WeakMap
关联真实 caller、definition 和冻结意图；复制对象或序列化 ID 不能获得权限。批准后
再次检查项目关联、设置修订、准确目标和调用存活状态。审批元数据的对象、函数、操作名
与高风险级别也在等待及执行期间复核。

`${databaseFile}.memory.sqlite` 使用独立 WAL 数据库，sibling owner SQLite 连接以
rollback-journal `BEGIN EXCLUSIVE` 持有一个支持的 Server writer。读取 worker 可以
在 owner 持锁时读取 WAL。文件身份丢失永久撤销当前 owner；符号链接、多重硬链接和
非普通文件拒绝打开。它不是对不合作文件写入者的操作系统隔离保证。

COMMIT 后确认丢失不会重发事务。Store 保留原 key 及 scope/逻辑调用 fence，通过原
回执只读确认 committed 或 absent；服务内的同一请求也能在临时故障恢复后重试确认。
当前授权仍在回执返回前检查。未确认的事务、worker 退出或关闭保留原资源和 owner，
关闭流程可重试。构造器中途失败的部分资源同样通过可信 cleanup port 保留，数据连接
实际关闭后才能释放 owner。

## 验收与测量

实际 Studio 生产构建配合受控 Provider 和临时 SQLite 验收了六条路径：

1. 用户创建，重启 Server 后读回相同内容与版本。
2. Agent 经高风险工具审批保存，页面显示 Agent 来源，用户准确审阅产生下一版本。
3. 两个窗口并发编辑，同一旧版本保存返回 409，原窗口草稿保留。
4. 审阅后 Agent 再修订，当前来源重新显示尚未审阅。
5. 删除后当前列表不命中，已审阅的旧版本仍可从详情历史读取。
6. 停用后用户仍能管理记录，Agent 的实际 search 调用返回 `memory-disabled`。

控制模型没有访问外部模型服务。浏览器中的预期 409、关闭重启时 SSE 断连，以及 fixture
未提供的 managed-plugin/favicon 404 分别记录，不把它们描述成“console 无错误”。
另有 100 次逆序响应、StrictMode 写入、scope 切换和旧历史返回的行为测试。

最终 `pnpm check` 完整通过，包含格式、lint、类型检查、5,204 项包内测试和依赖顺序
构建。`pnpm marketplace:check` 与 `pnpm web-plugin:verify` 也通过；构建后的 Memory
smoke 使用真实第二进程验证单 writer 排斥、SIGKILL 后回执恢复和只读查询 worker。
独立 Store/Protocol、Runtime/Server、HTTP/Studio 和最终组合审查均已完成。

规模 fixture 为 10,000 条记录，每条正文 6,300 UTF-8 字节，查询 `严格`、每页 50 条。
机器为 Apple M4 Pro / 24 GiB / Darwin arm64，Node 24.4.0：

| 测量                                        | 结果             |
| ------------------------------------------- | ---------------- |
| 写入 fixture                                | 7,011.8 ms       |
| 重开 Store 后第一次查询，3 次样本 p50 / p95 | 500.4 / 515.9 ms |
| 暖查询，12 次样本 p50 / p95                 | 496.5 / 555.6 ms |
| 暖查询期间主线程最大延迟                    | 11.5 ms          |
| 取消到实际 worker 清理                      | 2.4 ms           |

首次查询没有清空 OS 文件缓存；这些是本机测量，不是跨机器速度保证。搜索最多两个实际
存活 worker，合并 scope 候选最多 10,000 条，超过限制返回明确错误。每次查询期限为
5 秒，slot 在实际 exit 后释放。工具成功结果同时满足实际 JSON 字节和 Runner 的
estimated-token 上限；预算不足时拒绝，不返回无法解析的截断 JSON 或空页循环。

这轮不包含自动学习、后台总结、FTS、embedding、语义搜索或自动 prompt 注入。
后续检索只通过当前、准确、已审阅项目版本的内部 capture port 取得语料，外发授权
属于后续独立设计，普通 Memory 工具批准不赋予 embedding 外发权限。
