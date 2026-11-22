import { expect, it } from 'vitest';
import { mergeExecutionHistory } from '../src/features/agent/execution-history.js';

it('keeps canonical durable order, restores unseen completed work and preserves exact live overlays', () => {
  const durable = [
    { id: 'old-u', turnId: 'old', text: 'old question' },
    { id: 'old-a', turnId: 'old', text: 'durable first' },
    { id: 'missed-a', turnId: 'missed', text: 'completed without observer' },
    { id: 'next-u', text: 'next question' },
    { id: 'next-a', turnId: 'next', text: 'partial next' },
  ];
  const current = [
    { id: 'old-a-live', turnId: 'old', text: 'stale first' },
    { id: 'next-u', turnId: 'next', text: 'next question' },
    { id: 'next-a-live', turnId: 'next', text: 'complete live next' },
  ];
  expect(
    mergeExecutionHistory(durable, current, [{ turnId: 'next', userMessageId: 'next-u' }]),
  ).toEqual([...durable.slice(0, 3), ...current.slice(1)]);
});

it('keeps an earlier protected Turn in its canonical position before newer durable Turns', () => {
  const durable = [
    { id: 'a-u', turnId: 'a', text: 'a question' },
    { id: 'a-a', turnId: 'a', text: 'a durable' },
    { id: 'b-a', turnId: 'b', text: 'b durable' },
  ];
  const current = [
    { id: 'a-u', turnId: 'a', text: 'a question' },
    { id: 'a-live', turnId: 'a', text: 'a live' },
    { id: 'b-live', turnId: 'b', text: 'b live' },
  ];
  expect(mergeExecutionHistory(durable, current, [{ turnId: 'a', userMessageId: 'a-u' }])).toEqual([
    ...current.slice(0, 2),
    durable[2],
  ]);
});
