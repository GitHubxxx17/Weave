# 官方联网插件 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 交付可独立安装/停用的 `weave-web` ESM 插件，提供明确审批、来源可引用、有界可取消的真实搜索和公开网页读取。

**Architecture:** 独立 ESM 通过现有 SDK `toolsExtensionPoint` 贡献两个 protected readOnly 工具，由原 Tool Pipeline 执行；插件 Node HTTPS adapter 验证并固定 public DNS，查询仅外发给显式配置的 Tavily。复用 managed installer、Generation、现有错误/结果持久化和 Studio Markdown，不增通用网络/设置平台。内容合并后用真实 merge SHA 独立发行索引。

**Tech Stack:** Node >=24.4、TypeScript 5.9.3、ESM、现有 SDK Zod 4.6.7、Node builtin DNS/HTTPS/zlib/net、现有 Vitest/CLI；无新依赖。

**Spec:** `docs/superpowers/specs/2026-11-23-web-plugin-design.md`；执行分支首先将完整审核后的契约保存为 `docs/superpowers/specs/2026-11-23-web-plugin-design.md`，本计划保存为 `docs/superpowers/plans/2026-11-23-web-plugin.md`。正式文件日期可按实际执行日调整，所有引用同步。

## Global Constraints

- `@file` squash/绿CI后从最新 `origin/main` 新建 `feat/web-plugin`；不要在 `feat/file-context` 写实现。
- 先更新 foundation/设计后改实现。使用已授权的每功能独立PR、CI绿、review、squash、删除远程分支流程；提交 Conventional+中文。
- 插件源码 `plugins/official/weave-web-source/`；可安装产物 `plugins/official/weave-web/`，必须由实际现有CLI build生成。
- `network:request` 是审阅声明；trusted ESM不提供OS隔离。共享Pipeline是本官方工具执行入口，不赋予任意ESM网络sandbox保证。
- 唯一provider `tavily`，只有 `WEAVE_WEB_SEARCH_PROVIDER=tavily` + `WEAVE_WEB_TAVILY_API_KEY` 配置才搜索；不读宿主LLM key、完整env、workspace/Session。
- 默认只发 input.query 或 input.url；完整准确外发参数进入现有Approval。显式approval + readOnly:true，ask/trust需问，yolo沿用当前行为，policy只收紧。
- public HTTPS443，DNS all answers检查后连接pin，同origin最多3次redirect；搜索redirect全部拒绝。无proxy/private bypass/自动fallback/retry。
- 20s总deadline；header16KiB、wire512KiB、decoded1MiB、搜索raw JSON512KiB；完整成功结果JSON <=12,288 UTF-8 bytes，默认Pipeline32,000。
- tests在`apps/server/test/`；不在plugin source/payload新增test目录，不依赖任何API key、活网或模型。
- 不新增package/依赖/SDK/HTTP/Protocol/Session事件/Studio UI；如有实际必要先说明具体契约，不借此做通用设置平台。

## File Ownership and Parallel Work

| owner | 创建文件 | 只读使用/不得编辑 |
| --- | --- | --- |
| A 网络边界 | `plugins/official/weave-web-source/src/errors.ts`, `types.ts`, `url-policy.ts`, `address-policy.ts`, `transport.ts`; `apps/server/test/official-web-address.test.ts`, `official-web-transport.test.ts` | 不编辑index/tools/provider/formatter；先向B/C发布下列共享types |
| B 内容与provider | `plugins/official/weave-web-source/src/tavily.ts`, `html-text.ts`, `result.ts`; `apps/server/test/official-web-provider.test.ts`, `official-web-result.test.ts` | 依赖A的types/errors/transport；不编辑SDK入口 |
| C 主执行者 | source `package.json`, `weave-plugin.json`, `README.md`, `src/config.ts`, `schemas.ts`, `tools.ts`, `index.ts`; `apps/server/test/official-web-tools.test.ts`, `official-web-plugin.test.ts`, `official-web-artifact.test.ts`; payload目录；docs/env/official family | 主执行者维护编排、source factory/真实CLI验收与集成；只在A/B完成后整合共享文件 |

A/B可以并行，先由主执行者落共享types约定并传递，不同时编辑同文件。C的config/schema可并行，SDK wiring与artifact等待A/B。这只是一个PR的内部任务拆分。

## Task 1: 契约和共享类型，建立现有SDK源项目

