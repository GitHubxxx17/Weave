import { useCallback, useState } from 'react';
import { z } from 'zod';

/**
 * Remembers composer choices across reloads.
 * - Reasoning effort is remembered per Provider + model.
 * - Permission mode is remembered per Session only. It is never global, so a
 *   new Session always starts at the safest mode instead of inheriting "yolo".
 * Stored values are validated; anything invalid falls back to the default.
 */
export const permissionModeSchema = z.enum(['ask', 'trust', 'yolo']);
export type PermissionMode = z.infer<typeof permissionModeSchema>;
export const reasoningEffortSchema = z.enum(['low', 'medium', 'high']);
export type ReasoningEffort = z.infer<typeof reasoningEffortSchema>;

export const defaultPermissionMode: PermissionMode = 'ask';
export const defaultReasoningEffort: ReasoningEffort = 'medium';

const permissionKey = (sessionId: string): string =>
  `weave.studio.permissionMode.v1:${encodeURIComponent(sessionId)}`;
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

export function readPermissionMode(sessionId: string): PermissionMode {
  if (sessionId === '') return defaultPermissionMode;
  const parsed = permissionModeSchema.safeParse(readItem(permissionKey(sessionId)));
  return parsed.success ? parsed.data : defaultPermissionMode;
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
