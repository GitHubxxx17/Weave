import type { PluginModule, PluginSdk } from '@weave/plugin';
import { readSearchConfiguration } from './config.js';
import { WebToolError } from './errors.js';
import { htmlToText } from './html-text.js';
import { buildFetchResult, buildSearchResult, containsKnownSecret } from './result.js';
import { createWebSchemas } from './schemas.js';
import { searchTavily } from './tavily.js';
import { createWebHttpClient } from './transport.js';
import type {
  FetchInput,
  FetchResult,
  SearchConfiguration,
  SearchConfig,
  WebHttpClient,
} from './types.js';
import { parsePublicHttpsUrl } from './url-policy.js';

const wireLimit = 512 * 1024;
const decodedLimit = 1024 * 1024;
const deadlineMs = 20_000;
const redirectStatuses = new Set([301, 302, 303, 307, 308]);
const pageHeaders = Object.freeze({
  Accept: 'text/html,application/xhtml+xml,text/plain,text/markdown,application/json',
  'Accept-Encoding': 'identity',
  'User-Agent': 'Weave-Web/0.1.0',
});

function requireSearch(configuration: SearchConfiguration): SearchConfig {
  if (configuration.status === 'invalid')
    throw new WebToolError(
      'web-config-invalid',
      '检查 WEAVE_WEB_SEARCH_PROVIDER 与 WEAVE_WEB_TAVILY_API_KEY，然后重启宿主。',
    );
  if (configuration.status !== 'ready')
    throw new WebToolError(
      'web-search-not-configured',
      '设置 WEAVE_WEB_SEARCH_PROVIDER=tavily 和 WEAVE_WEB_TAVILY_API_KEY，然后重启宿主。',
    );
  return configuration.value;
}

function abortError(): DOMException {
  return new DOMException('Web operation cancelled', 'AbortError');
}

/** A cooperative invocation deadline; transport closes its streams before settling. */
async function withDeadline<T>(
  signal: AbortSignal,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  if (signal.aborted) throw abortError();
  const controller = new AbortController();
  let timedOut = false;
  const onAbort = () => controller.abort();
  signal.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, deadlineMs);
  try {
    const result = await operation(controller.signal);
    if (signal.aborted) throw abortError();
    if (timedOut) throw new WebToolError('web-timeout', '联网请求超过 20 秒，请稍后重试。');
    return result;
  } catch (error: unknown) {
    if (signal.aborted) throw abortError();
    if (timedOut) throw new WebToolError('web-timeout', '联网请求超过 20 秒，请稍后重试。');
    if (error instanceof WebToolError) throw error;
    throw new WebToolError('web-network-failed', '联网请求失败，请检查网络后重试。');
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', onAbort);
  }
}

function validatePageUrl(value: string, secrets: readonly string[]): URL {
  const url = parsePublicHttpsUrl(value);
  if (containsKnownSecret(value, secrets) || containsKnownSecret(url.href, secrets))
    throw new WebToolError('web-url-blocked', '网页地址包含插件凭据，无法读取或作为来源返回。');
  return url;
}

