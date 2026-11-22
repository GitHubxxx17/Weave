import { randomUUID } from 'node:crypto';
import { panelBytes } from './plugin-panel-types.js';
import type { PanelProjection } from './plugin-panel-projection.js';
export interface PanelCacheEntry {
  readonly identity: string;
  readonly version: number;
  readonly sessionId: string;
  readonly value: PanelProjection;
  readonly bytes: number;
}
/** Insertion ordered maps implement deterministic entry and Session LRU. */
export function createPanelCache() {
  const entries = new Map<string, PanelCacheEntry>();
  const sessions = new Map<string, Set<string>>();
  let bytes = 0;
  function remove(key: string) {
    const entry = entries.get(key);
    if (!entry) return;
    entries.delete(key);
    bytes -= entry.bytes;
    const bucket = sessions.get(entry.sessionId)!;
    bucket.delete(key);
    if (bucket.size === 0) sessions.delete(entry.sessionId);
  }
  function touch(key: string, entry: PanelCacheEntry) {
    entries.delete(key);
    entries.set(key, entry);
    const bucket = sessions.get(entry.sessionId)!;
    bucket.delete(key);
    bucket.add(key);
    sessions.delete(entry.sessionId);
    sessions.set(entry.sessionId, bucket);
  }
  function get(key: string) {
    const entry = entries.get(key);
    if (entry) touch(key, entry);
    return entry;
  }
  function put(key: string, sessionId: string, value: PanelProjection, base?: PanelCacheEntry) {
    const current = entries.get(key);
    if (base ? current !== base : current !== undefined) return;
    const size = panelBytes(value);
    if (size > 65536) return;
    if (current) remove(key);
    while (!sessions.has(sessionId) && sessions.size >= 128) {
      for (const member of [...sessions.values().next().value!]) remove(member);
    }
    let bucket = sessions.get(sessionId);
    if (!bucket) {
      bucket = new Set();
      sessions.set(sessionId, bucket);
    }
    const sessionBytes = () =>
      [...bucket!].reduce((sum, member) => sum + entries.get(member)!.bytes, 0);
    while (bucket.size >= 16 || sessionBytes() + size > 524288)
      remove(bucket.values().next().value!);
    while (entries.size >= 256 || bytes + size > 8388608) remove(entries.keys().next().value!);
    // An eviction can remove the empty bucket from the Session map.
    if (!sessions.has(sessionId)) sessions.set(sessionId, bucket);
    const entry = {
      identity: base?.identity ?? randomUUID(),
      version: (base?.version ?? 0) + 1,
      sessionId,
      value,
      bytes: size,
    };
    entries.set(key, entry);
    bucket.add(key);
    bytes += size;
    touch(key, entry);
  }
  return {
    get,
    put,
    clear() {
      entries.clear();
      sessions.clear();
      bytes = 0;
    },
  };
}
