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
  it('clears an accepted background owner bucket while preserving the current Session and ABA edits', () => {
    const { result, rerender } = renderHook(
      ({ sessionId }) => useComposerDraft({ sessionId, projectId: 'p', rootKey: 'root' }),
      { initialProps: { sessionId: 'a' } },
    );
    act(() => {
      result.current.setText('accepted a');
      result.current.setImages([{ id: 'a-image' }]);
    });
    const accepted = result.current.capture();
    rerender({ sessionId: 'b' });
    act(() => result.current.setText('keep b'));
    act(() => expect(result.current.clearSubmittedDraftIfCurrent(accepted)).toBe(true));
    expect(result.current.draft.text).toBe('keep b');
    rerender({ sessionId: 'a' });
    expect(result.current.draft.text).toBe('');
    expect(result.current.draft.images).toEqual([]);
    act(() => result.current.setText('another a'));
    const old = result.current.capture();
    rerender({ sessionId: 'b' });
    rerender({ sessionId: 'a' });
    act(() => result.current.setText('new a after ABA'));
    act(() => expect(result.current.clearSubmittedDraftIfCurrent(old)).toBe(false));
    expect(result.current.draft.text).toBe('new a after ABA');
  });
  it('keeps only copied sampling metadata with the owned draft and clears it on acceptance', () => {
    const { result, rerender } = renderHook(
      ({ sessionId }) => useComposerDraft({ sessionId, projectId: 'p', rootKey: 'root' }),
      { initialProps: { sessionId: 'a' } },
    );
    act(() => {
      result.current.setText('copied');
      result.current.setSampling({
        provider: 'p',
        model: 'm',
        useProviderDefaults: false,
        temperature: 0.23,
        maxTokens: 321,
      });
    });
    const captured = result.current.capture();
    expect(result.current.draft.sampling).toEqual({
      provider: 'p',
      model: 'm',
      useProviderDefaults: false,
      temperature: 0.23,
      maxTokens: 321,
    });
    rerender({ sessionId: 'b' });
    expect(result.current.draft.sampling).toBeUndefined();
    act(() => result.current.clearSubmittedDraftIfCurrent(captured));
    rerender({ sessionId: 'a' });
    expect(result.current.draft.sampling).toBeUndefined();
  });
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

it('owns ordered files through Session ABA, root changes and accepted revisions', () => {
  const { result, rerender } = renderHook(
    ({ sessionId, rootKey }) => useComposerDraft({ sessionId, rootKey, projectId: 'p' }),
    { initialProps: { sessionId: 'a', rootKey: 'one' } },
  );
  const original = result.current.owner;
  act(() => expect(result.current.addFile(original, 'a.ts')).toBe('added'));
  const revision = result.current.capture();
  act(() => expect(result.current.addFile(original, 'a.ts')).toBe('duplicate'));
  expect(result.current.capture().revision).toBe(revision.revision);
  rerender({ sessionId: 'b', rootKey: 'one' });
  act(() => expect(result.current.addFile(original, 'stale.ts')).toBe('stale'));
  rerender({ sessionId: 'a', rootKey: 'one' });
  expect(result.current.draft.files).toEqual([{ path: 'a.ts' }]);
  act(() => result.current.addFile(result.current.owner, 'new.ts'));
  act(() => expect(result.current.clearSubmittedDraftIfCurrent(revision)).toBe(false));
  const oldOwner = result.current.owner;
  const oldRevision = result.current.capture().revision;
  act(() => {
    result.current.setText('keep text');
    result.current.setImages([{ id: 'keep-image' }]);
  });
  rerender({ sessionId: 'a', rootKey: 'two' });
  expect(result.current.draft.files).toEqual([]);
  expect(result.current.draft.text).toBe('keep text');
  expect(result.current.draft.images).toEqual([{ id: 'keep-image' }]);
  expect(result.current.capture().revision).toBeGreaterThan(oldRevision);
  act(() => expect(result.current.addFile(oldOwner, 'wrong.ts')).toBe('stale'));
});

it('migrates provisional refs and enforces the exact eight file limit', () => {
  const { result } = renderHook(() =>
    useComposerDraft({ sessionId: '', rootKey: 'root', projectId: 'p' }),
  );
  act(() => {
    for (let i = 0; i < 8; i += 1)
      expect(result.current.addFile(result.current.owner, `${i}.ts`)).toBe('added');
  });
  act(() => expect(result.current.addFile(result.current.owner, 'ninth.ts')).toBe('full'));
  const capture = result.current.capture();
  act(() =>
    expect(result.current.migrateProvisional(capture, 'created', 'p', 'root')).not.toBeNull(),
  );
  expect(result.current.draft.files).toHaveLength(8);
  act(() => result.current.removeFile('0.ts'));
  expect(result.current.draft.files[0]).toEqual({ path: '1.ts' });
});
