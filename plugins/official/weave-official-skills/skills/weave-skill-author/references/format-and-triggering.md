# 格式与触发设计

## 最小有效格式

目录名与 frontmatter name 必须相同，是最长64字符的小写字母/数字单词，以单连字符
分隔。description 非空，规范化空白后最长1024字符；body 必须有实际非空指令。

```markdown
---
name: review-change
description: Review a proposed repository change for concrete correctness failures and missing verification.
user-invocable: true
disable-model-invocation: false
metadata:
  author: Your team
---

Read the repository instructions and requested scope. Inspect the relevant diff
and surrounding contracts. Use references/review-checklist.md when assessing
findings. Present reproducible issues with evidence and remaining uncertainty.
```

user-invocable 控制用户选择，disable-model-invocation:true 禁止模型自动选用。
两者独立；无需因为可能涉及敏感动作就把全部 Skill 改显式专用，执行前沿用已有授权。
metadata.author 是署名，不建立官方身份或能力。根据真实许可决定是否填写 license，
不要默认添加 MIT 或复制第三方正文后省略版权。

Weave 使用受限 YAML：支持字符串（含引号/块字符串）、两个布尔 invocation flags、
字符串值 metadata map 和有界未知字符串扩展。aliases/anchors、重复键、任意 tags、
复杂嵌套映射/序列和不支持类型会拒绝。不要复制 tools/permissions 等复杂上游字段并
期待其生效；它们不会给 Skill 授权。BOM/CRLF 规范化后形成指令身份。

## 描述与正文

把“何时使用”写到 description，因为它在正文加载前参与发现。用具体任务和输出，
例如“检查 Weave SKILL.md 与引用资源”，不要写“解决所有开发问题”。对容易混淆的
相邻任务增加简短边界；不用穷举所有不会做的事情。

正文围绕真实任务：识别输入与作用域、必要条件、关键决策、验证、输出及能力缺失时
的退路。没有用户授权的外部发送/安装/授信/发布不从加载技能推导。已有任务允许的
普通创作与只读诊断继续推进，不制造额外确认流程。

只在细节有多种独立模式或信息量较大时拆 references；主文需说明什么任务读什么资源。
不要主文和资源各复制一套步骤，不把资源数量、固定章节数或字数当质量目标。
