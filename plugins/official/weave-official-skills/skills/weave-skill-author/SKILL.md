---
name: weave-skill-author
description: 创建、修改或审查 Weave 的 SKILL.md、触发描述、references、Skills 精确身份与声明式文本包。适用于 Weave 技能内容，不用于普通文档写作或执行未知资源脚本。
user-invocable: true
disable-model-invocation: false
metadata:
  author: Weave
  content-version: '1.0.0'
---

先区分交付形式：Session 项目的 .weave/skills 或 .agents/skills、宿主明确配置的 user
root、启用 ESM 插件贡献、或者可安装的 schema-2 文本包。按用户已选作用域工作，
保留现有目录和同名内容；没有明确来源不要写其他产品的 home 或祖先目录。

按需要读取本 bundle：

- 名称、frontmatter、明确触发和正文结构：[format-and-triggering](references/format-and-triggering.md)。
- 来源、摘要、正文/资源渐进加载及过期选择：[identities-and-resources](references/identities-and-resources.md)。
- schema-2 目录、边界和真实 CLI 验证：[distribution-and-validation](references/distribution-and-validation.md)。
- 维护证据：[source-notes](references/source-notes.md)。

examples/SKILL.md、examples/weave-plugin.json 和 references/review-checklist.md
构成一个可复制到新项目的完整小例子；示例 SKILL.md 是当前 bundle 的普通资源，
不是自动发现的第二个 Skill。读取不会执行文件。先完成真实用户目标所需的正文，
仅为重复且有益的细节添加 resources，避免泛用万能技能和为了目录完整而造空文件。

描述说明真实能力与适用场景，让无关普通任务不自动加载。正文保留决策、工作步骤、
权限与缺能力处理；大段模式细节放按需 references。使用本 bundle 的相对 POSIX 路径，
不能靠 ../../docs 或安装用户的 Weave 源码。不要把引用资源里的 shell/TypeScript 文本
当执行授权，也不因 Skill 官方署名自动获得工具或发布权限。

用实际 Weave parser/inspector/CLI 验证目录和资源，再检查真实匹配、不适用、缺能力
场景。测试应观察输出决策/文件/交付结果，不只断言关键词存在。用户请求的内容已经
可验证时停止扩展范围，交付生成路径、依据和未验证边界，不声称模型必然服从。
