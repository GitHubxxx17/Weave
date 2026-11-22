# 官方联网插件：审批、公开地址与可引用文本

`weave-web` 是独立安装的 ESM 插件，通过现有 SDK 贡献 `web_search` 与 `web_fetch`，使用现有 Tool Pipeline、审批、Generation 和 Session 持久化。源码位于 `plugins/official/weave-web-source`，安装目录 `plugins/official/weave-web` 由真实开发者 CLI 构建。没有增加依赖或新的 Runtime、HTTP、Session、Studio 契约。

## 配置与外发

公开网页读取无需搜索凭据。搜索仅在宿主启动前配置 `WEAVE_WEB_SEARCH_PROVIDER=tavily` 和独立 `WEAVE_WEB_TAVILY_API_KEY` 后启用。插件工厂仅捕获这两个环境变量，配置在实例内固定；不读取 LLM key、完整环境或会话正文。Tavily 请求只包含本次查询及固定搜索选项，不自动重试或选择其他供应商。

两个工具同时声明 `readOnly` 和显式高风险审批。常规、信任模式会在 DNS 和 HTTP 之前等待决定；原有 yolo 模式沿用共享管线行为，策略仍可要求审批或拒绝。审批展示实际查询或完整目标 URL。未配置搜索在本地返回可恢复错误，网页内容仅作为不可信外部资料。

## 网络与结果边界

仅支持公开 HTTPS、443 端口。原始地址与 WHATWG 规范化地址都进行长度、字符、凭据和已知插件密钥检查。域名的全部 DNS 结果必须可公开路由，选定地址固定到本次连接，保留原域名 Host、SNI 和默认 TLS 证书校验。连接验证远端地址后才发送请求。IPv4、IPv6、mapped 和特殊地址的规则采用明确的保守集合。

网页最多跟随三次同源跳转，每次重新验证；跨站跳转需要另一次调用与审批。搜索端点不跟随跳转。传输分别限制响应头、压缩数据和解压后数据，支持取消并清理 socket、流和监听器。20 秒是覆盖请求过程的协作式总截止时间，不是对任意宿主阻塞行为的硬实时保证。

网页仅接收 UTF-8 文本、HTML、Markdown、JSON 与 XHTML，拒绝附件及不支持的 MIME、编码和压缩格式。线性 HTML 提取器移除脚本与隐藏容器，不执行 JavaScript、不加载子资源，也不声称支持任意网站。成功结果完整 JSON 限制为 12,288 UTF-8 字节；正文按码点截断，完整来源 URL 保留。已知搜索密钥在显示文本中脱敏；来源 URL 命中时整项省略或拒绝，避免改写后产生虚假引用。

这些是官方工具自身的限制。受信任的进程内 ESM 拥有宿主权限，声明的 `network:request` 不是网络或 OS sandbox。工具结果中的来源并不保证任意模型最终都会正确引用。

## 验证证据及范围

确定性测试覆盖地址边界、DNS 固定、TLS 连接选项、流式限制、取消、供应商请求契约、错误映射、HTML、引用预算，以及真实 Kernel / Pipeline / ApprovalBroker / Runner / SQLite 组合。成功请求的 adapter 测试验证工具结果进入下一次模型请求并在 Session 重开后保留，不依赖外网和付费 key。

`pnpm web-plugin:verify` 使用真实 CLI 验证源码、构建、验证安装目录并打包，逐个文件比较安装产物的名字和原始字节；再通过真实 loopback HTTP、HTTP 202 和可分离 SSE 验证惰性导入、独立激活、本地错误、SQLite 重启、停用、重新激活和撤销信任。该流程有 12 次模型请求及 12 个工具结果，并断言没有原生 HTTP 请求或外部 fetch。它的网络成功证据与本地安全失败证据不能混用。

真实 Studio 生产构建 + Server + SQLite 的一次性 fixture 另行验证：

1. 在左侧插件市场预览本地安装目录，核对权限和摘要，导入后仍需独立激活。
2. 常规模式下读取 `https://example.com/` 先显示包含完整 URL 的审批，拒绝后正常结束。
3. 再次读取并同意后，生产插件通过真实原生 HTTPS 返回 Example Domain 的标题、正文和完整来源 URL；可控模型随后渲染来源链接。
4. 搜索未配置时显示 `web-search-not-configured` 和正确配置项；刷新后网页结果、来源和错误历史仍在。
5. 等待审批时停止会取消当前执行；停用插件后下一回合调用返回 `tool-not-found`。

此 fixture 的模型是确定性适配器，网页读取是真实原生 HTTPS；它不能证明真实模型回答质量。另一次直接调用已编译插件也成功读取该公开网页。本轮没有配置或调用真实 Tavily key，不包含供应商账户、额度或线上搜索可用性的验收。

独立审查修复了原始 URL 规范化、跳转原始地址、HTML raw-text、Content-Type 参数、附件空白和凭据检查等具体问题，并添加失败先行的回归。特别是主机名小写化会抹去原始大写密钥匹配，因此输入与规范化地址都必须检查。

## 发行顺序

内容 PR 仅注册空的官方插件 family，不提供伪造 pin。内容 squash 后，下一独立发行 PR 使用真实完整 merge SHA 从 GitHub 获取安装目录，核对 manifest、Git blob 和目录摘要，再生成市场条目。安装使用说明见插件 README；设计与官方参考版本见 [设计文档](../superpowers/specs/2026-11-23-web-plugin-design.md)。
