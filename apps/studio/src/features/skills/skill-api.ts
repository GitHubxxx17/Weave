import { z } from 'zod';
import { runtimeApiUrl } from '../runtime/runtime-bridge.js';
import {
  skillCatalogSchema,
  skillPreviewSchema,
  skillRefSchema,
  sameSkill,
  type SkillCatalog,
  type SkillPreview,
  type SkillRef,
} from './skill-types.js';

export class SkillApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'SkillApiError';
  }
}
async function request<T>(
  sessionId: string,
  suffix: string,
  schema: z.ZodType<T>,
  signal?: AbortSignal,
  body?: unknown,
): Promise<T> {
  const response = await fetch(
    runtimeApiUrl(`/sessions/${encodeURIComponent(sessionId)}/skills${suffix}`),
    {
      method: body === undefined ? 'GET' : 'POST',
      ...(body === undefined
        ? {}
        : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
      ...(signal === undefined ? {} : { signal }),
    },
  );
  const data: unknown = await response.json();
  if (!response.ok) {
    const parsed = z
      .object({ error: z.object({ code: z.string(), message: z.string() }) })
      .safeParse(data);
    throw new SkillApiError(
      parsed.success ? parsed.data.error.code : 'skill-api-protocol',
      parsed.success ? parsed.data.error.message : '技能服务返回无效响应',
      response.status,
    );
  }
  const parsed = schema.safeParse(data);
  if (!parsed.success)
    throw new SkillApiError('skill-api-protocol', '技能服务返回无效数据', response.status);
  return parsed.data;
}
export function fetchSessionSkills(sessionId: string, signal?: AbortSignal): Promise<SkillCatalog> {
  return request(sessionId, '', skillCatalogSchema, signal);
}
export async function previewSessionSkill(
  sessionId: string,
  selected: SkillRef,
  signal?: AbortSignal,
): Promise<SkillPreview> {
  const ref = skillRefSchema.parse(selected);
  const result = await request(sessionId, '/preview', skillPreviewSchema, signal, { skill: ref });
  if (!sameSkill(result.skill, ref))
    throw new SkillApiError('skill-source-changed', '技能内容已变化，请刷新并重新选择', 409);
  return result;
}
