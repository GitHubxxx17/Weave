/// <reference types="vite/client" />

interface WeaveDesktopBridge {
  readonly isDesktop: true;
  readonly serverUrl: string;
  /** Opens the system folder dialog; null when the user cancels. Desktop only. */
  readonly pickDirectory?: () => Promise<{ readonly path: string; readonly name: string } | null>;
}

declare global {
  interface Window {
    weaveDesktop?: WeaveDesktopBridge;
  }
}

export {};
