# 质量报告面板示例

这个插件演示：声明式右侧面板读取插件自己在 Session 中持久化的报告，表单将完整提示词准备到当前对话草稿。用户需要明确发送；面板不会直接运行工具或测试。

`quality_report` 保存模型已经收集到的证据，不代替 linter、测试或 CI。没有实际执行和结果时，不能把检查标为通过。这个示例不提供 OS 沙箱或额外审批权限。

在支持 `panel` 能力的 Weave 构建中，从仓库根目录验证：

```sh
pnpm plugin:validate --artifact /absolute/path/to/quality-report
pnpm plugin:pack --artifact /absolute/path/to/quality-report --out /absolute/path/to/new-release
```

输出容器中的 `payload/` 才是可导入的插件目录，receipt 在 payload 外。市场入口位于左侧导航“插件市场”，本地导入、审阅及激活是独立步骤。激活后在右侧添加面板菜单选择“质量报告”。没有报告时显示空状态。

在本地 Mock Provider 下可发送以下调试消息，通过 Agent 和共享 Tool Pipeline 保存一份示例报告。使用真实模型时，改为自然语言要求收集证据并调用 `quality_report`：

```text
/tool quality_report {"schemaVersion":1,"score":75,"summary":"示例：尚待运行项目检查，以下是手工记录的状态。","checks":[{"name":"检查配置已核对","status":"pass"},{"name":"尚未运行测试","status":"warn"}]}
```

此处 `pass` 仅用于示范手工提供的证据，不表示插件已经自动运行任何检查。面板将显示最近一份匹配版本的报告。表单中的“准备到对话”追加文字到当前草稿，保留已有输入；检查文字后点击发送才进入普通 Agent 流程。

插件停用或撤销信任后，新面板请求失效；历史 Session 事件保留。相同事件类型的最新 payload 版本不兼容时显示相应状态，不回退到旧报告。重启保留布局和历史，重新解析当前插件授权。
