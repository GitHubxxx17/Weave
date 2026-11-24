import type { RetrievalEmbeddingBatchDescription } from '@weave/protocol';
import { isDeepStrictEqual } from 'node:util';
import { RetrievalError } from './retrieval-errors.js';
import type {
  RetrievalEgressPermit,
  RetrievalJobEgressGrant,
  RetrievalEgressPort,
} from './retrieval-types.js';

interface Permission {
  readonly operation: 'build' | 'query';
  readonly projectId: string;
  readonly requestId: string;
  readonly digest: string;
  readonly batch?: RetrievalEmbeddingBatchDescription;
}
const permits = new WeakMap<RetrievalEgressPermit, Permission>();
const grants = new WeakMap<
  RetrievalJobEgressGrant,
  {
    readonly permission: Permission;
    readonly batches: readonly RetrievalEmbeddingBatchDescription[];
    next: number;
  }
>();
const deny = () => new RetrievalError('retrieval-scope-forbidden');

/** Host-only composition seam. Never export through the Plugin SDK or accept JSON authority. */
export function issueLocalRetrievalPermit(permission: Permission): RetrievalEgressPermit {
  const permit = Object.freeze({}) as RetrievalEgressPermit;
  permits.set(permit, Object.freeze(structuredClone(permission)));
  return permit;
}
export function revokeRetrievalPermit(permit: RetrievalEgressPermit): void {
  permits.delete(permit);
}
export function createRetrievalEgress(): RetrievalEgressPort {
  return {
    consumeForBuild(input) {
      const permission = permits.get(input.permit);
      if (
        permission?.operation !== 'build' ||
        permission.projectId !== input.projectId ||
        permission.requestId !== input.requestId ||
        permission.digest !== input.manifestDigest
      )
        throw deny();
      permits.delete(input.permit);
      const grant = Object.freeze({}) as RetrievalJobEgressGrant;
      grants.set(grant, { permission, batches: structuredClone(input.batches), next: 0 });
      return grant;
    },
    consumeBatchSync(grant, description) {
      const known = grants.get(grant);
      if (
        known === undefined ||
        description.batch !== known.next ||
        !isDeepStrictEqual(description, known.batches[known.next])
      )
        throw deny();
      known.next++;
      return undefined;
    },
    consumeQueryBatchSync(permit, description, binding) {
      const permission = permits.get(permit);
      if (
        permission?.operation !== 'query' ||
        permission.projectId !== binding.projectId ||
        permission.requestId !== binding.requestId ||
        permission.digest !== description.requestBodyDigest ||
        description.batch !== 0 ||
        !isDeepStrictEqual(description, permission.batch)
      )
        throw deny();
      permits.delete(permit);
      return undefined;
    },
  };
}
