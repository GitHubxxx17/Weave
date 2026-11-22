# 精确来源、资源与加载

## 四个来源

builtin 为随 Server 提供的 weave-planning。plugin 为符合既有信任/Generation 的启用
插件。project 仅当前 Session 绑定项目的 .weave/skills 和 .agents/skills。user 为宿主
默认 data directory/skills 或显式配置的 skillsDirectory/WEAVE_SKILLS_DIR。false 只关闭
user 来源。不会隐式发现其他产品 home、祖先项目或网络目录。

短名是搜索提示。真正引用为 {id,instructionSha256,bundleSha256}，从实际 catalog
获取。plugin ID 形如 plugin:my-skills/review-change；project/user 身份还绑定 root
指纹，不能手写模拟。正文 hash 和 bundle hash 用于不同层的内容绑定；bundle 还包括
名称、描述、invocation 和排序后的资源身份。只改参考文件也会使旧选择过期。

## 渐进读取

read_skill 输入 skill 精确引用和可选 cursor。首个成功页不是整个正文；沿返回的
nextCursor 原样继续，直到 eof:true。然后用 read_skill_resource，以同一个 skill 引用
和 path，例如 references/review-checklist.md。资源也可能分页，需要读到 EOF。

路径是 bundle-relative POSIX，不是文件系统权限：不能绝对路径、反斜线、空分段、.
或 ..；SDK inline resources 还拒绝冒号/NUL及 **proto**/prototype/constructor 分段。
保持路径短且独立，不让正文引用另一个 bundle 的同名资源。SDK key 最长512字符。
需要另一 Skill 时先从 catalog 获取该来源完整引用，再独立加载，不能靠同包约定伪造。

资源为 UTF-8 文本且不得含 NUL。代码/脚本扩展名不触发执行，loader 不运行脚本。
如用户确实要求用示例创建文件，先在任务授权的新工作目录复制/编辑，再用普通
已授予工具和审批边界验证；不修改已安装不可变包，不自动执行外部下载内容。

## 容量与失效

standalone disk Skill：SKILL.md 64KiB，frontmatter8KiB，bundle1000文件/20MiB，深度8；
每 source 最多128候选，共享 discovery read budget64MiB。限制/不可读/unsafe/changed
会作为诊断呈现。installable text package 和 SDK inline 更小，见 distribution 资源。

Selection 最多32引用、显式指令总量1MiB。catalog JSON 有32KiB模型预算；progressive
page JSON 还受4096字节及实际 token 预算约束。因此 catalog incomplete/truncated 不等于
某技能绝对不存在。游标只属当前回合；取消后不可继续，不能用旧 cursor 读取新包。

遇到 source-changed 或旧 ref 消失，应准确失败。向用户说明刷新后重新选择会创建新
请求；不能默默用同名版本满足精确重试。requested/prepared/delivered/failed 是不同
持久证据，“已加载”不能仅靠助手复述正文或输出一个关键词来证明。