**Files:**
- Create: `docs/superpowers/specs/2026-11-23-web-plugin-design.md`, `docs/superpowers/plans/2026-11-23-web-plugin.md`。
- Modify: `docs/architecture/foundation.md`，新增边界与已实际读取reference段。
- Create: `plugins/official/weave-web-source/package.json`, `weave-plugin.json`, `README.md`, `src/types.ts`, `src/errors.ts`。
- Tests: `apps/server/test/official-web-artifact.test.ts`（该任务先验证descriptor/source形状，不要求未来生成文件存在）。

**Interfaces:** source package `{name:"weave-web-source",private:true,type:"module"}`，仅type-only SDK import和Node builtin，descriptor与spec逐字段一致。`src/types.ts` 提供：

```ts
export interface SearchInput { readonly query: string; readonly maxResults: number }
export interface FetchInput { readonly url: string; readonly maxChars: number }
export interface Address { readonly address: string; readonly family: 4 | 6 }
export interface HttpRequestInput {
  readonly url: URL;
  readonly method: 'GET' | 'POST';
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: Uint8Array | undefined;
  readonly signal: AbortSignal;
  readonly maxWireBytes: number;
  readonly maxDecodedBytes: number;
}
export interface HttpResponseData {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly bytes: Uint8Array;
}
export interface WebHttpClient {
  request(input: HttpRequestInput): Promise<HttpResponseData>;
}
export interface SearchConfig {
  readonly provider: 'tavily';
  readonly apiKey: string;
}
export type SearchConfiguration =
  | { readonly status: 'ready'; readonly value: SearchConfig }
  | { readonly status: 'unconfigured' }
  | { readonly status: 'invalid' };
export interface WebSource { readonly id: string; readonly title: string; readonly url: string; readonly excerpt: string }
```

`SearchResult` / `FetchResult` 与完整spec同名同字段。WebErrorCode明确列出spec表全部15个code，`WebToolError`只携带code和自有安全message，不携带cause/URL/key/nativeerror。readonly配置深拷贝冻结。

- [x] 确认`@file`已合并，fetch最新origin/main，在新分支读AGENTS/foundation/ADR/真实CLI profile。
- [x] 保存审核后的设计/计划并更新foundation；记录Tavily、Codex、Harness、Kiro、IANA、Node官方版本/日期和实际采用/未采用原则。
- [x] 写descriptor test断言 manifest精确工具名、network permission、无prompt/services/entry code执行；运行`pnpm exec vitest run apps/server/test/official-web-artifact.test.ts`见缺文件失败。
- [x] 创建source壳和共享types/errors，暂不生成伪artifact；实际后续index由Task4提供。
- [x] 重跑shape测试绿。确认不改Runtime/Protocol/Session与@file实现。

## Task 2: public URL/IP policy与DNS固定HTTPS transport（owner A）

**Files:** `url-policy.ts`, `address-policy.ts`, `transport.ts`, `official-web-address.test.ts`, `official-web-transport.test.ts`。

**Consumes:** Task1 types/errors。**Produces:**

```ts
export function parsePublicHttpsUrl(input: string): URL;
export function isPublicAddress(input: string): boolean;
export function createWebHttpClient(deps?: {
  lookup?: (hostname: string) => Promise<readonly Address[]>;
  request?: typeof import('node:https').request;
}): WebHttpClient;
```

默认deps是Node builtin，测试dep只在source纯helper内部，不暴露到PluginFactory参数、env或工具schema。request()一次请求，不自动跟随redirect（Task4 fetch负责跳转循环）；返回bytes是已解压/计数后的bytes。header map只含处理必需字段，lowercase，header值数量和长度受限。

- [x] 写表格测试（真实地址分类，不连网）：

```ts
it.each(['https://127.1/','https://2130706433/','https://0x7f000001/',
  'https://[::1]/','https://[::ffff:127.0.0.1]/','https://[::ffff:7f00:1]/',
  'https://[64:ff9b::7f00:1]/','https://[2002:7f00:1::]/',
  'https://[2001:db8::1]/','https://[3fff::1]/','https://localhost/',
  'https://service.local/','https://x.internal/','https://one/',
  'http://example.com/','https://example.com:8443/','https://u:p@example.com/',
  'https://example.com/#secret'])('blocks %s', (input) => {
  expect(() => parsePublicHttpsUrl(input)).toThrow();
});
it.each(['93.184.216.34','2606:4700:4700::1111'])('allows public %s', (ip) => {
  expect(isPublicAddress(ip)).toBe(true);
});
```

