/// <reference types="vite/client" />

interface WeaveDesktopBridge {
  readonly isDesktop: true;
  readonly serverUrl: string;
}

declare global {
  interface Window {
    weaveDesktop?: WeaveDesktopBridge;
  }
}

export {};
