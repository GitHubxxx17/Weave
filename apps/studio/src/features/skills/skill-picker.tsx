import { useEffect, useRef, useState, type ReactElement } from 'react';
import { previewSessionSkill } from './skill-api.js';
import {
  skillRef,
  sameSkill,
  type SkillCatalog,
  type SkillPreview,
  type SkillSummary,
} from './skill-types.js';
import './skills.css';
export function SkillPicker({
  sessionId,
  catalog,
  loading,
  error,
  selected,
  onToggle,
  onRefresh,
  onClose,
}: {
  readonly sessionId: string;
  readonly catalog: SkillCatalog | undefined;
  readonly loading: boolean;
  readonly error: string | undefined;
  readonly selected: readonly SkillSummary[];
  readonly onToggle: (skill: SkillSummary) => void;
  readonly onRefresh: () => void;
  readonly onClose: () => void;
}): ReactElement {
  const [query, setQuery] = useState('');
  const [preview, setPreview] = useState<SkillPreview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const request = useRef<AbortController | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    searchRef.current?.focus();
    return () => request.current?.abort();
  }, []);
  const entries =
    catalog?.entries.filter((item) =>
      `${item.name} ${item.description} ${item.source.label}`
        .toLowerCase()
        .includes(query.toLowerCase()),
    ) ?? [];
  async function showPreview(skill: SkillSummary): Promise<void> {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setPreview(null);
    setPreviewError(null);
    setPreviewing(true);
    try {
      const result = await previewSessionSkill(sessionId, skillRef(skill), controller.signal);
      if (!controller.signal.aborted) setPreview(result);
    } catch (cause) {
      if (!controller.signal.aborted)
        setPreviewError(cause instanceof Error ? cause.message : '无法预览技能');
    } finally {
      if (!controller.signal.aborted) setPreviewing(false);
    }
  }
  return (
    <section
      className="skill-picker"
      role="dialog"
      aria-label="技能"
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          onClose();
        }
      }}
    >
      <header>
        <strong>技能</strong>
        <button type="button" onClick={onRefresh} disabled={loading}>
          刷新技能
        </button>
        <button type="button" aria-label="关闭技能" onClick={onClose}>
          关闭
        </button>
      </header>
      <input
        ref={searchRef}
        aria-label="搜索技能"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder="按名称、描述或来源搜索"
      />
      {loading ? <p role="status">正在读取技能…</p> : null}
      {error === undefined ? null : <p role="alert">{error}</p>}
      {catalog !== undefined && (!catalog.complete || catalog.truncated) ? (
        <p role="status">目录尚未完整读取；保留原选择，发送时会校验内容。</p>
      ) : null}
      {catalog?.issues
        .filter((item) => item.field !== undefined)
        .map((item) => (
          <p key={`${item.skillId ?? item.source}:${item.field}`} role="status">
            {item.skillId === undefined ? item.source : item.skillId.split('/').pop()} 的 SKILL.md
            无效：字段 {item.field} 不能写成列表。
          </p>
        ))}
      <div className="skill-picker-list">
        {entries.map((item) => {
          const picked = selected.find((entry) => entry.id === item.id);
          const current = picked !== undefined && sameSkill(picked, item);
          return (
            <article key={item.id}>
              <label>
                <input
                  type="checkbox"
                  checked={current}
                  disabled={
                    !item.invocation.user || (selected.length >= 32 && picked === undefined)
                  }
                  onChange={() => onToggle(item)}
                />
                <strong>{item.name}</strong>
                <span className="skill-source">{item.source.label}</span>
              </label>
              <p>{item.description}</p>
              <small>{item.id}</small>
              {picked !== undefined && !current ? (
                <p className="skill-warning">内容已变化，重新选择以更新本轮引用。</p>
              ) : null}
              {item.ignoredFields === undefined ? null : (
                <p className="skill-warning">
                  以下字段 Weave 不支持，已忽略：{item.ignoredFields.join('、')}
                </p>
              )}
              {!item.invocation.user ? <p>仅供 Agent 按需使用</p> : null}
              <button
                type="button"
                aria-label={`预览 ${item.name}`}
                onClick={() => void showPreview(item)}
              >
                预览指令
              </button>
            </article>
          );
        })}
        {!loading && entries.length === 0 ? (
          <p>{query === '' ? '当前会话没有可用技能。' : '没有匹配的技能。'}</p>
        ) : null}
      </div>
      {previewing ? <p role="status">正在预览…</p> : null}
      {previewError === null ? null : <p role="alert">{previewError}</p>}
      {preview === null ? null : (
        <section className="skill-preview" aria-label="技能指令预览">
          <strong>{preview.skill.name}</strong>
          <p>只读预览；选择技能不会授予工具或执行权限。</p>
          <pre>{preview.instructions}</pre>
        </section>
      )}
    </section>
  );
}
