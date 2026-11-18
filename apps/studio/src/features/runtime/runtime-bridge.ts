/** Returns the local Server base URL exposed by the optional desktop bridge. */
export function getRuntimeServerUrl(): string {
  const desktopBridge = globalThis.window?.weaveDesktop;
  if (desktopBridge?.isDesktop !== true) {
    return '';
  }

  return desktopBridge.serverUrl.replace(/\/+$/, '');
}

/** Resolves a Studio API path for browser or desktop runtime execution. */
export function runtimeApiUrl(path: string): string {
  const normalizedPath = `/${path.replace(/^\/+/, '')}`;
  const serverUrl = getRuntimeServerUrl();

  return serverUrl === '' ? normalizedPath : `${serverUrl}${normalizedPath}`;
}

/**
 * Marks the document root with the desktop title bar style so CSS can add
 * drag regions and room for the macOS traffic lights. Browsers get no marker.
 */
export function applyWindowChrome(root: HTMLElement): void {
  const chrome = globalThis.window?.weaveDesktop?.windowChrome;
  if (chrome === 'hidden-inset' || chrome === 'native') {
    root.dataset.windowChrome = chrome;
  } else {
    delete root.dataset.windowChrome;
  }
}
