// @vitest-environment jsdom

import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

import { PlanPanel } from '../src/features/panel/plan-panel.js';
import type { PanelContext } from '../src/features/panel/panel-data.js';
import type { AgentPlan, TurnSummary } from '../src/features/workspace/workspace-types.js';

afterEach(cleanup);

function turn(plan: AgentPlan | undefined): TurnSummary {
  return {
    turnId: 't1',
    status: 'completed',
    startedAt: '2026-11-18T00:00:00.000Z',
    modelSteps: [],
    toolCalls: 0,
    failedToolCalls: 0,
    ...(plan === undefined ? {} : { plan }),
  };
}

function panelContext(turns: readonly TurnSummary[]): PanelContext {
  return {
    statusKey: 'completed',
    statusLabel: '已完成',
    isRunning: false,
    sessionLabel: '会话',
    folderPath: undefined,
    modelLabel: 'mock',
    turns,
    messages: [],
    errorMessage: null,
    formatTime: () => '',
    onSetFolder: () => undefined,
    onJumpToMessage: () => undefined,
  };
}

describe('PlanPanel', () => {
  it('prompts when no plan has been recorded', () => {
    render(<PlanPanel {...panelContext([])} />);
    expect(screen.getByText(/维护任务清单/)).toBeTruthy();
  });

  it('shows the checklist with progress, explanation, and statuses', () => {
    const plan: AgentPlan = {
      explanation: '先读后写',
      items: [
        { step: '读取文件', status: 'completed' },
        { step: '修改文件', status: 'in_progress' },
        { step: '运行测试', status: 'pending' },
      ],
    };
    render(<PlanPanel {...panelContext([turn(plan)])} />);
    expect(screen.getByText(/1\/3 已完成/)).toBeTruthy();
    expect(screen.getByText('先读后写')).toBeTruthy();
    expect(screen.getByText('读取文件')).toBeTruthy();
    expect(screen.getByText('修改文件')).toBeTruthy();
    expect(screen.getByText('运行测试')).toBeTruthy();
    expect(screen.getByText('进行中')).toBeTruthy();
  });

  it('reads the latest plan across turns', () => {
    const older: AgentPlan = { items: [{ step: '旧步骤', status: 'pending' }] };
    const newer: AgentPlan = { items: [{ step: '新步骤', status: 'completed' }] };
    render(<PlanPanel {...panelContext([turn(older), turn(newer)])} />);
    expect(screen.getByText('新步骤')).toBeTruthy();
    expect(screen.queryByText('旧步骤')).toBeNull();
  });
});
