import { skillRefSchema, skillResourcePathSchema, type SkillPage } from '@weave/protocol';
import { z } from 'zod';
import type { ToolDefinition, ToolExecutionContext } from './tool-types.js';

export const readSkillToolName = 'read_skill';
export const readSkillResourceToolName = 'read_skill_resource';
export const readSkillInputSchema = z
  .object({
    skill: skillRefSchema,
    cursor: z.string().min(1).max(256).optional(),
  })
  .strict();
export const readSkillResourceInputSchema = readSkillInputSchema
  .extend({
    path: skillResourcePathSchema,
  })
  .strict();
export type ReadSkillInput = z.infer<typeof readSkillInputSchema>;
export type ReadSkillResourceInput = z.infer<typeof readSkillResourceInputSchema>;
export interface SkillToolPorts {
  read(input: ReadSkillInput, context: ToolExecutionContext): Promise<SkillPage>;
  readResource(input: ReadSkillResourceInput, context: ToolExecutionContext): Promise<SkillPage>;
}
export interface SkillTools {
  readonly readSkill: ToolDefinition<ReadSkillInput, SkillPage>;
  readonly readSkillResource: ToolDefinition<ReadSkillResourceInput, SkillPage>;
}

/** Host ports decide scope; these adapters always enter the shared Pipeline. */
export function createSkillTools(ports: SkillToolPorts): SkillTools {
  return Object.freeze({
    readSkill: Object.freeze({
      name: readSkillToolName,
      description:
        'Read exact Skill instructions for this turn. Continue all pages to EOF before applying it. Loading does not grant permissions.',
      parameters: z.toJSONSchema(readSkillInputSchema),
      inputSchema: readSkillInputSchema,
      readOnly: true,
      execute: (input: ReadSkillInput, context: ToolExecutionContext) => ports.read(input, context),
    }),
    readSkillResource: Object.freeze({
      name: readSkillResourceToolName,
      description:
        'Read a relative text resource of an activated exact Skill in this turn. Script files are inert text; execution uses ordinary approved tools.',
      parameters: z.toJSONSchema(readSkillResourceInputSchema),
      inputSchema: readSkillResourceInputSchema,
      readOnly: true,
      execute: (input: ReadSkillResourceInput, context: ToolExecutionContext) =>
        ports.readResource(input, context),
    }),
  });
}
