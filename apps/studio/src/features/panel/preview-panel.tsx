import { useState, type FormEvent, type ReactElement } from 'react';
import { Globe, RotateCcw } from 'lucide-react';

/** Per-instance storage so two preview tabs keep independent addresses. */
const storageKeyPrefix = 'weave.studio.previewUrl';

/** Hosts that should default to http:// when the user omits the scheme. */
const localHostPattern = /^(localhost|127\.|0\.0\.0\.0|\[?::1\]?)/i;

interface ResolvedUrl {
  readonly url?: string;
  readonly error?: string;
}

/**
 * Turns user input into a safe http(s) URL. A missing scheme defaults to
 * http for local hosts and https otherwise; anything that is not http(s) is
 * rejected so the iframe never loads `javascript:` or `file:` targets.
 */
export function resolvePreviewUrl(input: string): ResolvedUrl {
  const trimmed = input.trim();
  if (trimmed === '') {
    return {};
  }
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)
    ? trimmed
    : `${localHostPattern.test(trimmed) ? 'http' : 'https'}://${trimmed}`;
  let parsed: URL;
  try {
    parsed = new URL(withScheme);
  } catch {
    return { error: '网址无效，请检查后重试' };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { error: '只支持 http 和 https 网址' };
  }
  return { url: parsed.toString() };
}

const crossOriginSandbox = 'allow-scripts allow-same-origin allow-forms allow-popups allow-modals';
const sameOriginSandbox = 'allow-scripts allow-forms allow-popups allow-modals';

/**
 * Same-origin pages must not get `allow-same-origin` together with
 * `allow-scripts`: that pair removes the sandbox and exposes Studio's DOM,
 * storage and the desktop bridge to the embedded page.
 */
export function isSameOriginPreview(url: string, currentOrigin: string): boolean {
  try {
    return new URL(url).origin === currentOrigin;
  } catch {
    return true;
  }
}

function readStoredUrl(storageKey: string): string {
  try {
    return globalThis.localStorage?.getItem(storageKey) ?? '';
  } catch {
    return '';
  }
}

/**
 * Embeds a web page in an iframe with an address bar and reload control.
 * Works in browser and desktop modes; the target must allow embedding
 * (many public sites set `X-Frame-Options`, and local dev servers do not).
 * `instanceId` keeps each preview tab's address separate when several are
 * open at once.
 */
export function PreviewPanel({ instanceId }: { readonly instanceId: string }): ReactElement {
  const storageKey = `${storageKeyPrefix}:${instanceId}`;
  const stored = readStoredUrl(storageKey);
  const [input, setInput] = useState(stored);
  const [loaded, setLoaded] = useState(stored);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  function submit(event: FormEvent): void {
    event.preventDefault();
    const resolved = resolvePreviewUrl(input);
    if (resolved.error !== undefined) {
      setError(resolved.error);
      return;
    }
    setError(null);
    setLoaded(resolved.url ?? '');
    try {
      globalThis.localStorage?.setItem(storageKey, resolved.url ?? '');
    } catch {
      // Storage can be unavailable (private mode, quota); the preview still loads.
    }
  }

  const isolated = loaded !== '' && isSameOriginPreview(loaded, globalThis.location.origin);

  return (
    <div className="preview-panel" role="region" aria-label="预览">
      <form className="preview-toolbar" onSubmit={submit}>
        <div className="preview-address">
          <Globe aria-hidden="true" />
          <input
            type="text"
            inputMode="url"
            aria-label="预览网址"
            placeholder="输入网址，例如 http://localhost:5173"
            spellCheck={false}
            value={input}
            onChange={(event) => setInput(event.target.value)}
          />
        </div>
        <button type="submit" className="preview-go">
          打开
        </button>
        <button
          type="button"
          className="icon-button"
          aria-label="刷新预览"
          title="刷新预览"
          disabled={loaded === ''}
          onClick={() => setReloadKey((current) => current + 1)}
        >
          <RotateCcw aria-hidden="true" />
        </button>
      </form>
      {error === null ? null : (
        <p className="preview-error" role="alert">
          {error}
        </p>
      )}
      {isolated ? (
        <p className="preview-error" role="status" data-testid="preview-isolation-notice">
          出于安全原因，与 Studio 同源的页面以隔离模式预览（不共享存储与桌面能力）。
        </p>
      ) : null}
      {loaded === '' ? (
        <div className="preview-empty">
          <span className="preview-empty-icon" aria-hidden="true">
            <Globe />
          </span>
          <strong>预览网页</strong>
          <p>输入要预览的网址，适合本地开发服务器或允许被嵌入的页面。</p>
        </div>
      ) : (
        <iframe
          key={`${loaded}#${reloadKey}`}
          className="preview-frame"
          title="网页预览"
          src={loaded}
          referrerPolicy="no-referrer"
          sandbox={isolated ? sameOriginSandbox : crossOriginSandbox}
        />
      )}
    </div>
  );
}
