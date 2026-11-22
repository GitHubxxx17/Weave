# 声明式插件面板

插件市场位于左侧导航，负责发现、安装、审阅和激活。插件提供的自定义面板使用右侧
标签系统：激活不会自动打开标签，用户从添加面板菜单选择需要的面板。

## 使用质量报告示例

仓库提供 `examples/plugins/quality-report/`。它保存已经收集到的报告，并显示分数、
总结和检查项；它不会自己运行 linter、测试或 CI。

从实际 Weave checkout 根目录验证已有 payload：

```sh
pnpm plugin:validate --artifact /absolute/path/to/weave/examples/plugins/quality-report
pnpm plugin:pack --artifact /absolute/path/to/weave/examples/plugins/quality-report --out /absolute/path/to/new-release
```

`new-release/payload/` 是可导入目录，receipt 留在目录外。通过左侧插件市场的本地
导入流程准备候选，审阅权限和贡献，再明确激活。也可将该示例放入明确配置的手动
插件目录，在管理界面审阅目录摘要并信任。文件发现、导入和验证都不等于激活。

添加右侧“质量报告”标签后，选择真实 Session。没有报告时显示空状态。使用本地
Mock Provider 时，可以发送示例 README 中的 `/tool quality_report ...` 调试消息，
通过 Agent 和共享 Tool Pipeline 写入报告；真实模型下使用普通语言要求收集证据和
调用该工具。报告内容来自工具输入，分数本身不是宿主验证结果。

表单中的“准备到对话”将选项展开成完整提示词，追加到当前可见草稿。用户检查和
编辑后明确发送。打开、刷新面板或准备文字都不会发送消息、运行工具或新增 Session
事件。已有文字、图片和 Skill 选择保留；准备后的草稿按文字直接发送，避免后来
同名命令改变其含义。显式重新选择斜杠命令会恢复普通命令展开方式。

## 作者契约

面板使用 schema-1 单文件 ESM 插件、`panel` capability 和显式
`contributes.panels`。在工厂收到的 SDK 上通过 `sdk.panelsExtensionPoint` 贡献，
不要在插件入口运行时 import 宿主包。`schemaVersion:2`、`host:declarative` 的文本
发行包仍只接受 Skills。

面板定义由宿主校验并快照，只支持 heading、text、status、metric、key-value、table
和 form。`chart` 只是图标名。不能贡献 React、HTML、Markdown、CSS、URL、iframe、
任意回调或直接执行按钮。表单只支持 text、boolean、select 字段，默认值来自声明。

数据 source 必须绑定同一候选插件真正成功注册的事件；form 必须绑定同一插件真正
成功注册的命令。仅在 manifest 列出事件或命令不足以绑定。宿主复制命令提示词，
不会在点击时按名字重新解析。数据路径是受限的字面记录属性路径，没有数组索引、
JSONPath、继承属性或原型访问。只有 table rows 绑定可以返回数组。

完整可运行的 SDK、事件、工具、命令和面板组合见质量报告示例；精确类型、路径
限制和预算见[规范](../superpowers/specs/2026-11-22-plugin-panels-design.md)。

## 生命周期与数据含义

稳定标签 ID 为 `plugin:<owner>/<local-panel-id>`，持久化只记录布局身份，不记录
授权 ref、代码、endpoint 或事件内容。重启后，旧标签先等待新目录确认；插件缺失或
不可用时保留占位。现有终端和预览实例 ID、顺序、固定状态继续保留。

授权 ref 绑定当前 Server、Generation 和已观察到的插件权限状态。重载、观察到权限
变化或撤销后，旧 ref 失效，即使旧回合仍持有已退役 Generation。面板不固定
Generation，也不会通过旧标签访问退役插件。未观察到的磁盘变化不在这项保证内。

Server 读取原始宿主 Session store，选择最近的精确事件类型，只投影所需字段。
HTTP 读取不调用插件的 schema、projector、service、factory 或工具。最新事件版本
不兼容时显示 incompatible，不回退到更旧的报告。历史事件只证明持久化了该类型和
payload，不证明来自哪个历史发行目录。

数据和准备操作依据实际读到的连续 Session 事件前缀。前缀包含归档时仍可看数据，
不能准备命令；包含删除时拒绝两者。并发归档或删除如果在读取前缀之后发生，当前
响应可能仍依据旧前缀返回。这里没有新增 Session 原子删除锁。

## 预算和验证范围

每插件最多八个面板，候选总数最多 128；每定义 64 KiB、完整目录 1 MiB、完整数据
64 KiB。表格最多返回 100 行并显示截断数量。选中字段过大显示 data-too-large；
文本不会悄悄截断为看似完整的数据。准备请求最多 16 KiB，最终提示词最多 32 KiB。

缓存和并发限制约束保留的投影、响应和准入工作。底层 Session store 可能一次物化
全部冷历史或增量，也不能强制取消，因此这些限制不是整个进程的内存或 CPU 上限。
关闭流程等待真实存储读取结束再关闭数据库。

该 SDK 属于同进程受信任插件机制，不是 OS/Node 沙箱。普通 getter 在定义快照前被
拒绝，Proxy 的反射 trap 在候选组装期间仍可能执行。借鉴 Codex、Harness、Kiro、
Kimi 的原则与固定来源见[参考审计](2026-11-22-official-plugin-references.md)，不把
这些产品的隔离保证或未核实的面板 API 套用到 Weave。

## 本轮验证记录

2026-11-22：Plugin、Server、Studio 独立审查通过，复现的问题已增加回归。
全仓 `pnpm check` 通过，共 4,121 项测试；真实 HTTP/SQLite 示例验证报告写入、
读取、准备不产生事件、重启、重载、撤销、归档与删除。两端 DTO 使用实际 HTTP
输出生成的相同 fixture 验证。临时数据目录的浏览器验收覆盖添加面板、报告展示、
准备保留草稿、明确发送、刷新恢复以及撤销/恢复信任。