把spec所有CIDR内外边界、compressed/mappedIPv6/invalid/multicast/zone附上，不能只有几个example。纯URL policy必须包含IP literal检查；域名DNS检查在request内。

- [x] 运行`pnpm exec vitest run apps/server/test/official-web-address.test.ts`，见缺导出失败。
- [x] 实现quote/control/credential/port/fragment/host规范化、IPv4位运算和IPv6 BigInt/CIDR，保持线性和明确保守集合；重跑绿。
- [x] 写request spy的关键测试：mixed public+private DNS=>request0次；>16/empty=>0次；request options的自定义lookup只返回pin、hostname/Host/SNI保持原host、`agent:false`、TLS默认校验、无proxy；DNS迟到且signal取消=>request0次。可用fake EventEmitter ClientRequest/Readable Response，只实现实际用到的Node接口。
- [x] 写bounds/cancel tests：headers/wire/decoded caps、gzip/br/deflate和unknown encoding、Content-Length大小/伪小、abort DNS/connect/headers/body/decompression、原生request抛含key字符串不传播、listeners/timers/streams销毁、无unhandled reject。
- [x] 实现先DNS allanswers validation，再pin lookup请求；secureConnect验证remoteAddress后才end/write发送POST body/header；20s上层controller由Task4提供，transport忠实执行signal。不默认全读response；流式限值与解压。
- [x] 运行两测试文件全绿，并用已有Node类型`pnpm plugin:validate --source <absolute source>`在Task4入口齐备后验证。将真实helper签名发B/C，明确自己未做网页redirect loop。

## Task 3: Tavily provider、HTML基础提取和完整引用预算（owner B）

**Files:** `tavily.ts`, `html-text.ts`, `result.ts`, `official-web-provider.test.ts`, `official-web-result.test.ts`。

**Consumes:** WebHttpClient/SearchConfig/SearchInput/WebSource/WebToolError；`parsePublicHttpsUrl`用于来源词法校验；注入SDK Zod。

**Produces:**

```ts
import type { PluginSdk } from '@weave/plugin';
export function searchTavily(
  z: PluginSdk['z'], http: WebHttpClient, config: SearchConfig,
  input: SearchInput, signal: AbortSignal,
): Promise<{ sources: readonly Omit<WebSource, 'id'>[]; omittedResults: number }>;
export function htmlToText(html: string): { title: string; text: string };
export function buildSearchResult(input: SearchInput, sources: readonly Omit<WebSource,'id'>[], omittedResults: number, now: Date, redactValues: readonly string[]): SearchResult;
export function buildFetchResult(input: FetchInput, finalUrl: URL, mime: string, title: string, text: string, now: Date, redactValues: readonly string[]): FetchResult;
```

- [x] 写provider fakeHttp测试实际url/method/header/body深等于spec；只有query，没有conversation/file/workspace/header key echo。用SDK真实`createPluginSdk().z`，不手写Zod stub。响应schema对必须字段校验、额外字段丢弃；结果去重且保序，空结果合法。
- [x] 写401/403、429+valid/invalid Retry-After、432、433、434、3xx、invalidJSON/UTF8/schema、超大字段测试。断言error.code与message安全无secret/rawprovider body；不创建fallback第二请求。
- [x] 运行`pnpm exec vitest run apps/server/test/official-web-provider.test.ts`见缺函数失败，按官方OpenAPI实现单provider，绿。
- [x] 写HTML输入fixture覆盖script/style/head/template/noscript/svg、注释、`>`在quoted attribute、entities/中文/emoji、broken HTML；断言无脚本/hidden externalfetch和无输出rawHTML，无document/DOM/browser dependency。
- [x] 写result JSON真实bytes边界（quotes/backslash、长URL、多来源、中文/emoji）、maxChars、source完整URL、truncated/omitted准确、literal/percentencoded key redaction。每成功结果`Buffer.byteLength(JSON.stringify(result))<=12288`；不截断URL；metadata不适配时抛明确error。
- [x] 实现有界单向scanner、UTF8 codepoint-safe trim、12KiB JSON预算和notice；运行result与provider测试绿。先还原来源对象再redact，避免错误地在JSON escape后才删secret。

