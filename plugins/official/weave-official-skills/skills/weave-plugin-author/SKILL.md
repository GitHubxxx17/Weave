---
name: weave-plugin-author
description: 创建、修改或验证 Weave Tool、Command、Skill 和右侧声明式 Panel 插件，核对 SDK/manifest、仓库内 CLI、单文件打包及固定版本投稿。适用于 Weave 插件开发，不用于泛指插件的普通应用功能。
user-invocable: true
disable-model-invocation: false
metadata:
  author: Weave
  content-version: '1.0.0'
---

先确认目标贡献类型和实际可用环境。若有 Weave checkout，核对根 package.json 中的
plugin:* 命令及真实已构建 @weave/plugin SDK。当前 CLI 是仓库内私有工具；没有该
环境时提供文件方案和前置条件，不虚构已发布的 npm CLI/SDK，不默认 npx 或安装依赖。

按任务读取：

- SDK、manifest、Tool/Command/事件边界：[sdk-and-manifest](references/sdk-and-manifest.md)。
- create/validate/build/pack 及报错：[cli-and-packaging](references/cli-and-packaging.md)。
- 固定 SHA、投稿、升级与审阅：[publication-and-review](references/publication-and-review.md)。
- 右侧声明式 Panel 的 SDK、数据与表单：[declarative-panels](references/declarative-panels.md)。
- 核对版本及下一次维护事项：[source-notes](references/source-notes.md)。

可读取 examples/hello-tool.ts、examples/hello-command.ts 及相应 manifest 作为
真实接口起点。它们是本 bundle 的惰性文本，不能直接当安装入口。用户请求创作时，
在用户选定或任务合理限定的新目录建立项目，保留已有文件，按实际 SDK 验证。运行值
来自注入 sdk；@weave/plugin 使用 type-only import。工具通过 SDK seam 注册，执行
经共享 Tool Pipeline；不要用自建 HTTP/执行路径绕过输入校验、审批或工作区规则。

完整读取本 Skill 正文后再按需读取资源。所有引用使用本回合 catalog 的精确身份；
没有工具能力时说明不可执行的步骤，不编造已运行编译或安装。Skill 的加载不授权
提交、推送、远端发布、修改市场索引、信任或启停插件；依用户已有任务授权处理这些
动作，先准备实际可审阅产物。不要把静态验证、receipt 或官方署名当作安全沙箱。

交付具体源码/目录、实际运行的验证及限制。区分 source 合法、payload 合法、被导入、
被激活和远端收录。Panel 使用真实 SDK 的受限 JSON，表单只准备草稿；不要生成富渲染或直接执行按钮。