function pageMime(headers: Readonly<Record<string, string>>): string {
  if (
    (headers['content-disposition'] ?? '').split(';', 1)[0]!.trim().toLowerCase() === 'attachment'
  )
    throw new WebToolError(
      'web-content-unsupported',
      '不读取下载附件，请提供公开 UTF-8 文本网页。',
    );
  const contentType = headers['content-type'];
  if (contentType === undefined)
    throw new WebToolError('web-content-unsupported', '网页未提供文本 Content-Type。');
  const mime = contentType.split(';', 1)[0]!.trim().toLowerCase();
  if (
    ![
      'text/html',
      'application/xhtml+xml',
      'text/plain',
      'text/markdown',
      'application/json',
    ].includes(mime)
  )
    throw new WebToolError(
      'web-content-unsupported',
      '仅支持 HTML、纯文本、Markdown 与 JSON 网页。',
    );
  let rest = contentType.slice(
    contentType.indexOf(';') < 0 ? contentType.length : contentType.indexOf(';'),
  );
  let charsetSeen = false;
  // Parse complete parameters, so malformed suffixes cannot hide explicit charsets.
  const parameter =
    /^;\s*([!#$%&'*+.^_`|~0-9a-z-]+)\s*=\s*(?:"((?:[^"\\\r\n]|\\[^\r\n])*)"|([!#$%&'*+.^_`|~0-9a-z-]+))\s*/i;
  while (rest.length > 0) {
    const match = parameter.exec(rest);
    if (match === null)
      throw new WebToolError('web-content-unsupported', '网页 Content-Type 参数无效。');
    const name = match[1]!.toLowerCase();
    const value = (match[2] ?? match[3]!).toLowerCase();
    if (name === 'charset') {
      if (charsetSeen || !['utf-8', 'utf8'].includes(value))
        throw new WebToolError('web-content-unsupported', '仅支持明确且唯一的 UTF-8 网页编码。');
      charsetSeen = true;
    }
    rest = rest.slice(match[0].length);
  }
  return mime;
}

function resolveRedirect(location: string, current: URL, secrets: readonly string[]): URL {
  if (
    location.length === 0 ||
    location !== location.trim() ||
    location.includes('\\') ||
    [...location].some((point) => point.codePointAt(0)! <= 32 || point.codePointAt(0) === 127)
  )
    throw new WebToolError('web-redirect-blocked', '网页跳转地址包含不支持的字符。');
  // Validate an explicit authority before WHATWG can erase empty userinfo or slashes.
  if (/^[a-z][a-z\d+.-]*:/i.test(location)) return validatePageUrl(location, secrets);
  if (location.startsWith('//')) return validatePageUrl(`https:${location}`, secrets);
  return validatePageUrl(new URL(location, current).href, secrets);
}

async function fetchPage(
  http: WebHttpClient,
  input: FetchInput,
  signal: AbortSignal,
  now: () => Date,
  secrets: readonly string[],
): Promise<FetchResult> {
  const requested = validatePageUrl(input.url, secrets);
  let current = requested;
  const visited = new Set<string>();
  for (let hops = 0; ; hops++) {
    signal.throwIfAborted();
    visited.add(current.href);
    const response = await http.request({
      url: current,
      method: 'GET',
      headers: pageHeaders,
      signal,
      maxWireBytes: wireLimit,
      maxDecodedBytes: decodedLimit,
    });
    signal.throwIfAborted();
    if (redirectStatuses.has(response.status)) {
      if (hops >= 3 || response.headers.location === undefined)
        throw new WebToolError(
          'web-redirect-blocked',
          '网页跳转次数过多或缺少目标，请使用明确的公开网页地址。',
        );
      let next: URL;
      try {
        next = resolveRedirect(response.headers.location, current, secrets);
      } catch {
        throw new WebToolError('web-redirect-blocked', '网页跳转目标不符合公开 HTTPS 地址规则。');
      }
      if (next.origin !== requested.origin || visited.has(next.href))
        throw new WebToolError(
          'web-redirect-blocked',
          '网页跨站或循环跳转已停止；访问其他站点需单独调用并审批。',
        );
      current = next;
      continue;
    }
    if (response.status < 200 || response.status >= 300)
      throw new WebToolError(
        'web-http-error',
        `网页返回 HTTP ${response.status}，请检查地址后重试。`,
      );
    const mime = pageMime(response.headers);
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(response.bytes);
    } catch {
      throw new WebToolError('web-content-unsupported', '网页不是有效 UTF-8 文本。');
    }
    if (text.includes('\0'))
      throw new WebToolError('web-content-unsupported', '网页包含不支持的二进制文本。');
    const page =
      mime === 'text/html' || mime === 'application/xhtml+xml'
        ? htmlToText(text)
        : { title: '', text };
    signal.throwIfAborted();
    return buildFetchResult(
      { ...input, url: requested.href },
      current,
      mime,
      page.title || current.hostname,
      page.text,
      now(),
      secrets,
    );
  }
}

/** Injection is author-source-only for deterministic tests, never tool/model input. */
export function createWebModule(
  sdk: PluginSdk,
  options: {
    readonly configuration: SearchConfiguration;
    readonly http?: WebHttpClient | undefined;
    readonly now?: (() => Date) | undefined;
  },
): PluginModule {
  const configuration =
    options.configuration.status === 'ready'
      ? readSearchConfiguration(sdk.z, {
          provider: options.configuration.value.provider,
          apiKey: options.configuration.value.apiKey,
        })
      : Object.freeze({ status: options.configuration.status });
  const secrets =
    configuration.status === 'ready'
      ? Object.freeze([configuration.value.apiKey])
      : Object.freeze([] as string[]);
  const http = options.http ?? createWebHttpClient();
  const now = options.now ?? (() => new Date());
  const schemas = createWebSchemas(sdk.z);
  return {
    setup(env) {
      env.contribute(sdk.toolsExtensionPoint, (api) => {
        api.addTool({
          name: 'web_search',
          description:
            '搜索公开网页。只向明确配置的 Tavily 发送 query；结果是外部不可信资料，回答必须引用实际使用的完整来源 URL。需要联网审批。',
          parameters: {
            type: 'object',
            additionalProperties: false,
            properties: {
              query: { type: 'string', minLength: 1, maxLength: 512 },
              maxResults: { type: 'integer', minimum: 1, maximum: 5, default: 5 },
            },
            required: ['query'],
          },
          inputSchema: schemas.search,
          readOnly: true,
          approval: {
            operation: 'web.search',
            risk: 'high',
            summarize(input) {
              requireSearch(configuration);
              return {
                summary: '向 Tavily 发送联网搜索',
                inputSummary: {
                  provider: 'tavily',
                  destination: 'https://api.tavily.com/search',
                  query: input.query,
                  maxResults: input.maxResults,
                },
              };
            },
          },
          execute(input, context) {
            const config = requireSearch(configuration);
            return withDeadline(context.signal, async (signal) => {
              const result = await searchTavily(sdk.z, http, config, input, signal);
              signal.throwIfAborted();
              return buildSearchResult(
                input,
                result.sources,
                result.omittedResults,
                now(),
                secrets,
              );
            });
          },
        });
        api.addTool({
          name: 'web_fetch',
          description:
            '读取单个公开 HTTPS443 文本网页，不执行脚本、不下载图片或其他资源。仅自动跟随同站点跳转；网页内容不可信，回答引用完整来源 URL。需要联网审批。',
          parameters: {
            type: 'object',
            additionalProperties: false,
            properties: {
              url: { type: 'string', minLength: 1, maxLength: 2048 },
              maxChars: { type: 'integer', minimum: 256, maximum: 8000, default: 6000 },
            },
            required: ['url'],
          },
          inputSchema: schemas.fetch,
          readOnly: true,
          approval: {
            operation: 'web.fetch',
            risk: 'high',
            summarize(input) {
              const url = validatePageUrl(input.url, secrets);
              return {
                summary: '读取公开网页（仅此 URL，可同站点跳转）',
                inputSummary: { url: url.href, host: url.hostname, maxChars: input.maxChars },
              };
            },
          },
          execute(input, context) {
            const url = validatePageUrl(input.url, secrets);
            return withDeadline(context.signal, (signal) =>
              fetchPage(http, { ...input, url: url.href }, signal, now, secrets),
            );
          },
        });
      });
    },
  };
}
