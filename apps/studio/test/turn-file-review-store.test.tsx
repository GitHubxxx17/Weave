// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { TurnFileReview } from '../src/features/file-undo/turn-file-review.js';
import { createTurnFileReviewStore } from '../src/features/file-undo/turn-file-review-store.js';
const review = {
  turnId: 't',
  files: [{ path: 'a.ts', existedBefore: true, previousContent: 'a', afterContent: 'b' }],
};
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
it('keeps one pending mutation and its exact retry after virtual unmount', async () => {
  let reject!: (error: Error) => void;
  const pending = new Promise<Response>((_resolve, decline) => {
    reject = decline;
  });
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce(new Response(JSON.stringify(review)))
    .mockReturnValueOnce(pending)
    .mockRejectedValueOnce(Error('offline'));
  vi.stubGlobal('fetch', fetchMock);
  const store = createTurnFileReviewStore();
  const first = render(
    <TurnFileReview store={store} projectId="p" sessionId="s" turnId="t" disabled={false} />,
  );
  fireEvent.click(screen.getByRole('button', { name: '审阅本轮文件' }));
  await screen.findByText('a.ts');
  fireEvent.click(screen.getByRole('button', { name: '撤销本轮文件改动' }));
  fireEvent.click(screen.getByRole('button', { name: '确认撤销' }));
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  first.unmount();
  render(<TurnFileReview store={store} projectId="p" sessionId="s" turnId="t" disabled={false} />);
  expect(screen.getByRole('button', { name: '继续未完成请求' })).toHaveProperty('disabled', true);
  expect(fetchMock).toHaveBeenCalledTimes(2);
  reject(Error('lost response'));
  await screen.findByRole('alert');
  fireEvent.click(screen.getByRole('button', { name: '重试原请求' }));
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
  expect(fetchMock.mock.calls[2]?.[1]?.body).toBe(fetchMock.mock.calls[1]?.[1]?.body);
  expect(store.getPinnedTurnIds('p', 's')).toEqual(['t']);
});
it('isolates pending identity across sessions and reads the latest disabled state', async () => {
  const store = createTurnFileReviewStore();
  const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(review)));
  vi.stubGlobal('fetch', fetchMock);
  const view = render(
    <TurnFileReview store={store} projectId="p" sessionId="s" turnId="t" disabled={false} />,
  );
  fireEvent.click(screen.getByRole('button', { name: '审阅本轮文件' }));
  await screen.findByText('a.ts');
  view.rerender(
    <TurnFileReview store={store} projectId="p" sessionId="other" turnId="t" disabled={false} />,
  );
  expect(screen.queryByText('a.ts')).toBeNull();
  view.rerender(
    <TurnFileReview store={store} projectId="p" sessionId="s" turnId="t" disabled={true} />,
  );
  expect(screen.getByRole('button', { name: '审阅本轮文件' })).toHaveProperty('disabled', true);
});

it('bounds closed settled unsubscribed reviews to the newest 32 while protecting active entries', () => {
  const store = createTurnFileReviewStore();
  const owner = (turnId: string) => ({ projectId: 'p', sessionId: 's', turnId });
  const pending = { turnId: 'pending', operationId: 'operation', requestId: 'request' };
  store.set(owner('pending'), { pending });
  store.set(owner('loading'), { loading: true });
  store.set(owner('open'), { open: true });
  const unsubscribe = store.subscribe(owner('subscribed'), () => {});
  store.set(owner('subscribed'), { error: 'subscribed' });
  for (let index = 0; index < 34; index++)
    store.set(owner(`settled-${index}`), { review: { ...review, turnId: `settled-${index}` } });
  expect(store.get(owner('settled-0')).review).toBeUndefined();
  expect(store.get(owner('settled-1')).review).toBeUndefined();
  expect(store.get(owner('settled-2')).review?.turnId).toBe('settled-2');
  expect(store.get(owner('pending')).pending).toEqual(pending);
  expect(store.get(owner('loading')).loading).toBe(true);
  expect(store.get(owner('open')).open).toBe(true);
  expect(store.get(owner('subscribed')).error).toBe('subscribed');
  unsubscribe();
  expect(store.get(owner('settled-3')).review).toBeUndefined();
  expect(store.get(owner('subscribed')).error).toBe('subscribed');
});