## Task 4: config/schema/tools/SDK接线与Pipeline真实行为（owner C）

**Files:** `src/config.ts`, `schemas.ts`, `tools.ts`, `index.ts`；`official-web-tools.test.ts`；`.env.example`与source README。

**Consumes:** Task1–3稳定helper。**Produces:**

```ts
export function readSearchConfiguration(input: {
  readonly provider?: string | undefined; readonly apiKey?: string | undefined;
}): SearchConfiguration;
export function createWebSchemas(z: PluginSdk['z']): {
  search: /* inferred Zod strict object SearchInput */;
  fetch: /* inferred Zod strict object FetchInput */;
};
export function createWebModule(sdk: PluginSdk, options: {
  readonly configuration: SearchConfiguration;
  readonly http?: WebHttpClient | undefined;
  readonly now?: (() => Date) | undefined;
}): PluginModule;
```

完整真实接口使用Zod推导返回类型，禁止any、手写虚假SDK声明或Runtime导入。`index.ts` default PluginFactory仅从`process.env.WEAVE_WEB_SEARCH_PROVIDER`和`process.env.WEAVE_WEB_TAVILY_API_KEY`捕获两值后调用`createWebModule`。上面source-level dependencies供确定性测试，default factory不接受model/host额外参数且不对外暴露config setter。

- [x] config/schema测试先红：未配置/none/unknown/empty/key控制/过长、冻结输入不受后续env变更影响、fetch无key正常、strict额外字段、query UTF8/Unicode和URL限制。
- [x] 用真实kernel+toolRegistryPlugin+createWebModule贡献，真实createToolPipeline+ApprovalBroker+fake WebHttpClient：在ask/trust调用web_search，等pending后断言http0次，approve后一次。重复fetch；reject/cancel/expiry=0；broker missing failclosed；yolo一次；policy ask仍pending；policy deny0次。
- [x] 结构参数 invalid 返回既有 tool-invalid-arguments；语义 URL/配置 invalid 在 summarize/execute 入口失败，assert DNS/request0；readOnly:true同时存在显式approval.operation web.search/web.fetch/risk high；不要改approval-risk。
- [x] 实现只贡献工具，20s总signal controller和cleanup包住DNS/HTTP/redirect/decode；fetch MIME/charset/attachment检查与同origin3跳，crossorigin只返回安全target不连接；无额外subresource。search调用Task3 provider。
- [x] code-bearingWebToolError必须从预期错误路径抛出；原生错误转换固定安全信息；context取消优先DOMException AbortError，内部20s=>web-timeout。用短fakeTimer而非真实等待20秒。
- [x] 运行`pnpm exec vitest run apps/server/test/official-web-tools.test.ts`全绿。可在测试下调私有deadline参数或fakeTimer；禁止把timeout上界暴露成tool arg/bypass。
- [x] `.env.example`只加入注释和占位key；README包括Server `--env-file-if-exists`真实行为、Desktop进程env/重启、无需LLM key、HTTPS443 public限制、Tavily basic产生供应商费用/额度、最终答案保留来源、plugin trust非sandbox。无索要/打印真实key命令。

## Task 5: actual CLI payload、managed生命周期和持久化引用

**Files:** create `plugins/official/weave-web/{weave-plugin.json,index.mjs,README.md}`；create `apps/server/test/official-web-plugin.test.ts`, 完成`official-web-artifact.test.ts`；modify `apps/server/src/official-marketplace-releases.ts`；docs/README。

**Consumes:** 完整source与真实SDK/CLI、现有`createInstallerHttpFixture`、`activateInput`、`runExecutionToLegacyResponse`、`getServerSessionStore`。

- [x] 执行实际CLI（使用实际绝对路径、新的临时out container）：

```sh
pnpm plugin:validate --source /absolute/checkout/plugins/official/weave-web-source
pnpm plugin:build --source /absolute/checkout/plugins/official/weave-web-source --out /tmp/weave-web-build-unique
pnpm plugin:validate --artifact /tmp/weave-web-build-unique/payload
pnpm plugin:pack --artifact /tmp/weave-web-build-unique/payload --out /tmp/weave-web-pack-unique
```

不能写死重复out；由`mkdtemp`/random产生再传CLI。将真实payload复制进目标目录；不把receipt/source/tsconfig加入payload。bundle只含Node imports，SDK runtime依赖为0。

