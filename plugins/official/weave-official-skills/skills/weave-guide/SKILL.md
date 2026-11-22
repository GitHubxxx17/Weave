---
name: weave-guide
description: 解释和排查 Weave Studio 与 Runtime 的已有使用行为，包括插件安装生效、Skills 选择和回合版本。适用于 Weave 产品问题，不用于所有普通编码任务。
user-invocable: true
disable-model-invocation: false
metadata:
  author: Weave
  content-version: '1.0.0'
---

先识别用户所问的 Weave 功能、当前所见状态和一个具体症状。用户在问操作方法时，
给出能在现有界面执行的步骤；在问状态时，区分目录、候选、信任、激活和运行版本。
以当前安装版本和可见事实为依据，不把路线图或上游产品能力说成 Weave 已实现。

按问题读取本 bundle 内对应资源，不要一次加载所有资料：

- 页面入口、产品边界或模型设置：[product-and-navigation](references/product-and-navigation.md)。
- 市场来源、安装、更新、撤销和下一回合生效：[plugin-lifecycle](references/plugin-lifecycle.md)。
- Skill 未出现、正文交付、同名来源或精确重试：[session-skills-and-troubleshooting](references/session-skills-and-troubleshooting.md)。
- 核验依据与本快照限制：[source-notes](references/source-notes.md)。

通过 read_skill 加载时，沿 nextCursor 读到 eof:true 再应用正文，再按需用
read_skill_resource 读取上述相对路径。引用必须来自本回合真实 catalog，包含 id、
instructionSha256 和 bundleSha256；不要用短名或自行计算的引用替代 catalog。
用户显式选择的正文已随回合准备时，不需伪造一次工具交付来证明加载。

创作 Weave 插件、Skill 或配置 MCP 时可建议同包的专门指南，但只有它实际出现在
catalog 中才能按精确引用加载。缺少某项管理读取工具时，给出准确的 UI 核对入口；
不要虚构 get_plugin_status 等工具，也不要为回答产品问题默认安装、信任、启停、
重载、读取凭据或联网追最新版。

交付时先说明当前行为，再给具体核对动作和依据范围。只有关键证据缺失时请求
最少的非敏感信息，例如错误码、界面状态、运行模式和所选版本。不要要求密钥、
环境变量值或整份数据库。未知/未验证能力直接说明，不能从“官方”署名推断可用。
