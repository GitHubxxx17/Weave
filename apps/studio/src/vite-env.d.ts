/// <reference types="vite/client" />

interface WeaveTerminalBridge {
  readonly create: (options: {
    readonly cwd?: string | null;
    readonly cols: number;
    readonly rows: number;
  }) => Promise<{ readonly id?: string; readonly error?: string }>;
  readonly write: (id: string, data: string) => void;
  readonly resize: (id: string, cols: number, rows: number) => void;
  readonly dispose: (id: string) => void;
  readonly onData: (
    listener: (payload: { readonly id: string; readonly data: string }) => void,
  ) => () => void;
  readonly onExit: (
    listener: (payload: { readonly id: string; readonly exitCode: number }) => void,
  ) => () => void;
}

interface WeaveDesktopBridge {
  readonly isDesktop: true;
  readonly serverUrl: string;
  /** How the desktop window draws its title bar; absent in older shells. */
  readonly windowChrome?: 'hidden-inset' | 'native';
  readonly pluginDirectoryPicker?: true;
  /** Opens the system folder dialog; null when the user cancels. Desktop only. */
  readonly pickDirectory?: (
    purpose?: 'project' | 'plugin-import',
  ) => Promise<{ readonly path: string; readonly name: string } | null>;
  /** Opens the Weave data directory in the system file manager; absent in browser mode. */
  readonly openDataDirectory?: () => Promise<{ readonly ok: boolean; readonly error?: string }>;
  /** User-driven terminal; absent in browser mode and older shells. */
  readonly terminal?: WeaveTerminalBridge;
}

declare global {
  interface Window {
    weaveDesktop?: WeaveDesktopBridge;
  }
}

export {};
