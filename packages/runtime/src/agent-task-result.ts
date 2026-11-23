import { agentTaskViewSchema, type AgentTaskView } from '@weave/protocol';
import { z } from 'zod';

export interface AgentTaskEnvelope {
  readonly tasks: readonly AgentTaskView[];
  readonly cursor: string;
  readonly timedOut?: boolean | undefined;
  readonly changed?: boolean | undefined;
  readonly allSettled?: boolean | undefined;
  readonly nextCursor?: string | undefined;
  readonly truncated?: boolean | undefined;
}
const cursorSchema = z
  .string()
  .min(1)
  .max(600)
  .regex(/^[!-~]+$/);
const envelopeSchema = z.strictObject({
  tasks: z.array(z.unknown()).max(16),
  cursor: cursorSchema,
  timedOut: z.boolean().optional(),
  changed: z.boolean().optional(),
  allSettled: z.boolean().optional(),
  nextCursor: cursorSchema.optional(),
  truncated: z.boolean().optional(),
});
const encoder = new TextEncoder();
const utf8Bytes = (value: string): number => encoder.encode(value).length;
function prefix(value: string, maxBytes: number): string {
  if (utf8Bytes(value) <= maxBytes) return value;
  let result = '';
  let size = 0;
  for (const point of value) {
    size += utf8Bytes(point);
    if (size > maxBytes) break;
    result += point;
  }
  return result;
}
function tooLarge(): Error & { readonly code: string } {
  return Object.assign(new Error('Agent task result metadata exceeds the output budget'), {
    code: 'agent-task-result-too-large',
  });
}
export function boundAgentTaskEnvelope(
  input: AgentTaskEnvelope,
  options: { readonly maxBytes?: number; readonly mode?: 'list' | 'detail' } = {},
): AgentTaskEnvelope & { readonly truncated: boolean } {
  const metadata = envelopeSchema.parse(input);
  const maxBytes = z
    .number()
    .int()
    .positive()
    .safe()
    .max(24_576)
    .parse(options.maxBytes ?? 24_576);
  const mode = options.mode ?? 'detail';
  if (metadata.tasks.length > (mode === 'list' ? 16 : 4)) throw tooLarge();
  let truncated = metadata.truncated === true;
  const tasks = input.tasks.map((task) => {
    const preview = prefix(task.preview, mode === 'list' ? 256 : 4096);
    if (preview !== task.preview) truncated = true;
    return agentTaskViewSchema.parse({
      ...task,
      preview,
      previewTruncated: task.previewTruncated || preview !== task.preview,
    });
  });
  const envelope = { ...metadata, tasks, truncated };
  const size = () => utf8Bytes(JSON.stringify(envelope));
  // Reduce the currently longest display field. The tie starts after the last
  // edited task so equal previews shrink in response order, preserving all IDs.
  let next = 0;
  for (const field of ['preview', 'title'] as const) {
    while (size() > maxBytes) {
      let longest = -1;
      let longestBytes = 0;
      for (let offset = 0; offset < tasks.length; offset++) {
        const index = (next + offset) % tasks.length;
        const bytes = utf8Bytes(tasks[index]![field]);
        if (bytes > longestBytes) {
          longest = index;
          longestBytes = bytes;
        }
      }
      if (longest === -1) break;
      const task = tasks[longest]!;
      const overage = size() - maxBytes;
      task[field] = prefix(
        task[field],
        Math.max(0, longestBytes - Math.max(1, Math.ceil(overage / tasks.length))),
      );
      if (field === 'preview') task.previewTruncated = true;
      envelope.truncated = true;
      next = (longest + 1) % tasks.length;
    }
  }
  if (size() > maxBytes) throw tooLarge();
  return envelope;
}
