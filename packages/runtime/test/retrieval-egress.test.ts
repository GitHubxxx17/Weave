import { describe, expect, it } from 'vitest';
import { createRetrievalEgress, issueLocalRetrievalPermit } from '../src/retrieval-egress.js';
import type { RetrievalEgressPermit } from '../src/retrieval-types.js';
const description = {
  batch: 0,
  chunkIds: ['a'.repeat(64)],
  inputDigests: ['b'.repeat(64)],
  inputBytes: 10,
  requestBytes: 100,
  requestBodyDigest: 'c'.repeat(64),
};
const binding = { projectId: 'project', requestId: 'request' };
describe('exact Retrieval egress authority', () => {
  it('consumes a build approval once and limits each ordered batch to frozen approved bytes', () => {
    const egress = createRetrievalEgress();
    const permit = issueLocalRetrievalPermit({
      operation: 'build',
      ...binding,
      digest: 'd'.repeat(64),
    });
    const input = { ...binding, permit, manifestDigest: 'd'.repeat(64), batches: [description] };
    expect(() =>
      egress.consumeForBuild({ ...input, permit: { ...permit } as RetrievalEgressPermit }),
    ).toThrow();
    const grant = egress.consumeForBuild(input);
    expect(() => egress.consumeForBuild(input)).toThrow();
    expect(() =>
      egress.consumeBatchSync(grant, { ...description, requestBodyDigest: 'e'.repeat(64) }),
    ).toThrow();
    egress.consumeBatchSync(grant, description);
    expect(() => egress.consumeBatchSync(grant, description)).toThrow();
  });
  it('cannot move query approval across project, request, operation, or bytes', () => {
    const egress = createRetrievalEgress();
    const permit = issueLocalRetrievalPermit({
      operation: 'query',
      ...binding,
      digest: description.requestBodyDigest,
      batch: description,
    });
    expect(() =>
      egress.consumeQueryBatchSync(permit, description, { ...binding, projectId: 'other' }),
    ).toThrow();
    expect(() =>
      egress.consumeQueryBatchSync(permit, description, { ...binding, requestId: 'other' }),
    ).toThrow();
    expect(() =>
      egress.consumeQueryBatchSync(permit, { ...description, inputBytes: 11 }, binding),
    ).toThrow();
    egress.consumeQueryBatchSync(permit, description, binding);
    expect(() => egress.consumeQueryBatchSync(permit, description, binding)).toThrow();
  });
});
