# Weave 官方使用与开发指南

这是由 Weave 维护者原创编写的四项文本 Skill，共享内容版本 1.0.0：

- weave-guide：Weave 已有功能的使用和问题分流。
- weave-plugin-author：真实 SDK、Tool/Command、声明式 Panel、本地 CLI 和发行准备。
- weave-skill-author：SKILL.md、渐进资源、声明式文本包及精确身份。
- weave-mcp-guide：本地 stdio MCP 配置、信任/审批边界和故障诊断。

本目录本身是 schema-2 Skills payload，没有 JavaScript 入口、构建脚本或执行权限。
所有示例都是惰性 UTF-8 资源。安装用户不需要拥有 Weave 源码来阅读这些指南。
资源中的仓库路径只用于维护溯源，不是安装后读取路径。

在 Studio 左侧“插件市场 → 已安装”导入真实目录，审阅 manifest 和实际摘要后，
由用户单独激活。安装、信任、启用、在 Composer 选择及向模型交付正文是不同状态。
加载这些指南不会授权插件管理、额外工具、执行示例、提交或发布。模型可按现有
Skill catalog 中的精确引用按需加载，不会因为四项内容同包而自动全部注入。

内容依据的 main 为 647a663ff129b1d3ca9497b6f660844b60fe1e3d；
服务/贡献 owner 修复已合并 main：fbc6d1a82d0cdc57889f44fb697e903c764f1d44。
当前产品与声明式 Panel SDK 已核对 main e7dd7ca80dfa71d46fa73b5a5b6dffbb1ae8ad49（PR #97）。
右侧面板使用宿主渲染的受限 JSON；表单只准备草稿，用户明确发送。官方市场
收录与固定 GitHub 来源由宿主发行记录决定，不由包内署名决定。
