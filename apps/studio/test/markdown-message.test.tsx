// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { MarkdownMessage } from '../src/features/conversation/markdown-message.js';

describe('MarkdownMessage', () => {
  afterEach(() => cleanup());

  it('renders headings, emphasis, lists, code and GFM tables', () => {
    const { container } = render(
      <MarkdownMessage
        text={[
          '## 结论',
          '',
          '我目前**不能直接读取**文件。',
          '',
          '1. 第一步',
          '2. 第二步',
          '',
          '```ts',
          'const a = 1;',
          '```',
          '',
          '| 列 | 值 |',
          '| --- | --- |',
          '| a | 1 |',
        ].join('\n')}
      />,
    );

    expect(screen.getByRole('heading', { level: 2, name: '结论' })).toBeTruthy();
    expect(container.querySelector('strong')?.textContent).toBe('不能直接读取');
    expect(container.querySelectorAll('ol > li')).toHaveLength(2);
    expect(container.querySelector('pre code')?.textContent).toContain('const a = 1;');
    expect(screen.getByRole('table')).toBeTruthy();
    expect(container.textContent).not.toContain('**');
  });

  it('does not interpret raw HTML from the model', () => {
    const { container } = render(
      <MarkdownMessage text={'<script>alert(1)</script><b onclick="x()">粗体</b>'} />,
    );

    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('b')).toBeNull();
  });

  it('opens safe links in a new window and neutralizes unsafe schemes', () => {
    const { container } = render(
      <MarkdownMessage text={'[文档](https://example.com) [危险](javascript:alert(1))'} />,
    );

    const links = container.querySelectorAll('a');
    expect(links).toHaveLength(1);
    expect(links[0]?.getAttribute('href')).toBe('https://example.com');
    expect(links[0]?.getAttribute('target')).toBe('_blank');
    expect(links[0]?.getAttribute('rel')).toBe('noopener noreferrer');
    expect(container.textContent).toContain('危险');
  });

  it('drops images so the model cannot load remote resources', () => {
    const { container } = render(<MarkdownMessage text={'![追踪](https://example.com/p.png)'} />);

    expect(container.querySelector('img')).toBeNull();
  });
});
