// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import {
  readPermissionMode,
  readReasoningEffort,
  writePermissionMode,
  writeReasoningEffort,
} from '../src/app/composer-preferences.js';

afterEach(() => localStorage.clear());

describe('composer preferences', () => {
  it('remembers the permission mode per Session and defaults new Sessions to ask', () => {
    writePermissionMode('session-a', 'yolo');
    expect(readPermissionMode('session-a')).toBe('yolo');
    expect(readPermissionMode('session-b')).toBe('ask');
    expect(readPermissionMode('')).toBe('ask');
  });

  it('remembers reasoning effort per Provider and model', () => {
    writeReasoningEffort('p', 'm1', 'high');
    expect(readReasoningEffort('p', 'm1')).toBe('high');
    expect(readReasoningEffort('p', 'm2')).toBe('medium');
    expect(readReasoningEffort('q', 'm1')).toBe('medium');
  });

  it('falls back to defaults for invalid stored values', () => {
    localStorage.setItem('weave.studio.permissionMode.v1:session-a', 'root');
    localStorage.setItem('weave.studio.reasoningEffort.v1:p:m', 'extreme');
    expect(readPermissionMode('session-a')).toBe('ask');
    expect(readReasoningEffort('p', 'm')).toBe('medium');
  });
});