- [x] 测试actual source通过CLI check/build后逐文件比较committedpayload，descriptor/fullSHA256摘要一致；CI不能靠先有dist：test可使用实际CLI public `buildPlugin`需要添加Server**devDependency** `@weave/plugin-cli`会违反当前server allowed列表，故**不要这样做**。采用已有explicit acceptance `.mjs`方式由root `plugin:verify`集成实际CLI再启动Server，或Server测试`execFile`调用CLI已建dist并由root script构建它。具体采用：新增root `web-plugin:verify`脚本先build CLI+Server依赖，再执行 `apps/server/test/acceptance/web-plugin.mjs`；CI在`pnpm check`后调用它。普通Vitest artifact test核对source descriptor/profile与空family归因；committedpayload的Host校验和实际rebuild逐字节一致由该显式runner负责。
- [x] acceptance runner参照`apps/server/test/acceptance/plugin-cli.mjs`，在临时目录实际CLI build/pack，比较artifact，启动真实Server/SQLite，preview/import后tool不可用且无网络，独立activate后catalog贡献两个tool，normalPipeline输入私网URL得到web-url-blocked、unconfigured搜索得到web-search-not-configured，消息持久化含code。source删除后restart仍可用；disable/revoke后新turn不可用。production transport不接收测试private白名单。
- [x] 成功请求+完整sourceURL/nextLLMrequest/Session replay用sourcecreateWebModule+fakeHttp注册真实KernelPlugin进真实Server integration测试；明确这是确定性adapter验收。不要宣称该测试跑了live DNS/Tavily，也不要通过production绕过proxy发到localhost。实际产物另由CLI+真实loader生命周期核验；活网页测试单独记录。
- [x] official release policy新增空family `weave-web`，无releases；测试普通spoof不能官方、空family没有installableentry、不加builtinreservedIDs、不凭publisherWeave赋官方。
- [x] README产品文档加本地导入真实payload步骤；source/payload README由相同sourcebuild生成。工具名冲突沿用kernel注册错误，不做same-name fallback。
- [x] 运行focusedtests、`pnpm web-plugin:verify`、`pnpm marketplace:check`，然后完整`pnpm check`。新CI步与根脚本实现必须在本PR，保持之前pluginverify行为。

## Task 6: 独立review、浏览器/活网范围、内容PR完成

- [x] 独立review按spec逐项检查请求0次保护、DNSpinning、所有IPv6保留段、mapped、redirect、abort、key只发固定origin、12KiB完整来源、错误持久化与artifact重现；核对无隐含SDK/API/依赖变化。
- [x] 修复实际review问题，重跑受影响tests，然后完整check只在有新改动/失败需要时重复。
- [x] 真实Studio验证安装review/activation、unconfigured搜索提示、Approvalpending/deny/cancel、默认页抓取publicHTTPS来源、刷新恢复、停用新回合。可以真实读取一个已明确指定公开官方文档，不需要APIkey。若当前环境公网不可达，记录真实error，与deterministictests区分；不放宽TLS/IP/重定向来使验收通过。
- [x] 无显式配置的Tavilykey则不调用liveprovider、不要求用户在chat贴key；test报告明确“官方wirecontract+确定性adapter，未验证当前key/plan/liveavailability”。已有配置且用户已授权provider外发时，仅用无敏感公共query做一次live验收，不打印header/key。
- [x] commit中文`feat: 增加独立联网搜索与网页读取插件`，push功能分支，PR描述问题/最终行为/边界/测试，等待CI绿，独立review后squash删分支。不要把fakefutureSHA或发行index提前塞入。

## Task 7: 真实SHA官方发行索引，独立PR

**Files:** `apps/server/src/official-marketplace-releases.ts`（append realtuple）、`marketplace/submissions/weave-web.json`、`marketplace/index.json`、`apps/server/test/official-web-release.test.ts`、使用文档发行记录。