it('removes settled session data and retains an uncertain original request until its outcome', async () => {
  let reject!: (error: Error) => void;
  let resolve!: (response: Response) => void;
  const fetchMock = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise<Response>((_resolve, decline) => {
          reject = decline;
        }),
    )
    .mockImplementationOnce(
      () =>
        new Promise<Response>((accept) => {
          resolve = accept;
        }),
    )
    .mockResolvedValueOnce(new Response(JSON.stringify(review)));
  vi.stubGlobal('fetch', fetchMock);
  const store = createTurnFileReviewStore();
  const owner = { projectId: 'p', sessionId: 's', turnId: 't' };
  store.set(owner, { open: true, review });
  store.set({ ...owner, turnId: 'settled' }, { review: { ...review, turnId: 'settled' } });
  store.set({ ...owner, sessionId: 'other' }, { review });
  const first = store.restore(owner, () => false);
  const exact = store.get(owner).pending;
  store.removeSession('p', 's');
  expect(store.get({ ...owner, turnId: 'settled' }).review).toBeUndefined();
  expect(store.get({ ...owner, sessionId: 'other' }).review).toEqual(review);
  expect(store.get(owner)).toMatchObject({ loading: true, pending: exact });
  reject(Error('uncertain response'));
  await first;
  expect(store.get(owner).pending).toEqual(exact);
  const second = store.restore(owner, () => false);
  expect(fetchMock.mock.calls[1]?.[1]?.body).toBe(fetchMock.mock.calls[0]?.[1]?.body);
  resolve(
    new Response(
      JSON.stringify({
        projectId: 'p',
        turnId: 't',
        operationId: exact!.operationId,
        requestId: exact!.requestId,
        results: [],
      }),
    ),
  );
  await second;
  expect(store.get(owner).review).toBeUndefined();
  expect(store.get(owner).pending).toBeUndefined();
});

it('disposes view state without cancelling an in-flight restore or notifying detached consumers', async () => {
  let resolve!: (response: Response) => void;
  const fetchMock = vi.fn().mockImplementationOnce(
    () =>
      new Promise<Response>((accept) => {
        resolve = accept;
      }),
  );
  vi.stubGlobal('fetch', fetchMock);
  const store = createTurnFileReviewStore();
  const owner = { projectId: 'p', sessionId: 's', turnId: 't' };
  const listener = vi.fn();
  const pins = vi.fn();
  store.subscribe(owner, listener);
  store.subscribePins(pins);
  const operation = store.restore(owner, () => false);
  const before = listener.mock.calls.length;
  const pinsBefore = pins.mock.calls.length;
  store.dispose();
  expect(store.get(owner).pending).toBeUndefined();
  resolve(new Response(JSON.stringify({ operationId: 'op', requestId: 'req', results: [] })));
  await operation;
  expect(listener).toHaveBeenCalledTimes(before);
  expect(pins).toHaveBeenCalledTimes(pinsBefore);
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(store.getPinnedTurnIds('p', 's')).toEqual([]);
  store.set(owner, { open: true });
  expect(store.get(owner).open).toBe(false);
});

it('uses access recency when pruning settled reviews and clears removed readbacks after completion', async () => {
  const store = createTurnFileReviewStore();
  const owner = (turnId: string) => ({ projectId: 'p', sessionId: 's', turnId });
  for (let index = 0; index < 32; index++)
    store.set(owner(String(index)), { error: String(index) });
  expect(store.get(owner('0')).error).toBe('0');
  store.set(owner('32'), { error: '32' });
  expect(store.get(owner('0')).error).toBe('0');
  expect(store.get(owner('1')).error).toBe('');
  let resolve!: (response: Response) => void;
  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation(
      () =>
        new Promise<Response>((accept) => {
          resolve = accept;
        }),
    ),
  );
  const loading = store.load(owner('loading'));
  store.removeSession('p', 's');
  expect(store.get(owner('loading')).loading).toBe(true);
  resolve(new Response(JSON.stringify({ ...review, turnId: 'loading' })));
  await loading;
  expect(store.get(owner('loading')).review).toBeUndefined();
  expect(store.getPinnedTurnIds('p', 's')).toEqual([]);
});

it('confirms only a matching completed readback and prunes a removed pending entry', async () => {
  const store = createTurnFileReviewStore();
  const owner = { projectId: 'p', sessionId: 's', turnId: 't' };
  const pending = { turnId: 't', operationId: 'original-operation', requestId: 'original-request' };
  store.set(owner, { pending, review });
  const completed = (operationId: string, requestId: string) => ({
    ...review,
    operation: {
      projectId: 'p',
      turnId: 't',
      operationId,
      requestId,
      status: 'completed',
      results: [],
    },
  });
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(review)))
      .mockResolvedValueOnce(new Response(JSON.stringify(completed('unrelated', 'unrelated'))))
      .mockResolvedValueOnce(
        new Response(JSON.stringify(completed(pending.operationId, pending.requestId))),
      ),
  );
  await store.load(owner);
  expect(store.get(owner).pending).toEqual(pending);
  await store.load(owner);
  expect(store.get(owner).pending).toEqual(pending);
  store.removeSession('p', 's');
  await store.load(owner);
  expect(store.get(owner).pending).toBeUndefined();
  expect(store.get(owner).review).toBeUndefined();
  expect(store.getPinnedTurnIds('p', 's')).toEqual([]);
});
