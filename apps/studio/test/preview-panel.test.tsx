// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import {
  isSameOriginPreview,
  PreviewPanel,
  resolvePreviewUrl,
} from '../src/features/panel/preview-panel.js';

beforeEach(() => {
  globalThis.localStorage.clear();
});
afterEach(cleanup);

function open(address: string): HTMLIFrameElement | null {
  render(<PreviewPanel instanceId="t" />);
  fireEvent.change(screen.getByLabelText('预览网址'), { target: { value: address } });
  fireEvent.click(screen.getByText('打开'));
  return document.querySelector('iframe');
}

describe('PreviewPanel sandbox', () => {
  it('keeps allow-same-origin for cross-origin previews', () => {
    const frame = open('http://localhost:5999');
    expect(frame?.getAttribute('sandbox')).toContain('allow-same-origin');
    expect(frame?.getAttribute('sandbox')).toContain('allow-scripts');
    expect(screen.queryByTestId('preview-isolation-notice')).toBeNull();
  });

  it('drops allow-same-origin and shows a notice for same-origin previews', () => {
    const frame = open(`${globalThis.location.origin}/page`);
    expect(frame?.getAttribute('sandbox')).not.toContain('allow-same-origin');
    expect(frame?.getAttribute('sandbox')).toContain('allow-scripts');
    expect(screen.getByTestId('preview-isolation-notice')).toBeTruthy();
  });

  it('keeps the existing error handling for invalid URLs', () => {
    const frame = open('ftp://example.com');
    expect(frame).toBeNull();
    expect(screen.getByRole('alert').textContent).toBe('只支持 http 和 https 网址');
    expect(resolvePreviewUrl('http://').error).toBe('网址无效，请检查后重试');
  });

  it('treats unparseable URLs as isolated', () => {
    expect(isSameOriginPreview('not a url', 'http://localhost:3000')).toBe(true);
    expect(isSameOriginPreview('http://localhost:3000/x', 'http://localhost:3000')).toBe(true);
    expect(isSameOriginPreview('http://localhost:5173/x', 'http://localhost:3000')).toBe(false);
  });
});
