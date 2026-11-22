import type { SessionEvent } from './events.js';
import type { FileSnapshot } from './file-undo.js';

export interface SafeFileSnapshot extends FileSnapshot {
  readonly fileIdentity?: string | undefined;
  readonly rootIdentity?: string | undefined;
  readonly beforeDigest?: string | undefined;
  readonly afterDigest?: string | undefined;
  readonly afterContent?: string | undefined;
  readonly unavailableReason?: string | undefined;
}

type Capture = Extract<SessionEvent, { type: 'workspace.file-snapshot' }>;
type Outcome = Extract<SessionEvent, { type: 'workspace.file-write' }>;

/** Only a unique, ordered intent/capture/outcome chain proves an original. */
export function collectSafeFileUndo(
  events: readonly SessionEvent[],
  turnId: string,
): readonly SafeFileSnapshot[] {
  const paths = new Map<string, SafeFileSnapshot>();
  const captures = new Map<string, Capture[]>();
  const writes = new Map<string, Outcome[]>();
  const intents = new Map<string, number>();
  let active: string | undefined;
  for (const event of events) {
    if (event.type === 'workspace.file-snapshot' && event.payload.snapshotId !== undefined) {
      const list = captures.get(event.payload.snapshotId) ?? [];
      list.push(event);
      captures.set(event.payload.snapshotId, list);
    }
    if (event.type === 'workspace.file-write') {
      const list = writes.get(event.payload.snapshotId) ?? [];
      list.push(event);
      writes.set(event.payload.snapshotId, list);
    }
    if (event.type === 'workspace.file-write-intent')
      intents.set(event.payload.snapshotId, (intents.get(event.payload.snapshotId) ?? 0) + 1);
  }
  for (const event of events) {
    if (event.type === 'turn.started') active = event.payload.turnId;
    if (event.type === 'turn.completed' && active === event.payload.turnId) active = undefined;
    if (
      event.type === 'workspace.file-snapshot' &&
      (event.payload.turnId ?? active) === turnId &&
      (event.payload.snapshotId === undefined || !intents.has(event.payload.snapshotId))
    ) {
      if (!paths.has(event.payload.path))
        paths.set(event.payload.path, {
          ...event.payload,
          unavailableReason:
            event.payload.snapshotId === undefined ? 'legacy-snapshot' : 'missing-write-intent',
        });
    }
    if (event.type !== 'workspace.file-write-intent' || event.payload.turnId !== turnId) continue;
    const intent = event.payload;
    const captureEvents = captures.get(intent.snapshotId) ?? [];
    const writeEvents = writes.get(intent.snapshotId) ?? [];
    const captureEvent = captureEvents[0];
    const writeEvent = writeEvents[0];
    const capture = captureEvent?.payload;
    const write = writeEvent?.payload;
    const first = paths.get(intent.path);
    const matches = (
      value:
        | {
            path: string;
            turnId?: string | undefined;
            toolCallId?: string | undefined;
            rootIdentity?: string | undefined;
          }
        | undefined,
    ) =>
      value !== undefined &&
      value.path === intent.path &&
      value.turnId === turnId &&
      value.toolCallId === intent.toolCallId &&
      value.rootIdentity === intent.rootIdentity;
    const unique =
      intents.get(intent.snapshotId) === 1 &&
      captureEvents.length === 1 &&
      writeEvents.length === 1;
    const ordered =
      captureEvent !== undefined &&
      writeEvent !== undefined &&
      event.sequence < captureEvent.sequence &&
      captureEvent.sequence < writeEvent.sequence;
    const valid =
      unique &&
      ordered &&
      matches(capture) &&
      matches(write) &&
      capture?.beforeDigest !== undefined &&
      write?.status === 'succeeded' &&
      write.captureStatus === 'captured' &&
      write.fileIdentity !== undefined;
    const reason = !valid
      ? writeEvents.length === 0
        ? 'missing-write-outcome'
        : (write?.reason ?? 'incomplete-write-evidence')
      : first?.unavailableReason;
    const continuous =
      first?.afterDigest === undefined ||
      (first.afterDigest === capture?.beforeDigest && first.rootIdentity === capture?.rootIdentity);
    paths.set(intent.path, {
      ...(first ?? capture ?? { path: intent.path, existedBefore: false, previousContent: '' }),
      rootIdentity: intent.rootIdentity,
      beforeDigest: first?.beforeDigest ?? capture?.beforeDigest,
      afterDigest: write?.afterDigest,
      afterContent: write?.afterContent,
      fileIdentity: write?.fileIdentity,
      unavailableReason: reason ?? (continuous ? undefined : 'incomplete-write-chain'),
    });
  }
  const result = [...paths.values()];
  const byIdentity = new Map<string, SafeFileSnapshot[]>();
  for (const file of result) {
    if (file.fileIdentity === undefined) continue;
    const group = byIdentity.get(`${file.rootIdentity ?? ''}:${file.fileIdentity}`) ?? [];
    group.push(file);
    byIdentity.set(`${file.rootIdentity ?? ''}:${file.fileIdentity}`, group);
  }
  for (const group of byIdentity.values())
    if (new Set(group.map((file) => file.path)).size > 1)
      for (const file of group)
        result[result.indexOf(file)] = { ...file, unavailableReason: 'path-alias-conflict' };
  return result;
}
