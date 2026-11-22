import { useEffect, useRef, useState } from 'react';
import { fetchSessionSkills } from './skill-api.js';
import { sameSkill, type SkillCatalog, type SkillSummary, type SkillRef } from './skill-types.js';

export interface SessionSkillDraft {
  readonly selected: readonly SkillSummary[];
  readonly revision: number;
}
interface CatalogState {
  readonly catalog?: SkillCatalog;
  readonly loading: boolean;
  readonly error?: string;
}
const emptyDraft: SessionSkillDraft = { selected: [], revision: 0 };
const emptyCatalog: CatalogState = { loading: false };
export function useSessionSkills(sessionId: string, rootKey: string) {
  const [drafts, setDrafts] = useState<Record<string, SessionSkillDraft>>({});
  const [catalogs, setCatalogs] = useState<Record<string, CatalogState>>({});
  const [open, setOpen] = useState(false);
  const requests = useRef(new Map<string, { epoch: number; controller: AbortController }>());
  const roots = useRef(new Map<string, string>());
  useEffect(() => {
    setOpen(false);
  }, [sessionId]);
  useEffect(() => {
    if (sessionId === '') return;
    const previous = roots.current.get(sessionId);
    roots.current.set(sessionId, rootKey);
    if (previous !== undefined && previous !== rootKey) {
      setOpen(false);
      requests.current.get(sessionId)?.controller.abort();
      setDrafts((all) => ({
        ...all,
        [sessionId]: {
          selected: (all[sessionId]?.selected ?? []).filter(
            (skill) => skill.source.kind !== 'project',
          ),
          revision: (all[sessionId]?.revision ?? 0) + 1,
        },
      }));
      setCatalogs((all) => ({ ...all, [sessionId]: emptyCatalog }));
    }
  }, [sessionId, rootKey]);
  useEffect(
    () => () => {
      for (const request of requests.current.values()) request.controller.abort();
    },
    [],
  );
  async function refresh(): Promise<void> {
    if (sessionId === '') return;
    const previous = requests.current.get(sessionId);
    previous?.controller.abort();
    const request = { epoch: (previous?.epoch ?? 0) + 1, controller: new AbortController() };
    requests.current.set(sessionId, request);
    setCatalogs((all) => ({ ...all, [sessionId]: { ...all[sessionId], loading: true } }));
    try {
      const catalog = await fetchSessionSkills(sessionId, request.controller.signal);
      if (request.controller.signal.aborted || requests.current.get(sessionId) !== request) return;
      setCatalogs((all) => ({ ...all, [sessionId]: { catalog, loading: false } }));
    } catch (error) {
      if (request.controller.signal.aborted || requests.current.get(sessionId) !== request) return;
      setCatalogs((all) => ({
        ...all,
        [sessionId]: {
          ...all[sessionId],
          loading: false,
          error: error instanceof Error ? error.message : '无法读取技能目录',
        },
      }));
    }
  }
  const draft = drafts[sessionId] ?? emptyDraft;
  function toggle(skill: SkillSummary): void {
    setDrafts((all) => {
      const current = all[sessionId] ?? emptyDraft;
      const existing = current.selected.find((item) => item.id === skill.id);
      const selected =
        existing !== undefined && sameSkill(existing, skill)
          ? current.selected.filter((item) => item.id !== skill.id)
          : [...current.selected.filter((item) => item.id !== skill.id), skill].slice(0, 32);
      return { ...all, [sessionId]: { selected, revision: current.revision + 1 } };
    });
  }
  function remove(id: string): void {
    setDrafts((all) => {
      const current = all[sessionId] ?? emptyDraft;
      return {
        ...all,
        [sessionId]: {
          selected: current.selected.filter((item) => item.id !== id),
          revision: current.revision + 1,
        },
      };
    });
  }
  function clearSent(target: string, revision: number, sent: readonly SkillRef[]): void {
    setDrafts((all) => {
      const current = all[target];
      if (current === undefined) return all;
      const selected =
        current.revision === revision
          ? []
          : current.selected.filter((skill) => !sent.some((ref) => sameSkill(skill, ref)));
      return selected.length === current.selected.length
        ? all
        : { ...all, [target]: { selected, revision: current.revision + 1 } };
    });
  }
  function forget(target: string): void {
    requests.current.get(target)?.controller.abort();
    requests.current.delete(target);
    roots.current.delete(target);
    setDrafts((all) => Object.fromEntries(Object.entries(all).filter(([key]) => key !== target)));
    setCatalogs((all) => Object.fromEntries(Object.entries(all).filter(([key]) => key !== target)));
  }
  return {
    draft,
    catalogState: catalogs[sessionId] ?? emptyCatalog,
    open,
    close: () => setOpen(false),
    show: () => {
      setOpen(true);
      void refresh();
    },
    refresh,
    toggle,
    remove,
    clearSent,
    forget,
  };
}
