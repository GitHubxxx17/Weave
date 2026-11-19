// @vitest-environment jsdom

import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

import { ContextPanel } from '../src/features/panel/context-panel.js';
import type { PanelContext } from '../src/features/panel/panel-data.js';
import type { ContextBreakdown, TurnSummary } from '../src/features/workspace/workspace-types.js';

afterEach(cleanup);

function breakdown(overrides?: Partial<ContextBreakdown>): ContextBreakdown {
  return {
    windowTokens: 128_000,
    sentTokens: 1200,
    ratio: 1200 / 128_000,
    trimmed: false,
    categories: {
      system: 100,
      tools: 50,
      userMessages: 200,
      assistantText: 300,
      assistantReasoning: 0,
      toolCalls: 150,
      toolResults: 400,
      skeleton: 0,
    },
    ...overrides,
  };
}

function turn(context: ContextBreakdown | undefined): TurnSummary {
  return {
    turnId: 't1',
    status: 'completed',
    startedAt: '2026-11-18T00:00:00.000Z',
    modelSteps: [],
    toolCalls: 0,
    failedToolCalls: 0,
    ...(context === undefined ? {} : { context }),
  };
}

function panelContext(turns: readonly TurnSummary[]): PanelContext {
  return {
    statusKey: 'completed',
    statusLabel: '已完成',
    isRunning: false,
    sessionLabel: '会话',
    folderPath: undefined,
    projectId: undefined,
    modelLabel: 'mock',
    turns,
    messages: [],
    errorMessage: null,
    formatTime: () => '',
    onSetFolder: () => undefined,
    onJumpToMessage: () => undefined,
  };
}

describe('ContextPanel', () => {
  it('prompts for a first message when no context has been recorded', () => {
    render(<ContextPanel {...panelContext([])} />);
    expect(screen.getByText(/发送第一条消息/)).toBeTruthy();
  });

  it('shows the window, occupancy, and category composition', () => {
    render(<ContextPanel {...panelContext([turn(breakdown())])} />);
    expect(screen.getByText('128k')).toBeTruthy();
    expect(screen.getByText('1%')).toBeTruthy();
    expect(screen.getByText('系统指令')).toBeTruthy();
    expect(screen.getByText('工具结果')).toBeTruthy();
    expect(screen.queryByText(/阈值/)).toBeNull();
  });

  it('warns and points to recall once occupancy crosses the threshold', () => {
    render(
      <ContextPanel
        {...panelContext([turn(breakdown({ ratio: 0.82, sentTokens: 104_960, trimmed: true }))])}
      />,
    );
    const occupancy = screen.getByText('82%');
    expect(occupancy.className).toContain('context-ratio-warn');
    expect(screen.getByText(/recall 工具取回原文/)).toBeTruthy();
  });
});