- [x] 内容PR已squash后fetch最新origin/main，记录实际full40hexmergeSHA与合并descriptor，在新`chore/web-plugin-release`分支核对它；不能用localHEAD/branch/tag冒充实际合并内容。
- [x] 将确切manifest、canonicalrepo、实际SHA、`plugins/official/weave-web`作为正式0.1.0tuple加入空family，不改旧官方发行。
- [x] 从现有`marketplace:entry --help`读取实际CLI参数，真实远程获取该commit的payload并生成submission，校验Gitblob/manifest；Host检查包含目录摘要计算，本地已审阅产物另行核对摘要。额外独立远程摘要比对三次超时/连接失败，已在使用文档准确保留，未用localreceipt替代真实获取。
- [x] `pnpm marketplace:generate` / `pnpm marketplace:check`；现有exactpolicy测试加新family真实case，官方GitHub卡片仍needsinstall不是builtin，镜像保留官方维护+独立indexsource、错误SHA/manifest拒绝。
- [x] 完整`pnpm check`、市场检查、真实产物验收通过；修复默认目录测试只预期官方Skills的断言后，独立review的87个针对性测试及本轮完整检查均通过。
- [x] 如实区分首次真实acquirer成功与后续额外远程摘要复核失败，不宣称公网获取持续稳定、远程浏览器安装或live Tavily已验收；发行PR合并前不宣称市场发布完成。
- [ ] commit `chore: 发布联网插件固定版本索引`、push/PR、CI绿review/squash删branch。

## 自审清单

- [x] 设计每一节有任务实现；types/helpers/signatures一致；没有未知SDK方法或Runtime直接HTTPS。
- [x] 所有source文件职责单一，A/B/C文件所有权无冲突，tests在包test目录。
- [x] 源码/payload两目录与CLIprofile吻合，Node builtin-only，无新npm依赖；root新verify+CI提供真正rebuild证据。
- [x] 已核对readOnly+approval实际效果而非注释推断。
- [x] live测试与确定性adapter/真实产物lifecycle各自结论准确，最终不声称sandbox/任意网页可读/自动引用模型保证。

## 实施前审查修订（纳入所有任务）

- Zod 只做结构/Unicode/长度/default；不抛语义 WebToolError。URL semantic check 在 summarize + execute，安全 code 经 Pipeline 恢复。
- raw 与 canonical href 均 <=2048 UTF-16、4096 bytes，每 redirect/display URL 同检。
- known-key 支持 literal + 一层 mixed percent octet，URL 命中整项 omit/fetch fail，绝不改写 citation；正文脱敏在 JSON预算前。
- IP literal 正规化IPv6括号且绕过DNS，SNI适配；socket mapped只供 equality。
- rawHeaders <=64 pairs，重复解释header拒绝，非2xx headers后销毁body并按status映射。迟到nativeerror保留handler。
- 精确 `.prettierignore` exception `plugins/official/weave-web/index.mjs`；source/descriptor/docs先format，再实际CLI build。
- 真实 installed ESM 环境测试保存/删除/恢复两个 web env，不能依赖Server environment:{}。

## 当前执行记录

Task 1–6 的实现、独立审查、源码 CLI 校验、产物逐字节重建、真实 Studio 与公开 HTTPS 验收已完成。最后一轮审查补充原始主机名凭据检查的两条 RED→GREEN 回归，已重新构建产物；修复后 `pnpm check` 已通过（262 文件、4,780 测试），产物 verifier 已通过（12 模型请求、12 工具结果）；内容 PR #106 两组精确 head CI 均通过并已 squash（`ecfe2e889b9897ee6ea249b2ed7469585114ab2a`）。浏览器与 adapter 验证的范围记录在 `docs/learning/2026-11-23-web-plugin.md`。

Task 7 已从该实际 merge SHA 创建独立 `chore/web-plugin-release`，真实 GitHub 获取已生成 submission，默认目录包含官方 Skills 与联网两个需安装包。旧完整检查唯一失败为默认目录测试只预期官方 Skills；已明确加入联网条目，独立审查的 6 个测试文件、87 个用例通过。2026-11-23 本轮重新执行 `pnpm check` 退出 0，13 个包汇总 263 个文件、4,794 个用例通过（未改动包复用 Turborepo 缓存，Server 本轮实际执行 95 个文件、1,756 个用例）；`pnpm marketplace:check` 返回 2 plugins, up to date；`pnpm web-plugin:verify` 退出 0，实际 CLI 重建字节一致与安装生命周期验收通过，12 次模型请求、12 个工具结果，`liveProviderValidation:false`。三次额外远程目录摘要复核未完成，未将本地摘要冒充额外远程成功。实现和验证已完成，提交、发行 PR、精确 head CI 与合并流程仍待执行。
