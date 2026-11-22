import type { PluginSdk } from '@weave/plugin';
import { WebToolError } from './errors.js';
import { containsKnownSecret } from './result.js';
import type {
  HttpResponseData,
  SearchConfig,
  SearchInput,
  WebHttpClient,
  WebSource,
} from './types.js';
import { parsePublicHttpsUrl } from './url-policy.js';

const responseByteLimit = 524_288;

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new DOMException('The operation was aborted', 'AbortError');
}

function rejectStatus(response: HttpResponseData): void {
  const status = response.status;
  if (status >= 200 && status < 300) return;
  if (status >= 300 && status < 400)
    throw new WebToolError(
      'web-redirect-blocked',
      'Search redirects are blocked. Check the configured search provider and try again.',
    );
  if (status === 401 || status === 403)
    throw new WebToolError(
      'web-search-auth-failed',
      'Search authentication failed. Check WEAVE_WEB_TAVILY_API_KEY and restart the host.',
    );
  if (status === 429 || status === 434) {
    const retryAfter = response.headers['retry-after'];
    const seconds =
      retryAfter !== undefined && /^(?:0|[1-9]\d*)$/.test(retryAfter)
        ? Number(retryAfter)
        : undefined;
    const suggestion =
      seconds !== undefined && seconds <= 3600
        ? ` Retry after ${seconds} seconds.`
        : ' Try again later.';
    throw new WebToolError('web-rate-limited', `The search provider is rate limited.${suggestion}`);
  }
  if (status === 432 || status === 433)
    throw new WebToolError(
      'web-search-quota-exceeded',
      'The search provider quota is exhausted. Check your Tavily account quota.',
    );
  throw new WebToolError(
    'web-http-error',
    `The search provider returned HTTP ${status}. Try again later.`,
  );
}

export async function searchTavily(
  z: PluginSdk['z'],
  http: WebHttpClient,
  config: SearchConfig,
  input: SearchInput,
  signal: AbortSignal,
): Promise<{ sources: readonly Omit<WebSource, 'id'>[]; omittedResults: number }> {
  throwIfAborted(signal);
  let response: HttpResponseData;
  try {
    response = await http.request({
      url: new URL('https://api.tavily.com/search'),
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'Accept-Encoding': 'identity',
        'User-Agent': 'Weave-Web/0.1.0',
      },
      body: new TextEncoder().encode(
        JSON.stringify({
          query: input.query,
          max_results: input.maxResults,
          search_depth: 'basic',
          chunks_per_source: 1,
          topic: 'general',
          auto_parameters: false,
          include_answer: false,
          include_raw_content: false,
          include_images: false,
          include_image_descriptions: false,
          include_favicon: false,
          include_usage: false,
        }),
      ),
      signal,
      maxWireBytes: responseByteLimit,
      maxDecodedBytes: responseByteLimit,
    });
  } catch (error) {
    throwIfAborted(signal);
    if (error instanceof WebToolError) throw error;
    throw new WebToolError(
      'web-network-failed',
      'The search request failed. Check the network connection and try again.',
    );
  }
  throwIfAborted(signal);
  rejectStatus(response);
  if (response.bytes.byteLength > responseByteLimit)
    throw new WebToolError(
      'web-response-too-large',
      'The search response exceeded the size limit. Try a narrower query.',
    );
  const schema = z.object({
    results: z
      .array(
        z.object({
          title: z.string().max(4096),
          url: z.string().max(4096),
          content: z.string().max(65536),
          score: z.number().finite().optional(),
        }),
      )
      .max(20),
  });
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(response.bytes));
  } catch {
    throw new WebToolError(
      'web-provider-response-invalid',
      'The search provider returned invalid data. Try again later.',
    );
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success)
    throw new WebToolError(
      'web-provider-response-invalid',
      'The search provider returned invalid data. Try again later.',
    );
  const sources: Omit<WebSource, 'id'>[] = [];
  const seen = new Set<string>();
  let omittedResults = 0;
  for (const result of parsed.data.results) {
    let url: URL;
    try {
      url = parsePublicHttpsUrl(result.url);
    } catch {
      omittedResults += 1;
      continue;
    }
    if (
      containsKnownSecret(result.url, [config.apiKey]) ||
      containsKnownSecret(url.href, [config.apiKey]) ||
      seen.has(url.href) ||
      sources.length >= input.maxResults
    ) {
      omittedResults += 1;
      continue;
    }
    seen.add(url.href);
    sources.push({ title: result.title, url: url.href, excerpt: result.content });
  }
  throwIfAborted(signal);
  return { sources, omittedResults };
}
