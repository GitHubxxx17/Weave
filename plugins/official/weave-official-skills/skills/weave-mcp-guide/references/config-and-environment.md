# 配置与环境

当前 JSON 是 schemaVersion:1、transport:stdio，包含稳定 id、label、command、args、cwd、
env。id 最长24字符，小写字母数字与单连字符；label1–80字符。command/cwd 必须是
Server 所在电脑的绝对路径，规范化时 command 必须真实文件且可执行，cwd 是目录。
不是浏览器电脑路径；不要从用户系统名称猜测精确 executable 位置。

examples/stdio-config.json 是结构完整的草稿，其 /absolute/path 路径必须换成实际已知
文件和目录；校验 schema 不表示这些路径存在，也不表示服务已启动或信任。

args 是最多64项字面字符串，不经 shell。空字符串、空格、反斜线和顺序都保留意义；
不要拼接 command + args 成 shell 字符串。每项最多4096 UTF-8字节且无 NUL。Windows
command 不接受 .cmd/.bat 作为 launcher；选实际 executable。Weave 不负责下载或安装它。

## 凭据引用

env 形式为目标变量名到 {fromHostEnv:宿主变量名}，最多32项。两边均是变量名，不能
写秘密值。先由用户在启动 Weave 的宿主环境设置值，新连接时解析一次。轮换秘密后
由用户显式重载。变量名以字母/下划线开始；WEAVE_ 前缀两边都禁止（不分大小写）。
Windows 将变量名规范大写并拒绝冲突。完整 canonical JSON 配置上限64KiB。

SDK 仍继承固定系统环境白名单；env:{} 不是空进程环境。不要建议读取宿主所有环境
或向对话贴值排查。只确定引用名、宿主启动环境是否设置及错误类型，避免把凭据
写到 config、args、日志、SKILL.md 或 git。UI 只处理引用，浏览器不直接读取环境。

修改 launch 字段会清除有效信任并停用；label 不改变启动摘要。恢复旧配置不自动
恢复信任。保存只是追加配置事实，不启动；审阅展示规范化完整启动配置和字段差异。
