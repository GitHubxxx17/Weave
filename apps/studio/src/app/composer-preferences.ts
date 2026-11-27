import { useCallback, useState } from 'react';
import { z } from 'zod';

/**
 * Remembers composer choices across reloads.
 * - Reasoning effort is remembered per Provider + model.
 * - Permission mode is remembered per Session. A Session that never recorded
 *   one (a new Session, or the draft before a Session exists) starts at the
 *   default mode from Settings. That default is only "ask" or "trust": "yolo"
 *   can never be the default, so a new Session never skips every Approval
 *   without the user choosing it there.
 * Stored values are validated; anything invalid falls back to the default.
 */
export const permissionModeSchema = z.enum(['ask', 'trust', 'yolo']);
export type PermissionMode = z.infer<typeof permissionModeSchema>;
export const reasoningEffortSchema = z.enum(['low', 'medium', 'high']);
export type ReasoningEffort = z.infer<typeof reasoningEffortSchema>;

/** Modes that may be the default for new Sessions; "yolo" is deliberately excluded. */
export const defaultPermissionModeSchema = z.enum(['ask', 'trust']);
export type DefaultPermissionMode = z.infer<typeof defaultPermissionModeSchema>;

export const defaultPermissionMode: DefaultPermissionMode = 'ask';
export const defaultReasoningEffort: ReasoningEffort = 'medium';

const permissionKey = (sessionId: string): string =>
  `weave.studio.permissionMode.v1:${encodeURIComponent(sessionId)}`;
const defaultPermissionKey = 'weave.studio.defaultPermissionMode.v1';
const reasoningKey = (provider: string, model: string): string =>
  `weave.studio.reasoningEffort.v1:${encodeURIComponent(provider)}:${encodeURIComponent(model)}`;

function readItem(key: string): string | undefined {
  try {
    return globalThis.localStorage?.getItem(key) ?? undefined;
  } catch {
    return undefined;
  }
}
function writeItem(key: string, value: string): void {
  try {
    globalThis.localStorage?.setItem(key, value);
  } catch {
    // Storage may be unavailable or full; the choice still applies in memory.
  }
}

/** Default mode for new Sessions. Invalid values, including "yolo", fall back to "ask". */
export function readDefaultPermissionMode(): DefaultPermissionMode {
  const parsed = defaultPermissionModeSchema.safeParse(readItem(defaultPermissionKey));
  return parsed.success ? parsed.data : defaultPermissionMode;
}
export function writeDefaultPermissionMode(mode: DefaultPermissionMode): void {
  const parsed = defaultPermissionModeSchema.safeParse(mode);
  if (parsed.success) writeItem(defaultPermissionKey, parsed.data);
}
/** The mode a Session recorded itself, or `undefined` when it never recorded one. */
export function readRecordedPermissionMode(sessionId: string): PermissionMode | undefined {
  if (sessionId === '') return undefined;
  const parsed = permissionModeSchema.safeParse(readItem(permissionKey(sessionId)));
  return parsed.success ? parsed.data : undefined;
}
/** A recorded Session mode wins; otherwise the Settings default applies. */
export function readPermissionMode(sessionId: string): PermissionMode {
  return readRecordedPermissionMode(sessionId) ?? readDefaultPermissionMode();
}
export function writePermissionMode(sessionId: string, mode: PermissionMode): void {
  if (sessionId !== '') writeItem(permissionKey(sessionId), mode);
}
export function readReasoningEffort(provider: string, model: string): ReasoningEffort {
  const parsed = reasoningEffortSchema.safeParse(readItem(reasoningKey(provider, model)));
  return parsed.success ? parsed.data : defaultReasoningEffort;
}
export function writeReasoningEffort(
  provider: string,
  model: string,
  effort: ReasoningEffort,
): void {
  writeItem(reasoningKey(provider, model), effort);
}

/** Permission mode of the active Session; choices made before a Session exists apply to its first send. */
export function usePermissionMode(activeSessionId: string) {
  const [cache, setCache] = useState<Readonly<Record<string, PermissionMode>>>({});
  const mode = cache[activeSessionId] ?? readPermissionMode(activeSessionId);
  const rememberFor = useCallback((sessionId: string, next: PermissionMode): void => {
    writePermissionMode(sessionId, next);
    setCache((current) => {
      // A pre-Session choice is consumed once a real Session takes it over.
      const { '': _draftChoice, ...rest } = current;
      void _draftChoice;
      return { ...(sessionId === '' ? current : rest), [sessionId]: next };
    });
  }, []);
  const setMode = useCallback(
    (next: PermissionMode): void => rememberFor(activeSessionId, next),
    [activeSessionId, rememberFor],
  );
  return { permissionMode: mode, setPermissionMode: setMode, rememberPermissionMode: rememberFor };
}
