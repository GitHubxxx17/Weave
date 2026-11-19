import { describe, expect, it } from 'vitest';
import { createUpdatePlanTool, parsePlanFromToolCall, updatePlanToolName } from '../src/index.js';

const samplePlan = {
  explanation: '先读后写',
  plan: [
    { step: '读取配置', status: 'completed' },
    { step: '修改配置', status: 'in_progress' },
    { step: '运行测试', status: 'pending' },
  ],
};

describe('update_plan tool', () => {
  it('is a read-only tool that needs no approval', () => {
    const tool = createUpdatePlanTool();
    expect(tool.name).toBe('update_plan');
    expect(tool.readOnly).toBe(true);
    expect(tool.approval).toBeUndefined();
  });

  it('summarizes the plan counts in its result', async () => {
    const tool = createUpdatePlanTool();
    const result = await tool.execute(
      { explanation: '先读后写', plan: samplePlan.plan as never },
      { signal: new AbortController().signal },
    );
    expect(result).toBe('已记录计划：共 3 项（进行中 1，已完成 1，待办 1）。');
  });

  it('rejects arguments that are not a valid plan', () => {
    const tool = createUpdatePlanTool();
    expect(tool.inputSchema.safeParse({ plan: [{ step: '', status: 'pending' }] }).success).toBe(
      false,
    );
    expect(tool.inputSchema.safeParse({ plan: [{ step: '一步', status: '未知' }] }).success).toBe(
      false,
    );
    expect(tool.inputSchema.safeParse({ plan: [] }).success).toBe(true);
  });
});

describe('parsePlanFromToolCall', () => {
  it('recovers an AgentPlan from an update_plan call, mapping plan to items', () => {
    const plan = parsePlanFromToolCall({
      name: updatePlanToolName,
      arguments: JSON.stringify(samplePlan),
    });
    expect(plan).toEqual({
      explanation: '先读后写',
      items: [
        { step: '读取配置', status: 'completed' },
        { step: '修改配置', status: 'in_progress' },
        { step: '运行测试', status: 'pending' },
      ],
    });
  });

  it('omits the explanation when it was not provided', () => {
    const plan = parsePlanFromToolCall({
      name: updatePlanToolName,
      arguments: JSON.stringify({ plan: [{ step: '一步', status: 'pending' }] }),
    });
    expect(plan).toEqual({ items: [{ step: '一步', status: 'pending' }] });
    expect(plan && 'explanation' in plan).toBe(false);
  });

  it('returns undefined for another tool or invalid arguments', () => {
    expect(parsePlanFromToolCall({ name: 'read_file', arguments: '{}' })).toBeUndefined();
    expect(
      parsePlanFromToolCall({ name: updatePlanToolName, arguments: 'not json' }),
    ).toBeUndefined();
    expect(
      parsePlanFromToolCall({ name: updatePlanToolName, arguments: JSON.stringify({}) }),
    ).toBeUndefined();
  });
});
