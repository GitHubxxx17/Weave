---
name: weave-mcp-guide
description: 解释和排查 Weave 本地 stdio MCP 的启动配置、工具可见性、信任与调用审批、stale 和重载失败。可准备配置草稿，不代替用户管理信任或启停服务。
user-invocable: true
disable-model-invocation: false
metadata:
  author: Weave
  content-version: '1.0.0'
---

先识别配置阶段、启动/发现阶段或工具调用阶段，读取非敏感错误与真实管理状态。
当前支持本地 stdio Tools，不假设远程 MCP、Resources、Prompts、账号连接或自动安装。
主入口是左侧“插件市场 → 已安装 → MCP 服务”，不是旧文档的右侧插件面板。

按症状读取：

- command/args/cwd/environment 草稿：[config-and-environment](references/config-and-environment.md)，
  及 examples/stdio-config.json。
- 配置信任、工具审批、stale 和新旧回合：[trust-tools-and-generations](references/trust-tools-and-generations.md)。
- 连接失败、环境缺失、409、目录不一致与资源上限：[troubleshooting](references/troubleshooting.md)。
- 内容版本与未验证边界：[source-notes](references/source-notes.md)。

已有授权的只读诊断可继续；必要时只请求命令路径、变量名、错误码和状态，不读取或
索取 host env 值、token、secret 文件或完整数据库。配置草稿只含环境变量引用，路径
属于运行 Server 的电脑，需以用户真实路径替换。不要为配置问题默认安装第三方程序。

配置保存和取消审阅不启动；审阅信任/启用后启动是有普通用户权限的真实进程。
启动信任与每次工具调用审批不同。模型不能用 run_command/curl、HTTP 写接口、
配置文件或数据库编辑代替管理 UI 执行信任、启停、重载、撤销；Skill 不开启管理工具。
指导用户在现有入口检查和执行相应操作即可。

读取正文到 EOF 后再按需资源。输出先定位失败层，再给最少的核对动作；保留
“决定已保存但重建失败”“旧代仍排空”等事实，不靠反复重载或恢复旧配置宣称成功。
