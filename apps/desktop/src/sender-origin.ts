/** The part of an Electron IPC event that identifies the calling frame. */
export interface IpcSenderEvent {
  readonly senderFrame?: { readonly url: string; readonly origin?: string } | null;
  /** The `webContents` that sent the message (`event.sender`). */
  readonly sender?: {
    readonly getURL: () => string;
    readonly mainFrame?: unknown;
  } | null;
}

/**
 * Returns true only when the IPC sender is the top-level page of the trusted
 * Studio origin.
 *
 * Checked together, all of which must hold:
 * - the sender frame's own `origin` (opaque origins report `'null'`) and the
 *   origin parsed from its URL equal `trustedOrigin`;
 * - the frame is the window's main frame, so an embedded child frame is
 *   refused even when it is same-origin;
 * - the window's current page (`webContents.getURL()`) is also on
 *   `trustedOrigin`, so a frame left over from a page that has since navigated
 *   away cannot keep using the bridge.
 *
 * A missing frame, sender, origin or an unparsable URL is untrusted.
 */
export function isTrustedSender(event: IpcSenderEvent, trustedOrigin: string): boolean {
  const senderFrame = event.senderFrame;
  if (senderFrame === null || senderFrame === undefined) {
    return false;
  }
  if (senderFrame.origin !== trustedOrigin) {
    return false;
  }
  const sender = event.sender;
  if (sender === null || sender === undefined || sender.mainFrame !== senderFrame) {
    return false;
  }
  try {
    return (
      new URL(senderFrame.url).origin === trustedOrigin &&
      new URL(sender.getURL()).origin === trustedOrigin
    );
  } catch {
    return false;
  }
}
