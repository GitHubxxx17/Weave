/** The part of an Electron IPC event that identifies the calling frame. */
export interface IpcSenderEvent {
  readonly senderFrame?: { readonly url: string; readonly origin?: string } | null;
}

/**
 * Returns true only when the IPC sender is a frame of the trusted Studio origin.
 *
 * Both the frame's own `origin` (opaque origins report `'null'`) and the origin
 * parsed from its URL must equal `trustedOrigin`. A missing frame, a missing
 * origin, or an unparsable URL is untrusted.
 */
export function isTrustedSender(event: IpcSenderEvent, trustedOrigin: string): boolean {
  const senderFrame = event.senderFrame;
  if (senderFrame === null || senderFrame === undefined) {
    return false;
  }
  if (senderFrame.origin !== trustedOrigin) {
    return false;
  }
  try {
    return new URL(senderFrame.url).origin === trustedOrigin;
  } catch {
    return false;
  }
}
