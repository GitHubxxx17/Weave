// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import {
  readDefaultPermissionMode,
  readPermissionMode,
  readRecordedPermissionMode,
  readReasoningEffort,
  writeDefaultPermissionMode,
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

describe('default permission mode', () => {
  it('defaults to ask and only accepts ask or trust', () => {
    expect(readDefaultPermissionMode()).toBe('ask');
    writeDefaultPermissionMode('trust');
    expect(readDefaultPermissionMode()).toBe('trust');
    expect(localStorage.getItem('weave.studio.defaultPermissionMode.v1')).toBe('trust');
  });

  it('falls back to ask for invalid stored values and never allows yolo', () => {
    for (const value of ['yolo', 'root', '', 'TRUST']) {
      localStorage.setItem('weave.studio.defaultPermissionMode.v1', value);
      expect(readDefaultPermissionMode()).toBe('ask');
    }
    localStorage.clear();
    writeDefaultPermissionMode('yolo' as never);
    expect(localStorage.getItem('weave.studio.defaultPermissionMode.v1')).toBeNull();
    expect(readDefaultPermissionMode()).toBe('ask');
  });

  it('uses the default for Sessions that never recorded a mode, including the draft', () => {
    writeDefaultPermissionMode('trust');
    expect(readPermissionMode('')).toBe('trust');
    expect(readPermissionMode('new-session')).toBe('trust');
    expect(readRecordedPermissionMode('new-session')).toBeUndefined();
  });

  it('keeps the mode a Session recorded when the default changes', () => {
    writePermissionMode('old-ask', 'ask');
    writePermissionMode('old-yolo', 'yolo');
    writeDefaultPermissionMode('trust');
    expect(readPermissionMode('old-ask')).toBe('ask');
    expect(readPermissionMode('old-yolo')).toBe('yolo');
    writeDefaultPermissionMode('ask');
    expect(readPermissionMode('old-ask')).toBe('ask');
  });
});
