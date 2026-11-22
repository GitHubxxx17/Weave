# 声明式文本包与验证

最小独立包：weave-plugin.json 和 skills/review-change/SKILL.md，正文引用的资源在
skills/review-change/references/review-checklist.md。复制 examples/weave-plugin.json、
examples/SKILL.md、references/review-checklist.md 到对应新项目路径即可形成
完整示例。schemaVersion:2，kind:skills；manifest host:declarative，仅 skill capability，
contributes.skills 精确列出1–16项，permissions:[]。没有 entry、ESM、tool、command、
hook、provider、service 或 Panel 声明。

只允许可选 root README.md/LICENSE/NOTICE（各64KiB以内）和已声明 Skills 树。
没有 license 要求时不编造许可。每包最多64个 aggregate resources、单资源256KiB、
资源合计2MiB；每份 SKILL.md/frontmatter 仍64/8KiB。不是每个 Skill 各64个资源。
拒绝 binary、NUL、symlink、special file、unsafe path 和漏声明/缺失 bundle。
examples/SKILL.md 只是同 bundle 普通文本资源，不作为另一声明 Skill 发现。

## 真实验证

有真实 Weave checkout 时可用：

```sh
pnpm plugin:create --template skills --id my-skills --directory /tmp/my-skills-project
pnpm plugin:validate --source /tmp/my-skills-project
pnpm plugin:build --source /tmp/my-skills-project --out /tmp/my-skills-build
pnpm plugin:validate --artifact /tmp/my-skills-build/payload
pnpm plugin:pack --artifact /tmp/my-skills-build/payload --out /tmp/my-skills-release
```

每个输出必须新建且不与 source 重叠；路径按任务实际替换。Skills 不用 SDK/compiler/
package.json。CLI 是 Weave 仓库内私有包，不假设全局安装或公开 npm。没有 checkout
时交付文件及未验证声明，不声称已经执行这些命令。

宿主已有 inspectPluginPayload(directory,{hostVersion?,signal?,limits?}) 可进行惰性
检查，返回 descriptor/digest/计数及 data union，不创建 managed store、不 import 作者。
省略 hostVersion 只表示离线语法/host/API核验，不证明任意宿主 engine 兼容。

## 内容验收

使用至少一项真实匹配任务：例如检查一个可复现问题的 diff，观察是否读取正文与需要
的参考资源并给出具体结论。再给普通不匹配任务，检查不会被泛化 Skill 抢占。
缺少读文件/运行验证工具时，应准确报告限制并给用户可执行步骤；不能编造执行记录。

安装后用 Composer 选择实际 refs、在工具流水线中读正文到 EOF及实际资源，核对持久
requested/prepared/delivered/failed；只搜索文案存在或让模型说“我用了”不够。
更新/资源编辑后旧引用应明确 stale；新回合使用新包，运行回合保持旧代不可变内容。
远端发行须实际 commit、真实获取和独立激活，不用本地 receipt 替代远端出处。
