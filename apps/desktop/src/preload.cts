import { contextBridge, ipcRenderer } from 'electron';

const serverUrlArgumentPrefix = '--weave-server-url=';
const windowChromeArgumentPrefix = '--weave-window-chrome=';
const pickDirectoryChannel = 'weave:pick-directory';
const openDataDirectoryChannel = 'weave:open-data-directory';
const terminalChannels = {
  create: 'weave:terminal:create',
  input: 'weave:terminal:input',
  resize: 'weave:terminal:resize',
  dispose: 'weave:terminal:dispose',
  data: 'weave:terminal:data',
  exit: 'weave:terminal:exit',
} as const;

function readArgument(prefix: string): string | undefined {
  return process.argv.find((argument) => argument.startsWith(prefix))?.slice(prefix.length);
}

const serverUrlArgument = readArgument(serverUrlArgumentPrefix);
const serverUrl =
  serverUrlArgument === undefined ? undefined : decodeURIComponent(serverUrlArgument);

if (serverUrl === undefined || serverUrl.length === 0) {
  throw new Error('Weave Desktop Server URL is missing from the preload arguments');
}

/** Unknown or missing values fall back to the native title bar layout. */
const windowChrome =
  readArgument(windowChromeArgumentPrefix) === 'hidden-inset' ? 'hidden-inset' : 'native';

contextBridge.exposeInMainWorld('weaveDesktop', {
  isDesktop: true as const,
  serverUrl,
  /** How the window draws its title bar, so Studio can lay out drag regions. */
  windowChrome,
  pluginDirectoryPicker: true as const,
  /** Opens the system folder dialog; resolves to null when the user cancels. */
  pickDirectory: (
    purpose?: 'project' | 'plugin-import',
  ): Promise<{ path: string; name: string } | null> =>
    purpose === undefined
      ? ipcRenderer.invoke(pickDirectoryChannel)
      : ipcRenderer.invoke(pickDirectoryChannel, purpose),
  /** Opens the configured Weave data directory in the system file manager; takes no path. */
  openDataDirectory: (): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke(openDataDirectoryChannel),
  /** User-driven terminal controlled from the Studio renderer. */
  terminal: {
    create: (options: {
      cwd?: string | null;
      cols: number;
      rows: number;
    }): Promise<{ id?: string; error?: string }> =>
      ipcRenderer.invoke(terminalChannels.create, options),
    write: (id: string, data: string): void => {
      ipcRenderer.send(terminalChannels.input, { id, data });
    },
    resize: (id: string, cols: number, rows: number): void => {
      ipcRenderer.send(terminalChannels.resize, { id, cols, rows });
    },
    dispose: (id: string): void => {
      ipcRenderer.send(terminalChannels.dispose, { id });
    },
    onData: (listener: (payload: { id: string; data: string }) => void): (() => void) => {
      const handler = (_event: unknown, payload: { id: string; data: string }): void =>
        listener(payload);
      ipcRenderer.on(terminalChannels.data, handler);
      return () => ipcRenderer.removeListener(terminalChannels.data, handler);
    },
    onExit: (listener: (payload: { id: string; exitCode: number }) => void): (() => void) => {
      const handler = (_event: unknown, payload: { id: string; exitCode: number }): void =>
        listener(payload);
      ipcRenderer.on(terminalChannels.exit, handler);
      return () => ipcRenderer.removeListener(terminalChannels.exit, handler);
    },
  },
});
