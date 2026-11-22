# Session Skills 与故障分流

## 使用与来源

在会话 Composer 旁选择 Skills，查看来源、描述和预览。选择属于当前 Session 草稿，
按顺序发送。一次消息被接受后只清理实际发送的选择；失败发送和导航有各自草稿状态。
Skill 仅提供指令和资源，不创建工具、执行资源或赋予额外权限。

当前来源为内置 weave-planning、启用插件贡献、Session 绑定项目的 .weave/skills 与
.agents/skills，以及宿主配置的 user skills root。默认 user root 是 data directory/skills，
可用 WEAVE_SKILLS_DIR 或嵌入式 skillsDirectory 改写；false 只停用 user disk discovery。
不会自动扫描父目录、其他产品的 home 或远程源。同名 Skill 用来源身份区分，不静默覆盖。

## 选择身份和读取

精确引用含 id、instructionSha256、bundleSha256。插件来源形如
plugin:weave-official-skills/weave-guide，但实际两个摘要必须读取 catalog。
即使只改 references 文件，bundle hash 也变化；旧选择会过期，不能用同名新来源补位。

模型 read_skill 读正文；有 nextCursor 就继续，到 eof:true 才完成。之后可用
read_skill_resource 读取本 bundle 的安全相对资源，如 references/plugin-lifecycle.md。
资源即使以 .ts/.sh 结尾也只是数据。加载不表示允许运行。

## 历史上的四种证据

requested 是用户请求了选择；prepared 是 host 为模型准备了指令；delivered 是模型
loader 的匹配成功完整工具结果已持久保存；failed 是读取失败。prepared 不证明模型
实际读懂或遵循，delivered 也不是质量保证。仅助手口头说“已读取”不能代替工具记录。

精确重试绑定原 user message（包括图片及顺序）、Skill refs、provider/model、有效采样、
reasoning 设置和权限模式。旧历史缺少完整快照时会明确不可用。原 Skill 改变或消失时
应保留该失败，刷新后新选 Skill 是新请求，不再声称精确重试。

## 常见情况

| 现象                           | 核对                                                            |
| ------------------------------ | --------------------------------------------------------------- |
| 新包已导入但 picker 没有 Skill | 确认激活、新 Generation、capability/contributes 与目录诊断      |
| 本地目录有文件但未发现         | Session 项目 root 是否相同，目录/名字是否匹配，是否 unsafe/受限 |
| 同名出现多条                   | 看来源 ID 和摘要，保留用户所选，不擅自合并                      |
| 读取资源失败                   | 是否正文已读完，路径属于相同引用，游标是否仍属本回合            |
| 精确重试失败                   | 原引用是否变化，历史请求快照是否完整；不要替换为新版本          |
| catalog incomplete/truncated   | 显示限制/诊断，不把截断结果当完整缺失证明                       |

只请求非敏感错误码和来源标签；不要要求用户提交整份私有资源或宿主密钥。
