import { contextBridge } from 'electron';

const serverUrlArgumentPrefix = '--weave-server-url=';
const serverUrlArgument = process.argv.find((argument) =>
  argument.startsWith(serverUrlArgumentPrefix),
);
const serverUrl =
  serverUrlArgument === undefined
    ? undefined
    : decodeURIComponent(serverUrlArgument.slice(serverUrlArgumentPrefix.length));

if (serverUrl === undefined || serverUrl.length === 0) {
  throw new Error('Weave Desktop Server URL is missing from the preload arguments');
}

contextBridge.exposeInMainWorld('weaveDesktop', {
  isDesktop: true as const,
  serverUrl,
});
