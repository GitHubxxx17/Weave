# 发布、收录与更新

本地验证不上传、不创建 PR、不授信。普通“做一个插件”任务先完成实际源码、payload
和验证；外部提交/推送/发布需要用户的相应已有授权，不从加载 Skill 推断授权。

开发者先把实际 payload 保存到自己拥有的公开 GitHub 仓库，获得真实完整小写40位
commit 和包含 weave-plugin.json 的精确 subdirectory。规范仓库 URL 为
https://github.com/owner/repository，无 .git、凭据、query、fragment。根目录使用空子目录。
不要将 branch/tag、未来 squash SHA 或随手举例的十六进制串写入真实市场。

准备带 name/description/publisher/tags/source 的 request JSON 后，在 Weave root 使用：

```sh
pnpm marketplace:entry --input /absolute/path/to/request.json --output marketplace/submissions/your-plugin-id.json
pnpm marketplace:generate
pnpm marketplace:check
```

这些路径按实际任务替换。entry 会通过 bounded GitHub acquirer 下载该固定来源并实际
核验 descriptor 和内容，不导入作者代码。output 名称对应真实 manifest ID，已有文件
不覆盖。API 限流/网络失败时保留真实失败，不以本地 receipt 冒充远端验证。

generate/check 离线验证 submissions 的全部 manifest、版本、保留 ID 和确定性顺序；
它们不会再次联网证明远端可达。每个新版本追加 release，保留旧版本/完整 manifest/
固定 source 供回滚；同版本不能悄悄移到不同内容。PR 说明贡献、权限、发布者与源码
关系及测试证据，遵循项目审查/CI。被收录后还需 included in build，才进入该构建的
packaged 默认目录。没有实际部署就不宣称在线目录已发布。

publisher、metadata.author、Weave 前缀、索引来源名都不能自行赋予官方身份。
官方身份由宿主产品规则决定；精选第三方、维护者原创、安装状态和授权是不同属性。
即使来源显示官方，用户仍审阅实际 manifest/digest 并单独激活。安装器不下载依赖或
执行构建脚本。不要承诺第三方账号服务、二进制和许可因目录收录自动可用。
