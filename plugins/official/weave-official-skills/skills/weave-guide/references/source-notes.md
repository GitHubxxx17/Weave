# 来源、内容版本与维护说明

内容版本：weave-official-skills 1.0.0。维护者：Weave 项目；本 Skill 正文和资源为维护者
原创组织的产品说明，不复制第三方 Skills 正文或资源，也不声称上游作者为 Weave 背书。

## 核对的产品版本

- main 基线完整 SHA：647a663ff129b1d3ca9497b6f660844b60fe1e3d（CLI PR #95 合并后）。
- Plugin owner prerequisite 已合并 main：fbc6d1a82d0cdc57889f44fb697e903c764f1d44。
  本文身份捕获、贡献接受和消费者 writer/reader 约束按该提交核对。早于此提交的 SDK
  不能视为已有这些新约束。
- 当前产品/Panel SDK 核对提交：e7dd7ca80dfa71d46fa73b5a5b6dffbb1ae8ad49（PR #97 已合并）。
- 声明式面板已支持受限 JSON、同 owner 事件与命令绑定、只准备到草稿的表单；
  富 React/HTML/webview 与直接运行工具按钮不在当前支持范围。
- 不填写推测的 engines.weave；plugin API 1.0.0 不是产品发布版本。

## 第三方启发的固定版本

来源审计为 Weave docs/learning/2026-11-22-official-plugin-references.md，固定读取：
openai/plugins@981b02c0c44058b595f3b4180002c3ae3c806d40；
openai/codex@cf3ff1530d821ec2d26452da4971d8e3e7d18d25；
deepseek-ai/deepseek-harness@d98f5d68519215da48f3002da2cb9c9d2068d81d；
MoonshotAI/kimi-code@83e4dde93453dd22e89da03d2c96d84999e7d0c2。
采用安装单元/Skill分离、精确发现、正文完整加载、渐进资源、产品任务路由与缺能力
明确说明。未采用其 mutable refs、pnpm安装授权、账号服务、Office引擎、浏览器/CUA
能力；不继承其权限或 OS 沙箱保证。历史 openai/skills 和已归档旧 Kimi CLI 不作当前
产品行为依据。这些固定版本只用于维护溯源，不要求安装用户联网读取。

## 本 bundle 的独立性

上列和下列仓库路径用于维护核验，**不是运行时资源路径**。安装后阅读只使用本 Skill
随附 references/examples，以本回合 catalog 的精确引用取资源，不依赖 Weave checkout。
例子是惰性文本。验证只证明实际跑过的内容，不宣称模型必然遵循，也不证明任意
第三方服务可用。本包仍是准备稿，未宣称市场发布、安装、trust 或 activation。

## Weave 维护来源

- docs/architecture/foundation.md
- docs/learning/2026-11-22-plugin-marketplace.md
- docs/learning/2026-11-22-studio-plugin-installer.md
- docs/learning/2026-11-22-skills.md
- docs/learning/2026-11-17-provider-settings.md
- apps/studio/src/features/plugins/plugin-marketplace-page.tsx
- apps/studio/src/features/mcp/mcp-panel.tsx
- packages/protocol/src/skills.ts
