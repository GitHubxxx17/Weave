import { contextBridge, ipcRenderer } from 'electron';

const serverUrlArgumentPrefix = '--weave-server-url=';
const windowChromeArgumentPrefix = '--weave-window-chrome=';
const pickDirectoryChannel = 'weave:pick-directory';

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
  /** Opens the system folder dialog; resolves to null when the user cancels. */
  pickDirectory: (): Promise<{ path: string; name: string } | null> =>
    ipcRenderer.invoke(pickDirectoryChannel),
});
