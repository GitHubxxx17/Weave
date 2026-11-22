// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useComposerDraft } from '../src/features/composer/use-composer-draft.js';
const authority = {
  panelRef: 'b'.repeat(32),
  serverEpoch: 'a'.repeat(32),
  generation: 1,
  authorityEpoch: 1,
};
describe('owned composer drafts', () => {
  it('appends prepared text to latest edits once and preserves image identity', () => {
    const { result } = renderHook(() =>
      useComposerDraft({ sessionId: 'a', projectId: 'p', rootKey: 'root' }),
    );
    const image = { id: 'image' };
    act(() => {
      result.current.setText('first');
      result.current.setImages([image]);
    });
    const owner = result.current.owner;
    result.current.setPanelContext({ ...authority, owner, visible: true, lifetime: 'mount' });
    const token = result.current.beginPrepare('form');
    act(() => result.current.setText('first edited'));
    const insertion = {
      ...authority,
      owner,
      formId: 'form',
      requestEpoch: token,
      text: 'prepared',
    };
    act(() => expect(result.current.insertPrepared(insertion)).toBe('inserted'));
    expect(result.current.draft.text).toBe('first edited\n\nprepared');
    expect(result.current.draft.images[0]).toBe(image);
    expect(result.current.draft.literalSend).toBe(true);
    act(() => expect(result.current.insertPrepared(insertion)).toBe('stale'));
  });
  it('rejects A B A ownership and hide show tokens even with identical refs', () => {
    const { result, rerender } = renderHook(
      ({ sessionId }) => useComposerDraft({ sessionId, projectId: 'p', rootKey: 'root' }),
      { initialProps: { sessionId: 'a' } },
    );
    const old = result.current.owner;
    result.current.setPanelContext({ ...authority, owner: old, visible: true, lifetime: 'm' });
    const token = result.current.beginPrepare('form');
    rerender({ sessionId: 'b' });
    rerender({ sessionId: 'a' });
    expect(result.current.owner.epoch).toBeGreaterThan(old.epoch);
    act(() =>
      expect(
        result.current.insertPrepared({
          ...authority,
          owner: old,
          formId: 'form',
          requestEpoch: token,
          text: 'stale',
        }),
      ).toBe('stale'),
    );
    const owner = result.current.owner;
    result.current.setPanelContext({ ...authority, owner, visible: true, lifetime: 'm' });
    const token2 = result.current.beginPrepare('form');
    result.current.setPanelContext({ ...authority, owner, visible: false, lifetime: 'm' });
    result.current.setPanelContext({ ...authority, owner, visible: true, lifetime: 'm' });
    act(() =>
      expect(
        result.current.insertPrepared({
          ...authority,
          owner,
          formId: 'form',
          requestEpoch: token2,
          text: 'stale',
        }),
      ).toBe('stale'),
    );
  });
  it('does not clear edited drafts or migrate a provisional draft edited during creation', () => {
    const { result } = renderHook(() =>
      useComposerDraft({ sessionId: '', projectId: 'p', rootKey: 'root' }),
    );
    act(() => result.current.setText('first'));
    const capture = result.current.capture();
    act(() => result.current.setText('newer'));
    expect(result.current.migrateProvisional(capture, 'created', 'p', 'root')).toBeNull();
    act(() => result.current.clearSubmittedDraftIfCurrent(capture));
    expect(result.current.draft.text).toBe('newer');
  });
  it('migrates unchanged provisional draft with a ticket and clears only that revision', () => {
    const { result, rerender } = renderHook(
      ({ sessionId }) => useComposerDraft({ sessionId, projectId: 'p', rootKey: 'root' }),
      { initialProps: { sessionId: '' } },
    );
    act(() => result.current.setText('first'));
    const capture = result.current.capture();
    let ticket: ReturnType<typeof result.current.migrateProvisional> = null;
    act(() => {
      ticket = result.current.migrateProvisional(capture, 'created', 'p', 'root');
    });
    expect(ticket).not.toBeNull();
    rerender({ sessionId: 'created' });
    expect(result.current.draft.text).toBe('first');
    act(() => result.current.clearSubmittedDraftIfCurrent(capture, ticket));
    expect(result.current.draft.text).toBe('');
    expect(result.current.draft.literalSend).toBe(false);
  });
});

it('keeps real Session text across root changes while rejecting the old owner epoch', () => {
  const { result, rerender } = renderHook(
    ({ rootKey }) => useComposerDraft({ sessionId: 'a', projectId: 'p', rootKey }),
    { initialProps: { rootKey: 'one' } },
  );
  act(() => result.current.setText('owned text'));
  const owner = result.current.owner;
  rerender({ rootKey: 'two' });
  expect(result.current.draft.text).toBe('owned text');
  expect(result.current.isOwnerCurrent(owner)).toBe(false);
});
