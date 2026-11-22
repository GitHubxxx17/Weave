import type { ReactElement } from 'react';
import { sameSkill, type SkillRef, type SkillSummary, type TurnSkills } from './skill-types.js';
/** Durable facts remain separate from optimistic selection and model consumption. */
export function SkillHistory({
  skills,
  selected,
}: {
  readonly skills?: TurnSkills | undefined;
  readonly selected?: readonly SkillSummary[] | undefined;
}): ReactElement | null {
  if (skills === undefined && (selected?.length ?? 0) === 0) return null;
  const names = new Map<string, string>(selected?.map((entry) => [entry.id, entry.name]));
  for (const application of skills?.applications ?? [])
    names.set(application.skill.id, application.skill.name);
  const name = (ref: SkillRef): string =>
    names.get(ref.id) ??
    ref.id
      .split('/')
      .at(-1)
      ?.replace(/^builtin:/, '') ??
    ref.id;
  return (
    <div className="message-skills" aria-label="本轮技能">
      {(skills === undefined ? (selected ?? []) : skills.requested).map((ref) => (
        <span className="skill-chip" title={ref.id} key={`request:${ref.id}`}>
          {skills === undefined ? '已选择' : '已请求'} · {name(ref)}
        </span>
      ))}
      {skills?.applications.map((entry, index) => (
        <span
          className="skill-chip"
          key={`application:${index}`}
          title={`${entry.skill.source.label} · ${entry.skill.id}`}
        >
          {entry.invocation === 'user'
            ? '已加入指令'
            : entry.delivery === 'delivered'
              ? '已交付'
              : '已准备'}{' '}
          · {entry.skill.name}
        </span>
      ))}
      {skills?.failures.map((failure, index) => (
        <span className="skill-chip skill-warning" key={`failure:${index}`} title={failure.code}>
          未生效 · {name(failure.skill)} ·{' '}
          {failure.code === 'skill-source-changed'
            ? '内容已变化，请重新选择'
            : failure.code === 'skill-not-invocable'
              ? '不允许本次调用'
              : '暂不可用'}
        </span>
      ))}
      {skills !== undefined &&
      skills.requested.some((ref) =>
        skills.applications.every((entry) => !sameSkill(entry.skill, ref)),
      ) &&
      skills.failures.length === 0 ? (
        <span className="skill-chip">未记录加入指令</span>
      ) : null}
    </div>
  );
}
